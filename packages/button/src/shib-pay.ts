import qrcode from 'qrcode-generator';
import { parseUnits } from 'viem';
import {
  BURN_CHAIN_ID, TOKEN_SYMBOLS, InsufficientBalanceError, burnMode, chainsForToken, explorerTxUrl, fetchPrices, findPayment, formatTokenAmount,
  getChain, getToken, payWithWallet, percentToBps, poll, publicClientFor, quoteAmount, splitBurn,
  splitterAvailable, toEip681, validateMerchantAddress, verifyPayment,
  type BurnMode, type Eip1193Provider, type PayStep, type TokenSymbol,
} from '@shibpay/core';
import { CHECK, CHEVRON, CLOSE, FLAME, PHONE, WALLET, shibLogo, tokenLogo, wordmark } from './brand';
import { STYLES } from './styles';

interface WalletInfo { uuid: string; name: string; icon: string; rdns: string; provider: Eip1193Provider }
type View = 'choose' | 'progress' | 'done' | 'error' | 'qr';

interface Config {
  to: `0x${string}`;
  amount: string;
  currency: string;
  burnBps: number;
  order: string;
  label: string;
  tokens: TokenSymbol[];
  returnUrl?: string;
  splitter?: `0x${string}`;
}

interface Paid { hash: `0x${string}`; chainId: number; amount: bigint; payer: string; mode: BurnMode; burned: bigint; pledged: bigint }

const QUOTE_MS = 15 * 60_000;

const esc = (s: unknown) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function fiat(amount: string, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(Number(amount));
  } catch {
    return `${amount} ${currency}`;
  }
}

function friendlyError(err: unknown, token: string, chain: string): string {
  const e = err as { code?: number; name?: string; shortMessage?: string; message?: string; cause?: { code?: number } };
  const text = `${e.shortMessage ?? ''} ${e.message ?? ''}`.toLowerCase();
  if (e.code === 4001 || e.cause?.code === 4001 || e.name === 'UserRejectedRequestError' || text.includes('user rejected') || text.includes('denied')) {
    return 'You cancelled in your wallet. Nothing was sent.';
  }
  if (err instanceof InsufficientBalanceError) return err.message;
  if (text.includes('insufficient funds') || text.includes('exceeds balance') || text.includes('transfer amount exceeds')) {
    return `Not enough ${token} or network fee on ${chain}. Top up, or pick another token or network.`;
  }
  return e.shortMessage || e.message || 'Something went wrong. Nothing was sent.';
}

/**
 * <shib-pay to="0x..." amount="12.50" currency="USD" burn="2" order="A-17" label="Ryoshi's Dorado Stall"></shib-pay>
 *
 * Fires `shibpay:paid` (bubbles, composed) with { txHash, chainId, token, amount, burnMode, burned, pledged, payer, order }.
 * On Ethereum the burn happens in the payment; elsewhere the shop is paid in full and `pledged` is theirs to burn.
 * Your server must still check the payment with verifyPayment() before shipping anything.
 *
 * With the `demo` attribute the checkout walks through every step but never
 * asks a wallet for anything and sends nothing: for showing the flow on a website.
 */
export class ShibPayElement extends HTMLElement {
  static observedAttributes = ['to', 'amount', 'currency', 'burn', 'order', 'label', 'tokens', 'return-url', 'theme', 'splitter', 'demo'];

  private root: ShadowRoot;
  private wallets: WalletInfo[] = [];
  private view: View = 'choose';
  private open = false;
  private token: TokenSymbol = 'SHIB';
  private chainId = 109;
  private prices: Partial<Record<TokenSymbol, number>> = {};
  private priceState: 'idle' | 'loading' | 'ok' | 'error' = 'idle';
  private quotedAt = 0;
  private tag = 0n;
  private splitterOk = new Map<number, boolean>();
  private step: PayStep | null = null;
  private message = '';
  private result: Paid | null = null;
  private abort: AbortController | null = null;
  private timer: number | undefined;
  private lastFocus: Element | null = null;

