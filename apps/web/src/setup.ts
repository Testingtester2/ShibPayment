import qrcode from 'qrcode-generator';
import { getEnsAddress } from 'viem/actions';
import { normalize } from 'viem/ens';
import {
  buildPaymentLink, isShibName, percentToBps, publicClientFor, resolveShibName, validateMerchantAddress, validateSolanaAddress,
} from '@shibpay/core';
import '@shibpay/button';
import { groupDigits, parsePrice } from './amount';

const form = document.getElementById('form') as HTMLFormElement;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const field = (name: string) => form.elements.namedItem(name) as HTMLInputElement;

let resolved: { input: string; address: `0x${string}` | null } = { input: '', address: null };
let resolving = 0;

function note(el: HTMLElement, text: string, kind: '' | 'ok' | 'bad' | 'warn' = '') {
  el.textContent = text;
  el.className = `note ${kind}`;
}

/** The receiving address: typed directly, or resolved from a .shib / .eth name. */
async function receiving(): Promise<`0x${string}` | null> {
  const input = field('to').value.trim();
  const toNote = $('toNote');
  if (!input) {
    field('to').removeAttribute('aria-invalid');
    note(toNote, 'Payments go straight here. One address works on all 13 networks.');
    return null;
  }
  if (input.startsWith('0x')) {
    try {
      const a = validateMerchantAddress(input);
      field('to').removeAttribute('aria-invalid');
      note(toNote, 'Looks good. Payments go straight to this wallet.', 'ok');
      return a;
    } catch (e) {
      field('to').setAttribute('aria-invalid', 'true');
      note(toNote, (e as Error).message, 'bad');
      return null;
    }
  }
  if (!isShibName(input) && !/\.eth$/i.test(input)) {
    field('to').setAttribute('aria-invalid', 'true');
    note(toNote, 'Enter a wallet address (0x…) or a .shib or .eth name.', 'bad');
    return null;
  }
  if (resolved.input === input) return resolved.address;
  const ticket = ++resolving;
  note(toNote, `Looking up ${input}…`);
  let address: `0x${string}` | null = null;
  try {
    address = isShibName(input)
      ? await resolveShibName(input)
      : await getEnsAddress(publicClientFor(1), { name: normalize(input) });
  } catch {
    address = null;
  }
  if (ticket !== resolving) return null;
  resolved = { input, address };
  if (address) {
    field('to').removeAttribute('aria-invalid');
    note(toNote, `${input} is ${address}. Make sure this is your wallet.`, 'ok');
  } else {
    field('to').setAttribute('aria-invalid', 'true');
    note(toNote, `Couldn't find ${input}. Check the name or paste the 0x address.`, 'bad');
  }
  return address;
}

/** Optional Solana wallet: undefined when empty, null when invalid. */
function solana(): string | undefined | null {
  const input = field('sol').value.trim();
  if (!input) {
    field('sol').removeAttribute('aria-invalid');
    note($('solNote'), "Leave empty if you don't use Solana.");
    return undefined;
  }
  try {
    const a = validateSolanaAddress(input);
    field('sol').removeAttribute('aria-invalid');
    note($('solNote'), 'Looks good. Buyers can now pay SHIB on Solana too.', 'ok');
    return a;
  } catch (e) {
    field('sol').setAttribute('aria-invalid', 'true');
    note($('solNote'), (e as Error).message, 'bad');
    return null;
  }
}

function burnBps(): number | null {
  try {
    const bps = percentToBps(field('burn').value || '0');
    const pct = bps / 100;
    note($('burnNote'), bps === 0
      ? '0% means no burn: you receive 100%.'
      : `Paid on Ethereum: ${pct}% is burned in the payment and you receive ${100 - pct}%. Paid on any other network: you receive 100% and burn ${pct}% yourself on Ethereum, where burns count. Buyers pay the same price either way.`, bps > 1000 ? 'warn' : '');
    $('burnHelp').hidden = bps === 0;
    $<HTMLAnchorElement>('burnHelp').href = `/burn.html?burn=${pct}`;
    return bps;
  } catch (e) {
    note($('burnNote'), (e as Error).message, 'bad');
    return null;
  }
}

