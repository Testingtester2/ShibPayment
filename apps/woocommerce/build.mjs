// Packs the WordPress plugin into apps/web/dist/shibpayment-woocommerce.zip, so
// the website hosts the download. The plugin ships its own copy of shib-pay.js:
// checkout keeps working even if this site is down, and no outside script runs
// on the shop's pages.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const plugin = here('./shibpayment');
const button = here('../../packages/button/dist/shib-pay.js');
const logo = here('../web/public/shib-logo.png');
const out = here('../web/dist/shibpayment-woocommerce.zip');

if (!fs.existsSync(button)) throw new Error('Build the button first: npm run build -w @shibpay/button');
if (!fs.existsSync(path.dirname(out))) throw new Error('Build the website first: npm run build -w @shibpay/web');

const files = {};
(function walk(dir) {
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) walk(full);
    else files[`shibpayment/${path.relative(plugin, full).split(path.sep).join('/')}`] = fs.readFileSync(full);
  }
})(plugin);
files['shibpayment/assets/shib-pay.js'] = fs.readFileSync(button);
files['shibpayment/assets/shib-logo.png'] = fs.readFileSync(logo);

fs.writeFileSync(out, zipSync(files, { level: 9, mtime: new Date('2026-01-01') }));
console.log(`${path.relative(process.cwd(), out)}: ${Object.keys(files).length} files, ${(fs.statSync(out).size / 1024).toFixed(0)} KB`);
