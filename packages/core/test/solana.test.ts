import { describe, expect, it } from 'vitest';
import { Keypair, PublicKey, Transaction } from '@solana/web3.js';
import {
  TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import {
  SOLANA_RPCS, SOLANA_SHIB, associatedTokenAddress, getMintInfo, solanaRpc, base58Decode, base58Encode, buildSolanaTransfer, findSolanaPayment, newReference,
  toSolanaPayUrl, toUiAmount, validateSolanaAddress, verifySolanaPayment, type PostFetch,
} from '../src';

const MINT = SOLANA_SHIB.mint;
const key = () => Keypair.generate().publicKey.toBase58();

describe('base58 and addresses', () => {
  it('matches @solana/web3.js', () => {
    for (let i = 0; i < 50; i++) {
      const pk = Keypair.generate().publicKey;
      expect(base58Encode(pk.toBytes())).toBe(pk.toBase58());
      expect(base58Decode(pk.toBase58())).toEqual(pk.toBytes());
    }
    expect(base58Encode(new Uint8Array(32))).toBe('11111111111111111111111111111111');
    expect(base58Decode('11111111111111111111111111111111')).toEqual(new Uint8Array(32));
    expect(base58Decode(newReference())).toHaveLength(32);
  });

  it('derives the same associated token account as spl-token', () => {
    for (let i = 0; i < 20; i++) {
      const owner = key();
      for (const program of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
        expect(associatedTokenAddress(owner, MINT, program.toBase58()))
          .toBe(getAssociatedTokenAddressSync(new PublicKey(MINT), new PublicKey(owner), false, program).toBase58());
      }
    }
  });

  it('validates shop addresses', () => {
    const a = key();
    expect(validateSolanaAddress(` ${a} `)).toBe(a);
    expect(() => validateSolanaAddress('0x1111111111111111111111111111111111111111')).toThrow(/not a valid Solana/);
    expect(() => validateSolanaAddress('abc')).toThrow();
    expect(() => validateSolanaAddress(MINT)).toThrow(/cannot receive/);
  });
});

describe('Solana Pay link', () => {
  it('formats a transfer request', () => {
    const recipient = key(), reference = key();
    expect(toUiAmount(12345n, 4)).toBe('1.2345');
    expect(toUiAmount(10000n, 4)).toBe('1');
    expect(toUiAmount(5n, 4)).toBe('0.0005');
    expect(toSolanaPayUrl({ recipient, amount: 1_453_744_5091n, decimals: 4, reference, label: "Ryoshi's Dorado Stall" }))
      .toBe(`solana:${recipient}?amount=1453744.5091&spl-token=${MINT}&reference=${reference}&label=Ryoshi%27s%20Dorado%20Stall`);
  });
});

describe('buildSolanaTransfer', () => {
  for (const program of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    it(`builds what spl-token would (${program.equals(TOKEN_PROGRAM_ID) ? 'Token' : 'Token-2022'})`, () => {
      const payer = key(), recipient = key(), reference = key(), blockhash = key();
      const bytes = buildSolanaTransfer({ payer, recipient, amount: 1_234_567n, decimals: 4, reference, blockhash, tokenProgram: program.toBase58() });
      const tx = Transaction.from(bytes);
      expect(tx.feePayer?.toBase58()).toBe(payer);
      expect(tx.recentBlockhash).toBe(blockhash);

      const mint = new PublicKey(MINT), P = new PublicKey(payer), R = new PublicKey(recipient);
      const toAta = getAssociatedTokenAddressSync(mint, R, false, program);
      const fromAta = getAssociatedTokenAddressSync(mint, P, false, program);
      const transfer = createTransferCheckedInstruction(fromAta, mint, toAta, P, 1_234_567n, 4, [], program);
      transfer.keys.push({ pubkey: new PublicKey(reference), isSigner: false, isWritable: false });
      const want = [createAssociatedTokenAccountIdempotentInstruction(P, toAta, R, mint, program), transfer];

      expect(tx.instructions).toHaveLength(2);
      tx.instructions.forEach((ix, i) => {
        expect(ix.programId.toBase58()).toBe(want[i].programId.toBase58());
        expect(Buffer.from(ix.data).toString('hex')).toBe(Buffer.from(want[i].data).toString('hex'));
        expect(ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner])).toEqual(want[i].keys.map((k) => [k.pubkey.toBase58(), k.isSigner]));
        // The payer is writable for the whole transaction (fee payer); every other key keeps its own flag.
        ix.keys.forEach((k, j) => {
          if (k.pubkey.toBase58() !== payer) expect(k.isWritable).toBe(want[i].keys[j].isWritable);
        });
      });
      // Exactly one signature slot, for the buyer.
      expect(tx.signatures.map((s) => s.publicKey.toBase58())).toEqual([payer]);
    });
  }
});

