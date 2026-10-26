// Deploys ShibPaySplitter to one or more chains through the CREATE2 deployer,
// so it lands at the same address everywhere. Safe to re-run: chains where
// the contract already exists are skipped.
//
//   PRIVATE_KEY=0x... npm run deploy -w @shibpay/contracts -- shibarium ethereum
//   PRIVATE_KEY=0x... npm run deploy -w @shibpay/contracts -- all
//
// The deployer key only pays gas. It gets no rights over the contract, which
// has no owner.

import fs from 'node:fs';
import { createPublicClient, createWalletClient, http, concat, defineChain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { EVM_CHAINS } from '../../chains/src/index.ts';

const art = JSON.parse(fs.readFileSync(new URL('../artifacts.json', import.meta.url), 'utf8'));
const keys = process.argv.slice(2);
if (!process.env.PRIVATE_KEY || keys.length === 0) {
  console.error('Usage: PRIVATE_KEY=0x... npm run deploy -w @shibpay/contracts -- <chain key...|all>');
  console.error('Chain keys:', EVM_CHAINS.map((c) => c.key).join(', '));
  process.exit(1);
}
const targets = keys.includes('all') ? EVM_CHAINS : EVM_CHAINS.filter((c) => keys.includes(c.key));
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
