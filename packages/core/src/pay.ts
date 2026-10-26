import { createPublicClient, createWalletClient, custom, getAddress, type TransactionReceipt } from 'viem';
import { BURN_ADDRESS, BURN_CHAIN_ID, getChain, getToken, type TokenSymbol } from '@shibpay/chains';
import { SPLITTER_ADDRESS, splitterAbi } from '@shibpay/contracts';
import { erc20Abi } from './abi';
import { burnMode, splitBurn, type BurnMode } from './amounts';
import { viemChain } from './clients';
import { validateMerchantAddress } from './merchant';
import { orderIdHash } from './request';

/** Any EIP-1193 wallet provider: window.ethereum, an EIP-6963 provider, WalletConnect... */
export interface Eip1193Provider {
  request(args: { method: string; params?: unknown }): Promise<unknown>;
}

export type PayStep = 'connecting' | 'switching-chain' | 'approving' | 'paying' | 'confirming';

export interface PayParams {
  provider: Eip1193Provider;
  chainId: number;
  token: TokenSymbol;
  merchant: string;
  /** Total the buyer pays, in the token's smallest units, burn included. */
  amount: bigint;
  /**
   * The shop's burn, in basis points of `amount`. On Ethereum it is burned in
   * the same transaction; on other chains the merchant is paid in full and
   * the burn is their pledge (see burnMode).
   */
  burnBps: number;
  orderId: string;
  onStep?: (step: PayStep) => void;
  /** Override for tests or a custom deployment. */
  splitter?: `0x${string}`;
}

export interface PayResult {
  hash: `0x${string}`;
  chainId: number;
  payer: `0x${string}`;
  receipt: TransactionReceipt;
  burnMode: BurnMode;
  /** Burned in this transaction. */
  burned: bigint;
  /** Left for the merchant to burn on Ethereum. */
  pledged: bigint;
}

export class InsufficientBalanceError extends Error {
  constructor(token: string, chainName: string) {
    super(`Not enough ${token} on ${chainName} for this payment. Top up, or pick another token or network.`);
    this.name = 'InsufficientBalanceError';
  }
}

/** True when the burn splitter is deployed on the provider's current chain. */
export async function splitterAvailable(
  client: { getCode(a: { address: `0x${string}` }): Promise<`0x${string}` | undefined> },
  splitter: `0x${string}` = SPLITTER_ADDRESS,
): Promise<boolean> {
  const code = await client.getCode({ address: splitter });
  return !!code && code !== '0x';
}

/** Ask the wallet to move to `chainId`, adding the network if it doesn't know it. */
export async function ensureChain(provider: Eip1193Provider, chainId: number): Promise<void> {
  const current = Number(await provider.request({ method: 'eth_chainId' }));
  if (current === chainId) return;
  const c = getChain(chainId);
  if (!c) throw new Error(`Unsupported chain ${chainId}`);
  const hexId = `0x${chainId.toString(16)}`;
  try {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hexId }] });
  } catch (err) {
    const code = (err as { code?: number; data?: { originalError?: { code?: number } } }).code
      ?? (err as { data?: { originalError?: { code?: number } } }).data?.originalError?.code;
    if (code !== 4902) throw err;
    await provider.request({
      method: 'wallet_addEthereumChain',
      params: [{
        chainId: hexId,
        chainName: c.name,
        nativeCurrency: { name: c.nativeSymbol, symbol: c.nativeSymbol, decimals: 18 },
        rpcUrls: c.rpcUrls,
        blockExplorerUrls: [c.explorerUrl],
      }],
    });
  }
}

/**
 * Pays through the buyer's wallet. Without an in-transaction burn this is one
 * ordinary transfer straight to the merchant. With one (Ethereum only) it goes
 * through ShibPaySplitter: an exact-amount approval (skipped when already
 * approved), then one pay() call that sends the burn share to 0x...dEaD and
 * the rest to the merchant.
 */
