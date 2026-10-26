import { createPublicClient, defineChain, fallback, http, type Chain, type PublicClient } from 'viem';
import { getChain, type EvmChain } from '@shibpay/chains';

export function viemChain(c: EvmChain): Chain {
  return defineChain({
    id: c.chainId,
    name: c.name,
    nativeCurrency: { name: c.nativeSymbol, symbol: c.nativeSymbol, decimals: 18 },
    rpcUrls: { default: { http: c.rpcUrls } },
    blockExplorers: { default: { name: c.name, url: c.explorerUrl } },
  });
}

const cache = new Map<number, PublicClient>();

/** A read-only client over the chain's public RPCs, with fallbacks. */
export function publicClientFor(chainId: number): PublicClient {
  const hit = cache.get(chainId);
  if (hit) return hit;
  const c = getChain(chainId);
  if (!c) throw new Error(`Unsupported chain ${chainId}`);
  const client = createPublicClient({
    chain: viemChain(c),
    transport: fallback(c.rpcUrls.map((u) => http(u, { timeout: 10_000 }))),
  }) as PublicClient;
  cache.set(chainId, client);
  return client;
}
