import { defineConfig } from 'vite';

// shib-pay-walletconnect.js: one ES module next to shib-pay.js, fetched only
// when a buyer picks WalletConnect.
export default defineConfig({
  define: { 'process.env.NODE_ENV': '"production"' },
  build: {
    lib: { entry: 'src/walletconnect.ts', formats: ['es'], fileName: () => 'shib-pay-walletconnect.js' },
    target: 'es2020',
    minify: true,
    emptyOutDir: false,
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