  constructor() {
    super();
    this.root = this.attachShadow({ mode: 'open' });
    this.root.addEventListener('click', (e) => this.onClick(e));
    this.root.addEventListener('change', (e) => this.onChange(e));
    this.root.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Escape') this.close();
    });
  }

  connectedCallback() {
    window.addEventListener('eip6963:announceProvider', this.onAnnounce as EventListener);
    window.dispatchEvent(new Event('eip6963:requestProvider'));
    this.render();
  }

  disconnectedCallback() {
    window.removeEventListener('eip6963:announceProvider', this.onAnnounce as EventListener);
    this.abort?.abort();
    clearInterval(this.timer);
  }

  attributeChangedCallback() {
    if (this.isConnected) this.render();
  }

  /** Opens the checkout, as if the button had been pressed. */
  show() {
    const cfg = this.config();
    if (typeof cfg === 'string') return;
    this.lastFocus = document.activeElement;
    this.open = true;
    this.view = 'choose';
    this.token = cfg.tokens.includes('SHIB') ? 'SHIB' : cfg.tokens[0];
    if (TOKEN_SYMBOLS.includes(cfg.currency as TokenSymbol)) this.token = cfg.currency as TokenSymbol;
    this.chainId = chainsForToken(this.token)[0].chainId;
    this.tag = BigInt(1 + Math.floor(Math.random() * 9999)) * 10n ** 12n; // 3rd-6th decimals, see orderTag()
    this.render();
    this.loadPrices(cfg);
    this.checkSplitter(cfg);
    clearInterval(this.timer);
    this.timer = window.setInterval(() => this.tick(cfg), 1000);
    requestAnimationFrame(() => (this.root.querySelector('.sheet') as HTMLElement | null)?.focus());
  }

  close() {
    if (!this.open) return;
    this.open = false;
    this.abort?.abort();
    clearInterval(this.timer);
    this.render();
    (this.lastFocus as HTMLElement | null)?.focus?.();
  }

  // ── config ────────────────────────────────────────────────────────────────

  private config(): Config | string {
    try {
      const to = validateMerchantAddress(this.getAttribute('to') ?? '');
      const amount = (this.getAttribute('amount') ?? '').trim();
      if (!/^\d+(\.\d+)?$/.test(amount) || Number(amount) <= 0) return 'Set amount="..." to a positive number.';
      const currency = (this.getAttribute('currency') ?? 'USD').trim().toUpperCase();
      const tokensAttr = this.getAttribute('tokens');
      const tokens = (tokensAttr ? tokensAttr.split(',').map((t) => t.trim().toUpperCase()) : [...TOKEN_SYMBOLS])
        .filter((t): t is TokenSymbol => TOKEN_SYMBOLS.includes(t as TokenSymbol));
      if (!tokens.length) return 'tokens="..." lists no supported token (SHIB, BONE, LEASH, TREAT).';
      const returnUrl = this.getAttribute('return-url') ?? undefined;
      if (returnUrl && !/^https?:\/\//i.test(returnUrl)) return 'return-url must start with https://';
      const splitter = this.getAttribute('splitter') as `0x${string}` | null;
      return {
        to, amount, currency,
        burnBps: percentToBps(this.getAttribute('burn') ?? '0'),
        order: this.getAttribute('order') || `shibpay-${Date.now().toString(36)}`,
        label: this.getAttribute('label') ?? '',
        tokens,
        returnUrl,
        splitter: splitter ? validateMerchantAddress(splitter) : undefined,
      };
    } catch (err) {
      return (err as Error).message;
    }
  }

  private pricedInToken(cfg: Config) {
    return TOKEN_SYMBOLS.includes(cfg.currency as TokenSymbol);
  }

  /** Burned in the payment (Ethereum, splitter live), pledged by the shop, or none. */
  private mode(cfg: Config): BurnMode {
    return burnMode(this.chainId, cfg.burnBps, this.splitterOk.get(this.chainId) === true);
  }

  /** Amount the buyer pays in the selected token, or null while the price loads. */
  private quote(cfg: Config): bigint | null {
    const t = getToken(this.chainId, this.token);
    if (!t) return null;
    const base = this.pricedInToken(cfg)
      ? parseUnits(cfg.amount, t.decimals)
      : this.prices[this.token]
        ? quoteAmount(cfg.amount, this.prices[this.token]!, t.decimals)
        : null;
    if (base === null) return null;
    // Plain transfers carry no order number, so each order gets a unique amount.
    return this.mode(cfg) === 'in-tx' ? base : base + this.tag;
  }

  private async loadPrices(cfg: Config) {
    if (this.pricedInToken(cfg)) {
      this.priceState = 'ok';
      this.quotedAt = Date.now();
      return this.render();
    }
    this.priceState = 'loading';
    this.render();
    try {
      this.prices = await fetchPrices(cfg.tokens, cfg.currency);
      this.priceState = Object.keys(this.prices).length ? 'ok' : 'error';
      if (!this.prices[this.token]) {
        const first = cfg.tokens.find((t) => this.prices[t]);
        if (first) this.selectToken(first);
      }
    } catch {
      this.priceState = 'error';
    }
    this.quotedAt = Date.now();
    this.render();
  }

  private async checkSplitter(cfg: Config) {
    if (cfg.burnBps === 0 || this.chainId !== BURN_CHAIN_ID || this.splitterOk.has(this.chainId)) return;
    const id = this.chainId;
    try {
      this.splitterOk.set(id, await splitterAvailable(publicClientFor(id), cfg.splitter));
    } catch {
      // Can't tell from here (RPC blocked); the wallet path checks again before paying.
    }
    this.render();
  }

  private tick(cfg: Config) {
    if (this.view !== 'choose') return;
    const left = QUOTE_MS - (Date.now() - this.quotedAt);
    if (this.quotedAt && left <= 0) return void this.loadPrices(cfg);
    const el = this.root.querySelector('.lock');
    if (el && this.quotedAt) {
      const m = Math.floor(left / 60_000), s = Math.floor((left % 60_000) / 1000);
      el.textContent = this.pricedInToken(cfg) ? 'Exact amount, no conversion' : `Price held for ${m}:${String(s).padStart(2, '0')}`;
    }
  }

  // ── events ────────────────────────────────────────────────────────────────

  private onAnnounce = (e: CustomEvent<{ info: Omit<WalletInfo, 'provider'>; provider: Eip1193Provider }>) => {
    const { info, provider } = e.detail ?? {};
    if (!info?.uuid || !provider || this.wallets.some((w) => w.uuid === info.uuid)) return;
    this.wallets.push({ ...info, provider });
    // ShibWallet first.
    this.wallets.sort((a, b) => Number(/shib/i.test(b.rdns + b.name)) - Number(/shib/i.test(a.rdns + a.name)));
    if (this.open && this.view === 'choose') this.render();
  };

  private selectToken(t: TokenSymbol) {
    this.token = t;
    const chains = chainsForToken(t);
    if (!chains.some((c) => c.chainId === this.chainId)) this.chainId = chains[0].chainId;
  }

  private onChange(e: Event) {
    const el = e.target as HTMLSelectElement;
    if (el.name !== 'chain') return;
    this.chainId = Number(el.value);
    const cfg = this.config();
    if (typeof cfg !== 'string') this.checkSplitter(cfg);
    this.render();
  }

  private onClick(e: Event) {
    const target = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
    if (!target) {
      if ((e.target as HTMLElement).classList.contains('backdrop')) this.close();
      return;
    }
    const act = target.dataset.act!;
    if (act === 'open') return this.show();
    if (act === 'close') return this.close();
    if (act === 'token') {
      this.selectToken(target.dataset.token as TokenSymbol);
      const cfg = this.config();
      if (typeof cfg !== 'string') this.checkSplitter(cfg);
      return this.render();
    }
    if (act === 'wallet') {
      const w = this.wallets.find((x) => x.uuid === target.dataset.uuid);
      return void this.pay(w?.provider);
    }
    if (act === 'injected') return void this.pay((window as unknown as { ethereum?: Eip1193Provider }).ethereum);
    if (act === 'demo') return void this.demoPay();
    if (act === 'qr') return void this.showQr();
    if (act === 'back') {
      this.abort?.abort();
      this.view = 'choose';
      return this.render();
    }
    if (act === 'return') return this.goBack();
  }

  // ── paying ────────────────────────────────────────────────────────────────

  private async pay(provider: Eip1193Provider | undefined) {
    const cfg = this.config();
    if (typeof cfg === 'string' || !provider) return;
    const amount = this.quote(cfg);
    if (amount === null) return;
    const chain = getChain(this.chainId)!;
    this.view = 'progress';
    this.step = 'connecting';
    this.render();
    try {
      const res = await payWithWallet({
        provider, chainId: this.chainId, token: this.token, merchant: cfg.to, amount, burnBps: cfg.burnBps,
        orderId: cfg.order, splitter: cfg.splitter,
        onStep: (s) => {
          this.step = s;
          this.render();
        },
      });
      this.finish(cfg, { hash: res.hash, chainId: res.chainId, amount, payer: res.payer, mode: res.burnMode, burned: res.burned, pledged: res.pledged });
    } catch (err) {
      this.view = 'error';
      this.message = friendlyError(err, this.token, chain.name);
      this.render();
    }
  }

  private get demo() {
    return this.hasAttribute('demo');
  }

  /** Plays the payment steps without touching a wallet. */
  private async demoPay() {
    const cfg = this.config();
    if (typeof cfg === 'string') return;
    const amount = this.quote(cfg);
    if (amount === null) return;
    this.view = 'progress';
    for (const s of ['connecting', 'switching-chain', 'paying', 'confirming'] as PayStep[]) {
      this.step = s;
      this.render();
      await new Promise((r) => setTimeout(r, 650));
      if (!this.open || this.view !== 'progress') return;
    }
    const mode = this.mode(cfg);
    const share = mode === 'none' ? 0n : splitBurn(amount, cfg.burnBps).burned;
    this.result = {
      hash: `0x${'0'.repeat(64)}`, chainId: this.chainId, amount, payer: '', mode,
      burned: mode === 'in-tx' ? share : 0n, pledged: mode === 'pledge' ? share : 0n,
    };
    this.view = 'done';
    this.render();
  }

  private async showQr() {
    const cfg = this.config();
    if (typeof cfg === 'string') return;
    this.view = 'qr';
    this.render();
    const amount = this.quote(cfg);
    const token = getToken(this.chainId, this.token);
    if (this.mode(cfg) === 'in-tx' || !token || token.native || amount === null) return;

    // A plain transfer: watch the chain for this order's unique amount.
    this.abort?.abort();
    const abort = (this.abort = new AbortController());
    const client = publicClientFor(this.chainId);
    try {
      const fromBlock = (await client.getBlockNumber()) - 5n;
      const chainId = this.chainId, sym = this.token;
      const hash = await poll(
        () => findPayment({ client, chainId, token: sym, merchant: cfg.to, amount, orderId: cfg.order, fromBlock }),
        { signal: abort.signal, timeoutMs: QUOTE_MS },
      );
      if (!hash || abort.signal.aborted) return;
      const v = await poll(async () => {
        const r = await verifyPayment(client, hash, { chainId, token: sym, merchant: cfg.to, amount, burnBps: cfg.burnBps, minConfirmations: 1 });
        return r.ok ? r : null;
      }, { signal: abort.signal, intervalMs: 3000, timeoutMs: 5 * 60_000 });
      if (v) this.finish(cfg, { hash, chainId, amount: v.amount, payer: v.payer, mode: v.burnMode, burned: v.burned, pledged: v.pledged });
    } catch {
      // Watching is a convenience; the merchant's server verification is the source of truth.
    }
  }

  private finish(cfg: Config, r: Paid) {
    this.result = r;
    this.view = 'done';
    this.render();
    this.dispatchEvent(new CustomEvent('shibpay:paid', {
      bubbles: true, composed: true,
      detail: {
        txHash: r.hash, chainId: r.chainId, token: this.token, amount: r.amount.toString(),
        burnMode: r.mode, burned: r.burned.toString(), pledged: r.pledged.toString(),
        payer: r.payer, order: cfg.order, merchant: cfg.to,
      },
    }));
    if (cfg.returnUrl) setTimeout(() => this.open && this.view === 'done' && this.goBack(), 6000);
  }

  private goBack() {
    const cfg = this.config();
    if (typeof cfg === 'string' || !cfg.returnUrl || !this.result) return this.close();
    const u = new URL(cfg.returnUrl);
    u.searchParams.set('shibpay_tx', this.result.hash);
    u.searchParams.set('shibpay_chain', String(this.result.chainId));
    u.searchParams.set('shibpay_order', cfg.order);
    location.href = u.toString();
  }

  // ── rendering ─────────────────────────────────────────────────────────────

  private render() {
    const cfg = this.config();
    const theme = this.getAttribute('theme') === 'dark' ? 'dark' : '';
    const bad = typeof cfg === 'string';
    if (bad) console.error(`<shib-pay>: ${cfg}`);
    const trigger = `<button class="trigger ${theme}" part="button" data-act="open" ${bad ? `disabled title="${esc(cfg)}"` : ''}>
        <img src="${shibLogo}" alt="" /><span>Pay with <b>SHIB</b></span></button>`;
    const focused = this.root.activeElement as HTMLElement | null;
    const focusKey = focused?.dataset?.act ? `[data-act="${focused.dataset.act}"]${focused.dataset.token ? `[data-token="${focused.dataset.token}"]` : ''}` : focused?.getAttribute?.('name') ? `[name="${focused.getAttribute('name')}"]` : '';
    this.root.innerHTML = `<style>${STYLES}</style>${trigger}${this.open && !bad ? this.dialog(cfg as Config) : ''}`;
    if (focusKey) (this.root.querySelector(focusKey) as HTMLElement | null)?.focus();
  }

  private dialog(cfg: Config): string {
    const body =
      this.view === 'progress' ? this.progressView(cfg)
      : this.view === 'done' ? this.doneView(cfg)
      : this.view === 'error' ? this.errorView()
      : this.view === 'qr' ? this.qrView(cfg)
      : this.chooseView(cfg);
    return `<div class="backdrop"><div class="sheet" role="dialog" aria-modal="true" aria-label="Pay with SHIB" tabindex="-1">
      <header>${wordmark(20)}<button class="close" data-act="close" aria-label="Close">${CLOSE}</button></header>
      <div class="body">${body}</div></div></div>`;
  }

  private summary(cfg: Config, amount: bigint | null): string {
    const t = getToken(this.chainId, this.token)!;
    const priced = this.pricedInToken(cfg);
    const tokenLine = amount !== null
      ? `<b>${formatTokenAmount(amount, t.decimals)}</b> ${this.token}`
      : this.priceState === 'error' ? `<span class="err">Price unavailable right now</span>` : `<span class="skeleton"></span>`;
    return `${cfg.label ? `<div class="merchant">${esc(cfg.label)}</div>` : '<div class="merchant">Checkout</div>'}
      <div class="price">${priced ? `${esc(cfg.amount)} ${esc(cfg.currency)}` : esc(fiat(cfg.amount, cfg.currency))}</div>
      ${priced ? '' : `<div class="token-amount">${tokenLine}</div><div class="lock">${amount !== null ? 'Price held for 15:00' : ''}</div>`}
      ${this.burnLine(cfg)}`;
  }

  private burnLine(cfg: Config): string {
    const pct = esc(cfg.burnBps / 100);
    const mode = this.mode(cfg);
    if (mode === 'none') return '';
    return mode === 'in-tx'
      ? `<div class="burn">${FLAME}${pct}% of this payment is burned forever</div>`
      : `<div class="burn" title="Burns count on Ethereum, so the shop burns its share there.">${FLAME}${cfg.label ? esc(cfg.label) : 'The shop'} burns ${pct}% of this sale</div>`;
  }

  private chooseView(cfg: Config): string {
    const amount = this.quote(cfg);
    const chains = chainsForToken(this.token);
    const chain = getChain(this.chainId)!;
    const canPay = amount !== null;

    const tokens = cfg.tokens.map((s) => {
      const disabled = this.priceState === 'ok' && !this.pricedInToken(cfg) && !this.prices[s];
      const fixed = this.pricedInToken(cfg) && s !== cfg.currency;
      return `<button class="tok" data-act="token" data-token="${s}" aria-pressed="${s === this.token}" ${disabled || fixed ? 'disabled' : ''}>
        ${tokenLogo(s)}${s}</button>`;
    }).join('');

    const injected = (window as unknown as { ethereum?: unknown }).ethereum;
    const touch = matchMedia('(pointer: coarse)').matches;
    if (this.demo) {
      return `${this.summary(cfg, amount)}
      <div class="label">Pay with</div><div class="tokens">${tokens}</div>
      <div class="label">Network</div>
      <div class="net"><select name="chain" aria-label="Network">${chains.map((c) => `<option value="${c.chainId}" ${c.chainId === this.chainId ? 'selected' : ''}>${esc(c.name)}${c.chainId === 109 ? ' (lowest fees)' : ''}</option>`).join('')}</select></div>
      <div class="label">How do you want to pay?</div>
      <div class="wallets"><button class="wallet primary" data-act="demo" ${canPay ? '' : 'disabled'}><span class="ico">${WALLET}</span>
        <span class="grow">ShibWallet<span class="sub">Demo: nothing is sent</span></span>${CHEVRON}</button></div>
      <div class="foot"><span>Demo checkout</span><i class="dot"></i><span>No wallet needed</span></div>`;
    }
    const walletRows = this.wallets.map((w, i) => `<button class="wallet ${i === 0 ? 'primary' : ''}" data-act="wallet" data-uuid="${esc(w.uuid)}" ${canPay ? '' : 'disabled'}>
        <span class="ico">${/^data:image\//.test(w.icon) ? `<img src="${esc(w.icon)}" alt="" />` : WALLET}</span>
        <span class="grow">${esc(w.name)}<span class="sub">Pay ${amount !== null ? 'now' : ''} on ${esc(chain.name)}</span></span>${CHEVRON}</button>`).join('');
    const fallback = !this.wallets.length && injected
      ? `<button class="wallet primary" data-act="injected" ${canPay ? '' : 'disabled'}><span class="ico">${WALLET}</span>
          <span class="grow">Browser wallet<span class="sub">Pay on ${esc(chain.name)}</span></span>${CHEVRON}</button>` : '';
    const phone = `<button class="wallet ${!this.wallets.length && !injected ? 'primary' : ''}" data-act="qr" ${amount !== null ? '' : 'disabled'}>
        <span class="ico">${PHONE}</span><span class="grow">${touch ? 'Pay with a wallet app' : 'Pay from my phone'}<span class="sub">${touch ? 'Open in ShibWallet or scan the QR' : 'Scan a QR code with ShibWallet'}</span></span>${CHEVRON}</button>`;

    return `${this.summary(cfg, amount)}
      <div class="label">Pay with</div><div class="tokens">${tokens}</div>
      <div class="label">Network</div>
      <div class="net"><select name="chain" aria-label="Network">${chains.map((c) => `<option value="${c.chainId}" ${c.chainId === this.chainId ? 'selected' : ''}>${esc(c.name)}${c.chainId === 109 ? ' (lowest fees)' : ''}</option>`).join('')}</select></div>
      <div class="hint">Pick the network where your ${this.token} is.</div>
      <div class="label">How do you want to pay?</div>
      <div class="wallets">${walletRows}${fallback}${phone}</div>
      <div class="foot"><span>No fees</span><i class="dot"></i><span>Paid straight to the shop</span><i class="dot"></i><span>Non-custodial</span></div>`;
  }

  private progressView(cfg: Config): string {
    const twoSteps = this.mode(cfg) === 'in-tx';
    const text: Record<PayStep, [string, string]> = {
      'connecting': ['Connect your wallet', 'Approve the connection in your wallet.'],
      'switching-chain': [`Switch to ${getChain(this.chainId)!.name}`, 'Your wallet may ask to change network.'],
      'approving': [`Allow ${this.token} (step 1 of 2)`, `This lets the payment move exactly this amount of ${this.token}, nothing more.`],
      'paying': [twoSteps ? 'Confirm payment (step 2 of 2)' : 'Confirm payment', 'Check the amount in your wallet and confirm.'],
      'confirming': ['Sending…', 'Waiting for the network to confirm. This usually takes a few seconds.'],
    };
    const [big, small] = text[this.step ?? 'connecting'];
    const order: PayStep[] = ['connecting', 'switching-chain', ...(twoSteps ? ['approving' as const] : []), 'paying', 'confirming'];
    const idx = order.indexOf(this.step ?? 'connecting');
    return `<div class="center"><div class="spinner" role="status" aria-label="Working"></div>
      <div class="big">${esc(big)}</div><div class="small">${esc(small)}</div>
      <div class="steps">${order.map((_, i) => `<i class="${i <= idx ? 'on' : ''}"></i>`).join('')}</div></div>
      <button class="btn ghost" data-act="back">Cancel</button>`;
  }

  private doneView(cfg: Config): string {
    const r = this.result!;
    const t = getToken(r.chainId, this.token)!;
    const shop = cfg.label ? esc(cfg.label) : 'The shop';
    return `<div class="center done">${CHECK}<div class="big" style="margin-top:12px">${this.demo ? 'That’s the whole checkout' : 'Payment sent'}</div>
      <div class="small">${this.demo ? `In a real checkout, ${shop} would be paid now. This demo sent nothing.` : `${shop} has been paid. Thank you!`}</div></div>
      <div class="receipt">
        <div><span>Paid</span><span>${formatTokenAmount(r.amount, t.decimals)} ${this.token}</span></div>
        ${r.burned > 0n ? `<div><span>Burned forever</span><span style="color:var(--amber)">${formatTokenAmount(r.burned, t.decimals)} ${this.token}</span></div>` : ''}
        ${r.pledged > 0n ? `<div><span>Shop will burn</span><span style="color:var(--amber)">${formatTokenAmount(r.pledged, t.decimals)} ${this.token}</span></div>` : ''}
        <div><span>Network</span><span>${esc(getChain(r.chainId)!.name)}</span></div>
        <div><span>Order</span><span>${esc(cfg.order)}</span></div>
      </div>
      ${this.demo ? '' : `<div class="center"><a class="link" href="${esc(explorerTxUrl(r.chainId, r.hash))}" target="_blank" rel="noopener">View receipt on the explorer</a></div>`}
      <button class="btn" data-act="return">${cfg.returnUrl ? 'Back to the shop' : 'Done'}</button>`;
  }

  private errorView(): string {
    return `<div class="center"><div class="big">Payment not sent</div><div class="small">${esc(this.message)}</div></div>
      <button class="btn" data-act="back">Try again</button>`;
  }

  private qrView(cfg: Config): string {
    const amount = this.quote(cfg);
    const token = getToken(this.chainId, this.token)!;
    const chain = getChain(this.chainId)!;
    const direct = this.mode(cfg) !== 'in-tx' && !token.native && amount !== null;
    const data = direct ? toEip681({ chainId: this.chainId, token: this.token, merchant: cfg.to, amount: amount! }) : location.href;
    const qr = qrcode(0, 'M');
    qr.addData(data);
    qr.make();
    const svg = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
    return `${this.summary(cfg, amount)}
      <div class="qr" style="margin-top:18px">${svg}<img src="${shibLogo}" alt="" /></div>
      <div class="center">${direct
        ? `<div class="small">Scan with ShibWallet or any wallet app.<br/>It sends exactly <b style="color:#fff">${formatTokenAmount(amount!, token.decimals)} ${this.token}</b> on ${esc(chain.name)}.</div>
           <div class="pulse">Waiting for your payment…</div>
           ${matchMedia('(pointer: coarse)').matches ? `<a class="btn" href="${esc(data)}">Open in my wallet app</a>` : ''}`
        : `<div class="small">Scan to open this checkout inside your wallet app's browser (ShibWallet, MetaMask, Trust…), then tap Pay there.</div>`}
      </div>
      <button class="btn ghost" data-act="back">Back</button>`;
  }
}

if (!customElements.get('shib-pay')) customElements.define('shib-pay', ShibPayElement);
