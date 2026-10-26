// The WooCommerce plugin's PHP, run against the same in-process chain as the
// SDK's tests and held to the same answers as verifyPayment().
import { execFile, spawnSync } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeEventTopics, getAddress, keccak256, parseEther, toHex } from 'viem';
import { splitterAbi } from '@shibpay/contracts';
import { payWithWallet, verifyPayment, type Eip1193Provider } from '@shibpay/core';
import { startChain } from '../../../packages/core/test/ganache';

const harness = fileURLToPath(new URL('./php/harness.php', import.meta.url));
const hasPhp = spawnSync('php', ['-v']).status === 0;

/** Runs a job through the PHP harness. Async, so this process can keep answering its RPC calls. */
function php(job: object): Promise<any> {
  const env = { ...process.env, no_proxy: '127.0.0.1', NO_PROXY: '127.0.0.1' }; // the local chain, never through a proxy
  return new Promise((resolve, reject) => {
    const child = execFile('php', [harness], { env }, (err, out) => (err ? reject(err) : resolve(JSON.parse(out))));
    child.stdin!.end(JSON.stringify(job));
  });
}

/** Serves an EIP-1193 provider as a JSON-RPC endpoint, as a public RPC would. */
async function serve(provider: Eip1193Provider) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      const { id, method, params } = JSON.parse(body);
      let reply: object;
      try {
        reply = { jsonrpc: '2.0', id, result: (await provider.request({ method, params })) ?? null };
      } catch (e) {
        reply = { jsonrpc: '2.0', id, error: { code: -32000, message: String((e as Error).message) } };
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(reply));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
}

const TAG = 1234n * 10n ** 12n;

