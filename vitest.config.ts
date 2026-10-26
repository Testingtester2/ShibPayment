import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const pkg = (name: string) => fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@shibpay/chains': pkg('chains'),
      '@shibpay/core': pkg('core'),
      '@shibpay/contracts': pkg('contracts'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/woocommerce/test/**/*.test.ts', 'apps/web/test/**/*.test.ts'],
    testTimeout: 30_000,
  },
});