describe('finding and verifying', () => {
  const recipient = key(), payer = key(), reference = key(), sig = 'sig1';
  const tx = (o: { amount?: string; err?: unknown; ref?: boolean; mint?: string } = {}) => ({
    meta: {
      err: o.err ?? null,
      preTokenBalances: [{ owner: payer, mint: MINT, uiTokenAmount: { amount: '50000000' } }],
      postTokenBalances: [
        { owner: payer, mint: MINT, uiTokenAmount: { amount: '30000000' } },
        { owner: recipient, mint: o.mint ?? MINT, uiTokenAmount: { amount: o.amount ?? '20000000' } },
      ],
    },
    transaction: { message: { accountKeys: [{ pubkey: payer, signer: true }, ...(o.ref === false ? [] : [{ pubkey: reference, signer: false }])] } },
  });
  const rpc = (result: unknown): { fetchFn: PostFetch; calls: { method: string; params: unknown[] }[] } => {
    const calls: { method: string; params: unknown[] }[] = [];
    return {
      calls,
      fetchFn: async (_u, init) => {
        calls.push(JSON.parse(init.body));
        return { ok: true, json: async () => ({ result }) };
      },
    };
  };

  it('accepts a payment that reaches the shop, and reports the pledge', async () => {
    const r = await verifySolanaPayment(rpc(tx()), sig, { recipient, amount: 20_000_000n, reference, burnBps: 200 });
    expect(r).toEqual({ ok: true, signature: sig, amount: 20_000_000n, payer, burnMode: 'pledge', pledged: 400_000n });
  });

  it('rejects underpaid, wrong token, failed, missing reference and not-found', async () => {
    const e = { recipient, amount: 20_000_000n, reference };
    expect(await verifySolanaPayment(rpc(tx({ amount: '19999999' })), sig, e)).toMatchObject({ ok: false, reason: 'Underpaid.' });
    expect(await verifySolanaPayment(rpc(tx({ mint: key() })), sig, e)).toMatchObject({ ok: false });
    expect(await verifySolanaPayment(rpc(tx({ err: { InstructionError: [1, 'x'] } })), sig, e)).toMatchObject({ ok: false, reason: /failed/ });
    expect(await verifySolanaPayment(rpc(tx({ ref: false })), sig, e)).toMatchObject({ ok: false, reason: /reference/ });
    expect(await verifySolanaPayment(rpc(null), sig, e)).toMatchObject({ ok: false, reason: /not found/ });
  });

  it('asks for finalized by default', async () => {
    const r = rpc(tx());
    await verifySolanaPayment(r, sig, { recipient, amount: 1n });
    expect(r.calls[0]).toMatchObject({ method: 'getTransaction', params: [sig, { commitment: 'finalized', maxSupportedTransactionVersion: 0 }] });
  });

  it('finds the first successful payment for a reference', async () => {
    const r = rpc([{ signature: 'bad', err: { x: 1 } }, { signature: 'good', err: null }]);
    expect(await findSolanaPayment(r, reference)).toBe('good');
    expect(r.calls[0]).toMatchObject({ method: 'getSignaturesForAddress', params: [reference, { commitment: 'confirmed' }] });
  });
});

describe('RPC', () => {
  it('uses the pinned SHIB mint details without a network call', async () => {
    const fetchFn: PostFetch = async () => { throw new Error('no network'); };
    expect(await getMintInfo({ fetchFn })).toEqual({ decimals: 4, tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' });
  });

  it('falls back to the next public RPC when one refuses', async () => {
    const urls: string[] = [];
    const fetchFn: PostFetch = async (url) => {
      urls.push(url);
      if (urls.length === 1) return { ok: false, status: 403, json: async () => ({}) };
      return { ok: true, json: async () => ({ result: 42 }) };
    };
    expect(await solanaRpc({ fetchFn }, 'getSlot', [])).toBe(42);
    expect(urls).toEqual([...SOLANA_RPCS]);
  });

  it('falls back when a provider refuses the method, and reports the last error', async () => {
    let n = 0;
    const refuse: PostFetch = async () => ({ ok: true, json: async () => ({ error: { message: `method disabled ${++n}` } }) });
    await expect(solanaRpc({ fetchFn: refuse }, 'getSignaturesForAddress', [])).rejects.toThrow(`method disabled ${SOLANA_RPCS.length}`);
  });

  it("sticks to the shop's own RPC", async () => {
    const urls: string[] = [];
    const fetchFn: PostFetch = async (url) => { urls.push(url); return { ok: false, status: 403, json: async () => ({}) }; };
    await expect(solanaRpc({ url: 'https://rpc.example', fetchFn }, 'getSlot', [])).rejects.toThrow(/403/);
    expect(urls).toEqual(['https://rpc.example']);
  });
});