describe.skipIf(!hasPhp)('WooCommerce plugin (PHP)', () => {
  it('hashes like viem: keccak256, EIP-55 checksums, the Paid event topic', async () => {
    const inputs = ['', 'abc', 'A-1017', 'a'.repeat(135), 'b'.repeat(136), 'c'.repeat(137), 'ünïcødé ✓', 'x'.repeat(1000)];
    expect(await php({ op: 'keccak', data: inputs })).toEqual(inputs.map((s) => keccak256(toHex(s))));
    expect((await php({ op: 'keccak', data: ['Paid(bytes32,address,address,address,uint256,uint256)'] }))[0])
      .toBe(encodeEventTopics({ abi: splitterAbi, eventName: 'Paid' })[0]);

    const addrs = ['0x95ad61b0a150d79219dcf64e1e6cc01f0b64c4ce', '0x495EEA66B0F8B636D441DC6A98D8F5C3D455C4C0', '0x000000000000000000000000000000000000dead'];
    expect(await php({ op: 'checksum', data: addrs })).toEqual(addrs.map((a) => getAddress(a)));
    // A mixed-case address with a wrong checksum is a typo, not an address.
    expect(await php({ op: 'checksum', data: ['0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cf', '0x123'] })).toEqual([null, null]);
  });

  it('does uint256 sums on decimal strings', async () => {
    const big = 2n ** 256n - 1n;
    expect(await php({
      op: 'uint',
      cases: [
        ['from_hex', toHex(big)], ['from_hex', '0x0'], ['add', '999999999999999999999', '1'], ['mul', '123456789012345678901234567890', 200],
        ['div', '123456789012345678901234567890', 10000], ['cmp', '1000', '999'], ['cmp', '0010', '10'],
        ['parse', '1452380.95', 18], ['format', '1452380950000000000000000', 18, 2], ['format', '5', 18, 6],
        ['has_tag', (parseEther('1000') + TAG).toString(), 1234], ['has_tag', (parseEther('1000') + TAG).toString(), 4321],
        ['has_tag', (parseEther('0.01') + 7n * 10n ** 12n).toString(), 7],
      ],
    })).toEqual([
      big.toString(), '0', '1000000000000000000000', (123456789012345678901234567890n * 200n).toString(),
      (123456789012345678901234567890n / 10000n).toString(), 1, 0,
      '1452380950000000000000000', '1,452,380.95', '0',
      true, false, true,
    ]);
  });

  describe('on Ethereum, with the burn splitter', () => {
    let c: Awaited<ReturnType<typeof startChain>>;
    let rpc: Awaited<ReturnType<typeof serve>>;
    const verify = (tx: string, expected: object) => php({ op: 'verify', rpc: { 1: rpc.url }, tx, expected });

    beforeAll(async () => {
      c = await startChain(1);
      rpc = await serve(c.provider);
    });
    afterAll(() => rpc.close());

    it('accepts a plain transfer carrying the order tag, and nothing less', async () => {
      const amount = parseEther('1000') + TAG;
      const { hash } = await payWithWallet({ provider: c.provider, chainId: 1, token: 'SHIB', merchant: c.merchant, amount, burnBps: 0, orderId: '17' });
      const expected = { chainId: 1, token: 'SHIB' as const, merchant: c.merchant, minAmount: parseEther('990').toString(), burnBps: 0, orderId: '17', tag: 1234 };

      expect(await verify(hash, expected)).toMatchObject({ ok: false, retry: true, reason: 'Waiting for confirmations (1/2)' });
      await c.mine();
      const ts = await verifyPayment(c.pub, hash, { ...expected, amount: parseEther('990') });
      expect(ts.ok).toBe(true);
      expect(await verify(hash, expected)).toEqual({
        ok: true, payer: c.buyer.toLowerCase(), amount: amount.toString(), confirmations: 2, viaSplitter: false, burnMode: 'none', burned: '0', pledged: '0',
      });

      expect(await verify(hash, { ...expected, minAmount: parseEther('1001').toString() })).toMatchObject({ ok: false, retry: false, reason: 'Paid less than the price' });
      expect(await verify(hash, { ...expected, merchant: c.stranger })).toMatchObject({ ok: false, reason: 'That transaction does not pay this merchant' });
      expect(await verify(hash, { ...expected, tag: 4321 })).toMatchObject({ ok: false, review: true, amount: amount.toString() });
      expect(await verify(hash, { ...expected, notBefore: Math.floor(Date.now() / 1000) + 3600 }))
        .toMatchObject({ ok: false, retry: false, reason: 'That payment was made before this order was placed.' });
      expect(await verify(hash, { ...expected, minConfirmations: 5 })).toMatchObject({ ok: false, retry: true });
      // The splitter is live, so a shop that asked for a burn needs the burn in the payment.
      expect(await verify(hash, { ...expected, burnBps: 200 })).toMatchObject({ ok: false, reason: 'No burn payment to this merchant in that transaction' });
      expect(await verify('0x' + 'ab'.repeat(32), expected)).toMatchObject({ ok: false, retry: true, reason: 'Transaction not found yet' });
    });

    it('accepts a burn payment through the splitter for its own order only', async () => {
      const amount = parseEther('5000');
      const { hash } = await payWithWallet({ provider: c.provider, chainId: 1, token: 'SHIB', merchant: c.merchant, amount, burnBps: 200, orderId: 'A-1017' });
      await c.mine();
      const expected = { chainId: 1, token: 'SHIB', merchant: c.merchant, minAmount: amount.toString(), burnBps: 200, orderId: 'A-1017', tag: 1234 };
      expect(await verify(hash, expected)).toEqual({
        ok: true, payer: c.buyer.toLowerCase(), amount: amount.toString(), confirmations: 2, viaSplitter: true,
        burnMode: 'in-tx', burned: parseEther('100').toString(), pledged: '0',
      });
      expect(await verify(hash, { ...expected, orderId: 'A-1018' })).toMatchObject({ ok: false });
      expect(await verify(hash, { ...expected, burnBps: 300 })).toMatchObject({ ok: false, reason: 'Burned less than the merchant asked for' });
      expect(await verify(hash, { ...expected, minAmount: (amount + 1n).toString() })).toMatchObject({ ok: false, reason: 'Paid less than the price' });
    });

    it('runs WooCommerce orders: paid, waiting, used twice, wrong order, tampered amount', async () => {
      await c.mint(c.buyer, parseEther('5000000'));
      const now = Math.floor(Date.now() / 1000);
      const meta = (tag: number) => ({ _shibpay_tag: tag, _shibpay_merchant: c.merchant, _shibpay_burn_bps: 0, _shibpay_tokens: 'SHIB,BONE,LEASH,TREAT' });
      // R330 at R0.00033 per SHIB is 1,000,000 SHIB; the button rounds and adds the tag.
      const pay = async (shib: bigint) =>
        (await payWithWallet({ provider: c.provider, chainId: 1, token: 'SHIB', merchant: c.merchant, amount: shib, burnBps: 0, orderId: 'x' })).hash;
      const good = await pay(parseEther('1000000') + TAG);
      const cheap = await pay(parseEther('900000') + 5555n * 10n ** 12n);
      const fresh = await pay(parseEther('1000000') + 2222n * 10n ** 12n);
      await c.mine();

      const r = await php({
        op: 'orders', rpc: { 1: rpc.url }, currency: 'ZAR', prices: { SHIB: 0.00033 },
        orders: [
          { id: 101, total: '330.00', meta: meta(1234), created: now },
          { id: 102, total: '330.00', meta: meta(1234), created: now },
          { id: 103, total: '330.00', meta: meta(9999), created: now },
          { id: 104, total: '330.00', meta: meta(5555), created: now },
          { id: 105, total: '330.00', meta: meta(2222), created: now },
        ],
        calls: [
          { order: 101, tx: good, chain: 1, token: 'SHIB' },
          { order: 101, tx: good, chain: 1, token: 'SHIB' }, // the button and the return page both report it
          { order: 102, tx: good, chain: 1, token: 'SHIB' }, // someone else's payment
          { order: 103, tx: `https://etherscan.io/tx/${fresh}` }, // pasted link, wrong order's tag
          { order: 104, tx: cheap }, // bare hash, paid too little
          { order: 105, tx: fresh, chain: 1, token: 'SHIB' },
        ],
      });
      expect(r.answers.map((a: { status: string }) => a.status)).toEqual(['paid', 'paid', 'failed', 'review', 'failed', 'failed']);
      expect(r.answers[2].message).toMatch(/already been used/);
      expect(r.answers[4].message).toBe('That payment is less than the order total.');
      expect(r.answers[5].message).toMatch(/already been used/); // order 103 holds it for review
      expect(r.orders[101]).toMatchObject({ status: 'processing', tx: good, meta: { _shibpay_state: 'paid', _shibpay_chain: 1, _shibpay_token: 'SHIB' } });
      expect(r.orders[101].notes[0]).toMatch(/^Paid 1,000,000\.001234 SHIB on Ethereum/);
      expect(r.orders[102].status).toBe('pending');
      expect(r.orders[103]).toMatchObject({ status: 'on-hold', meta: { _shibpay_state: 'review', _shibpay_tx: fresh } });
      expect(r.orders[104].status).toBe('pending');

      // Not confirmed yet: the order waits and a recheck is scheduled; the recheck then marks it paid.
      const late = await pay(parseEther('1000000') + 3333n * 10n ** 12n);
      const job = {
        op: 'orders', rpc: { 1: rpc.url }, currency: 'ZAR', prices: { SHIB: 0.00033 },
        orders: [{ id: 201, total: '330.00', meta: meta(3333), created: now }],
        calls: [{ order: 201, tx: late, chain: 1, token: 'SHIB' }],
      };
      const waiting = await php(job);
      expect(waiting.answers[0].status).toBe('confirming');
      expect(waiting.orders[201].meta).toMatchObject({ _shibpay_state: 'confirming', _shibpay_tx: late, _shibpay_attempts: 1 });
      expect(waiting.cron).toEqual(['shibpay_recheck[201]']);
      await c.mine();
      const later = await php({ ...job, orders: [{ ...job.orders[0], meta: waiting.orders[201].meta }], calls: [{ call: 'recheck', order: 201 }] });
      expect(later.orders[201]).toMatchObject({ status: 'processing', tx: late });
    });
  });

  describe('elsewhere: the burn is the shop\'s pledge', () => {
    it('Shibarium: native BONE and SHIB with a 2% pledge', async () => {
      const c = await startChain(109);
      const rpc = await serve(c.provider);
      try {
        const bone = parseEther('12.5') + TAG;
        const b = await payWithWallet({ provider: c.provider, chainId: 109, token: 'BONE', merchant: c.merchant, amount: bone, burnBps: 200, orderId: '7' });
        const shib = parseEther('50000') + TAG;
        const s = await payWithWallet({ provider: c.provider, chainId: 109, token: 'SHIB', merchant: c.merchant, amount: shib, burnBps: 200, orderId: '7' });
        await c.mine();
        const verify = (tx: string, expected: object) => php({ op: 'verify', rpc: { 109: rpc.url }, tx, expected });
        const base = { chainId: 109, merchant: c.merchant, burnBps: 200, orderId: '7', tag: 1234 };
        expect(await verify(b.hash, { ...base, token: 'BONE', minAmount: parseEther('12').toString() })).toMatchObject({
          ok: true, burnMode: 'pledge', amount: bone.toString(), pledged: ((bone * 200n) / 10000n).toString(), payer: c.buyer.toLowerCase(),
        });
        expect(await verify(s.hash, { ...base, token: 'SHIB', minAmount: parseEther('50000').toString() })).toMatchObject({
          ok: true, burnMode: 'pledge', pledged: ((shib * 200n) / 10000n).toString(),
        });
        // A SHIB payment is not a BONE payment.
        expect(await verify(s.hash, { ...base, token: 'BONE', minAmount: '1' })).toMatchObject({ ok: false, reason: 'That transaction does not pay this merchant' });

        const now = Math.floor(Date.now() / 1000);
        const r = await php({
          op: 'orders', rpc: { 109: rpc.url }, currency: 'USD', prices: { SHIB: 0.0000125, BONE: 0.5 },
          orders: [{ id: 301, total: '0.62', meta: { _shibpay_tag: 1234, _shibpay_merchant: c.merchant, _shibpay_burn_bps: 200, _shibpay_tokens: 'SHIB' }, created: now }],
          calls: [{ order: 301, tx: s.hash, chain: 109, token: 'SHIB' }],
        });
        expect(r.answers[0].status).toBe('paid');
        expect(r.orders[301].notes[0]).toMatch(/burn pledge for this sale: 1,000\.000024 SHIB/);
        expect(r.pledged).toEqual({ SHIB: ((shib * 200n) / 10000n).toString() });
      } finally {
        rpc.close();
      }
    });
  });
});
