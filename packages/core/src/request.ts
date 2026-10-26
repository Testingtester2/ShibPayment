import { keccak256, toHex } from 'viem';
import { getToken, type TokenSymbol } from '@shibpay/chains';
import { percentToBps } from './amounts';
import { validateMerchantAddress } from './merchant';

/** bytes32 order reference, as stored in the splitter's Paid event. */
export function orderIdHash(orderId: string): `0x${string}` {
  return keccak256(toHex(orderId));
}

/**
 * EIP-681 link for a plain transfer (no burn). Wallets that scan it open a
 * pre-filled send. A link cannot express the burn split, so with a burn the
 * buyer pays through the button instead.
 */
export function toEip681(p: { chainId: number; token: TokenSymbol; merchant: string; amount: bigint }): string {
  const t = getToken(p.chainId, p.token);
  if (!t) throw new Error(`${p.token} is not available on chain ${p.chainId}`);
  const merchant = validateMerchantAddress(p.merchant);
  if (t.native) return `ethereum:${merchant}@${p.chainId}?value=${p.amount}`;
  return `ethereum:${t.address}@${p.chainId}/transfer?address=${merchant}&uint256=${p.amount}`;
}

/** What a merchant puts in a payment link or on a button. */
export interface CheckoutConfig {
  /** Merchant's receiving address (EVM). */
  to: `0x${string}`;
  /** Price, in `currency`. */
  amount: string;
  /** "USD", "EUR", "NGN"... or a token symbol to price directly in tokens. */
  currency: string;
  /** Burn, in basis points (250 = 2.5%). */
  burnBps: number;
  /** Merchant's order reference, if any. */
  order?: string;
  /** Shop name shown to the buyer. */
  label?: string;
  /** Where to send the buyer after paying; tx details are appended. */
  returnUrl?: string;
}

/** Builds a payment-page link: `${base}?to=...&amount=...`. */
export function buildPaymentLink(base: string, c: CheckoutConfig): string {
  const u = new URL(base);
  u.searchParams.set('to', validateMerchantAddress(c.to));
  u.searchParams.set('amount', c.amount);
  u.searchParams.set('currency', c.currency.toUpperCase());
  if (c.burnBps) u.searchParams.set('burn', String(c.burnBps / 100));
  if (c.order) u.searchParams.set('order', c.order);
  if (c.label) u.searchParams.set('label', c.label);
  if (c.returnUrl) u.searchParams.set('return', c.returnUrl);
  return u.toString();
}

/** Reads a payment-page link back. Throws with a plain-language message on bad input. */
export function parsePaymentLink(url: string | URL): CheckoutConfig {
  const q = new URL(url).searchParams;
  const amount = q.get('amount') ?? '';
  if (!/^\d+(\.\d+)?$/.test(amount) || Number(amount) <= 0) throw new Error('This payment link has no valid amount.');
  const currency = (q.get('currency') ?? 'USD').toUpperCase();
  if (!/^[A-Z]{2,6}$/.test(currency)) throw new Error('This payment link has an unknown currency.');
  const returnUrl = q.get('return') ?? undefined;
  if (returnUrl && !/^https?:\/\//i.test(returnUrl)) throw new Error('This payment link has an invalid return address.');
  return {
    to: validateMerchantAddress(q.get('to') ?? ''),
    amount,
    currency,
    burnBps: percentToBps(q.get('burn') ?? '0'),
    order: q.get('order') ?? undefined,
    label: q.get('label') ?? undefined,
    returnUrl,
  };
}
