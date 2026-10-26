// Deploys ShibPaySplitter on Ethereum through the CREATE2 deployer, so it
// lands at its fixed address. Ethereum is the only chain where burns count, so
// it is the only chain the checkout burns on; other chains never need it.
// Safe to re-run: skipped when the contract already exists.
//
//   PRIVATE_KEY=0x... npm run deploy -w @shibpay/contracts
//
// The deployer key only pays gas. It gets no rights over the contract, which
// has no owner.

import fs from 'node:fs';
import { createPublicClient, createWalletClient, http, concat, defineChain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { BURN_CHAIN_ID, EVM_CHAINS } from '../../chains/src/index.ts';

const art = JSON.parse(fs.readFileSync(new URL('../artifacts.json', import.meta.url), 'utf8'));
if (!process.env.PRIVATE_KEY) {
  console.error('Usage: PRIVATE_KEY=0x... npm run deploy -w @shibpay/contracts');
  process.exit(1);
}
const targets = EVM_CHAINS.filter((c) => c.chainId === BURN_CHAIN_ID);
const account = privateKeyToAccount(process.env.PRIVATE_KEY);

for (const c of targets) {
  const chain = defineChain({
    id: c.chainId,
    name: c.name,
    nativeCurrency: { name: c.nativeSymbol, symbol: c.nativeSymbol, decimals: 18 },
    rpcUrls: { default: { http: c.rpcUrls } },
  });
  const pub = createPublicClient({ chain, transport: http(c.rpcUrls[0]) });
  const wallet = createWalletClient({ chain, account, transport: http(c.rpcUrls[0]) });
  try {
    if ((await pub.getCode({ address: art.splitterAddress }))?.length > 2) {
      console.log(`${c.name}: already deployed at ${art.splitterAddress}`);
      continue;
    }
    if (!((await pub.getCode({ address: art.CREATE2_DEPLOYER }))?.length > 2)) {
      console.log(`${c.name}: CREATE2 deployer missing on this chain, skipped`);
      continue;
    }
    const hash = await wallet.sendTransaction({
      to: art.CREATE2_DEPLOYER,
      data: concat([art.SALT, art.splitter.bytecode]),
    });
    await pub.waitForTransactionReceipt({ hash });
    const ok = (await pub.getCode({ address: art.splitterAddress }))?.length > 2;
    console.log(`${c.name}: ${ok ? 'deployed' : 'FAILED'} ${art.splitterAddress} (tx ${hash})`);
  } catch (err) {
    console.log(`${c.name}: error, ${err.shortMessage ?? err.message}`);
  }
}
