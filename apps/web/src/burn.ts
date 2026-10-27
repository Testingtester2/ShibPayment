import { parseUnits } from 'viem';
import {
  BURN_CHAIN_ID, InsufficientBalanceError, TOKEN_SYMBOLS, burnOnEthereum, explorerTxUrl, formatTokenAmount, getChain, getToken,
  percentToBps, splitBurn, type Eip1193Provider, type PayStep, type TokenSymbol,
} from '@shibpay/core';
import { CHEVRON, FLAME, WALLET, tokenLogo } from '@shibpay/button';
import { initEvery, renderEvery } from './burn-every';

interface WalletInfo { uuid: string; name: string; icon: string; rdns: string; provider: Eip1193Provider }

const form = document.getElementById('form') as HTMLFormElement;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const field = (name: string) => form.elements.namedItem(name) as HTMLInputElement;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const chain = getChain(BURN_CHAIN_ID)!;
const wallets: WalletInfo[] = [];
let token: TokenSymbol = 'SHIB';
let busy = false;

const q = new URLSearchParams(location.search);
if (q.get('burn')) field('pct').value = q.get('burn')!;
const fromLink = q.get('token')?.toUpperCase();
if (fromLink && TOKEN_SYMBOLS.includes(fromLink as TokenSymbol)) token = fromLink as TokenSymbol;

function decimals() {
  return getToken(BURN_CHAIN_ID, token)!.decimals;
}

function parse(v: string): bigint | null {
  const s = v.trim().replace(/,/g, '');
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  try {
    return parseUnits(s, decimals());
  } catch {
    return null;
  }
}

/** Amount to burn in smallest units, or null when the field is empty or invalid. */
function amount(): bigint | null {
  const a = parse(field('amount').value);
  return a && a > 0n ? a : null;
}

function status(text: string, kind: '' | 'ok' | 'bad' = '', html = false) {
  const el = $('status');
  el.className = `status note ${kind}`;
  if (html) el.innerHTML = text;
  else el.textContent = text;
}

/** takings × % → amount to burn. */
function calc() {
  const takings = parse(field('takings').value);
  let bps: number;
  try {
    bps = percentToBps(field('pct').value || '0');
  } catch (e) {
    $('calcNote').textContent = (e as Error).message;
    $('calcNote').className = 'note bad';
    return;
  }
  $('calcNote').className = 'note';
  if (takings === null) {
    $('calcNote').textContent = 'Add up the sales you took on other networks since your last burn.';
    return;
  }
  const burn = splitBurn(takings, bps).burned;
  field('amount').value = formatTokenAmount(burn, decimals()).replace(/,/g, '');
  $('calcNote').textContent = `${bps / 100}% of ${formatTokenAmount(takings, decimals())} ${token}.`;
}

function render() {
  $('tokens').innerHTML = TOKEN_SYMBOLS.map((s) =>
    `<button type="button" class="tok" data-token="${s}" aria-pressed="${s === token}">${tokenLogo(s)}${s}</button>`).join('');
  const a = amount();
  $('total').innerHTML = `<span class="flame">${FLAME}</span> ${a ? formatTokenAmount(a, decimals()) : '0'} ${token}`;
  const can = !!a && !busy;
  const injected = (window as unknown as { ethereum?: Eip1193Provider }).ethereum;
  const rows = wallets.map((w, i) => `<button type="button" class="wallet ${i === 0 ? 'primary' : ''}" data-uuid="${esc(w.uuid)}" ${can ? '' : 'disabled'}>
      ${/^data:image\//.test(w.icon) ? `<img src="${esc(w.icon)}" alt="" />` : WALLET}<span class="grow">Burn with ${esc(w.name)}</span>${CHEVRON}</button>`);
  if (!wallets.length && injected) {
    rows.push(`<button type="button" class="wallet primary" data-uuid="injected" ${can ? '' : 'disabled'}>${WALLET}<span class="grow">Burn with my browser wallet</span>${CHEVRON}</button>`);
  }
  $('wallets').innerHTML = rows.length
    ? rows.join('')
    : `<div class="note">Open this page in ShibWallet, MetaMask or another wallet's browser to burn.</div>`;
}

const STEP_TEXT: Record<PayStep, string> = {
  'connecting': 'Approve the connection in your wallet…',
  'switching-chain': `Switch your wallet to ${chain.name}…`,
  'approving': '',
  'paying': 'Check the amount in your wallet and confirm…',
  'approve-and-pay': '',
  'confirming': 'Burning… waiting for Ethereum to confirm.',
};

async function burn(provider: Eip1193Provider | undefined) {
  const a = amount();
  if (!provider || !a || busy) return;
  busy = true;
  render();
  try {
    const res = await burnOnEthereum({ provider, token, amount: a, onStep: (s) => status(STEP_TEXT[s]) });
    status(`Burned ${formatTokenAmount(a, decimals())} ${token} for good. <a href="${esc(explorerTxUrl(BURN_CHAIN_ID, res.hash))}" target="_blank" rel="noopener">See it on Etherscan</a>`, 'ok', true);
    const t = getToken(BURN_CHAIN_ID, token)!;
    const h = $('history');
    h.innerHTML = `<a href="${esc(`${chain.explorerUrl}/token/${t.address}?a=${res.payer}`)}" target="_blank" rel="noopener">All ${token} burns and transfers from your wallet</a>`;
    h.hidden = false;
    field('amount').value = '';
    field('takings').value = '';
  } catch (err) {
    const e = err as { code?: number; shortMessage?: string; message?: string; cause?: { code?: number } };
    const text = `${e.shortMessage ?? ''} ${e.message ?? ''}`.toLowerCase();
    status(
      e.code === 4001 || e.cause?.code === 4001 || text.includes('user rejected') ? 'You cancelled in your wallet. Nothing was burned.'
      : err instanceof InsufficientBalanceError ? `Not enough ${token} on Ethereum. If it's on another network, burn it from there below.`
      : text.includes('insufficient funds') ? 'Not enough ETH for the Ethereum network fee.'
      : e.shortMessage || e.message || 'Something went wrong. Nothing was burned.',
      'bad',
    );
  } finally {
    busy = false;
    render();
  }
}

window.addEventListener('eip6963:announceProvider', ((e: CustomEvent<{ info: Omit<WalletInfo, 'provider'>; provider: Eip1193Provider }>) => {
  const { info, provider } = e.detail ?? {};
  if (!info?.uuid || !provider || wallets.some((w) => w.uuid === info.uuid)) return;
  wallets.push({ ...info, provider });
  wallets.sort((a, b) => Number(/shib/i.test(b.rdns + b.name)) - Number(/shib/i.test(a.rdns + a.name)));
  render();
  renderEvery(wallets);
}) as EventListener);
window.dispatchEvent(new Event('eip6963:requestProvider'));

form.addEventListener('input', (e) => {
  const name = (e.target as HTMLInputElement).name;
  if (name === 'takings' || name === 'pct') calc();
  render();
});
form.addEventListener('submit', (e) => e.preventDefault());
form.addEventListener('click', (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-token],[data-uuid]');
  if (!el) return;
  if (el.dataset.token) {
    token = el.dataset.token as TokenSymbol;
    calc();
    return render();
  }
  const uuid = el.dataset.uuid!;
  void burn(uuid === 'injected'
    ? (window as unknown as { ethereum?: Eip1193Provider }).ethereum
    : wallets.find((w) => w.uuid === uuid)?.provider);
});

render();
initEvery();
