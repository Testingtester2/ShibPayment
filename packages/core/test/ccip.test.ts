import { beforeAll, describe, expect, it } from 'vitest';
import { decodeAbiParameters, decodeEventLog, numberToHex, parseEther } from 'viem';
import { BURN_ADDRESS, CCIP_ROUTERS, getChain, getToken } from '@shibpay/chains';
import { mockCcipRouterAbi } from '../../contracts/src/artifacts';
import {
  BURN_FROM_CHAIN_IDS, CCIP_EXTRA_ARGS, InsufficientGasError, burnFromChain, burnableTokens, findBurnableBalances, quoteCcipBurn,
  type Eip1193Provider, type PayStep,
} from '../src';
import { startChain } from './ganache';

type Chain = Awaited<ReturnType<typeof startChain>>;

describe('the CCIP registry', () => {
  it('covers Ethereum and the 11 CCIP networks, and never Shibarium', () => {
    expect(BURN_FROM_CHAIN_IDS).toHaveLength(12);
    expect(BURN_FROM_CHAIN_IDS).not.toContain(109);
    for (const id of Object.keys(CCIP_ROUTERS).map(Number)) {
      expect(getChain(id), `chain ${id}`).toBeTruthy();
      expect(burnableTokens(id)).toEqual(['SHIB', 'BONE', 'LEASH']);
    }
    expect(burnableTokens(1)).toEqual(['SHIB', 'BONE', 'LEASH', 'TREAT']);
    expect(burnableTokens(109)).toEqual([]);
  });
});

