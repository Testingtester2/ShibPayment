import { decodeEventLog, getAddress, isAddressEqual, zeroAddress, type Log } from 'viem';
import { BURN_CHAIN_ID, getToken, type TokenSymbol } from '@shibpay/chains';
import { SPLITTER_ADDRESS, splitterAbi } from '@shibpay/contracts';
import { erc20Abi } from './abi';
import { splitBurn, type BurnMode } from './amounts';
import { splitterAvailable } from './pay';
import { orderIdHash } from './request';

export interface ExpectedPayment {
  chainId: number;
  token: TokenSymbol;
  merchant: string;
  /** Minimum total paid (burn included), in smallest units. */
  amount: bigint;
  /**
   * Burn the merchant asked for, in basis points. On Ethereum, once the
   * splitter is deployed, the payment must burn at least this share. Elsewhere
   * the merchant is paid in full and the share is reported as `pledged`.
   */
  burnBps: number;
  /** When set, a splitter payment must carry this order reference. */
  orderId?: string;
  /** Blocks on top of the payment's block, counting it. Default 2. */
  minConfirmations?: number;
  splitter?: `0x${string}`;
}

export type VerifyResult =
  | {
      ok: true; payer: `0x${string}`; amount: bigint; confirmations: number; viaSplitter: boolean;
      burnMode: BurnMode;
      /** Burned in the payment transaction. */
      burned: bigint;
      /** The merchant's own burn, still to do on Ethereum. */
      pledged: bigint;
    }
  | { ok: false; reason: string; retry: boolean };

/** The subset of a viem PublicClient that verification needs. */
export interface ReadClient {
  getTransactionReceipt(a: { hash: `0x${string}` }): Promise<{
    status: 'success' | 'reverted'; blockNumber: bigint; from: `0x${string}`; to: `0x${string}` | null; logs: Log[];
  }>;
  getTransaction(a: { hash: `0x${string}` }): Promise<{ to: `0x${string}` | null; value: bigint; from: `0x${string}` }>;
  getBlockNumber(a?: { cacheTime?: number }): Promise<bigint>;
  getCode(a: { address: `0x${string}` }): Promise<`0x${string}` | undefined>;
}

const fail = (reason: string, retry = false): VerifyResult => ({ ok: false, reason, retry });

/**
 * Checks on-chain that `txHash` pays `expected`. Run it on the merchant's
 * server before marking an order paid: anything the browser reports can be faked.
 */
export async function verifyPayment(client: ReadClient, txHash: `0x${string}`, expected: ExpectedPayment): Promise<VerifyResult> {
  const token = getToken(expected.chainId, expected.token);
  if (!token) return fail(`${expected.token} is not supported on chain ${expected.chainId}`);
  const merchant = getAddress(expected.merchant);
  const splitter = expected.splitter ?? SPLITTER_ADDRESS;

  let receipt: Awaited<ReturnType<ReadClient['getTransactionReceipt']>>;
  try {
    receipt = await client.getTransactionReceipt({ hash: txHash });
  } catch {
    return fail('Transaction not found yet', true);
  }
  if (receipt.status !== 'success') return fail('Transaction failed on-chain');

  const confirmations = Number((await client.getBlockNumber({ cacheTime: 0 })) - receipt.blockNumber + 1n);
  const need = expected.minConfirmations ?? 2;
  if (confirmations < need) return fail(`Waiting for confirmations (${confirmations}/${need})`, true);

  // 1. Through the splitter: trust its Paid event (the contract reverts unless both transfers succeed).
  const tokenAddr = token.native ? zeroAddress : token.address;
  for (const log of receipt.logs) {
    if (!isAddressEqual(log.address, splitter)) continue;
    let ev;
    try {
      ev = decodeEventLog({ abi: splitterAbi, data: log.data, topics: log.topics });
    } catch {
      continue;
    }
    if (ev.eventName !== 'Paid') continue;
    const a = ev.args;
    if (!isAddressEqual(a.merchant, merchant) || !isAddressEqual(a.token, tokenAddr)) continue;
    if (expected.orderId !== undefined && a.orderId !== orderIdHash(expected.orderId)) continue;
    if (a.amount < expected.amount) return fail('Paid less than the price');
    if (a.burned < splitBurn(a.amount, expected.burnBps).burned) return fail('Burned less than the merchant asked for');
    return { ok: true, payer: a.payer, amount: a.amount, confirmations, viaSplitter: true, burnMode: 'in-tx', burned: a.burned, pledged: 0n };
  }

  // 2. A plain transfer. With a burn, that's the merchant's pledge, except on
  // Ethereum once the splitter is live, where the burn must be in the payment.
  if (expected.burnBps > 0 && expected.chainId === BURN_CHAIN_ID && (await splitterAvailable(client, splitter))) {
    return fail('No burn payment to this merchant in that transaction');
  }
  const plain = (payer: `0x${string}`, amount: bigint): VerifyResult => ({
    ok: true, payer, amount, confirmations, viaSplitter: false,
    burnMode: expected.burnBps > 0 ? 'pledge' : 'none',
    burned: 0n,
    pledged: splitBurn(amount, expected.burnBps).burned,
  });

  if (token.native) {
    const tx = await client.getTransaction({ hash: txHash });
    if (!tx.to || !isAddressEqual(tx.to, merchant)) return fail('That transaction does not pay this merchant');
    if (tx.value < expected.amount) return fail('Paid less than the price');
    return plain(tx.from, tx.value);
  }

  let total = 0n;
  let payer: `0x${string}` | undefined;
  for (const log of receipt.logs) {
    if (!isAddressEqual(log.address, token.address)) continue;
    try {
      const ev = decodeEventLog({ abi: erc20Abi, data: log.data, topics: log.topics });
      if (ev.eventName === 'Transfer' && isAddressEqual(ev.args.to, merchant)) {
        total += ev.args.value;
        payer ??= ev.args.from;
      }
    } catch {
      // not a Transfer
    }
  }
  if (!payer) return fail('That transaction does not pay this merchant');
  if (total < expected.amount) return fail('Paid less than the price');
  return plain(payer, total);
}
