import { formatUnits } from 'viem';

export const MAX_BPS = 10_000;

/** "2.5" (percent) -> 250 basis points. Throws outside 0..100 or past 2 decimals. */
export function percentToBps(percent: string | number): number {
  const s = String(percent).trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s)) throw new Error(`Burn must be a number from 0 to 100 with at most 2 decimals, got "${s}"`);
  const bps = Math.round(Number(s) * 100);
  if (bps > MAX_BPS) throw new Error('Burn cannot be more than 100%');
  return bps;
}

export function bpsToPercent(bps: number): string {
  return (bps / 100).toString();
}

/** Same rounding as ShibPaySplitter: the burn rounds down, the merchant gets the rest. */
export function splitBurn(amount: bigint, burnBps: number): { burned: bigint; toMerchant: bigint } {
  if (!Number.isInteger(burnBps) || burnBps < 0 || burnBps > MAX_BPS) throw new Error(`Invalid burn ${burnBps}`);
  const burned = (amount * BigInt(burnBps)) / BigInt(MAX_BPS);
  return { burned, toMerchant: amount - burned };
}

/** Round a token amount up to `places` decimals. */
export function roundUp(amount: bigint, decimals: number, places = 2): bigint {
  if (places >= decimals) return amount;
  const step = 10n ** BigInt(decimals - places);
  return ((amount + step - 1n) / step) * step;
}

/**
 * A random 1..9999 tag in the 3rd-6th decimal places. Added to a quote that was
 * rounded to 2 decimals, it makes each order's amount unique, so a plain
 * transfer (which carries no order number) can still be matched to its order.
 */
export function orderTag(decimals: number, random: () => number = Math.random): bigint {
  if (decimals < 6) return 0n;
  const tag = 1n + BigInt(Math.floor(random() * 9999));
  return tag * 10n ** BigInt(decimals - 6);
}

/** 1234567.5 -> "1,234,567.5", trimming trailing zeros. */
export function formatTokenAmount(amount: bigint, decimals: number, maxFraction = 6): string {
  const [int, frac = ''] = formatUnits(amount, decimals).split('.');
  const intFmt = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fracFmt = frac.slice(0, maxFraction).replace(/0+$/, '');
  return fracFmt ? `${intFmt}.${fracFmt}` : intFmt;
}
