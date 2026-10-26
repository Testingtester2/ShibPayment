import { beforeAll, describe, expect, it } from 'vitest';
import { parseEther } from 'viem';
import { BURN_ADDRESS } from '@shibpay/chains';
import { burnOnEthereum, findPayment, payWithWallet, verifyPayment, type PayStep } from '../src';
import { startChain } from './ganache';

type Chain = Awaited<ReturnType<typeof startChain>>;

describe('Ethereum: the burn happens in the payment (in-process EVM posing as Ethereum)', () => {
  let c: Chain;
  beforeAll(async () => {
    c = await startChain(1);
  });

  it('pays with a 2% burn through the splitter: approve, pay, verify', async () => {
    const steps: PayStep[] = [];
    const [m0, b0] = [await c.balance(c.merchant), await c.balance(BURN_ADDRESS)];
    const res = await payWithWallet({
      provider: c.provider, chainId: 1, token: 'SHIB', merchant: c.merchant,
      amount: parseEther('5000'), burnBps: 200, orderId: 'order-1', onStep: (s) => steps.push(s),
    });
    expect(steps).toEqual(['connecting', 'switching-chain', 'approving', 'paying', 'confirming']);
    expect(res).toMatchObject({ burnMode: 'in-tx', burned: parseEther('100'), pledged: 0n });
    expect(await c.balance(c.merchant) - m0).toBe(parseEther('4900'));
    expect(await c.balance(BURN_ADDRESS) - b0).toBe(parseEther('100'));

    const expected = { chainId: 1, token: 'SHIB' as const, merchant: c.merchant, amount: parseEther('5000'), burnBps: 200, orderId: 'order-1' };
    expect(await verifyPayment(c.pub, res.hash, expected)).toMatchObject({ ok: false, retry: true }); // 1 confirmation so far
    await c.mine();
    expect(await verifyPayment(c.pub, res.hash, expected)).toMatchObject({
      ok: true, viaSplitter: true, burnMode: 'in-tx', payer: c.buyer, amount: parseEther('5000'), burned: parseEther('100'), pledged: 0n,
    });

    // Every way of lying about the payment fails.
    expect(await verifyPayment(c.pub, res.hash, { ...expected, orderId: 'order-2' })).toMatchObject({ ok: false });
    expect(await verifyPayment(c.pub, res.hash, { ...expected, amount: parseEther('5001') })).toMatchObject({ ok: false, reason: 'Paid less than the price' });
    expect(await verifyPayment(c.pub, res.hash, { ...expected, burnBps: 300 })).toMatchObject({ ok: false, reason: 'Burned less than the merchant asked for' });
    expect(await verifyPayment(c.pub, res.hash, { ...expected, merchant: c.stranger })).toMatchObject({ ok: false });

    expect(await findPayment({ client: c.pub, chainId: 1, token: 'SHIB', merchant: c.merchant, amount: 1n, orderId: 'order-1', fromBlock: 0n }))
      .toBe(res.hash);
  });

  it('pays with no burn as one plain transfer (no approval, no contract)', async () => {
    const steps: PayStep[] = [];
    const amount = parseEther('123.45') + 4321n * 10n ** 12n; // tagged amount
    const res = await payWithWallet({
      provider: c.provider, chainId: 1, token: 'SHIB', merchant: c.merchant, amount, burnBps: 0, orderId: 'order-3',
      onStep: (s) => steps.push(s),
    });
    expect(steps).not.toContain('approving');
    expect(res.burnMode).toBe('none');
    const tx = await c.pub.getTransaction({ hash: res.hash });
    expect(tx.to?.toLowerCase()).toBe(c.SHIB.toLowerCase());
    await c.mine();

    const expected = { chainId: 1, token: 'SHIB' as const, merchant: c.merchant, amount, burnBps: 0 };
    expect(await verifyPayment(c.pub, res.hash, expected)).toMatchObject({ ok: true, viaSplitter: false, burnMode: 'none', amount });
    // On Ethereum with the splitter live, a merchant who asked for a burn does not accept a plain transfer.
    expect(await verifyPayment(c.pub, res.hash, { ...expected, burnBps: 100 })).toMatchObject({ ok: false });
    // Found by its unique tagged amount, for buyers who paid by QR.
    expect(await findPayment({ client: c.pub, chainId: 1, token: 'SHIB', merchant: c.merchant, amount, orderId: 'order-3', fromBlock: 0n }))
      .toBe(res.hash);
  });

  it('lets a merchant burn their pledge on Ethereum from their own wallet', async () => {
    const b0 = await c.balance(BURN_ADDRESS);
    const res = await burnOnEthereum({ provider: c.provider, token: 'SHIB', amount: parseEther('250') });
    expect(res.burned).toBe(parseEther('250'));
    expect(await c.balance(BURN_ADDRESS) - b0).toBe(parseEther('250'));
    const tx = await c.pub.getTransaction({ hash: res.hash });
    expect(tx.to?.toLowerCase()).toBe(c.SHIB.toLowerCase());
    await expect(burnOnEthereum({ provider: c.provider, token: 'SHIB', amount: parseEther('1000000000') }))
      .rejects.toThrow(/Not enough SHIB on Ethereum/);
  });

  it('stops before sending when the buyer cannot afford it', async () => {
    await expect(payWithWallet({
      provider: c.provider, chainId: 1, token: 'SHIB', merchant: c.merchant, amount: parseEther('1000000000'), burnBps: 200, orderId: 'big',
    })).rejects.toThrow(/Not enough SHIB on Ethereum/);
  });

  it('refuses tokens a chain does not have', async () => {
    await expect(payWithWallet({
      provider: c.provider, chainId: 8453, token: 'TREAT', merchant: c.merchant, amount: 1n, burnBps: 0, orderId: 'x',
    })).rejects.toThrow(/not available/);
  });
});

