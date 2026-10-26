import { defineConfig, type Plugin } from 'vite';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const pkg = (name: string) => here(`../../packages/${name}/src/index.ts`);

// Serve and ship the standalone button script at /shib-pay.js, so the embed
// snippet the link builder hands out works from this same site. WalletConnect
// support is a separate, larger file the button fetches only when used.
function buttonScript(): Plugin {
  const files = ['shib-pay.js', 'shib-pay-walletconnect.js'];
  const path = (f: string) => here(`../../packages/button/dist/${f}`);
  return {
    name: 'shib-pay-script',
    configureServer(server) {
      for (const f of files) {
        server.middlewares.use(`/${f}`, (_req, res) => {
          res.setHeader('content-type', 'text/javascript');
          res.end(fs.existsSync(path(f)) ? fs.readFileSync(path(f)) : '// run: npm run build -w @shibpay/button');
        });
      }
    },
    generateBundle() {
      for (const f of files) {
        if (!fs.existsSync(path(f))) this.error('Build the button first: npm run build -w @shibpay/button');
        this.emitFile({ type: 'asset', fileName: f, source: fs.readFileSync(path(f)) });
      }
    },
  };
}

export default defineConfig({
  resolve: {
    alias: {
      '@shibpay/chains': pkg('chains'),
      '@shibpay/core': pkg('core'),
      '@shibpay/contracts': pkg('contracts'),
      '@shibpay/button': pkg('button'),
    },
  },
  plugins: [buttonScript()],
  build: {
    target: 'es2020',
    rollupOptions: {
      input: { index: here('index.html'), setup: here('setup.html'), pay: here('pay.html'), burn: here('burn.html') },
    },
  },
});
