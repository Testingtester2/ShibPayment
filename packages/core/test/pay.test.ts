import { beforeAll, describe, expect, it } from 'vitest';
import { parseEther } from 'viem';
import { BURN_ADDRESS } from '@shibpay/chains';
import { findPayment, payWithWallet, verifyPayment, type PayStep } from '../src';
import { startChain, SHIB } from './ganache';

type Chain = Awaited<ReturnType<typeof startChain>>;

describe('paying and verifying end to end (in-process EVM posing as Shibarium)', () => {
  let c: Chain;
  beforeAll(async () => {
    c = await startChain();
  });

  it('pays with a 2% burn through the splitter: approve, pay, verify', async () => {
    const steps: PayStep[] = [];
    const [m0, b0] = [await c.balance(c.merchant), await c.balance(BURN_ADDRESS)];
    const res = await payWithWallet({
      provider: c.provider, chainId: 109, token: 'SHIB', merchant: c.merchant,
      amount: parseEther('5000'), burnBps: 200, orderId: 'order-1', onStep: (s) => steps.push(s),
    });
    expect(steps).toEqual(['connecting', 'switching-chain', 'approving', 'paying', 'confirming']);
    expect(await c.balance(c.merchant) - m0).toBe(parseEther('4900'));
    expect(await c.balance(BURN_ADDRESS) - b0).toBe(parseEther('100'));

    const expected = { chainId: 109, token: 'SHIB' as const, merchant: c.merchant, amount: parseEther('5000'), burnBps: 200, orderId: 'order-1' };
    expect(await verifyPayment(c.pub, res.hash, expected)).toMatchObject({ ok: false, retry: true }); // 1 confirmation so far
    await c.mine();
    expect(await verifyPayment(c.pub, res.hash, expected)).toMatchObject({
      ok: true, viaSplitter: true, payer: c.buyer, amount: parseEther('5000'), burned: parseEther('100'),
    });

    // Every way of lying about the payment fails.
    expect(await verifyPayment(c.pub, res.hash, { ...expected, orderId: 'order-2' })).toMatchObject({ ok: false });
    expect(await verifyPayment(c.pub, res.hash, { ...expected, amount: parseEther('5001') })).toMatchObject({ ok: false, reason: 'Paid less than the price' });
    expect(await verifyPayment(c.pub, res.hash, { ...expected, burnBps: 300 })).toMatchObject({ ok: false, reason: 'Burned less than the merchant asked for' });
    expect(await verifyPayment(c.pub, res.hash, { ...expected, merchant: c.stranger })).toMatchObject({ ok: false });

    expect(await findPayment({ client: c.pub, chainId: 109, token: 'SHIB', merchant: c.merchant, amount: 1n, orderId: 'order-1', fromBlock: 0n }))
      .toBe(res.hash);
  });

  it('pays with no burn as one plain transfer (no approval, no contract)', async () => {
    const steps: PayStep[] = [];
    const amount = parseEther('123.45') + 4321n * 10n ** 12n; // tagged amount
    const res = await payWithWallet({
      provider: c.provider, chainId: 109, token: 'SHIB', merchant: c.merchant, amount, burnBps: 0, orderId: 'order-3',
      onStep: (s) => steps.push(s),
    });
    expect(steps).not.toContain('approving');
    const tx = await c.pub.getTransaction({ hash: res.hash });
    expect(tx.to?.toLowerCase()).toBe(SHIB.toLowerCase());
    await c.mine();

    const expected = { chainId: 109, token: 'SHIB' as const, merchant: c.merchant, amount, burnBps: 0 };
    expect(await verifyPayment(c.pub, res.hash, expected)).toMatchObject({ ok: true, viaSplitter: false, amount });
    // A merchant who asked for a burn does not accept a plain transfer.
    expect(await verifyPayment(c.pub, res.hash, { ...expected, burnBps: 100 })).toMatchObject({ ok: false });
    // Found by its unique tagged amount, for buyers who paid by QR.
    expect(await findPayment({ client: c.pub, chainId: 109, token: 'SHIB', merchant: c.merchant, amount, orderId: 'order-3', fromBlock: 0n }))
      .toBe(res.hash);
  });

  it('pays native BONE, with and without a burn', async () => {
    const b0 = await c.pub.getBalance({ address: BURN_ADDRESS });
    const withBurn = await payWithWallet({
      provider: c.provider, chainId: 109, token: 'BONE', merchant: c.merchant, amount: parseEther('20'), burnBps: 500, orderId: 'order-4',
    });
    expect(await c.pub.getBalance({ address: BURN_ADDRESS }) - b0).toBe(parseEther('1'));
    const plain = await payWithWallet({
      provider: c.provider, chainId: 109, token: 'BONE', merchant: c.merchant, amount: parseEther('3'), burnBps: 0, orderId: 'order-5',
    });
    await c.mine();
    const base = { chainId: 109, token: 'BONE' as const, merchant: c.merchant };
    expect(await verifyPayment(c.pub, withBurn.hash, { ...base, amount: parseEther('20'), burnBps: 500, orderId: 'order-4' }))
      .toMatchObject({ ok: true, burned: parseEther('1') });
    expect(await verifyPayment(c.pub, plain.hash, { ...base, amount: parseEther('3'), burnBps: 0 })).toMatchObject({ ok: true });
    expect(await verifyPayment(c.pub, plain.hash, { ...base, amount: parseEther('3.1'), burnBps: 0 })).toMatchObject({ ok: false });
  });

  it('stops before sending when the buyer cannot afford it', async () => {
    await expect(payWithWallet({
      provider: c.provider, chainId: 109, token: 'SHIB', merchant: c.merchant, amount: parseEther('1000000000'), burnBps: 200, orderId: 'big',
    })).rejects.toThrow(/Not enough SHIB on Shibarium/);
  });

  it('refuses tokens a chain does not have', async () => {
    await expect(payWithWallet({
      provider: c.provider, chainId: 8453, token: 'TREAT', merchant: c.merchant, amount: 1n, burnBps: 0, orderId: 'x',
    })).rejects.toThrow(/not available/);
  });
});
