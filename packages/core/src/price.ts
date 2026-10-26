import { parseUnits } from 'viem';
import { COINGECKO_IDS, type TokenSymbol } from '@shibpay/chains';
import { orderTag, roundUp } from './amounts';

export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status?: number; json(): Promise<unknown> }>;

/** Prices of the tokens in `currency` (e.g. "usd", "eur", "ngn"), from CoinGecko. */
export async function fetchPrices(
  symbols: readonly TokenSymbol[],
  currency: string,
  fetchFn: FetchLike = fetch,
): Promise<Partial<Record<TokenSymbol, number>>> {
  const cur = currency.toLowerCase();
  const ids = symbols.map((s) => COINGECKO_IDS[s]).join(',');
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=${encodeURIComponent(cur)}`;
  const res = await fetchFn(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Price feed unavailable (${res.status ?? 'network'})`);
  const json = (await res.json()) as Record<string, Record<string, number>>;
  const out: Partial<Record<TokenSymbol, number>> = {};
  for (const s of symbols) {
    const p = json[COINGECKO_IDS[s]]?.[cur];
    if (typeof p === 'number' && p > 0) out[s] = p;
  }
  return out;
}

/**
 * Token amount (smallest units) for a local-currency price, rounded up to 2
 * decimals so the merchant is never short. `price` is one token in that currency.
 */
export function quoteAmount(fiat: string, price: number, decimals: number): bigint {
  if (!(price > 0)) throw new Error('No price for this token');
  const fiatE18 = parseUnits(fiat, 18);
  // price to 1e18 fixed point; toPrecision keeps 15 significant digits of the float.
  const priceE18 = parseUnits(Number(price.toPrecision(15)).toFixed(18), 18);
  if (priceE18 === 0n) throw new Error('Price too small to quote');
  const raw = (fiatE18 * 10n ** BigInt(decimals) + priceE18 - 1n) / priceE18;
  return roundUp(raw, decimals, 2);
}

/** quoteAmount plus a unique order tag (see orderTag). */
export function quoteWithTag(fiat: string, price: number, decimals: number, random?: () => number): bigint {
  return quoteAmount(fiat, price, decimals) + orderTag(decimals, random);
}
