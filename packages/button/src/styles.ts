// ShibWallet's palette: near-black surfaces, SHIB orange to amber gradient.
export const STYLES = `
:host {
  --bg: #0D0D0D; --surface: #1A1A1A; --surface-2: #222222; --border: #2E2E2E;
  --glass: rgba(255,255,255,0.04); --glass-border: rgba(255,255,255,0.08);
  --text: #FFFFFF; --muted: #9A9A9A; --faint: #6B6B6B;
  --orange: #FF6900; --orange-2: #FF8C00; --amber: #FFB800; --red: #FF5A4E; --green: #3DD68C;
  --glow: rgba(255,105,0,0.15); --glow-strong: rgba(255,105,0,0.35);
  --grad: linear-gradient(135deg, var(--orange) 0%, var(--orange-2) 50%, var(--amber) 100%);
  display: inline-block;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  -webkit-font-smoothing: antialiased;
}
*, *::before, *::after { box-sizing: border-box; }
button { font: inherit; color: inherit; cursor: pointer; border: 0; background: none; padding: 0; }
button:focus-visible, a:focus-visible, select:focus-visible { outline: 2px solid var(--amber); outline-offset: 2px; }

/* Trigger */
.trigger {
  display: inline-flex; align-items: center; gap: 10px; height: 48px; padding: 0 22px 0 8px;
  border-radius: 999px; background: var(--grad); color: #fff; font-weight: 700; font-size: 16px;
  letter-spacing: .01em; box-shadow: 0 4px 16px var(--glow-strong); transition: transform .15s, box-shadow .15s;
}
.trigger:hover { transform: translateY(-1px); box-shadow: 0 8px 30px var(--glow-strong); }
.trigger:active { transform: scale(.98); }
.trigger img { width: 34px; height: 34px; border-radius: 50%; background: #fff; padding: 2px; }
.trigger.dark { background: var(--bg); border: 1px solid var(--border); box-shadow: none; }
.trigger.dark span b { background: var(--grad); -webkit-background-clip: text; background-clip: text; color: transparent; }
.trigger[disabled] { opacity: .5; cursor: not-allowed; }

/* Dialog */
.backdrop {
  position: fixed; inset: 0; z-index: 2147483000; display: flex; align-items: center; justify-content: center;
  padding: 16px; background: rgba(0,0,0,.72); backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
  animation: fade .15s ease-out;
}
.sheet:focus { outline: none; }
.sheet {
  position: relative; width: 100%; max-width: 420px; max-height: calc(100vh - 32px); overflow: auto;
  background: var(--bg); color: var(--text); border: 1px solid var(--glass-border); border-radius: 24px;
  box-shadow: 0 30px 80px rgba(0,0,0,.6), 0 0 0 1px rgba(255,105,0,.06);
  animation: rise .25s cubic-bezier(.2,.8,.2,1);
}
.sheet::before {
  content: ""; position: absolute; inset: 0 0 auto 0; height: 160px; pointer-events: none; border-radius: 24px 24px 0 0;
  background: radial-gradient(ellipse at 50% -20%, var(--glow-strong), transparent 70%);
}
@media (max-width: 480px) {
  .backdrop { align-items: flex-end; padding: 0; }
  .sheet { max-width: none; border-radius: 24px 24px 0 0; max-height: 92vh; max-height: 92dvh; padding-bottom: env(safe-area-inset-bottom); animation: up .25s cubic-bezier(.2,.8,.2,1); }
}
@keyframes fade { from { opacity: 0 } }
@keyframes rise { from { opacity: 0; transform: translateY(12px) scale(.98) } }
@keyframes up { from { transform: translateY(100%) } }
@keyframes spin { to { transform: rotate(360deg) } }
@keyframes pop { 0% { transform: scale(.6); opacity: 0 } 70% { transform: scale(1.08) } 100% { transform: scale(1) } }

header { position: relative; display: flex; align-items: center; justify-content: space-between; padding: 18px 20px 6px; }
.close { width: 36px; height: 36px; border-radius: 50%; display: grid; place-items: center; color: var(--muted); background: var(--glass); }
.close:hover { color: var(--text); background: rgba(255,255,255,.08); }
.body { position: relative; padding: 8px 20px 20px; }

.wordmark { display: inline-flex; align-items: center; gap: 8px; font-weight: 800; font-size: var(--wm); letter-spacing: -.01em; line-height: 1; }
.wordmark img { width: calc(var(--wm) * 1.35); height: calc(var(--wm) * 1.35); }
.wm-shib { color: #fff; }
.wm-pay { background: linear-gradient(90deg, var(--orange), var(--amber)); -webkit-background-clip: text; background-clip: text; color: transparent; }
.tlogo { position: relative; display: grid; place-items: center; width: var(--tl); height: var(--tl); border-radius: 50%; background: var(--grad); color: #fff; font-weight: 800; font-size: calc(var(--tl) * .45); overflow: hidden; }
.tlogo img { position: absolute; inset: 0; width: 100%; height: 100%; border-radius: 50%; background: #fff; object-fit: cover; }

.merchant { color: var(--muted); font-size: 14px; margin: 10px 0 2px; text-align: center; }
.price { font-size: 40px; font-weight: 800; letter-spacing: -.02em; text-align: center; line-height: 1.15; }
.token-amount { margin-top: 6px; text-align: center; color: var(--muted); font-size: 15px; font-variant-numeric: tabular-nums; }
.token-amount b { color: var(--text); font-weight: 600; }
.lock { margin-top: 4px; text-align: center; color: var(--faint); font-size: 12px; }
.burn {
  display: flex; align-items: center; justify-content: center; gap: 6px; width: fit-content; margin: 12px auto 0;
  padding: 6px 12px; border-radius: 999px; font-size: 13px; font-weight: 600; color: var(--amber);
  background: rgba(255,105,0,.10); border: 1px solid rgba(255,105,0,.25);
}

.label { margin: 22px 0 8px; font-size: 12px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: .08em; }
.tokens { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
.tok {
  display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 12px 4px 10px; border-radius: 16px;
  background: var(--surface); border: 1px solid var(--border); font-size: 13px; font-weight: 600; transition: border-color .15s, background .15s;
}
.tok:hover:not([disabled]) { border-color: rgba(255,105,0,.5); }
.tok[aria-pressed="true"] { border-color: var(--orange); background: rgba(255,105,0,.10); box-shadow: 0 0 20px var(--glow); }
.tok[disabled] { opacity: .35; cursor: not-allowed; }

.net { position: relative; }
.net select {
  appearance: none; -webkit-appearance: none; width: 100%; height: 48px; padding: 0 40px 0 14px; border-radius: 14px;
  background: var(--surface); color: var(--text); border: 1px solid var(--border); font: inherit; font-size: 15px; cursor: pointer;
}
.net::after { content: ""; position: absolute; right: 16px; top: 50%; width: 8px; height: 8px; border-right: 2px solid var(--muted); border-bottom: 2px solid var(--muted); transform: translateY(-70%) rotate(45deg); pointer-events: none; }
.hint { margin-top: 6px; font-size: 12px; color: var(--faint); }

.wallets { display: flex; flex-direction: column; gap: 8px; }
.wallet {
  display: flex; align-items: center; gap: 12px; width: 100%; height: 56px; padding: 0 14px; border-radius: 16px;
  background: var(--surface); border: 1px solid var(--border); font-weight: 600; font-size: 15px; text-align: left; transition: border-color .15s, background .15s;
}
.wallet[disabled] { opacity: .45; cursor: not-allowed; }
.wallet:hover:not([disabled]) { border-color: rgba(255,105,0,.5); background: var(--surface-2); }
.wallet .ico { width: 32px; height: 32px; border-radius: 10px; display: grid; place-items: center; background: var(--glass); color: var(--amber); overflow: hidden; flex: none; }
.wallet .ico img { width: 100%; height: 100%; object-fit: cover; }
.wallet .grow { flex: 1; }
.wallet .sub { display: block; font-size: 12px; font-weight: 500; color: var(--muted); margin-top: 2px; }
.wallet.primary { background: var(--grad); border: 0; color: #fff; box-shadow: 0 4px 16px var(--glow-strong); }
.wallet.primary .ico { background: rgba(255,255,255,.18); color: #fff; }
.wallet.primary .sub { color: rgba(255,255,255,.85); }
.wallet svg:last-child { color: var(--faint); }
.wallet.primary svg:last-child { color: #fff; }

.foot { margin-top: 18px; display: flex; align-items: center; justify-content: center; gap: 8px; font-size: 12px; color: var(--faint); text-align: center; }
.foot .dot { width: 3px; height: 3px; border-radius: 50%; background: var(--faint); }

.center { text-align: center; padding: 12px 0 4px; }
.spinner { width: 56px; height: 56px; margin: 8px auto 18px; border-radius: 50%; border: 4px solid var(--surface-2); border-top-color: var(--orange); border-right-color: var(--amber); animation: spin .9s linear infinite; }
.big { font-size: 20px; font-weight: 700; }
.small { margin-top: 8px; font-size: 14px; color: var(--muted); line-height: 1.5; }
.steps { display: flex; gap: 6px; justify-content: center; margin-top: 16px; }
.steps i { width: 28px; height: 4px; border-radius: 4px; background: var(--surface-2); }
.steps i.on { background: var(--grad); }
.done svg { animation: pop .4s ease-out; }
.receipt { margin: 18px 0 0; padding: 14px 16px; border-radius: 16px; background: var(--surface); border: 1px solid var(--border); text-align: left; font-size: 14px; }
.receipt div { display: flex; justify-content: space-between; gap: 12px; padding: 4px 0; }
.receipt span:first-child { color: var(--muted); }
.receipt span:last-child { font-weight: 600; font-variant-numeric: tabular-nums; text-align: right; }
.btn { display: flex; align-items: center; justify-content: center; width: 100%; height: 52px; margin-top: 16px; border-radius: 16px; font-weight: 700; font-size: 16px; background: var(--grad); color: #fff; box-shadow: 0 4px 16px var(--glow-strong); text-decoration: none; }
.btn.ghost { background: var(--glass); border: 1px solid var(--glass-border); box-shadow: none; color: var(--text); }
.apps { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.apps .btn { margin-top: 0; }
.other { margin-top: 16px; text-align: center; }
.other summary { cursor: pointer; color: var(--muted); font-size: 14px; padding: 10px; }
.other .qr { margin-top: 8px; }
.link { display: inline-block; margin-top: 12px; color: var(--amber); font-size: 14px; font-weight: 600; text-decoration: none; }
.link:hover { text-decoration: underline; }
.err { color: var(--red); }
.qr { width: 232px; height: 232px; margin: 8px auto 0; padding: 12px; border-radius: 20px; background: #fff; position: relative; }
.qr svg { display: block; width: 100%; height: 100%; }
.qr img { position: absolute; left: 50%; top: 50%; width: 44px; height: 44px; transform: translate(-50%,-50%); border-radius: 50%; background: #fff; padding: 3px; }
.pulse { display: inline-flex; align-items: center; gap: 8px; margin-top: 14px; font-size: 13px; color: var(--muted); }
.pulse::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: var(--orange); box-shadow: 0 0 0 0 var(--glow-strong); animation: ping 1.4s infinite; }
@keyframes ping { 70% { box-shadow: 0 0 0 10px rgba(255,105,0,0) } 100% { box-shadow: 0 0 0 0 rgba(255,105,0,0) } }
.skeleton { display: inline-block; width: 140px; height: 16px; border-radius: 6px; background: linear-gradient(90deg, var(--surface) 25%, var(--surface-2) 50%, var(--surface) 75%); background-size: 200% 100%; animation: shimmer 1.4s linear infinite; vertical-align: middle; }
@keyframes shimmer { from { background-position: 200% 0 } to { background-position: -200% 0 } }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }
`;