describe('bridge and burn through CCIP (in-process EVM posing as Base)', () => {
  let c: Chain;
  beforeAll(async () => {
    c = await startChain(8453, { splitter: false });
    await c.mint(c.buyer, parseEther('500000'), 'BONE');
    await c.mint(c.buyer, parseEther('500000'), 'LEASH');
  });

  const sentEvents = async (hash: `0x${string}`) => {
    const r = await c.pub.getTransactionReceipt({ hash });
    return r.logs.filter((l) => l.address.toLowerCase() === c.router!.toLowerCase())
      .map((l) => decodeEventLog({ abi: mockCcipRouterAbi, data: l.data, topics: l.topics }).args as unknown as {
        destinationChainSelector: bigint; receiver: `0x${string}`; token: string; amount: bigint; fee: bigint; extraArgs: string;
      });
  };

  it('finds what the wallet holds on each network, and flags networks it could not read', async () => {
    const found = await findBurnableBalances(c.buyer, (id) => {
      if (id === 8453) return c.pub as never;
      return { readContract: () => Promise.reject(new Error('offline')), getBalance: () => Promise.reject(new Error('offline')) };
    });
    const base = found.find((f) => f.chainId === 8453)!;
    expect(base.tokens.map((t) => t.token)).toEqual(['SHIB', 'BONE', 'LEASH']);
    expect(base.native).toBeGreaterThan(0n);
    expect(found.find((f) => f.chainId === 10)).toMatchObject({ tokens: [], error: 'offline' });
  });

  it('approves the router, then sends to 0x...dEaD on Ethereum, paying the fee in ETH', async () => {
    const steps: PayStep[] = [];
    const [b0, r0, eth0] = [await c.balance(c.buyer), await c.balance(c.router!), await c.pub.getBalance({ address: c.buyer })];
    const res = await burnFromChain({
      provider: c.provider, chainId: 8453, items: [{ token: 'SHIB', amount: parseEther('1000') }], onStep: (s) => steps.push(s),
    });
    expect(steps).toEqual(['connecting', 'switching-chain', 'approving', 'paying', 'confirming']);
    expect(res).toMatchObject({ via: 'ccip', fee: parseEther('0.001'), payer: c.buyer });
    expect(res.hashes).toHaveLength(1);
    expect(b0 - await c.balance(c.buyer)).toBe(parseEther('1000'));
    expect(await c.balance(c.router!) - r0).toBe(parseEther('1000'));
    expect(eth0 - await c.pub.getBalance({ address: c.buyer })).toBeGreaterThan(parseEther('0.001'));

    const [ev] = await sentEvents(res.hashes[0]);
    expect(ev.destinationChainSelector).toBe(5009297550715157269n);
    expect(decodeAbiParameters([{ type: 'address' }], ev.receiver)[0]).toBe(BURN_ADDRESS);
    expect(ev.token).toBe(getToken(8453, 'SHIB')!.address);
    expect(ev.fee).toBe(parseEther('0.001'));
    expect(ev.extraArgs).toBe(CCIP_EXTRA_ARGS);

    // Already approved: no second approval.
    await c.walletOf(c.buyer).writeContract({
      address: getToken(8453, 'SHIB')!.address, abi: [{ type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] }],
      functionName: 'approve', args: [c.router!, parseEther('5000')],
    });
    const again: PayStep[] = [];
    await burnFromChain({ provider: c.provider, chainId: 8453, items: [{ token: 'SHIB', amount: parseEther('10') }], onStep: (s) => again.push(s) });
    expect(again).not.toContain('approving');
  });

  it('does a whole network in one confirmation when the wallet can bundle (EIP-5792)', async () => {
    const sent: { to: string; value: string }[][] = [];
    let hashes: string[] = [];
    const batching: Eip1193Provider = {
      request: async ({ method, params }) => {
        if (method === 'wallet_getCapabilities') return { [numberToHex(8453)]: { atomic: { status: 'supported' } } };
        if (method === 'wallet_sendCalls') {
          const [{ calls, from }] = params as [{ calls: { to: string; data: string; value: string }[]; from: string }];
          sent.push(calls.map(({ to, value }) => ({ to, value })));
          hashes = [];
          for (const call of calls) hashes.push((await c.provider.request({ method: 'eth_sendTransaction', params: [{ from, ...call }] })) as string);
          return { id: 'b' };
        }
        if (method === 'wallet_getCallsStatus') return { status: 200, receipts: hashes.map((transactionHash) => ({ transactionHash, status: '0x1' })) };
        return c.provider.request({ method, params });
      },
    };
    const steps: PayStep[] = [];
    const [bone0, leash0] = [await c.balance(c.router!, 'BONE'), await c.balance(c.router!, 'LEASH')];
    const res = await burnFromChain({
      provider: batching, chainId: 8453, onStep: (s) => steps.push(s),
      items: [{ token: 'BONE', amount: parseEther('7') }, { token: 'LEASH', amount: parseEther('3') }, { token: 'SHIB', amount: 0n }],
    });
    expect(steps).toEqual(['connecting', 'switching-chain', 'approve-and-pay', 'confirming']);
    expect(sent).toHaveLength(1);
    const router = CCIP_ROUTERS[8453];
    expect(sent[0]).toEqual([
      { to: getToken(8453, 'BONE')!.address, value: '0x0' },
      { to: router, value: numberToHex(parseEther('0.001')) },
      { to: getToken(8453, 'LEASH')!.address, value: '0x0' },
      { to: router, value: numberToHex(parseEther('0.001')) },
    ]);
    expect(res.fee).toBe(parseEther('0.002'));
    expect(await c.balance(c.router!, 'BONE') - bone0).toBe(parseEther('7'));
    expect(await c.balance(c.router!, 'LEASH') - leash0).toBe(parseEther('3'));
  });

  it("falls back to the router's default extraArgs if a lane refuses ours", async () => {
    const admin = c.walletOf(c.deployer);
    await c.pub.waitForTransactionReceipt({ hash: await admin.writeContract({ address: c.router!, abi: mockCcipRouterAbi, functionName: 'setRefusedTag', args: ['0x181dcf10'] }) });
    expect((await quoteCcipBurn(c.pub, 8453, [{ token: 'SHIB', amount: 1n }])).extraArgs).toBe('0x');
    const res = await burnFromChain({ provider: c.provider, chainId: 8453, items: [{ token: 'SHIB', amount: parseEther('5') }] });
    expect((await sentEvents(res.hashes[0]))[0].extraArgs).toBe('0x');
    await c.pub.waitForTransactionReceipt({ hash: await admin.writeContract({ address: c.router!, abi: mockCcipRouterAbi, functionName: 'setRefusedTag', args: ['0x00000000'] }) });
  });

  it('stops before sending when there is not enough gas coin for the fee, or not enough tokens', async () => {
    await c.mint(c.stranger, parseEther('100'));
    await c.provider.request({ method: 'evm_setAccountBalance', params: [c.stranger, numberToHex(parseEther('0.0005'))] });
    const asStranger: Eip1193Provider = {
      request: ({ method, params }) => (method === 'eth_requestAccounts' || method === 'eth_accounts' ? Promise.resolve([c.stranger]) : c.provider.request({ method, params })),
    };
    await expect(burnFromChain({ provider: asStranger, chainId: 8453, items: [{ token: 'SHIB', amount: parseEther('100') }] }))
      .rejects.toBeInstanceOf(InsufficientGasError);
    await expect(burnFromChain({ provider: c.provider, chainId: 8453, items: [{ token: 'SHIB', amount: parseEther('1000000000') }] }))
      .rejects.toThrow(/Not enough SHIB on Base/);
  });

  it('refuses what CCIP cannot burn', async () => {
    await expect(burnFromChain({ provider: c.provider, chainId: 8453, items: [{ token: 'TREAT', amount: 1n }] })).rejects.toThrow(/can't be burned from Base/);
    await expect(burnFromChain({ provider: c.provider, chainId: 109, items: [{ token: 'SHIB', amount: 1n }] })).rejects.toThrow(/not supported/);
    await expect(burnFromChain({ provider: c.provider, chainId: 8453, items: [{ token: 'SHIB', amount: 0n }] })).rejects.toThrow(/Nothing to burn/);
  });
});

describe('burning from Ethereum itself goes straight to 0x...dEaD', () => {
  it('sends each token to the dead address', async () => {
    const c = await startChain(1, { splitter: false });
    await c.mint(c.buyer, parseEther('50'), 'TREAT');
    const [s0, t0] = [await c.balance(BURN_ADDRESS), await c.balance(BURN_ADDRESS, 'TREAT')];
    const res = await burnFromChain({
      provider: c.provider, chainId: 1, items: [{ token: 'SHIB', amount: parseEther('200') }, { token: 'TREAT', amount: parseEther('50') }],
    });
    expect(res).toMatchObject({ via: 'direct', fee: 0n });
    expect(res.hashes).toHaveLength(2);
    expect(await c.balance(BURN_ADDRESS) - s0).toBe(parseEther('200'));
    expect(await c.balance(BURN_ADDRESS, 'TREAT') - t0).toBe(parseEther('50'));
  });
});