describe('Ethereum before the splitter is deployed: the burn is a pledge', () => {
  it('pays the merchant in full and verifies as a pledge', async () => {
    const c = await startChain(1, { splitter: false });
    const m0 = await c.balance(c.merchant);
    const res = await payWithWallet({
      provider: c.provider, chainId: 1, token: 'SHIB', merchant: c.merchant, amount: parseEther('1000'), burnBps: 200, orderId: 'early',
    });
    expect(res).toMatchObject({ burnMode: 'pledge', burned: 0n, pledged: parseEther('20') });
    expect(await c.balance(c.merchant) - m0).toBe(parseEther('1000'));
    await c.mine();
    expect(await verifyPayment(c.pub, res.hash, { chainId: 1, token: 'SHIB', merchant: c.merchant, amount: parseEther('1000'), burnBps: 200 }))
      .toMatchObject({ ok: true, burnMode: 'pledge', burned: 0n, pledged: parseEther('20') });
  });
});

describe('Other chains: the merchant is paid in full and pledges the burn (posing as Shibarium)', () => {
  let c: Chain;
  beforeAll(async () => {
    c = await startChain(109, { splitter: false });
  });

  it('sends SHIB as a plain transfer even with a burn, and verifies the pledge', async () => {
    const steps: PayStep[] = [];
    const [m0, b0] = [await c.balance(c.merchant), await c.balance(BURN_ADDRESS)];
    const res = await payWithWallet({
      provider: c.provider, chainId: 109, token: 'SHIB', merchant: c.merchant,
      amount: parseEther('5000'), burnBps: 200, orderId: 'order-6', onStep: (s) => steps.push(s),
    });
    expect(steps).not.toContain('approving');
    expect(res).toMatchObject({ burnMode: 'pledge', burned: 0n, pledged: parseEther('100') });
    expect(await c.balance(c.merchant) - m0).toBe(parseEther('5000'));
    expect(await c.balance(BURN_ADDRESS)).toBe(b0); // nothing burned on a side chain

    await c.mine();
    const expected = { chainId: 109, token: 'SHIB' as const, merchant: c.merchant, amount: parseEther('5000'), burnBps: 200 };
    expect(await verifyPayment(c.pub, res.hash, expected))
      .toMatchObject({ ok: true, viaSplitter: false, burnMode: 'pledge', burned: 0n, pledged: parseEther('100') });
    expect(await verifyPayment(c.pub, res.hash, { ...expected, amount: parseEther('5001') })).toMatchObject({ ok: false, reason: 'Paid less than the price' });
    expect(await verifyPayment(c.pub, res.hash, { ...expected, merchant: c.stranger })).toMatchObject({ ok: false });
  });

  it('pays native BONE, with and without a burn', async () => {
    const m0 = await c.pub.getBalance({ address: c.merchant });
    const withBurn = await payWithWallet({
      provider: c.provider, chainId: 109, token: 'BONE', merchant: c.merchant, amount: parseEther('20'), burnBps: 500, orderId: 'order-4',
    });
    expect(withBurn).toMatchObject({ burnMode: 'pledge', pledged: parseEther('1') });
    expect(await c.pub.getBalance({ address: c.merchant }) - m0).toBe(parseEther('20'));
    const plain = await payWithWallet({
      provider: c.provider, chainId: 109, token: 'BONE', merchant: c.merchant, amount: parseEther('3'), burnBps: 0, orderId: 'order-5',
    });
    await c.mine();
    const base = { chainId: 109, token: 'BONE' as const, merchant: c.merchant };
    expect(await verifyPayment(c.pub, withBurn.hash, { ...base, amount: parseEther('20'), burnBps: 500 }))
      .toMatchObject({ ok: true, burnMode: 'pledge', pledged: parseEther('1') });
    expect(await verifyPayment(c.pub, plain.hash, { ...base, amount: parseEther('3'), burnBps: 0 })).toMatchObject({ ok: true, burnMode: 'none' });
    expect(await verifyPayment(c.pub, plain.hash, { ...base, amount: parseEther('3.1'), burnBps: 0 })).toMatchObject({ ok: false });
  });
});
