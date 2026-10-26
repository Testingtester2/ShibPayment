import qrcode from 'qrcode-generator';
import { parseUnits } from 'viem';
import {
  BURN_CHAIN_ID, TOKEN_SYMBOLS, InsufficientBalanceError, burnMode, chainsForToken, explorerTxUrl, fetchPrices, findPayment, formatTokenAmount,
  getChain, getToken, payWithWallet, percentToBps, poll, publicClientFor, quoteAmount, splitBurn,
  splitterAvailable, toEip681, validateMerchantAddress, verifyPayment,
  SOLANA_SHIB, findSolanaPayment, isSolanaAddress, newReference, payWithSolanaWallet, solanaTxUrl, toSolanaPayUrl, validateSolanaAddress,
  verifySolanaPayment, watchSolanaWallets,
  type BurnMode, type Eip1193Provider, type PayStep, type SolanaWallet, type TokenSymbol,
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
  /** Shop's Solana wallet: offers SHIB on Solana when set. */
  sol?: string;
  solanaRpc?: string;
  /** Reown (WalletConnect) project ID: offers phone wallets over WalletConnect when set. */
  walletConnect?: string;
}

/** `solana` set: `hash` is a Solana signature and `chainId` is unused. */
interface Paid { hash: string; chainId: number; amount: bigint; payer: string; mode: BurnMode; burned: bigint; pledged: bigint; solana?: boolean }

const QUOTE_MS = 15 * 60_000;

// shib-pay-walletconnect.js sits next to this script; it is large, so it is fetched only when used.
const SCRIPT_SRC = (typeof document !== 'undefined' && (document.currentScript as HTMLScriptElement | null)?.src) || 'https://shibpayments.shibfun.app/shib-pay.js';
type WalletConnectModule = typeof import('./walletconnect');
const loadWalletConnect = (): Promise<WalletConnectModule> => import(/* @vite-ignore */ ShibPayElement.walletConnectScript);

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
 * Add sol="<Solana address>" to also take SHIB on Solana (Solana Pay; solana-rpc="..." to use your own RPC).
 * Add walletconnect="<Reown project ID>" to offer phone wallets (Trust, Rainbow, MetaMask Mobile…) over
 * WalletConnect. Allow your site's domain in the Reown dashboard.
 *
 * Fires `shibpay:paid` (bubbles, composed) with { txHash, chainId, token, amount, burnMode, burned, pledged, payer, order }.
 * On Solana, chainId is "solana", txHash is the signature and `reference` is the checkout's Solana Pay reference.
 * On Ethereum the burn happens in the payment; elsewhere the shop is paid in full and `pledged` is theirs to burn.
 * Your server must still check the payment with verifyPayment() before shipping anything.
 *
 * With the `demo` attribute the checkout walks through every step but never
 * asks a wallet for anything and sends nothing: for showing the flow on a website.
 */
export class ShibPayElement extends HTMLElement {
  /** Where WalletConnect support is loaded from. Defaults to next to shib-pay.js. */
  static walletConnectScript = new URL('shib-pay-walletconnect.js', SCRIPT_SRC).href;