/** The price as a plain number, with the exact amount echoed back so a misread can't slip through. */
function price(): string | null {
  const raw = field('amount').value.trim();
  const currency = (form.elements.namedItem('currency') as HTMLSelectElement).value;
  const amount = parsePrice(raw);
  if (!raw) note($('amountNote'), '');
  else if (amount === null) note($('amountNote'), 'Enter a price like 12.50 or 10,000.', 'bad');
  else if (currency === 'SHIB' || currency === 'BONE') note($('amountNote'), `Buyers pay exactly ${groupDigits(amount)} ${currency}.`, 'ok');
  else note($('amountNote'), `Buyers pay ${groupDigits(amount)} ${currency}, in SHIB, BONE, LEASH or TREAT at the live price.`, 'ok');
  return amount;
}

async function update() {
  const to = await receiving();
  const bps = burnBps();
  const sol = solana();
  const amount = price();
  const okAmount = amount !== null;
  const returnUrl = field('returnUrl').value.trim();
  const okReturn = !returnUrl || /^https?:\/\//i.test(returnUrl);
  if (!to || bps === null || sol === null || !okAmount || !okReturn) {
    $('empty').hidden = false;
    $('result').hidden = true;
    $('empty').textContent = !okReturn ? 'The return address must start with https://'
      : sol === null ? 'Check your Solana address, or leave it empty.' : 'Add your wallet and a price to see your payment link.';
    return;
  }
  const cfg = {
    to, sol, amount: amount!, currency: (form.elements.namedItem('currency') as HTMLSelectElement).value, burnBps: bps,
    order: field('order').value.trim() || undefined, label: field('label').value.trim() || undefined, returnUrl: returnUrl || undefined,
  };
  const link = buildPaymentLink(`${location.origin}/pay.html`, cfg);
  $<HTMLInputElement>('link').value = link;
  $<HTMLAnchorElement>('openLink').href = link;

  const qr = qrcode(0, 'M');
  qr.addData(link);
  qr.make();
  $('qr').innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });

  const attrs: [string, string | undefined][] = [
    ['to', cfg.to], ['sol', cfg.sol], ['amount', cfg.amount], ['currency', cfg.currency], ['burn', bps ? String(bps / 100) : undefined],
    ['order', cfg.order], ['label', cfg.label], ['return-url', cfg.returnUrl],
  ];
  const attrText = attrs.filter(([, v]) => v !== undefined).map(([k, v]) => `  ${k}="${v!.replace(/"/g, '&quot;')}"`).join('\n');
  $<HTMLTextAreaElement>('snippet').value = `<script src="${location.origin}/shib-pay.js"></script>\n<shib-pay\n${attrText}>\n</shib-pay>`;

  const pv = document.createElement('shib-pay');
  for (const [k, v] of attrs) if (v !== undefined) pv.setAttribute(k, v);
  $('pvButton').replaceChildren(pv);
  $('pvShop').textContent = cfg.label ?? 'Your shop';
  $('empty').hidden = true;
  $('result').hidden = false;
}

let debounce: number | undefined;
form.addEventListener('input', (e) => {
  const t = e.target as HTMLInputElement;
  if (t.name === 'burnRange') field('burn').value = t.value;
  if (t.name === 'burn') field('burnRange').value = String(Math.min(10, Number(t.value) || 0));
  clearTimeout(debounce);
  debounce = window.setTimeout(update, t.name === 'to' ? 500 : 150);
});
form.addEventListener('submit', (e) => e.preventDefault());

document.addEventListener('click', async (e) => {
  const id = (e.target as HTMLElement).closest<HTMLElement>('[data-copy]')?.dataset.copy;
  if (!id) return;
  const el = $<HTMLInputElement>(id);
  try {
    await navigator.clipboard.writeText(el.value);
  } catch {
    el.select();
    document.execCommand('copy');
  }
  $('toast').classList.add('on');
  setTimeout(() => $('toast').classList.remove('on'), 1400);
});
