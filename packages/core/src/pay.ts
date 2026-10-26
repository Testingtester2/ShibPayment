import { createPublicClient, createWalletClient, custom, getAddress, type TransactionReceipt } from 'viem';
import { getChain, getToken, type TokenSymbol } from '@shibpay/chains';
import { SPLITTER_ADDRESS, splitterAbi } from '@shibpay/contracts';
import { erc20Abi } from './abi';
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
  /** Basis points burned from `amount`; 0 sends a plain transfer with no contract. */
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
}

export class InsufficientBalanceError extends Error {
  constructor(token: string, chainName: string) {
    super(`Not enough ${token} on ${chainName} for this payment. Top up, or pick another token or network.`);
    this.name = 'InsufficientBalanceError';
  }
}

export class BurnUnavailableError extends Error {
  constructor(chainName: string) {
    super(`Burning is not set up on ${chainName} yet. Choose another network or pay without a burn.`);
    this.name = 'BurnUnavailableError';
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
 * Pays through the buyer's wallet. With no burn this is one ordinary transfer
 * straight to the merchant. With a burn it goes through ShibPaySplitter: an
 * exact-amount approval (ERC-20 only, skipped when already approved), then one
 * pay() call that sends the burn share to 0x...dEaD and the rest to the merchant.
 */
export async function payWithWallet(p: PayParams): Promise<PayResult> {
  const chain = getChain(p.chainId);
  const token = getToken(p.chainId, p.token);
  if (!chain || !token) throw new Error(`${p.token} is not available on this network.`);
  if (p.amount <= 0n) throw new Error('Nothing to pay.');
  const merchant = validateMerchantAddress(p.merchant);
  const splitter = p.splitter ?? SPLITTER_ADDRESS;

  p.onStep?.('connecting');
  const accounts = (await p.provider.request({ method: 'eth_requestAccounts' })) as string[];
  if (!accounts?.length) throw new Error('No wallet account was shared.');
  const payer = getAddress(accounts[0]);

  p.onStep?.('switching-chain');
  await ensureChain(p.provider, p.chainId);

  const vchain = viemChain(chain);
  const transport = custom(p.provider);
  const pub = createPublicClient({ chain: vchain, transport, pollingInterval: 1_000 });
  const wallet = createWalletClient({ chain: vchain, transport, account: payer });

  // Check the balance first: a failed transaction still costs the buyer gas.
  const balance = token.native
    ? await pub.getBalance({ address: payer })
    : await pub.readContract({ address: token.address, abi: erc20Abi, functionName: 'balanceOf', args: [payer] });
  if (balance < p.amount) throw new InsufficientBalanceError(p.token, chain.name);

  let hash: `0x${string}`;
  if (p.burnBps > 0) {
    if (!(await splitterAvailable(pub, splitter))) throw new BurnUnavailableError(chain.name);
    if (token.native) {
      p.onStep?.('paying');
      hash = await wallet.writeContract({
        address: splitter, abi: splitterAbi, functionName: 'payNative',
        args: [merchant, p.burnBps, orderIdHash(p.orderId)], value: p.amount,
      });
    } else {
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
    }
  } else {
    p.onStep?.('paying');
    hash = token.native
      ? await wallet.sendTransaction({ to: merchant, value: p.amount })
      : await wallet.writeContract({
          address: token.address, abi: erc20Abi, functionName: 'transfer', args: [merchant, p.amount],
        });
  }

  p.onStep?.('confirming');
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error('The payment did not go through. No money was moved.');
  return { hash, chainId: p.chainId, payer, receipt };
}