export async function payWithWallet(p: PayParams): Promise<PayResult> {
  const chain = getChain(p.chainId);
  const token = getToken(p.chainId, p.token);
  if (!chain || !token) throw new Error(`${p.token} is not available on this network.`);
  if (p.amount <= 0n) throw new Error('Nothing to pay.');
  const merchant = validateMerchantAddress(p.merchant);
  const splitter = p.splitter ?? SPLITTER_ADDRESS;

  p.onStep?.('connecting');
  const payer = await connect(p.provider);

  p.onStep?.('switching-chain');
  await ensureChain(p.provider, p.chainId);

  const { pub, wallet } = clientsFor(p.provider, p.chainId, payer);
  await requireBalance(pub, p.token, p.chainId, payer, p.amount);

  // Before the splitter is deployed, Ethereum payments fall back to a pledge too.
  const mode = burnMode(p.chainId, p.burnBps, p.chainId === BURN_CHAIN_ID && p.burnBps > 0 && (await splitterAvailable(pub, splitter)));
  const share = mode === 'none' ? 0n : splitBurn(p.amount, p.burnBps).burned;

  let hash: `0x${string}`;
  if (mode === 'in-tx' && !token.native) {
    const allowance = await pub.readContract({
      address: token.address, abi: erc20Abi, functionName: 'allowance', args: [payer, splitter],
    });
    if (allowance < p.amount) {
      p.onStep?.('approving');
      const approveHash = await wallet.writeContract({
        address: token.address, abi: erc20Abi, functionName: 'approve', args: [splitter, p.amount],
      });
      const r = await pub.waitForTransactionReceipt({ hash: approveHash });
      if (r.status !== 'success') throw new Error('The approval did not go through.');
    }
    p.onStep?.('paying');
    hash = await wallet.writeContract({
      address: splitter, abi: splitterAbi, functionName: 'pay',
      args: [token.address, merchant, p.amount, p.burnBps, orderIdHash(p.orderId)],
    });
  } else {
    p.onStep?.('paying');
    hash = await transfer(wallet, token, merchant, p.amount);
  }

  p.onStep?.('confirming');
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error('The payment did not go through. No money was moved.');
  return {
    hash, chainId: p.chainId, payer, receipt, burnMode: mode,
    burned: mode === 'in-tx' ? share : 0n,
    pledged: mode === 'pledge' ? share : 0n,
  };
}

export interface BurnParams {
  provider: Eip1193Provider;
  token: TokenSymbol;
  /** Smallest units to burn. */
  amount: bigint;
  onStep?: (step: PayStep) => void;
}

/**
 * Burns tokens from the connected wallet on Ethereum: one plain transfer to
 * 0x...dEaD, the address burn trackers count. This is how a merchant settles
 * the burn they pledged on payments taken on other chains.
 */
export async function burnOnEthereum(p: BurnParams): Promise<Omit<PayResult, 'burnMode' | 'pledged'>> {
  const chainId = BURN_CHAIN_ID;
  const chain = getChain(chainId)!;
  const token = getToken(chainId, p.token);
  if (!token) throw new Error(`${p.token} is not available on ${chain.name}.`);
  if (p.amount <= 0n) throw new Error('Nothing to burn.');

  p.onStep?.('connecting');
  const payer = await connect(p.provider);
  p.onStep?.('switching-chain');
  await ensureChain(p.provider, chainId);
  const { pub, wallet } = clientsFor(p.provider, chainId, payer);
  await requireBalance(pub, p.token, chainId, payer, p.amount);

  p.onStep?.('paying');
  const hash = await transfer(wallet, token, BURN_ADDRESS, p.amount);
  p.onStep?.('confirming');
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error('The burn did not go through. Nothing was burned.');
  return { hash, chainId, payer, receipt, burned: p.amount };
}

async function connect(provider: Eip1193Provider): Promise<`0x${string}`> {
  const accounts = (await provider.request({ method: 'eth_requestAccounts' })) as string[];
  if (!accounts?.length) throw new Error('No wallet account was shared.');
  return getAddress(accounts[0]);
}

function clientsFor(provider: Eip1193Provider, chainId: number, account: `0x${string}`) {
  const vchain = viemChain(getChain(chainId)!);
  const transport = custom(provider);
  return {
    pub: createPublicClient({ chain: vchain, transport, pollingInterval: 1_000 }),
    wallet: createWalletClient({ chain: vchain, transport, account }),
  };
}

// Check the balance first: a failed transaction still costs the sender gas.
async function requireBalance(pub: ReturnType<typeof clientsFor>['pub'], symbol: TokenSymbol, chainId: number, who: `0x${string}`, amount: bigint) {
  const token = getToken(chainId, symbol)!;
  const balance = token.native
    ? await pub.getBalance({ address: who })
    : await pub.readContract({ address: token.address, abi: erc20Abi, functionName: 'balanceOf', args: [who] });
  if (balance < amount) throw new InsufficientBalanceError(symbol, getChain(chainId)!.name);
}

function transfer(wallet: ReturnType<typeof clientsFor>['wallet'], token: { address: `0x${string}`; native?: boolean }, to: `0x${string}`, amount: bigint) {
  return token.native
    ? wallet.sendTransaction({ to, value: amount })
    : wallet.writeContract({ address: token.address, abi: erc20Abi, functionName: 'transfer', args: [to, amount] });
}
