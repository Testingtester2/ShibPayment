import { getAddress, type PublicClient } from 'viem';
import { getToken, type TokenSymbol } from '@shibpay/chains';
import { SPLITTER_ADDRESS, splitterAbi } from '@shibpay/contracts';
import { erc20Abi } from './abi';
import { orderIdHash } from './request';

export interface FindParams {
  client: PublicClient;
  chainId: number;
  token: TokenSymbol;
  merchant: string;
  /** The exact tagged amount quoted for this order (see quoteWithTag). */
  amount: bigint;
  orderId: string;
  fromBlock: bigint;
  splitter?: `0x${string}`;
}

/**
 * Looks for this order's payment from `fromBlock` on, for buyers who paid by
 * scanning a QR instead of through the button: a splitter Paid event carrying
 * the order reference, or a plain ERC-20 transfer of the exact tagged amount.
 * Returns the transaction hash, or null. Confirm it with verifyPayment.
 */
export async function findPayment(p: FindParams): Promise<`0x${string}` | null> {
  const merchant = getAddress(p.merchant);
  const paid = await p.client.getContractEvents({
    address: p.splitter ?? SPLITTER_ADDRESS,
    abi: splitterAbi,
    eventName: 'Paid',
    args: { orderId: orderIdHash(p.orderId), merchant },
    fromBlock: p.fromBlock,
  });
  if (paid.length) return paid[0].transactionHash;

  const token = getToken(p.chainId, p.token);
  if (!token || token.native) return null; // native transfers leave no log to search
  const transfers = await p.client.getContractEvents({
    address: token.address,
    abi: erc20Abi,
    eventName: 'Transfer',
    args: { to: merchant },
    fromBlock: p.fromBlock,
  });
  return transfers.find((l) => l.args.value === p.amount)?.transactionHash ?? null;
}

/** Calls `check` every `intervalMs` until it returns a value, the timeout passes, or `signal` aborts. */
export async function poll<T>(
  check: () => Promise<T | null>,
  { intervalMs = 5_000, timeoutMs = 15 * 60_000, signal }: { intervalMs?: number; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<T | null> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end && !signal?.aborted) {
    try {
      const v = await check();
      if (v !== null) return v;
    } catch {
      // RPC hiccup: try again next round
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return null;
}
