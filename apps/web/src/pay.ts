import { parsePaymentLink } from '@shibpay/core';
import { ShibPayElement } from '@shibpay/button';

// Reown (WalletConnect) project for shibpayments.shibfun.app; it only works on domains allowed in its dashboard.
const WALLETCONNECT_PROJECT_ID = 'baa20aa26d36f8ba686135b5fac6bca8';
ShibPayElement.walletConnectScript = '/shib-pay-walletconnect.js';

const box = document.getElementById('box')!;

function text(tag: string, cls: string, value: string) {
  const el = document.createElement(tag);
  el.className = cls;
  el.textContent = value;
  return el;
}

function price(amount: string, currency: string) {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(Number(amount));
  } catch {
    // Exact token prices (SHIB, BONE): group the digits without going through floats.
    return `${amount.replace(/^(\d+)/, (i) => i.replace(/\B(?=(\d{3})+(?!\d))/g, ','))} ${currency}`;
  }
}

try {
  const cfg = parsePaymentLink(location.href);
  const btn = document.createElement('shib-pay');
  btn.setAttribute('to', cfg.to);
  if (cfg.sol) btn.setAttribute('sol', cfg.sol);
  btn.setAttribute('amount', cfg.amount);
  btn.setAttribute('currency', cfg.currency);
  if (cfg.burnBps) btn.setAttribute('burn', String(cfg.burnBps / 100));
  if (cfg.order) btn.setAttribute('order', cfg.order);
  if (cfg.label) btn.setAttribute('label', cfg.label);
  if (cfg.returnUrl) btn.setAttribute('return-url', cfg.returnUrl);
  btn.setAttribute('walletconnect', WALLETCONNECT_PROJECT_ID);

  box.append(
    text('div', 'muted', cfg.label ? `Pay ${cfg.label}` : 'Payment request'),
    text('div', 'price', price(cfg.amount, cfg.currency)),
    text('div', 'faint', `To ${cfg.to.slice(0, 6)}…${cfg.to.slice(-4)}${cfg.order ? ` · Order ${cfg.order}` : ''}`),
  );
  if (cfg.burnBps) box.append(Object.assign(text('div', 'pill', `${cfg.label ?? 'This shop'} burns ${cfg.burnBps / 100}% of every sale`), { style: 'margin-top:14px' }));
  box.append(btn);
  const trust = document.createElement('div');
  trust.className = 'trust';
  trust.append(text('span', '', 'No fees'), text('span', '', 'Paid straight to the shop'), text('span', '', 'We never hold your money'));
  box.append(trust);
  // Open the checkout straight away; closing it leaves the button to reopen.
  customElements.whenDefined('shib-pay').then(() => (btn as unknown as { show(): void }).show());
} catch (e) {
  box.append(text('h3', '', 'This payment link is not valid'), text('p', 'muted', (e as Error).message));
}
