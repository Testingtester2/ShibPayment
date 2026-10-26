import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const pkg = (name: string) => fileURLToPath(new URL(`../${name}/src/index.ts`, import.meta.url));

// One self-contained script: <script src="shib-pay.js"></script> and the tag works.
export default defineConfig({
  resolve: {
    alias: {
      '@shibpay/chains': pkg('chains'),
      '@shibpay/core': pkg('core'),
      '@shibpay/contracts': pkg('contracts'),
    },
  },
  build: {
    lib: { entry: 'src/index.ts', name: 'ShibPay', formats: ['iife', 'es'], fileName: (f) => (f === 'es' ? 'shib-pay.mjs' : 'shib-pay.js') },
    target: 'es2020',
    minify: true,
  },
});
