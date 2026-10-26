// SHIB on Solana in the WooCommerce plugin: the PHP side of Solana Pay, against
// a stand-in Solana RPC that answers with the jsonParsed shapes mainnet returns.
import { execFile, spawnSync } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SOLANA_SHIB, base58Decode, base58Encode } from '@shibpay/core';

const harness = fileURLToPath(new URL('./php/harness.php', import.meta.url));
const hasPhp = spawnSync('php', ['-v']).status === 0;

function php(job: object): Promise<any> {
  const env = { ...process.env, no_proxy: '127.0.0.1', NO_PROXY: '127.0.0.1' };
  return new Promise((resolve, reject) => {
    const child = execFile('php', [harness], { env }, (err, out) => (err ? reject(err) : resolve(JSON.parse(out))));
    child.stdin!.end(JSON.stringify(job));
  });
}

const rand = (n: number) => base58Encode(crypto.getRandomValues(new Uint8Array(n)));
const MINT = SOLANA_SHIB.mint;
const DECIMALS = 5;
const shib = (n: number) => BigInt(Math.round(n * 10 ** DECIMALS)).toString();

/** A Solana RPC holding a few transactions: finalized ones, and some only "confirmed" so far. */
function solanaRpc() {
  const finalized = new Map<string, object>();
  const confirmed = new Map<string, object>();
  const byReference = new Map<string, string>();
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const { id, method, params } = JSON.parse(body);
      let result: unknown = null;
      if (method === 'getAccountInfo' && params[0] === MINT) {
        result = { value: { owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', data: { parsed: { type: 'mint', info: { decimals: DECIMALS } } } } };
      } else if (method === 'getTransaction') {
        const sig = params[0];
        result = params[1].commitment === 'finalized' ? finalized.get(sig) ?? null : finalized.get(sig) ?? confirmed.get(sig) ?? null;
      } else if (method === 'getSignaturesForAddress') {
        const sig = byReference.get(params[0]);
        result = sig ? [{ signature: rand(64), err: { InstructionError: [0, 'x'] } }, { signature: sig, err: null }] : [];
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
    });
  });
  return { server, finalized, confirmed, byReference };
}

interface Pay { recipient: string; payer?: string; amount: string; reference?: string; err?: unknown; mint?: string; blockTime?: number }
function tx(p: Pay) {
  const payer = p.payer ?? rand(32);
  return {
    blockTime: p.blockTime ?? Math.floor(Date.now() / 1000),
    meta: {
      err: p.err ?? null,
      preTokenBalances: [
        { owner: payer, mint: MINT, uiTokenAmount: { amount: shib(10_000_000) } },
        { owner: p.recipient, mint: p.mint ?? MINT, uiTokenAmount: { amount: shib(5) } },
      ],
      postTokenBalances: [
        { owner: payer, mint: MINT, uiTokenAmount: { amount: (BigInt(shib(10_000_000)) - BigInt(p.amount)).toString() } },
        { owner: p.recipient, mint: p.mint ?? MINT, uiTokenAmount: { amount: (BigInt(shib(5)) + BigInt(p.amount)).toString() } },
      ],
    },
    transaction: {
      message: {
        accountKeys: [
          { pubkey: payer, signer: true, writable: true },
          { pubkey: rand(32), signer: false, writable: true },
          ...(p.reference ? [{ pubkey: p.reference, signer: false, writable: false }] : []),
        ],
      },
    },
  };
}

