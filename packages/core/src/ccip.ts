import { concat, encodeAbiParameters, encodeFunctionData, parseAbi, zeroAddress } from 'viem';
import {
  BURN_ADDRESS, BURN_CHAIN_ID, CCIP_BURN_TOKENS, CCIP_ETHEREUM_SELECTOR, CCIP_ROUTERS, getChain, getToken, type TokenSymbol,
} from '@shibpay/chains';
import { erc20Abi } from './abi';
import { publicClientFor } from './clients';
import {
  connectWallet, ensureChain, requireBalance, sendAtomicBatch, walletClients, type Call, type Eip1193Provider, type PayStep,
} from './pay';

export const ccipRouterAbi = parseAbi([
  'struct EVMTokenAmount { address token; uint256 amount; }',
  'struct EVM2AnyMessage { bytes receiver; bytes data; EVMTokenAmount[] tokenAmounts; address feeToken; bytes extraArgs; }',
  'function getFee(uint64 destinationChainSelector, EVM2AnyMessage message) view returns (uint256 fee)',
  'function ccipSend(uint64 destinationChainSelector, EVM2AnyMessage message) payable returns (bytes32)',
]);

/**
 * EVMExtraArgsV2: no gas limit on Ethereum, since 0x...dEaD runs no code (the
 * default would make the burner pay for 200k gas they never use), and
 * out-of-order execution so one stuck message never holds up another.
 */
export const CCIP_EXTRA_ARGS = concat(['0x181dcf10', encodeAbiParameters([{ type: 'uint256' }, { type: 'bool' }], [0n, true])]);

/** Chains whose SHIB, BONE and LEASH can be burned from where they sit: Ethereum directly, the rest through CCIP. */
export const BURN_FROM_CHAIN_IDS: readonly number[] = [BURN_CHAIN_ID, ...Object.keys(CCIP_ROUTERS).map(Number)];

/** Tokens the burn helper can burn on `chainId` (TREAT only on Ethereum itself). */
export function burnableTokens(chainId: number): TokenSymbol[] {
  const chain = getChain(chainId);
  if (!chain) return [];
  if (chainId === BURN_CHAIN_ID) return chain.tokens.filter((t) => !t.native).map((t) => t.symbol);
  if (!CCIP_ROUTERS[chainId]) return [];
  return CCIP_BURN_TOKENS.filter((s) => getToken(chainId, s));
}

export interface BurnItem { token: TokenSymbol; amount: bigint }

/** Where to follow a CCIP transfer until it lands in 0x...dEaD on Ethereum. */
export function ccipExplorerUrl(hash: string): string {
  return `https://ccip.chain.link/tx/${hash}`;
}

function ccipMessage(chainId: number, item: BurnItem, extraArgs: `0x${string}`) {
  return {
    receiver: encodeAbiParameters([{ type: 'address' }], [BURN_ADDRESS]),
    data: '0x' as const,
    tokenAmounts: [{ token: getToken(chainId, item.token)!.address, amount: item.amount }],
    feeToken: zeroAddress,
    extraArgs,
  };
}

interface Reader { readContract(args: unknown): Promise<unknown> }

/**
 * The CCIP fee for each item, in the source chain's gas coin. Uses the cheap
 * extraArgs and falls back to the router's defaults if a lane ever refuses them.
 */
export async function quoteCcipBurn(client: Reader, chainId: number, items: BurnItem[]): Promise<{ fees: bigint[]; extraArgs: `0x${string}` }> {
  const router = CCIP_ROUTERS[chainId];
  if (!router) throw new Error(`${getChain(chainId)?.name ?? 'This network'} can't bridge to Ethereum.`);
  const quote = (extraArgs: `0x${string}`) => Promise.all(items.map((item) => client.readContract({
    address: router, abi: ccipRouterAbi, functionName: 'getFee', args: [CCIP_ETHEREUM_SELECTOR, ccipMessage(chainId, item, extraArgs)],
  }) as Promise<bigint>));
  try {
    return { fees: await quote(CCIP_EXTRA_ARGS), extraArgs: CCIP_EXTRA_ARGS };
  } catch {
    return { fees: await quote('0x'), extraArgs: '0x' };
  }
}

export class InsufficientGasError extends Error {
  constructor(symbol: string, chainName: string) {
    super(`Not enough ${symbol} on ${chainName} for the fees. Add a little ${symbol} there and try again.`);
    this.name = 'InsufficientGasError';
  }
}

export interface ChainBurnParams {
  provider: Eip1193Provider;
  chainId: number;
  items: BurnItem[];
  onStep?: (step: PayStep) => void;
}

export interface ChainBurnResult {
  chainId: number;
  payer: `0x${string}`;
  /** 'direct' on Ethereum; 'ccip' when the tokens are on their way to 0x...dEaD on Ethereum. */
  via: 'direct' | 'ccip';
  /** The transactions that sent tokens (not approvals). */
  hashes: `0x${string}`[];
  /** CCIP fee paid, in the source chain's gas coin. */
  fee: bigint;
}

/**
 * Burns tokens from one network. On Ethereum it is a plain transfer to
 * 0x...dEaD. Elsewhere each token goes through CCIP to 0x...dEaD on Ethereum:
 * approve the router (skipped if already approved), then ccipSend, paying the
 * fee in the network's gas coin. Wallets that bundle (EIP-5792) do the whole
 * network in one confirmation.
 */
