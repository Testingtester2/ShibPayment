import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha2';
import { SOLANA_SHIB } from '@shibpay/chains';
import type { BurnMode } from './amounts';
import { splitBurn } from './amounts';

/*
 * SHIB on Solana, paid with Solana Pay. No Solana SDK: the few pieces needed
 * (base58, the token-account address, one transfer transaction, JSON-RPC) are
 * small enough to write out, and keep shib-pay.js light. The tests check every
 * byte against @solana/web3.js and @solana/spl-token.
 *
 * Each checkout gets a random `reference` key. It rides along in the transfer,
 * so the shop finds the payment by asking the network for transactions that
 * mention it: no unique amounts needed.
 */

/**
 * Public RPCs, tried in order. Solana's own api.mainnet-beta refuses most
 * requests from web pages (HTTP 403), so a browser-friendly one comes first.
 */
export const SOLANA_RPCS = ['https://solana-rpc.publicnode.com', 'https://api.mainnet-beta.solana.com'] as const;
export const SOLANA_RPC = SOLANA_RPCS[0];
export const SOLANA_CHAIN = 'solana:mainnet';
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const SYSTEM_PROGRAM = '11111111111111111111111111111111';

// ── base58 ──────────────────────────────────────────────────────────────────

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = '1' + out;
  }
  return out;
}

export function base58Decode(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error('Not base58');
    n = n * 58n + BigInt(i);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const c of s) {
    if (c !== '1') break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

/** Checks a Solana wallet address (base58, 32 bytes) and returns it trimmed. */
export function validateSolanaAddress(input: string): string {
  const s = input.trim();
  let ok = false;
  try {
    ok = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s) && base58Decode(s).length === 32;
  } catch {
    ok = false;
  }
  if (!ok) throw new Error('That is not a valid Solana address.');
  if (s === SYSTEM_PROGRAM || s === SOLANA_SHIB.mint) throw new Error('That address cannot receive payments.');
  return s;
}

export function isSolanaAddress(input: string): boolean {
  try {
    validateSolanaAddress(input);
    return true;
  } catch {
    return false;
  }
}

/** A fresh random reference key for one checkout. */
export function newReference(): string {
  return base58Encode(crypto.getRandomValues(new Uint8Array(32)));
}

// ── addresses ───────────────────────────────────────────────────────────────

function onCurve(key: Uint8Array): boolean {
  try {
    ed25519.ExtendedPoint.fromHex(key);
    return true;
  } catch {
    return false;
  }
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) {
    out.set(p, i);
    i += p.length;
  }
  return out;
}

const PDA_MARKER = new TextEncoder().encode('ProgramDerivedAddress');

/** The shop's (or buyer's) token account for `mint`: an associated token account. */
export function associatedTokenAddress(owner: string, mint: string, tokenProgram: string = TOKEN_PROGRAM): string {
  const seeds = [base58Decode(owner), base58Decode(tokenProgram), base58Decode(mint)];
  const program = base58Decode(ATA_PROGRAM);
  for (let bump = 255; bump >= 0; bump--) {
    const key = sha256(concat(...seeds, Uint8Array.of(bump), program, PDA_MARKER));
    if (!onCurve(key)) return base58Encode(key);
  }
  throw new Error('No associated token address');
}

// ── Solana Pay link ─────────────────────────────────────────────────────────

/** `amount` (smallest units) as a plain decimal string, e.g. 12345n, 4 -> "1.2345". */
export function toUiAmount(amount: bigint, decimals: number): string {
  const s = amount.toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, s.length - decimals);
  const frac = decimals ? s.slice(-decimals).replace(/0+$/, '') : '';
  return frac ? `${whole}.${frac}` : whole;
}

export interface SolanaPayRequest {
  recipient: string;
  amount: bigint;
  decimals: number;
  mint?: string;
  reference: string;
  label?: string;
  message?: string;
}

/**
 * Solana Pay transfer request: `solana:<recipient>?amount=…&spl-token=…&reference=…`.
 * Phantom, Solflare, Backpack and other Solana wallets open it as a pre-filled
 * send, from a QR or a tap.
 */
export function toSolanaPayUrl(r: SolanaPayRequest): string {
  const q = new URLSearchParams();
  q.set('amount', toUiAmount(r.amount, r.decimals));
  q.set('spl-token', r.mint ?? SOLANA_SHIB.mint);
  q.set('reference', r.reference);
  if (r.label) q.set('label', r.label);
  if (r.message) q.set('message', r.message);
  return `solana:${validateSolanaAddress(r.recipient)}?${q.toString().replace(/\+/g, '%20')}`;
}