describe.skipIf(!hasPhp)('WooCommerce plugin: SHIB on Solana (PHP)', () => {
  const rpc = solanaRpc();
  let url = '';
  beforeAll(async () => {
    await new Promise<void>((r) => rpc.server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(rpc.server.address() as AddressInfo).port}`;
  });
  afterAll(() => rpc.server.close());

  it('reads and writes base58 like the SDK', async () => {
    const bytes = [new Uint8Array(32), Uint8Array.of(0, 0, 1, 2, 255), ...Array.from({ length: 20 }, () => crypto.getRandomValues(new Uint8Array(32))), crypto.getRandomValues(new Uint8Array(64))];
    const hex = bytes.map((b) => Buffer.from(b).toString('hex'));
    const b58 = bytes.map((b) => base58Encode(b));
    const r = await php({ op: 'base58', hex, b58, keys: [b58[2], rand(64), '0x' + 'a'.repeat(40), 'abc', MINT] });
    expect(r.encoded).toEqual(b58);
    expect(r.decoded).toEqual(hex);
    expect(r.keys).toEqual([true, false, false, false, true]);
    expect(r.sigs).toEqual([false, true, false, false, false]);
    expect(base58Decode(r.random)).toHaveLength(32);
  });

  it('runs Solana orders: paid by reference, pasted link, not final yet, untagged, underpaid, used twice', async () => {
    const shop = rand(32);
    const now = Math.floor(Date.now() / 1000);
    // $1.00 at $0.00001 per SHIB is 100,000 SHIB; 2% burn pledged.
    const order = (id: number, extra: object = {}) => ({
      id, total: '1.00', created: now,
      meta: { _shibpay_merchant: '0x8edc8Bb8d62eDC8BD62258cb48e6E995404Fabb7', _shibpay_burn_bps: 200, _shibpay_tokens: 'SHIB,BONE', _shibpay_tag: 1, _shibpay_sol: shop, _shibpay_reference: rand(32), ...extra },
    });
    const orders = [order(401), order(402), order(403), order(404), order(405), order(406, { _shibpay_sol: '' }), order(407)];
    const ref = (i: number) => orders[i].meta._shibpay_reference;

    const good = rand(64), pasted = rand(64), pending = rand(64), untagged = rand(64), cheap = rand(64), found = rand(64), old = rand(64);
    rpc.finalized.set(good, tx({ recipient: shop, amount: shib(100_000.5), reference: ref(0) }));
    rpc.finalized.set(pasted, tx({ recipient: shop, amount: shib(100_000), reference: ref(1) }));
    rpc.confirmed.set(pending, tx({ recipient: shop, amount: shib(100_000), reference: ref(2) }));
    rpc.finalized.set(untagged, tx({ recipient: shop, amount: shib(100_000) }));
    rpc.finalized.set(cheap, tx({ recipient: shop, amount: shib(90_000), reference: ref(4) }));
    rpc.finalized.set(found, tx({ recipient: shop, amount: shib(100_000), reference: ref(6) }));
    rpc.finalized.set(old, tx({ recipient: shop, amount: shib(100_000), reference: ref(4), blockTime: now - 86_400 }));
    rpc.byReference.set(ref(6), found);

    const r = await php({
      op: 'orders', rpc: { solana: url }, currency: 'USD', prices: { SHIB: 0.00001, BONE: 0.5 }, orders,
      calls: [
        { order: 401, tx: good, chain: 'solana', token: 'SHIB' }, // from the button
        { order: 402, tx: `https://solscan.io/tx/${pasted}` }, // pasted link
        { order: 403, tx: pending, chain: 'solana' }, // confirmed, not final
        { order: 404, tx: untagged }, // bare signature, no reference
        { order: 405, tx: cheap },
        { order: 405, tx: old },
        { order: 406, tx: good }, // shop doesn't take Solana, and it's 401's anyway
        { order: 406, tx: rand(64) },
        { call: 'watch', order: 407 }, // paid by QR, buyer left the page
        { order: 402, tx: good }, // someone else's payment
      ],
    });
    const st = r.answers.map((a: { status: string } | null) => a?.status ?? null);
    expect(st).toEqual(['paid', 'paid', 'confirming', 'review', 'failed', 'failed', 'failed', 'failed', null, 'paid']);
    expect(r.answers[4].message).toBe('That payment is less than the order total.');
    expect(r.answers[5].message).toBe('That payment was made before this order was placed.');
    expect(r.answers[6].message).toMatch(/already been used/);
    expect(r.answers[7].message).toBe('This shop does not take payments on Solana');

    expect(r.orders[401]).toMatchObject({ status: 'processing', tx: good, meta: { _shibpay_chain: 'solana', _shibpay_token: 'SHIB', _shibpay_state: 'paid' } });
    expect(r.orders[401].notes[0]).toMatch(/^Paid 100,000\.5 SHIB on Solana\. Transaction: <a href="https:\/\/solscan\.io\/tx\//);
    expect(r.orders[401].notes[0]).toMatch(/burn pledge for this sale: 2,000\.01 SHIB/);
    expect(r.orders[402]).toMatchObject({ status: 'processing', tx: pasted });
    expect(r.orders[403]).toMatchObject({ status: 'pending', meta: { _shibpay_state: 'confirming', _shibpay_tx: pending } });
    expect(r.cron).toContain('shibpay_recheck[403]');
    expect(r.orders[404]).toMatchObject({ status: 'on-hold', meta: { _shibpay_state: 'review' } });
    expect(r.orders[405].status).toBe('pending');
    expect(r.orders[407]).toMatchObject({ status: 'processing', tx: found });
    // Pledges are kept in Ethereum's 18 decimals, where the shop burns them: 2% of 100,000.5 + 100,000 + 100,000 SHIB.
    expect(r.pledged).toEqual({ SHIB: (6_000_010n * 10n ** 15n).toString() });
  });
});
