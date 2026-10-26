import { getAddress, isAddress, zeroAddress } from 'viem';
import { BURN_ADDRESS } from '@shibpay/chains';
import type { FetchLike } from './price';

/**
 * Checks a merchant's receiving address and returns it checksummed. Rejects
 * malformed input, the zero address and the burn address (a typo there would
 * burn every payment).
 */
export function validateMerchantAddress(input: string): `0x${string}` {
  const s = input.trim();
  if (!isAddress(s, { strict: false })) throw new Error('That is not a valid wallet address (0x followed by 40 characters).');
  const addr = getAddress(s);
  if (addr === zeroAddress || addr.toLowerCase() === BURN_ADDRESS.toLowerCase()) {
    throw new Error('That address cannot receive payments.');
  }
  return addr;
}

export const isShibName = (s: string) => /^[a-z0-9_-]+\.shib$/i.test(s.trim());

/**
 * .shib name -> address. Same resolvers as ShibWallet (src/lib/sns.ts), in the
 * same order: ShibWatch, then Shibariumscan, then the D3 DNS records.
 * Returns null when the name doesn't resolve.
 */
export async function resolveShibName(name: string, fetchFn: FetchLike = fetch): Promise<`0x${string}` | null> {
  const n = name.trim().toLowerCase();
  const tries: Array<() => Promise<string | null>> = [
    async () => {
      const r = await fetchFn(`https://shibwatch.vercel.app/api/name?q=${encodeURIComponent(n)}`, { signal: AbortSignal.timeout(8_000) });
      if (!r.ok) return null;
      const j = (await r.json()) as { owner?: string; registered?: boolean };
      return j.registered === false ? null : j.owner ?? null;
    },
    async () => {
      const r = await fetchFn(`https://shibariumscan.io/api/v2/search?q=${encodeURIComponent(n)}`, { signal: AbortSignal.timeout(8_000) });
      if (!r.ok) return null;
      const j = (await r.json()) as { items?: { type: string; address_hash?: string; ens_info?: { name: string } }[] };
      return j.items?.find((it) => it.type === 'ens_domain' && it.ens_info?.name?.toLowerCase() === n)?.address_hash ?? null;
    },
    async () => {
      for (const domain of ['vana', 'interstellar.xyz']) {
        for (const prefix of ['_w3addr', '_web3connect']) {
          const r = await fetchFn(
            `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(`${prefix}.${n}.${domain}`)}&type=TXT`,
            { signal: AbortSignal.timeout(8_000) },
          );
          if (!r.ok) continue;
          const j = (await r.json()) as { Status: number; Answer?: { type: number; data: string }[] };
          for (const a of j.Answer ?? []) {
            if (a.type !== 16) continue;
            const m = a.data.replace(/"/g, '').match(/^(?:BONE:|WALLET\.BONE=)(0x[0-9a-fA-F]{40})$/i);
            if (m) return m[1];
          }
        }
      }
      return null;
    },
  ];
  for (const t of tries) {
    try {
      const addr = await t();
      if (addr && isAddress(addr, { strict: false })) return getAddress(addr);
    } catch {
      // try the next resolver
    }
  }
  return null;
}
