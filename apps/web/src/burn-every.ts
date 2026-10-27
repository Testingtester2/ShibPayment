// "Burn from every network": finds the shop's SHIB, BONE and LEASH on
// Ethereum and the 11 CCIP networks, then burns what they choose one network
// at a time. Amounts are the shop's to set; nothing is stored.
import { formatUnits, parseUnits } from 'viem';
import {
  BURN_CHAIN_ID, InsufficientBalanceError, InsufficientGasError, burnFromChain, ccipExplorerUrl, connectWallet, explorerTxUrl,
  findBurnableBalances, formatTokenAmount, getChain, getToken, publicClientFor, quoteCcipBurn,
  type BurnItem, type ChainBalances, type Eip1193Provider, type PayStep, type TokenSymbol,
} from '@shibpay/core';
import { CHEVRON, WALLET, tokenLogo } from '@shibpay/button';

export interface WalletChoice { uuid: string; name: string; icon: string; provider: Eip1193Provider }

interface Net {
  chainId: number;
  on: boolean;
  balances: ChainBalances;
  /** What the shop typed, per token. */
  amounts: Partial<Record<TokenSymbol, string>>;
  /** CCIP fee for burning everything listed, in the network's gas coin. */
  fee?: bigint;
  state: 'ready' | 'working' | 'done' | 'failed';
  note?: string;
  noteKind?: '' | 'ok' | 'bad' | 'warn';
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const link = (href: string, text: string) => `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(text)}</a>`;

let provider: Eip1193Provider | undefined;
let nets: Net[] = [];
let busy = false;
let wallets: WalletChoice[] = [];

const decimals = (chainId: number, s: TokenSymbol) => getToken(chainId, s)!.decimals;

function amountOf(n: Net, s: TokenSymbol): bigint | null {
  const v = (n.amounts[s] ?? '').trim().replace(/,/g, '');
  if (!v) return 0n;
  if (!/^\d+(\.\d+)?$/.test(v)) return null;
  try {
    return parseUnits(v, decimals(n.chainId, s));
  } catch {
    return null;
  }
}

/** The tokens to burn on a network, or null if an amount is invalid or more than the balance. */
function itemsOf(n: Net): BurnItem[] | null {
  const items: BurnItem[] = [];
  for (const t of n.balances.tokens) {
    const a = amountOf(n, t.token);
    if (a === null || a > t.balance) return null;
    if (a > 0n) items.push({ token: t.token, amount: a });
  }
  return items;
}

const runnable = (n: Net) => n.on && n.state !== 'done' && !!itemsOf(n)?.length && !lacksGas(n);
const lacksGas = (n: Net) => n.fee !== undefined && n.balances.native < n.fee;

function fmtNative(chainId: number, v: bigint) {
  const s = Number(formatUnits(v, 18));
  return `${s < 0.0001 ? '<0.0001' : s.toLocaleString('en-US', { maximumSignificantDigits: 2 })} ${getChain(chainId)!.nativeSymbol}`;
}

export function renderEvery(list: WalletChoice[] = wallets) {
  wallets = list;
  const injected = (window as unknown as { ethereum?: Eip1193Provider }).ethereum;
  const choices = wallets.length ? wallets : injected ? [{ uuid: 'injected', name: 'my browser wallet', icon: '', provider: injected }] : [];
  const find = $('findWallets');
  if (provider) {
    find.innerHTML = '';
  } else {
    find.innerHTML = choices.length
      ? choices.map((w, i) => `<button type="button" class="wallet ${i === 0 ? 'primary' : ''}" data-find="${esc(w.uuid)}" ${busy ? 'disabled' : ''}>
        ${/^data:image\//.test(w.icon) ? `<img src="${esc(w.icon)}" alt="" />` : WALLET}<span class="grow">Find my tokens with ${esc(w.name)}</span>${CHEVRON}</button>`).join('')
      : `<div class="note">Open this page in ShibWallet, MetaMask or another wallet's browser to find your tokens.</div>`;
  }

  const box = $('nets');
  box.hidden = !nets.length;
  box.innerHTML = nets.map((n, i) => {
    const chain = getChain(n.chainId)!;
    const locked = busy || n.state === 'done';
    const fee = n.chainId === BURN_CHAIN_ID ? 'No bridge fee' : n.fee === undefined ? '' : `Bridge fee about ${fmtNative(n.chainId, n.fee)}`;
    const lines = n.balances.tokens.map((t) => {
      const a = amountOf(n, t.token);
      const bad = a === null || (a ?? 0n) > t.balance;
      return `<div class="line"><span class="tl">${tokenLogo(t.token, 28)}</span>
        <input inputmode="decimal" data-net="${i}" data-token="${t.token}" value="${esc(n.amounts[t.token] ?? '')}" placeholder="0" aria-label="${t.token} to burn from ${esc(chain.name)}" ${bad ? 'aria-invalid="true"' : ''} ${locked ? 'disabled' : ''} />
        <button type="button" class="btn ghost small" data-max="${i}" data-token="${t.token}" ${locked ? 'disabled' : ''}>All</button>
        <div class="bal">You have ${formatTokenAmount(t.balance, decimals(n.chainId, t.token))} ${t.token}</div></div>`;
    }).join('');
    const gas = lacksGas(n) && n.state !== 'done'
      ? `<div class="note warn">Add a little ${chain.nativeSymbol} on ${esc(chain.name)} for the bridge fee (you have ${fmtNative(n.chainId, n.balances.native)}).</div>` : '';
    const note = n.note ? `<div class="note ${n.noteKind ?? ''}">${n.note}</div>` : '';
    return `<div class="net ${n.on ? '' : 'off'}">
      <label class="net-head"><input type="checkbox" data-on="${i}" ${n.on ? 'checked' : ''} ${locked ? 'disabled' : ''} />
        <span class="grow">${esc(chain.name)}</span><span class="fee">${fee}</span></label>
      <div class="lines">${lines}</div>${gas}${note}</div>`;
  }).join('');

  const todo = nets.filter(runnable);
  const btn = $('burnAll') as HTMLButtonElement;
  btn.hidden = !nets.length;
  btn.disabled = busy || !todo.length;
  btn.textContent = busy ? 'Burning…'
    : todo.length ? `Burn from ${todo.length} network${todo.length === 1 ? '' : 's'}` : 'Nothing selected to burn';
}

function everyStatus(text: string, kind: '' | 'ok' | 'bad' = '') {
  const el = $('everyStatus');
  el.className = `status note ${kind}`;
  el.innerHTML = text;
}

async function find(p: Eip1193Provider | undefined) {
  if (!p || busy) return;
  busy = true;
  renderEvery();
  try {
    everyStatus('Approve the connection in your wallet…');
    const owner = await connectWallet(p);
    provider = p;
    everyStatus('Looking on 12 networks…');
    const found = await findBurnableBalances(owner);
    nets = found.filter((b) => b.tokens.length).map((balances) => ({
      chainId: balances.chainId, on: true, balances, state: 'ready',
      amounts: Object.fromEntries(balances.tokens.map((t) => [t.token, formatUnits(t.balance, decimals(balances.chainId, t.token))])),
    }));
    const missed = found.filter((b) => b.error).map((b) => getChain(b.chainId)!.name);
    const short = `${owner.slice(0, 6)}…${owner.slice(-4)}`;
    everyStatus(
      (nets.length ? `Found tokens on ${nets.length} network${nets.length === 1 ? '' : 's'} for ${short}. Every amount starts at your full balance: change any you want to keep.`
        : `No SHIB, BONE or LEASH found for ${short} on these networks.`)
      + (missed.length ? ` Couldn't reach ${missed.join(', ')} just now, so ${missed.length === 1 ? 'it is' : 'they are'} not listed.` : ''),
      nets.length ? '' : 'bad',
    );
    busy = false;
    renderEvery();
    await Promise.all(nets.filter((n) => n.chainId !== BURN_CHAIN_ID).map(async (n) => {
      try {
        const items = n.balances.tokens.map((t) => ({ token: t.token, amount: t.balance }));
        n.fee = (await quoteCcipBurn(publicClientFor(n.chainId), n.chainId, items)).fees.reduce((a, b) => a + b, 0n);
        if (lacksGas(n)) n.on = false;
        renderEvery();
      } catch {
        // The fee is quoted again when burning; this one is only for show.
      }
    }));
  } catch (err) {
    provider = undefined;
    everyStatus(rejected(err) ? 'You cancelled in your wallet.' : (err as Error).message, 'bad');
  } finally {
    busy = false;
    renderEvery();
  }
}

function rejected(err: unknown) {
  const e = err as { code?: number; shortMessage?: string; message?: string; cause?: { code?: number } };
  const text = `${e.shortMessage ?? ''} ${e.message ?? ''}`.toLowerCase();
  return e.code === 4001 || e.cause?.code === 4001 || text.includes('user rejected') || text.includes('user denied');
}

function stepText(step: PayStep, chainId: number): string {
  const name = getChain(chainId)!.name;
  return {
    'connecting': 'Connecting…',
    'switching-chain': `Switch your wallet to ${name}…`,
    'approving': 'Step 1 of 2: allow the bridge to take the tokens, then confirm.',
    'paying': chainId === BURN_CHAIN_ID ? 'Confirm the burn in your wallet…' : 'Confirm the bridge to the burn address in your wallet…',
    'approve-and-pay': 'Confirm once in your wallet…',
    'confirming': `Waiting for ${name} to confirm…`,
  }[step];
}

async function burnAll() {
  if (!provider || busy) return;
  const queue = nets.filter(runnable);
  if (!queue.length) return;
  busy = true;
  let ok = 0;
  for (const [k, n] of queue.entries()) {
    const chain = getChain(n.chainId)!;
    const items = itemsOf(n)!;
    n.state = 'working';
    everyStatus(`Network ${k + 1} of ${queue.length}: ${esc(chain.name)}`);
    try {
      const res = await burnFromChain({
        provider, chainId: n.chainId, items,
        onStep: (s) => { n.note = stepText(s, n.chainId); n.noteKind = ''; renderEvery(); },
      });
      const what = items.map((i) => `${formatTokenAmount(i.amount, decimals(n.chainId, i.token))} ${i.token}`).join(' + ');
      const tx = res.hashes[res.hashes.length - 1];
      n.state = 'done';
      n.noteKind = 'ok';
      n.note = res.via === 'direct'
        ? `Burned ${what}. ${link(explorerTxUrl(n.chainId, tx), 'See it on Etherscan')}`
        : `${what} sent to the burn address on Ethereum. It lands in about 20 minutes. ${res.hashes.map((h, j) => link(ccipExplorerUrl(h), res.hashes.length > 1 ? `Track ${j + 1}` : 'Track it')).join(' · ')}`;
      ok++;
    } catch (err) {
      n.state = 'failed';
      n.noteKind = 'bad';
      n.note = rejected(err) ? 'You cancelled in your wallet. Nothing was burned here.'
        : err instanceof InsufficientGasError || err instanceof InsufficientBalanceError ? esc(err.message)
        : esc((err as { shortMessage?: string }).shortMessage || (err as Error).message || 'Something went wrong. Nothing was burned here.');
    }
    renderEvery();
  }
  busy = false;
  const failed = queue.length - ok;
  everyStatus(failed ? `Done: ${ok} of ${queue.length} networks burned. Check the ones marked in red.` : `Done: burned from ${ok} network${ok === 1 ? '' : 's'}.`, failed ? 'bad' : 'ok');
  renderEvery();
}

export function initEvery() {
  const sec = $('every');
  sec.addEventListener('click', (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-find],[data-max],#burnAll');
    if (!el) return;
    if (el.id === 'burnAll') return void burnAll();
    if (el.dataset.find) {
      const uuid = el.dataset.find;
      return void find(uuid === 'injected'
        ? (window as unknown as { ethereum?: Eip1193Provider }).ethereum
        : wallets.find((w) => w.uuid === uuid)?.provider);
    }
    const n = nets[Number(el.dataset.max)];
    const s = el.dataset.token as TokenSymbol;
    const bal = n.balances.tokens.find((t) => t.token === s)!.balance;
    n.amounts[s] = formatUnits(bal, decimals(n.chainId, s));
    renderEvery();
  });
  sec.addEventListener('change', (e) => {
    const el = e.target as HTMLInputElement;
    if (el.dataset.on === undefined) return;
    nets[Number(el.dataset.on)].on = el.checked;
    renderEvery();
  });
  sec.addEventListener('input', (e) => {
    const el = e.target as HTMLInputElement;
    if (el.dataset.net === undefined) return;
    const n = nets[Number(el.dataset.net)];
    n.amounts[el.dataset.token as TokenSymbol] = el.value;
    // Update the button and validity without redrawing the field being typed in.
    const a = amountOf(n, el.dataset.token as TokenSymbol);
    const bal = n.balances.tokens.find((t) => t.token === el.dataset.token)!.balance;
    if (a === null || a > bal) el.setAttribute('aria-invalid', 'true');
    else el.removeAttribute('aria-invalid');
    const todo = nets.filter(runnable);
    const btn = $('burnAll') as HTMLButtonElement;
    btn.disabled = busy || !todo.length;
    btn.textContent = todo.length ? `Burn from ${todo.length} network${todo.length === 1 ? '' : 's'}` : 'Nothing selected to burn';
  });
  renderEvery();
}
