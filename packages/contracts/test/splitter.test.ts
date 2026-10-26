import { beforeAll, describe, expect, it } from 'vitest';
import { decodeEventLog, parseEther, zeroAddress } from 'viem';
import { BURN_ADDRESS } from '@shibpay/chains';
import { SPLITTER_ADDRESS, splitterAbi } from '@shibpay/contracts';
import { testTokenAbi } from '../src/artifacts';
import { startChain, SHIB } from '../../core/test/ganache';

type Chain = Awaited<ReturnType<typeof startChain>>;
const ORDER = `0x${'ab'.repeat(32)}` as const;

describe('ShibPaySplitter', () => {
  let c: Chain;
  beforeAll(async () => {
    c = await startChain();
  });

  async function approveAndPay(amount: bigint, burnBps: number, from = c.buyer, merchant = c.merchant) {
    const w = c.walletOf(from);
    await c.pub.waitForTransactionReceipt({
      hash: await w.writeContract({ address: SHIB, abi: testTokenAbi, functionName: 'approve', args: [SPLITTER_ADDRESS, amount] }),
    });
    const hash = await w.writeContract({
      address: SPLITTER_ADDRESS, abi: splitterAbi, functionName: 'pay', args: [SHIB, merchant, amount, burnBps, ORDER],
    });
    return c.pub.waitForTransactionReceipt({ hash });
  }

  it('sends the burn share to 0x...dEaD and the rest to the merchant', async () => {
    const [m0, b0] = [await c.balance(c.merchant), await c.balance(BURN_ADDRESS)];
    const r = await approveAndPay(parseEther('1000'), 250); // 2.5%
    expect(await c.balance(c.merchant) - m0).toBe(parseEther('975'));
    expect(await c.balance(BURN_ADDRESS) - b0).toBe(parseEther('25'));
    expect(await c.balance(SPLITTER_ADDRESS)).toBe(0n);

    const ev = r.logs.filter((l) => l.address.toLowerCase() === SPLITTER_ADDRESS.toLowerCase())
      .map((l) => decodeEventLog({ abi: splitterAbi, data: l.data, topics: l.topics }))[0];
    expect(ev.eventName).toBe('Paid');
    expect(ev.args).toMatchObject({ orderId: ORDER, amount: parseEther('1000'), burned: parseEther('25'), token: SHIB });
  });

  it('handles 0% and 100% burns', async () => {
    const m0 = await c.balance(c.merchant);
    await approveAndPay(100n, 0);
    expect(await c.balance(c.merchant) - m0).toBe(100n);

    const [m1, b1] = [await c.balance(c.merchant), await c.balance(BURN_ADDRESS)];
    await approveAndPay(100n, 10_000);
    expect(await c.balance(c.merchant)).toBe(m1);
    expect(await c.balance(BURN_ADDRESS) - b1).toBe(100n);
  });

  it('rounds the burn down, so dust goes to the merchant', async () => {
    const [m0, b0] = [await c.balance(c.merchant), await c.balance(BURN_ADDRESS)];
    await approveAndPay(199n, 50); // 0.5% of 199 = 0.995 -> 0
    expect(await c.balance(BURN_ADDRESS) - b0).toBe(0n);
    expect(await c.balance(c.merchant) - m0).toBe(199n);
  });

  it('rejects bad input', async () => {
    // simulate = eth_call, which surfaces the contract's custom error by name
    const call = (args: readonly [`0x${string}`, `0x${string}`, bigint, number, `0x${string}`]) =>
      c.pub.simulateContract({ account: c.buyer, address: SPLITTER_ADDRESS, abi: splitterAbi, functionName: 'pay', args });
    await expect(call([SHIB, c.merchant, 1n, 10_001, ORDER])).rejects.toThrow(/InvalidBurn/);
    await expect(call([SHIB, zeroAddress, 1n, 0, ORDER])).rejects.toThrow(/InvalidMerchant/);
    await expect(call([SHIB, BURN_ADDRESS, 1n, 0, ORDER])).rejects.toThrow(/InvalidMerchant/);
    await expect(call([SHIB, c.merchant, 0n, 0, ORDER])).rejects.toThrow(/ZeroAmount/);
    await expect(call([c.stranger, c.merchant, 1n, 0, ORDER])).rejects.toThrow(/NotAContract/);
    await expect(call([SHIB, c.merchant, parseEther('1'), 0, ORDER])).rejects.toThrow(/TransferFailed/); // no allowance
  });

  it("cannot spend someone else's approval", async () => {
    const w = c.walletOf(c.buyer);
    await c.pub.waitForTransactionReceipt({
      hash: await w.writeContract({ address: SHIB, abi: testTokenAbi, functionName: 'approve', args: [SPLITTER_ADDRESS, parseEther('500')] }),
    });
    // The stranger tries to route the buyer's approval to themselves: the splitter pulls from msg.sender (the stranger).
    await expect(
      c.pub.simulateContract({
        account: c.stranger, address: SPLITTER_ADDRESS, abi: splitterAbi, functionName: 'pay',
        args: [SHIB, c.stranger, parseEther('500'), 0, ORDER],
      }),
    ).rejects.toThrow(/TransferFailed/);
  });

  it('splits native coin payments', async () => {
    const before = await c.pub.getBalance({ address: BURN_ADDRESS });
    const m0 = await c.pub.getBalance({ address: c.merchant });
    const hash = await c.walletOf(c.buyer).writeContract({
      address: SPLITTER_ADDRESS, abi: splitterAbi, functionName: 'payNative', args: [c.merchant, 1000, ORDER], value: parseEther('10'),
    });
    await c.pub.waitForTransactionReceipt({ hash });
    expect(await c.pub.getBalance({ address: BURN_ADDRESS }) - before).toBe(parseEther('1'));
    expect(await c.pub.getBalance({ address: c.merchant }) - m0).toBe(parseEther('9'));
    expect(await c.pub.getBalance({ address: SPLITTER_ADDRESS })).toBe(0n);
  });
});