// ── RPC ─────────────────────────────────────────────────────────────────────

export type PostFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status?: number; json(): Promise<unknown> }>;

export interface SolanaRpc {
  /** Your own RPC (Helius, QuickNode, Triton…) is more reliable than the public default. */
  url?: string;
  fetchFn?: PostFetch;
}

export async function solanaRpc<T>(rpc: SolanaRpc, method: string, params: unknown[]): Promise<T> {
  const f: PostFetch = rpc.fetchFn ?? fetch;
  const urls = rpc.url ? [rpc.url] : SOLANA_RPCS;
  let failure: unknown;
  for (const url of urls) {
    let res: Awaited<ReturnType<PostFetch>>;
    try {
      res = await f(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      failure = e;
      continue;
    }
    if (!res.ok) {
      failure = new Error(`Solana network unavailable (${res.status ?? 'network'})`);
      continue;
    }
    const j = (await res.json()) as { result?: T; error?: { message: string } };
    if (j.error) throw new Error(j.error.message);
    return j.result as T;
  }
  throw failure instanceof Error ? failure : new Error('Solana network unavailable');
}

export interface MintInfo { decimals: number; tokenProgram: string }

/** The token's decimals and token program: pinned for SHIB, read from the chain for any other mint. */
export async function getMintInfo(rpc: SolanaRpc, mint: string = SOLANA_SHIB.mint): Promise<MintInfo> {
  if (mint === SOLANA_SHIB.mint) return { decimals: SOLANA_SHIB.decimals, tokenProgram: SOLANA_SHIB.tokenProgram };
  const r = await solanaRpc<{ value: null | { owner: string; data: { parsed?: { type: string; info: { decimals: number } } } } }>(
    rpc, 'getAccountInfo', [mint, { encoding: 'jsonParsed', commitment: 'confirmed' }],
  );
  const v = r.value;
  if (!v || v.data.parsed?.type !== 'mint' || ![TOKEN_PROGRAM, TOKEN_2022_PROGRAM].includes(v.owner)) {
    throw new Error('SHIB on Solana could not be read from the network.');
  }
  return { decimals: v.data.parsed.info.decimals, tokenProgram: v.owner };
}

// ── finding and verifying ───────────────────────────────────────────────────

/** First successful transaction that carries `reference`, or null. Confirm it with verifySolanaPayment. */
export async function findSolanaPayment(rpc: SolanaRpc, reference: string): Promise<string | null> {
  const sigs = await solanaRpc<{ signature: string; err: unknown }[]>(
    rpc, 'getSignaturesForAddress', [reference, { limit: 10, commitment: 'confirmed' }],
  );
  return sigs.find((s) => s.err === null)?.signature ?? null;
}

export interface SolanaExpected {
  /** Shop's Solana wallet (owner, not token account). */
  recipient: string;
  /** Smallest units of `mint`. */
  amount: bigint;
  /** The checkout's reference key. Strongly recommended: it ties the payment to this order. */
  reference?: string;
  burnBps?: number;
  mint?: string;
  /** "confirmed" (seconds) or "finalized" (~13 s, cannot be rolled back). Default finalized. */
  commitment?: 'confirmed' | 'finalized';
}

export type SolanaVerifyResult =
  | { ok: true; signature: string; amount: bigint; payer: string; burnMode: BurnMode; pledged: bigint }
  | { ok: false; reason: string };

interface TokenBalance { owner?: string; mint: string; uiTokenAmount: { amount: string } }
interface ParsedTx {
  meta: null | { err: unknown; preTokenBalances?: TokenBalance[]; postTokenBalances?: TokenBalance[] };
  transaction: { message: { accountKeys: { pubkey: string; signer: boolean }[] } };
}

/**
 * Checks a Solana transaction pays the shop at least `amount` of SHIB, and
 * (if given) carries this checkout's reference. Run it on your server before
 * shipping. Burns aren't possible here (only Ethereum burns count), so a burn
 * comes back as `pledged`: the shop's share to burn on Ethereum.
 */
export async function verifySolanaPayment(rpc: SolanaRpc, signature: string, e: SolanaExpected): Promise<SolanaVerifyResult> {
  const mint = e.mint ?? SOLANA_SHIB.mint;
  const recipient = validateSolanaAddress(e.recipient);
  const tx = await solanaRpc<ParsedTx | null>(rpc, 'getTransaction', [
    signature, { encoding: 'jsonParsed', commitment: e.commitment ?? 'finalized', maxSupportedTransactionVersion: 0 },
  ]);
  if (!tx || !tx.meta) return { ok: false, reason: 'Transaction not found yet (or not final).' };
  if (tx.meta.err !== null) return { ok: false, reason: 'Transaction failed on-chain.' };
  const keys = tx.transaction.message.accountKeys;
  if (e.reference && !keys.some((k) => k.pubkey === e.reference)) return { ok: false, reason: 'Transaction is not for this order (reference missing).' };

  const delta = (owner: (o?: string) => boolean) => {
    const sum = (list: TokenBalance[] = []) =>
      list.filter((b) => b.mint === mint && owner(b.owner)).reduce((n, b) => n + BigInt(b.uiTokenAmount.amount), 0n);
    return sum(tx.meta!.postTokenBalances) - sum(tx.meta!.preTokenBalances);
  };
  const received = delta((o) => o === recipient);
  if (received < e.amount) return { ok: false, reason: received > 0n ? 'Underpaid.' : 'No SHIB reached the shop in this transaction.' };

  const burnBps = e.burnBps ?? 0;
  const pledged = burnBps > 0 ? splitBurn(received, burnBps).burned : 0n;
  return { ok: true, signature, amount: received, payer: keys.find((k) => k.signer)?.pubkey ?? '', burnMode: burnBps > 0 ? 'pledge' : 'none', pledged };
}

// ── building the transfer ───────────────────────────────────────────────────

function shortvec(n: number): number[] {
  const out: number[] = [];
  for (;;) {
    let b = n & 0x7f;
    n >>= 7;
    if (n) b |= 0x80;
    out.push(b);
    if (!n) return out;
  }
}

interface Meta { key: string; signer: boolean; writable: boolean }
interface Ix { program: string; keys: Meta[]; data: Uint8Array }

/** Serializes an unsigned legacy transaction (one fee payer). */
function serialize(payer: string, ixs: Ix[], blockhash: string): Uint8Array {
  const metas = new Map<string, Meta>([[payer, { key: payer, signer: true, writable: true }]]);
  const add = (m: Meta) => {
    const x = metas.get(m.key);
    if (x) {
      x.signer ||= m.signer;
      x.writable ||= m.writable;
    } else metas.set(m.key, { ...m });
  };
  for (const ix of ixs) {
    ix.keys.forEach(add);
    add({ key: ix.program, signer: false, writable: false });
  }
  // Fee payer first, then signers before others, writable before read-only; otherwise first-seen order.
  const rank = (m: Meta) => (m.key === payer ? 0 : m.signer ? (m.writable ? 1 : 2) : m.writable ? 3 : 4);
  const list = [...metas.values()].map((m, i) => ({ m, i })).sort((a, b) => rank(a.m) - rank(b.m) || a.i - b.i).map((x) => x.m);
  const idx = new Map(list.map((m, i) => [m.key, i]));
  const signers = list.filter((m) => m.signer);
  const header = [signers.length, signers.filter((m) => !m.writable).length, list.filter((m) => !m.signer && !m.writable).length];

  const msg: number[] = [...header, ...shortvec(list.length)];
  for (const m of list) msg.push(...base58Decode(m.key));
  msg.push(...base58Decode(blockhash));
  msg.push(...shortvec(ixs.length));
  for (const ix of ixs) {
    msg.push(idx.get(ix.program)!, ...shortvec(ix.keys.length), ...ix.keys.map((k) => idx.get(k.key)!));
    msg.push(...shortvec(ix.data.length), ...ix.data);
  }
  return Uint8Array.from([...shortvec(signers.length), ...new Array(64 * signers.length).fill(0), ...msg]);
}

export interface TransferParams {
  payer: string;
  recipient: string;
  amount: bigint;
  decimals: number;
  reference: string;
  blockhash: string;
  mint?: string;
  tokenProgram?: string;
}

/**
 * The same transaction a Solana Pay wallet builds: create the shop's SHIB
 * account if it has none (the buyer pays its small rent), then transferChecked
 * with the reference key attached.
 */
export function buildSolanaTransfer(p: TransferParams): Uint8Array {
  const mint = p.mint ?? SOLANA_SHIB.mint;
  const program = p.tokenProgram ?? TOKEN_PROGRAM;
  const from = associatedTokenAddress(p.payer, mint, program);
  const to = associatedTokenAddress(p.recipient, mint, program);
  const amount = new Uint8Array(8);
  new DataView(amount.buffer).setBigUint64(0, p.amount, true);
  return serialize(p.payer, [
    {
      program: ATA_PROGRAM,
      keys: [
        { key: p.payer, signer: true, writable: true },
        { key: to, signer: false, writable: true },
        { key: p.recipient, signer: false, writable: false },
        { key: mint, signer: false, writable: false },
        { key: SYSTEM_PROGRAM, signer: false, writable: false },
        { key: program, signer: false, writable: false },
      ],
      data: Uint8Array.of(1), // CreateIdempotent
    },
    {
      program,
      keys: [
        { key: from, signer: false, writable: true },
        { key: mint, signer: false, writable: false },
        { key: to, signer: false, writable: true },
        { key: p.payer, signer: true, writable: false },
        { key: p.reference, signer: false, writable: false },
      ],
      data: Uint8Array.from([12, ...amount, p.decimals]), // TransferChecked
    },
  ], p.blockhash);
}

// ── paying through a wallet (Wallet Standard) ───────────────────────────────

export interface SolanaWallet {
  name: string;
  icon: string;
  chains: readonly string[];
  accounts: readonly { address: string }[];
  features: Record<string, unknown>;
}

interface ConnectFeature { connect(): Promise<{ accounts: readonly { address: string }[] }> }
interface SendFeature {
  signAndSendTransaction(...inputs: { account: { address: string }; transaction: Uint8Array; chain: string }[]): Promise<{ signature: Uint8Array }[]>;
}

/**
 * Solana wallets the page can pay with (Phantom, Solflare, Backpack…), found
 * through the Wallet Standard. Calls `onChange` as more register.
 */
export function watchSolanaWallets(onChange: (wallets: SolanaWallet[]) => void): () => void {
  const found: SolanaWallet[] = [];
  const api = {
    register(...ws: SolanaWallet[]) {
      for (const w of ws) {
        const fit = w.chains.includes(SOLANA_CHAIN) && 'standard:connect' in w.features && 'solana:signAndSendTransaction' in w.features;
        if (fit && !found.includes(w)) found.push(w);
      }
      onChange([...found]);
      return () => {};
    },
  };
  const onRegister = (e: Event) => (e as CustomEvent<(a: typeof api) => void>).detail?.(api);
  window.addEventListener('wallet-standard:register-wallet', onRegister);
  window.dispatchEvent(Object.assign(new Event('wallet-standard:app-ready'), { detail: api }));
  return () => window.removeEventListener('wallet-standard:register-wallet', onRegister);
}

export type SolanaPayStep = 'connecting' | 'paying' | 'confirming';

export interface SolanaPayParams extends SolanaRpc {
  wallet: SolanaWallet;
  recipient: string;
  amount: bigint;
  reference: string;
  burnBps?: number;
  onStep?: (s: SolanaPayStep) => void;
}

/** Pays SHIB on Solana from a Wallet Standard wallet. Resolves once the network confirms. */
export async function payWithSolanaWallet(p: SolanaPayParams) {
  const rpc = { url: p.url, fetchFn: p.fetchFn };
  p.onStep?.('connecting');
  const { accounts } = await (p.wallet.features['standard:connect'] as ConnectFeature).connect();
  const account = accounts[0];
  if (!account) throw new Error('No Solana account in this wallet.');
  const { decimals, tokenProgram } = await getMintInfo(rpc);
  const { value } = await solanaRpc<{ value: { blockhash: string } }>(rpc, 'getLatestBlockhash', [{ commitment: 'confirmed' }]);
  const transaction = buildSolanaTransfer({
    payer: account.address, recipient: p.recipient, amount: p.amount, decimals, tokenProgram, reference: p.reference, blockhash: value.blockhash,
  });
  p.onStep?.('paying');
  const [out] = await (p.wallet.features['solana:signAndSendTransaction'] as SendFeature)
    .signAndSendTransaction({ account, transaction, chain: SOLANA_CHAIN });
  const signature = base58Encode(out.signature);
  p.onStep?.('confirming');
  for (let i = 0; i < 60; i++) {
    const r = await verifySolanaPayment(rpc, signature, { recipient: p.recipient, amount: p.amount, reference: p.reference, burnBps: p.burnBps, commitment: 'confirmed' });
    if (r.ok) return r;
    if (r.reason !== 'Transaction not found yet (or not final).') throw new Error(r.reason);
    await new Promise((res) => setTimeout(res, 2000));
  }
  throw new Error('The network has not confirmed the payment yet. Check your wallet before trying again.');
}

export const solanaTxUrl = (signature: string) => `https://solscan.io/tx/${signature}`;
