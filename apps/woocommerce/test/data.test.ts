// The plugin's network and token list is generated from @shibpay/chains, so the
// PHP side matches payments against exactly the SDK's addresses.
// Regenerate with: npm run data -w @shibpay/woocommerce
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { encodeEventTopics, getAddress } from 'viem';
import { BURN_ADDRESS, BURN_CHAIN_ID, COINGECKO_IDS, EVM_CHAINS, SOLANA_SHIB, sortChains } from '@shibpay/chains';
import { SOLANA_RPCS, solanaTxUrl } from '@shibpay/core';
import { SPLITTER_ADDRESS, splitterAbi } from '@shibpay/contracts';

const file = fileURLToPath(new URL('../shibpayment/data/chains.json', import.meta.url));

function pluginData() {
  return {
    note: 'Generated from @shibpay/chains by apps/woocommerce/test/data.test.ts. Do not edit by hand.',
    burnChainId: BURN_CHAIN_ID,
    burnAddress: BURN_ADDRESS,
    splitter: getAddress(SPLITTER_ADDRESS),
    paidTopic: encodeEventTopics({ abi: splitterAbi, eventName: 'Paid' })[0],
    coingeckoIds: COINGECKO_IDS,
    solana: { mint: SOLANA_SHIB.mint, rpcUrls: [...SOLANA_RPCS], explorerUrl: solanaTxUrl('').replace(/\/tx\/$/, '') },
    chains: sortChains(EVM_CHAINS).map((c) => ({
      chainId: c.chainId,
      name: c.name,
      rpcUrls: c.rpcUrls,
      explorerUrl: c.explorerUrl,
      tokens: c.tokens.map((t) => ({ symbol: t.symbol, address: t.address, decimals: t.decimals, ...(t.native ? { native: true } : {}) })),
    })),
  };
}

describe('WooCommerce plugin data', () => {
  it('matches @shibpay/chains', () => {
    const want = JSON.stringify(pluginData(), null, 2) + '\n';
    if (process.env.UPDATE_PLUGIN_DATA) fs.writeFileSync(file, want);
    expect(fs.readFileSync(file, 'utf8'), 'Run: npm run data -w @shibpay/woocommerce').toBe(want);
  });
});
