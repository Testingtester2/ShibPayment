// Shared in-process chain for the tests: a ganache EVM posing as Shibarium
// (chain 109), with the test token's code placed at the real SHIB address and
// the splitter's code at its real CREATE2 address, so the SDK runs unmodified.
import ganache from 'ganache';
import { createPublicClient, createWalletClient, custom, getAddress, parseEther, type PublicClient } from 'viem';
import { getToken } from '@shibpay/chains';
import { SPLITTER_ADDRESS, splitterAbi, splitterBytecode } from '@shibpay/contracts';
import { testTokenAbi, testTokenBytecode } from '../../contracts/src/artifacts';
import { viemChain } from '../src/clients';
import { getChain } from '@shibpay/chains';
import type { Eip1193Provider } from '../src/pay';

export const SHIB = getToken(109, 'SHIB')!.address;

export async function startChain() {
  const raw = ganache.provider({
    logging: { quiet: true },
    chain: { chainId: 109, hardfork: 'shanghai' },
    wallet: { totalAccounts: 4, defaultBalance: 1000 },
  });
  // A wallet-shaped provider: ganache has no eth_requestAccounts.
  // Unknown wallet_ methods answer "unsupported" (4200), as real wallets do, and
  // transactions without a gas limit get an estimate, as wallets do (ganache
  // would otherwise use a fixed 90k).
  const provider: Eip1193Provider = {
    request: async ({ method, params }) => {
      if (method === 'wallet_sendTransaction') throw Object.assign(new Error('Unsupported method'), { code: 4200 });
      if (method === 'eth_requestAccounts') method = 'eth_accounts';
      if (method === 'eth_sendTransaction') {
        const [tx] = params as [Record<string, string>];
        if (!tx.gas) tx.gas = (await raw.request({ method: 'eth_estimateGas', params: [tx] } as never)) as string;
      }
      try {
        return await raw.request({ method, params } as never);
      } catch (e) {
        // Reverts: report them like geth (code 3 + revert data) so viem decodes the custom error.
        const data = (e as { data?: unknown }).data;
        if (typeof data === 'string') throw Object.assign(new Error('execution reverted'), { code: 3, data });
        throw e;
      }
    },
  };
  const chain = viemChain(getChain(109)!);
  const pub = createPublicClient({ chain, transport: custom(provider), pollingInterval: 50 }) as PublicClient;
  const [buyer, merchant, stranger, deployer] = ((await provider.request({ method: 'eth_accounts' })) as string[]).map((a) => getAddress(a));
  const deployWallet = createWalletClient({ chain, transport: custom(provider), account: deployer });

  // Deploy each contract normally, then copy its runtime code to the real address.
  async function placeAt(abi: readonly unknown[], bytecode: `0x${string}`, at: `0x${string}`) {
    const hash = await deployWallet.deployContract({ abi: abi as never, bytecode });
    const r = await pub.waitForTransactionReceipt({ hash });
    const code = await pub.getCode({ address: r.contractAddress! });
    await provider.request({ method: 'evm_setAccountCode', params: [at, code] });
  }
  await placeAt(testTokenAbi, testTokenBytecode, SHIB);
  await placeAt(splitterAbi, splitterBytecode, SPLITTER_ADDRESS);

  const walletOf = (account: `0x${string}`) => createWalletClient({ chain, transport: custom(provider), account });
  const mint = async (to: `0x${string}`, amount: bigint) => {
    const hash = await walletOf(deployer).writeContract({ address: SHIB, abi: testTokenAbi, functionName: 'mint', args: [to, amount] });
    await pub.waitForTransactionReceipt({ hash });
  };
  const balance = (who: `0x${string}`) =>
    pub.readContract({ address: SHIB, abi: testTokenAbi, functionName: 'balanceOf', args: [who] }) as Promise<bigint>;
  const mine = (n = 1) => Promise.all(Array.from({ length: n }, () => provider.request({ method: 'evm_mine' })));

  await mint(buyer, parseEther('1000000'));
  return { provider, pub, buyer, merchant, stranger, walletOf, mint, balance, mine };
}