export async function burnFromChain(p: ChainBurnParams): Promise<ChainBurnResult> {
  const chain = getChain(p.chainId);
  const items = p.items.filter((i) => i.amount > 0n);
  if (!chain || !BURN_FROM_CHAIN_IDS.includes(p.chainId)) throw new Error('Burning from this network is not supported.');
  if (!items.length) throw new Error('Nothing to burn.');
  for (const i of items) {
    if (!burnableTokens(p.chainId).includes(i.token)) throw new Error(`${i.token} can't be burned from ${chain.name}.`);
  }

  p.onStep?.('connecting');
  const payer = await connectWallet(p.provider);
  p.onStep?.('switching-chain');
  await ensureChain(p.provider, p.chainId);
  const { pub, wallet } = walletClients(p.provider, p.chainId, payer);
  for (const i of items) await requireBalance(pub, i.token, p.chainId, payer, i.amount);

  const done = async (hashes: `0x${string}`[], via: ChainBurnResult['via'], fee: bigint): Promise<ChainBurnResult> => {
    p.onStep?.('confirming');
    for (const hash of hashes) {
      const r = await pub.waitForTransactionReceipt({ hash });
      if (r.status !== 'success') throw new Error('The burn did not go through. Nothing was burned.');
    }
    return { chainId: p.chainId, payer, via, hashes, fee };
  };

  if (p.chainId === BURN_CHAIN_ID) {
    const calls: Call[] = items.map((i) => ({
      to: getToken(p.chainId, i.token)!.address,
      data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [BURN_ADDRESS, i.amount] }),
    }));
    const batched = calls.length > 1 ? await sendAtomicBatch(p.provider, p.chainId, payer, calls, () => p.onStep?.('approve-and-pay')) : null;
    if (batched) return done([batched], 'direct', 0n);
    const hashes: `0x${string}`[] = [];
    for (const c of calls) {
      p.onStep?.('paying');
      hashes.push(await wallet.sendTransaction({ to: c.to, data: c.data }));
    }
    return done(hashes, 'direct', 0n);
  }

  const router = CCIP_ROUTERS[p.chainId];
  const quoted = await quoteCcipBurn(pub, p.chainId, items);
  const totalFee = quoted.fees.reduce((a, b) => a + b, 0n);
  if (await pub.getBalance({ address: payer }) < totalFee) throw new InsufficientGasError(chain.nativeSymbol, chain.name);

  const allowances = await Promise.all(items.map((i) => pub.readContract({
    address: getToken(p.chainId, i.token)!.address, abi: erc20Abi, functionName: 'allowance', args: [payer, router],
  })));
  const approve = (i: BurnItem): Call => ({
    to: getToken(p.chainId, i.token)!.address,
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [router, i.amount] }),
  });
  const send = (i: BurnItem, fee: bigint): Call => ({
    to: router,
    data: encodeFunctionData({ abi: ccipRouterAbi, functionName: 'ccipSend', args: [CCIP_ETHEREUM_SELECTOR, ccipMessage(p.chainId, i, quoted.extraArgs)] }),
    value: fee,
  });

  const calls = items.flatMap((i, n) => [...(allowances[n] < i.amount ? [approve(i)] : []), send(i, quoted.fees[n])]);
  const batched = calls.length > 1 ? await sendAtomicBatch(p.provider, p.chainId, payer, calls, () => p.onStep?.('approve-and-pay')) : null;
  if (batched) return done([batched], 'ccip', totalFee);

  const hashes: `0x${string}`[] = [];
  let paid = 0n;
  for (const [n, i] of items.entries()) {
    if (allowances[n] < i.amount) {
      p.onStep?.('approving');
      const a = await wallet.sendTransaction(approve(i));
      const r = await pub.waitForTransactionReceipt({ hash: a });
      if (r.status !== 'success') throw new Error('The approval did not go through.');
    }
    // Quote again: approving can take a while and the fee moves with gas prices.
    const fee = (await quoteCcipBurn(pub, p.chainId, [i])).fees[0];
    p.onStep?.('paying');
    const c = send(i, fee);
    hashes.push(await wallet.sendTransaction({ to: c.to, data: c.data, value: fee }));
    paid += fee;
  }
  return done(hashes, 'ccip', paid);
}

export interface ChainBalances {
  chainId: number;
  /** Non-zero balances only. */
  tokens: { token: TokenSymbol; balance: bigint }[];
  /** Gas coin balance, to warn before a CCIP fee can't be paid. */
  native: bigint;
  /** Set when the network couldn't be read. */
  error?: string;
}

/** What `owner` holds that the burn helper can burn, on Ethereum and every CCIP network. */
export async function findBurnableBalances(
  owner: `0x${string}`, clientFor: (chainId: number) => Reader & { getBalance(a: { address: `0x${string}` }): Promise<bigint> } = publicClientFor,
): Promise<ChainBalances[]> {
  return Promise.all(BURN_FROM_CHAIN_IDS.map(async (chainId): Promise<ChainBalances> => {
    try {
      const client = clientFor(chainId);
      const symbols = burnableTokens(chainId);
      const [native, ...balances] = await Promise.all([
        client.getBalance({ address: owner }),
        ...symbols.map((s) => client.readContract({
          address: getToken(chainId, s)!.address, abi: erc20Abi, functionName: 'balanceOf', args: [owner],
        }) as Promise<bigint>),
      ]);
      return { chainId, native, tokens: symbols.map((token, n) => ({ token, balance: balances[n] })).filter((t) => t.balance > 0n) };
    } catch (e) {
      return { chainId, native: 0n, tokens: [], error: (e as Error).message };
    }
  }));
}