  static observedAttributes = ['to', 'amount', 'currency', 'burn', 'order', 'label', 'tokens', 'return-url', 'theme', 'splitter', 'demo', 'tag', 'sol', 'solana-rpc', 'reference', 'walletconnect'];

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
  /** Steps this payment has gone through, so the progress dots match what the wallet actually asked. */
  private seen = new Set<PayStep>();
  private message = '';
  private result: Paid | null = null;
  private abort: AbortController | null = null;
  private timer: number | undefined;
  private lastFocus: Element | null = null;
  // Solana
  private solana = false;
  private solWallets: SolanaWallet[] = [];
  private reference = '';
  private stopSolWallets: (() => void) | null = null;

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
    this.stopSolWallets = watchSolanaWallets((ws) => {
      this.solWallets = ws;
      if (this.open && this.view === 'choose') this.render();
    });
    this.render();
  }

  disconnectedCallback() {
    window.removeEventListener('eip6963:announceProvider', this.onAnnounce as EventListener);
    this.abort?.abort();
    clearInterval(this.timer);
    this.stopSolWallets?.();
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
    this.solana = false;
    // Solana Pay reference. A shop's server can pick it (reference="<base58 key>") to find and tie the payment to its order.
    const ref = this.getAttribute('reference');
    this.reference = ref && isSolanaAddress(ref) ? ref : newReference();
    // 3rd-6th decimals, see orderTag(). A shop's server can pick it (tag="1234") to tie the payment to its order.
    const tag = Number(this.getAttribute('tag'));
    this.tag = BigInt(Number.isInteger(tag) && tag >= 1 && tag <= 9999 ? tag : 1 + Math.floor(Math.random() * 9999)) * 10n ** 12n;
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
      const sol = this.getAttribute('sol');
      const solanaRpc = this.getAttribute('solana-rpc') ?? undefined;
      if (solanaRpc && !/^https:\/\//i.test(solanaRpc)) return 'solana-rpc must start with https://';
      return {
        to, amount, currency,
        burnBps: percentToBps(this.getAttribute('burn') ?? '0'),
        order: this.getAttribute('order') || `shibpay-${Date.now().toString(36)}`,
        label: this.getAttribute('label') ?? '',
        tokens,
        returnUrl,
        splitter: splitter ? validateMerchantAddress(splitter) : undefined,
        sol: sol ? validateSolanaAddress(sol) : undefined,
        solanaRpc,
        walletConnect: this.getAttribute('walletconnect')?.trim() || undefined,
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
    // Only Ethereum burns count, so on Solana a burn is always the shop's pledge.
    if (this.solana) return cfg.burnBps > 0 ? 'pledge' : 'none';
    return burnMode(this.chainId, cfg.burnBps, this.splitterOk.get(this.chainId) === true);
  }

  /** Amount the buyer pays in the selected token, or null while the price loads. */
  private quote(cfg: Config): bigint | null {
    const decimals = this.decimals();
    if (decimals === null) return null;
    const base = this.pricedInToken(cfg)
      ? parseUnits(cfg.amount, decimals)
      : this.prices[this.token]
        ? quoteAmount(cfg.amount, this.prices[this.token]!, decimals)
        : null;
    if (base === null) return null;
    // Solana payments carry the checkout's reference key, so they need no unique amount.
    if (this.solana) return base;
    // Plain transfers carry no order number, so each order gets a unique amount.
    return this.mode(cfg) === 'in-tx' ? base : base + this.tag;
  }

  /** Decimals of the selected token on the selected network. */
  private decimals(): number | null {
    if (this.solana) return SOLANA_SHIB.decimals;
    return getToken(this.chainId, this.token)?.decimals ?? null;
  }

  private networkName(): string {
    return this.solana ? 'Solana' : getChain(this.chainId)!.name;
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
    if (t !== 'SHIB') this.solana = false;
    const chains = chainsForToken(t);
    if (!chains.some((c) => c.chainId === this.chainId)) this.chainId = chains[0].chainId;
  }

  private onChange(e: Event) {
    const el = e.target as HTMLSelectElement;
    if (el.name !== 'chain') return;
    const cfg = this.config();
    this.solana = el.value === 'solana';
    if (!this.solana) this.chainId = Number(el.value);
    if (typeof cfg !== 'string') {
      if (!this.solana) this.checkSplitter(cfg);
    }
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
    if (act === 'solwallet') return void this.paySolana(this.solWallets[Number(target.dataset.i)]);
    if (act === 'injected') return void this.pay((window as unknown as { ethereum?: Eip1193Provider }).ethereum);
    if (act === 'walletconnect') return void this.payWalletConnect();
    if (act === 'demo') return void this.demoPay();
    if (act === 'copy') return void this.copyLink();
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
    this.seen.clear();
    this.render();
    try {
      const res = await payWithWallet({
        provider, chainId: this.chainId, token: this.token, merchant: cfg.to, amount, burnBps: cfg.burnBps,
        orderId: cfg.order, splitter: cfg.splitter,
        onStep: (s) => {
          this.step = s;
          this.seen.add(s);
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

  private async payWalletConnect() {
    const cfg = this.config();
    if (typeof cfg === 'string' || !cfg.walletConnect) return;
    const chain = getChain(this.chainId)!;
    this.view = 'progress';
    this.step = 'connecting';
    this.seen.clear();
    this.render();
    let provider: Eip1193Provider;
    try {
      const wc = await loadWalletConnect();
      const chains = [chain, ...chainsForToken(this.token).filter((c) => c.chainId !== chain.chainId)];
      provider = await wc.connectWalletConnect({
        projectId: cfg.walletConnect,
        chainIds: chains.map((c) => c.chainId),
        rpcMap: Object.fromEntries(chains.map((c) => [c.chainId, c.rpcUrls[0]])),
        zIndex: 2147483600,
      }) as unknown as Eip1193Provider;
    } catch (err) {
      // Closing Reown's wallet picker is not an error: back to the choices.
      const text = String((err as Error)?.message ?? err).toLowerCase();
      if (text.includes('closed') || text.includes('rejected') || text.includes('reset')) {
        this.view = 'choose';
        this.render();
        return;
      }
      this.view = 'error';
      this.message = `Couldn't open WalletConnect: ${(err as Error)?.message ?? err}`;
      this.render();
      return;
    }
    await this.pay(provider);
  }

  private async paySolana(wallet: SolanaWallet | undefined) {
    const cfg = this.config();
    if (typeof cfg === 'string' || !wallet || !cfg.sol) return;
    const amount = this.quote(cfg);
    if (amount === null) return;
    this.view = 'progress';
    this.step = 'connecting';
    this.render();
    try {
      const r = await payWithSolanaWallet({
        wallet, url: cfg.solanaRpc, recipient: cfg.sol, amount, reference: this.reference, burnBps: cfg.burnBps,
        onStep: (s) => {
          this.step = s;
          this.render();
        },
      });
      this.finish(cfg, { hash: r.signature, chainId: 0, amount, payer: r.payer, mode: r.burnMode, burned: 0n, pledged: r.pledged, solana: true });
    } catch (err) {
      this.view = 'error';
      this.message = friendlyError(err, this.token, 'Solana');
      this.render();
    }
  }

  private copied = false;

  private async copyLink() {
    try {
      await navigator.clipboard.writeText(location.href);
      this.copied = true;
    } catch {
      window.prompt('Copy this link', location.href);
    }
    this.render();
    setTimeout(() => {
      this.copied = false;
      if (this.view === 'qr') this.render();
    }, 2500);
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
    for (const s of (this.solana ? ['connecting', 'paying', 'confirming'] : ['connecting', 'switching-chain', 'paying', 'confirming']) as PayStep[]) {
      this.step = s;
      this.render();
      await new Promise((r) => setTimeout(r, 650));
      if (!this.open || this.view !== 'progress') return;
    }
    const mode = this.mode(cfg);
    const share = mode === 'none' ? 0n : splitBurn(amount, cfg.burnBps).burned;
    this.result = {
      hash: `0x${'0'.repeat(64)}`, chainId: this.chainId, amount, payer: '', mode,
      burned: mode === 'in-tx' ? share : 0n, pledged: mode === 'pledge' ? share : 0n, solana: this.solana,
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
    if (this.solana) return void this.watchSolana(cfg, amount);
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

  /** Waits for a Solana Pay payment carrying this checkout's reference. */
  private async watchSolana(cfg: Config, amount: bigint | null) {
    if (amount === null || !cfg.sol || this.demo) return;
    this.abort?.abort();
    const abort = (this.abort = new AbortController());
    const rpc = { url: cfg.solanaRpc }, recipient = cfg.sol, reference = this.reference;
    try {
      const sig = await poll(() => findSolanaPayment(rpc, reference), { signal: abort.signal, intervalMs: 4000, timeoutMs: QUOTE_MS });
      if (!sig || abort.signal.aborted) return;
      const v = await poll(async () => {
        const r = await verifySolanaPayment(rpc, sig, { recipient, amount, reference, burnBps: cfg.burnBps, commitment: 'confirmed' });
        return r.ok ? r : null;
      }, { signal: abort.signal, intervalMs: 3000, timeoutMs: 5 * 60_000 });
      if (v) this.finish(cfg, { hash: sig, chainId: 0, amount: v.amount, payer: v.payer, mode: v.burnMode, burned: 0n, pledged: v.pledged, solana: true });
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
        txHash: r.hash, chainId: r.solana ? 'solana' : r.chainId, token: this.token, amount: r.amount.toString(),
        burnMode: r.mode, burned: r.burned.toString(), pledged: r.pledged.toString(),
        payer: r.payer, order: cfg.order, merchant: r.solana ? cfg.sol : cfg.to,
        ...(r.solana ? { reference: this.reference } : {}),
      },
    }));
    if (cfg.returnUrl) setTimeout(() => this.open && this.view === 'done' && this.goBack(), 6000);
  }

  private goBack() {
    const cfg = this.config();
    // A demo sent nothing, so it never hands the shop a transaction reference.
    if (typeof cfg === 'string' || !cfg.returnUrl || !this.result || this.demo) return this.close();
    const u = new URL(cfg.returnUrl);
    u.searchParams.set('shibpay_tx', this.result.hash);
    u.searchParams.set('shibpay_chain', this.result.solana ? 'solana' : String(this.result.chainId));
    if (this.result.solana) u.searchParams.set('shibpay_ref', this.reference);
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
    const decimals = this.decimals() ?? 0;
    const priced = this.pricedInToken(cfg);
    const tokenLine = amount !== null
      ? `<b>${formatTokenAmount(amount, decimals)}</b> ${this.token}`
      : this.priceState === 'error' ? `<span class="err">Price unavailable right now</span>`
      : `<span class="skeleton"></span>`;
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
    const chain = this.networkName();
    const canPay = amount !== null;
    const options = chains.map((c) => `<option value="${c.chainId}" ${!this.solana && c.chainId === this.chainId ? 'selected' : ''}>${esc(c.name)}${c.chainId === 109 ? ' (lowest fees)' : ''}</option>`).join('')
      + (cfg.sol && this.token === 'SHIB' ? `<option value="solana" ${this.solana ? 'selected' : ''}>Solana</option>` : '');

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
      <div class="net"><select name="chain" aria-label="Network">${options}</select></div>
      <div class="label">How do you want to pay?</div>
      <div class="wallets"><button class="wallet primary" data-act="demo" ${canPay ? '' : 'disabled'}><span class="ico">${WALLET}</span>
        <span class="grow">ShibWallet<span class="sub">Demo: nothing is sent</span></span>${CHEVRON}</button></div>
      <div class="foot"><span>Demo checkout</span><i class="dot"></i><span>No wallet needed</span></div>`;
    }
    const walletRows = this.solana
      ? this.solWallets.map((w, i) => `<button class="wallet ${i === 0 ? 'primary' : ''}" data-act="solwallet" data-i="${i}" ${canPay ? '' : 'disabled'}>
        <span class="ico">${/^data:image\//.test(w.icon) ? `<img src="${esc(w.icon)}" alt="" />` : WALLET}</span>
        <span class="grow">${esc(w.name)}<span class="sub">Pay on Solana</span></span>${CHEVRON}</button>`).join('')
      : this.wallets.map((w, i) => `<button class="wallet ${i === 0 ? 'primary' : ''}" data-act="wallet" data-uuid="${esc(w.uuid)}" ${canPay ? '' : 'disabled'}>
        <span class="ico">${/^data:image\//.test(w.icon) ? `<img src="${esc(w.icon)}" alt="" />` : WALLET}</span>
        <span class="grow">${esc(w.name)}<span class="sub">Pay ${amount !== null ? 'now' : ''} on ${esc(chain)}</span></span>${CHEVRON}</button>`).join('');
    const fallback = !this.solana && !this.wallets.length && injected
      ? `<button class="wallet primary" data-act="injected" ${canPay ? '' : 'disabled'}><span class="ico">${WALLET}</span>
          <span class="grow">Browser wallet<span class="sub">Pay on ${esc(chain)}</span></span>${CHEVRON}</button>` : '';
    const wc = !this.solana && cfg.walletConnect
      ? `<button class="wallet ${!this.wallets.length && !injected ? 'primary' : ''}" data-act="walletconnect" ${canPay ? '' : 'disabled'}><span class="ico">${PHONE}</span>
          <span class="grow">WalletConnect<span class="sub">${touch ? 'MetaMask, Trust, Rainbow and other wallet apps' : 'Scan with MetaMask, Trust or another phone wallet'}</span></span>${CHEVRON}</button>` : '';
    const noneFound = this.solana ? !this.solWallets.length : !this.wallets.length && !injected && !wc;
    const phoneSub = this.solana
      ? touch ? 'Open in Phantom, Solflare or another Solana wallet' : 'Scan a QR code with Phantom or Solflare'
      : touch ? 'Open in ShibWallet or scan the QR' : 'Scan a QR code with ShibWallet';
    const phone = `<button class="wallet ${noneFound ? 'primary' : ''}" data-act="qr" ${amount !== null ? '' : 'disabled'}>
        <span class="ico">${PHONE}</span><span class="grow">${touch ? 'Pay with a wallet app' : 'Pay from my phone'}<span class="sub">${phoneSub}</span></span>${CHEVRON}</button>`;

    return `${this.summary(cfg, amount)}
      <div class="label">Pay with</div><div class="tokens">${tokens}</div>
      <div class="label">Network</div>
      <div class="net"><select name="chain" aria-label="Network">${options}</select></div>
      <div class="hint">Pick the network where your ${this.token} is.</div>
      <div class="label">How do you want to pay?</div>
      <div class="wallets">${walletRows}${fallback}${wc}${phone}</div>
      <div class="foot"><span>No fees</span><i class="dot"></i><span>Paid straight to the shop</span><i class="dot"></i><span>Non-custodial</span></div>`;
  }

  private progressView(cfg: Config): string {
    // In-transaction burns need an approval first, unless the wallet bundled it with the payment.
    const bundled = this.seen.has('approve-and-pay');
    const twoSteps = !this.solana && this.mode(cfg) === 'in-tx' && !bundled && (this.seen.has('approving') || this.step === 'connecting' || this.step === 'switching-chain');
    const text: Record<PayStep, [string, string]> = {
      'connecting': ['Connect your wallet', 'Approve the connection in your wallet.'],
      'switching-chain': [`Switch to ${this.networkName()}`, 'Your wallet may ask to change network.'],
      'approving': [`Allow ${this.token} (step 1 of 2)`, `This lets the payment move exactly this amount of ${this.token}, nothing more.`],
      'paying': [twoSteps ? 'Confirm payment (step 2 of 2)' : 'Confirm payment', 'Check the amount in your wallet and confirm.'],
      'approve-and-pay': ['Confirm payment', `One confirmation allows exactly this amount of ${this.token} and pays. Check it in your wallet.`],
      'confirming': ['Sending…', 'Waiting for the network to confirm. This usually takes a few seconds.'],
    };
    const [big, small] = text[this.step ?? 'connecting'];
    const order: PayStep[] = ['connecting', ...(this.solana ? [] : ['switching-chain' as const]), ...(twoSteps ? ['approving' as const] : []), bundled ? 'approve-and-pay' : 'paying', 'confirming'];
    const idx = order.indexOf(this.step ?? 'connecting');
    return `<div class="center"><div class="spinner" role="status" aria-label="Working"></div>
      <div class="big">${esc(big)}</div><div class="small">${esc(small)}</div>
      <div class="steps">${order.map((_, i) => `<i class="${i <= idx ? 'on' : ''}"></i>`).join('')}</div></div>
      <button class="btn ghost" data-act="back">Cancel</button>`;
  }

  private doneView(cfg: Config): string {
    const r = this.result!;
    const d = r.solana ? SOLANA_SHIB.decimals : getToken(r.chainId, this.token)!.decimals;
    const shop = cfg.label ? esc(cfg.label) : 'The shop';
    return `<div class="center done">${CHECK}<div class="big" style="margin-top:12px">${this.demo ? 'That’s the whole checkout' : 'Payment sent'}</div>
      <div class="small">${this.demo ? `In a real checkout, ${shop} would be paid now. This demo sent nothing.` : `${shop} has been paid. Thank you!`}</div></div>
      <div class="receipt">
        <div><span>Paid</span><span>${formatTokenAmount(r.amount, d)} ${this.token}</span></div>
        ${r.burned > 0n ? `<div><span>Burned forever</span><span style="color:var(--amber)">${formatTokenAmount(r.burned, d)} ${this.token}</span></div>` : ''}
        ${r.pledged > 0n ? `<div><span>Shop will burn</span><span style="color:var(--amber)">${formatTokenAmount(r.pledged, d)} ${this.token}</span></div>` : ''}
        <div><span>Network</span><span>${esc(r.solana ? 'Solana' : getChain(r.chainId)!.name)}</span></div>
        <div><span>Order</span><span>${esc(cfg.order)}</span></div>
      </div>
      ${this.demo ? '' : `<div class="center"><a class="link" href="${esc(r.solana ? solanaTxUrl(r.hash) : explorerTxUrl(r.chainId, r.hash))}" target="_blank" rel="noopener">View receipt on the explorer</a></div>`}
      <button class="btn" data-act="return">${cfg.returnUrl && !this.demo ? 'Back to the shop' : 'Done'}</button>`;
  }

  private errorView(): string {
    return `<div class="center"><div class="big">Payment not sent</div><div class="small">${esc(this.message)}</div></div>
      <button class="btn" data-act="back">Try again</button>`;
  }

  private qrView(cfg: Config): string {
    if (this.solana) return this.solanaQrView(cfg);
    const amount = this.quote(cfg);
    const token = getToken(this.chainId, this.token)!;
    const chain = getChain(this.chainId)!;
    const direct = this.mode(cfg) !== 'in-tx' && !token.native && amount !== null;
    const data = direct ? toEip681({ chainId: this.chainId, token: this.token, merchant: cfg.to, amount: amount! }) : location.href;
    const qr = qrcode(0, 'M');
    qr.addData(data);
    qr.make();
    const svg = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
    const exact = direct ? `It sends exactly <b style="color:#fff">${formatTokenAmount(amount!, token.decimals)} ${this.token}</b> on ${esc(chain.name)}.` : '';
    const waiting = direct ? '<div class="pulse">Waiting for your payment…</div>' : '';

    if (matchMedia('(pointer: coarse)').matches) {
      // On a phone a QR of the same screen can't be scanned: hand the checkout to a wallet app instead.
      const here = location.href;
      const metamask = `https://metamask.app.link/dapp/${location.host}${location.pathname}${location.search}`;
      const trust = `https://link.trustwallet.com/open_url?coin_id=60&url=${encodeURIComponent(here)}`;
      return `${this.summary(cfg, amount)}
        ${direct ? `<a class="btn" href="${esc(data)}">Open in my wallet app</a><div class="small center" style="margin-top:8px">${exact}</div>` : ''}
        <div class="label">${direct ? 'Or open this checkout in' : 'Open this checkout in'}</div>
        <div class="apps">
          <a class="btn ghost" href="${esc(metamask)}">MetaMask</a>
          <a class="btn ghost" href="${esc(trust)}">Trust Wallet</a>
        </div>
        <button class="btn ghost" data-act="copy">${this.copied ? 'Link copied' : 'Copy link for ShibWallet'}</button>
        <div class="small center" style="margin-top:8px">In ShibWallet, paste it into the dApp browser and tap Pay there.</div>
        ${waiting}
        <details class="other"><summary>Paying from another phone? Show QR</summary>
          <div class="qr">${svg}<img src="${shibLogo}" alt="" /></div></details>
        <button class="btn ghost" data-act="back">Back</button>`;
    }
    return `${this.summary(cfg, amount)}
      <div class="qr" style="margin-top:18px">${svg}<img src="${shibLogo}" alt="" /></div>
      <div class="center">${direct
        ? `<div class="small">Scan with ShibWallet or any wallet app.<br/>${exact}</div>${waiting}`
        : `<div class="small">Scan to open this checkout inside your wallet app's browser (ShibWallet, MetaMask, Trust…), then tap Pay there.</div>`}
      </div>
      <button class="btn ghost" data-act="back">Back</button>`;
  }

  /** Solana Pay: one link any Solana wallet opens, as a QR or a tap. */
  private solanaQrView(cfg: Config): string {
    const amount = this.quote(cfg);
    const decimals = this.decimals();
    if (amount === null || decimals === null || !cfg.sol) return `${this.summary(cfg, amount)}<button class="btn ghost" data-act="back">Back</button>`;
    const data = toSolanaPayUrl({ recipient: cfg.sol, amount, decimals, reference: this.reference, label: cfg.label || undefined, message: cfg.order });
    const qr = qrcode(0, 'M');
    qr.addData(data);
    qr.make();
    const svg = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
    const exact = `It sends exactly <b style="color:#fff">${formatTokenAmount(amount, decimals)} SHIB</b> on Solana.`;
    const waiting = this.demo ? '' : '<div class="pulse">Waiting for your payment…</div>';
    if (matchMedia('(pointer: coarse)').matches) {
      const here = encodeURIComponent(location.href), ref = encodeURIComponent(location.origin);
      return `${this.summary(cfg, amount)}
        <a class="btn" href="${esc(data)}">Open in my Solana wallet</a><div class="small center" style="margin-top:8px">${exact}</div>
        <div class="label">Or open this checkout in</div>
        <div class="apps">
          <a class="btn ghost" href="${esc(`https://phantom.app/ul/browse/${here}?ref=${ref}`)}">Phantom</a>
          <a class="btn ghost" href="${esc(`https://solflare.com/ul/v1/browse/${here}?ref=${ref}`)}">Solflare</a>
        </div>
        ${waiting}
        <details class="other"><summary>Paying from another phone? Show QR</summary>
          <div class="qr">${svg}<img src="${shibLogo}" alt="" /></div></details>
        <button class="btn ghost" data-act="back">Back</button>`;
    }
    return `${this.summary(cfg, amount)}
      <div class="qr" style="margin-top:18px">${svg}<img src="${shibLogo}" alt="" /></div>
      <div class="center"><div class="small">Scan with Phantom, Solflare or any Solana Pay wallet.<br/>${exact}</div>${waiting}</div>
      <button class="btn ghost" data-act="back">Back</button>`;
  }

}

if (!customElements.get('shib-pay')) customElements.define('shib-pay', ShibPayElement);
