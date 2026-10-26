import { defineConfig, type Plugin } from 'vite';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const pkg = (name: string) => here(`../../packages/${name}/src/index.ts`);

// Serve and ship the standalone button script at /shib-pay.js, so the embed
// snippet the link builder hands out works from this same site.
function buttonScript(): Plugin {
  const file = here('../../packages/button/dist/shib-pay.js');
  return {
    name: 'shib-pay-script',
    configureServer(server) {
      server.middlewares.use('/shib-pay.js', (_req, res) => {
        res.setHeader('content-type', 'text/javascript');
        res.end(fs.existsSync(file) ? fs.readFileSync(file) : '// run: npm run build -w @shibpay/button');
      });
    },
    generateBundle() {
      if (!fs.existsSync(file)) this.error('Build the button first: npm run build -w @shibpay/button');
      this.emitFile({ type: 'asset', fileName: 'shib-pay.js', source: fs.readFileSync(file) });
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
      input: { index: here('index.html'), setup: here('setup.html'), pay: here('pay.html') },
    },
  },
});
