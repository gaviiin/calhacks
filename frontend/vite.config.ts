import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const REPO = fileURLToPath(new URL('..', import.meta.url));

// Local files the agents write, served to the dashboard by the dev server only. Seat codes are the
// one-time invites `make bootstrap` mints for the human seats (agents/state/seat_codes.json): on a
// local demo the person at the screen takes a seat with one; anywhere real they arrive out of band.
const LOCAL_FILES: Record<string, string> = {
  '/local/seats': 'agents/state/seat_codes.json',
  '/local/scorecard': 'agents/out/scorecard.json',
};

function localFiles(): Plugin {
  return {
    name: 'pit-wall-local-files',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const file = LOCAL_FILES[(req.url ?? '').split('?')[0]];
        if (!file) return next();
        try {
          const body = await readFile(resolve(REPO, file), 'utf8');
          res.setHeader('content-type', 'application/json');
          res.setHeader('cache-control', 'no-store');
          res.end(body);
        } catch {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: `${file} not found` }));
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), localFiles()],
  server: {
    port: 5173,
    proxy: {
      // the revenue desk API (finance/api.py)
      '/api': { target: process.env.PITWALL_API ?? 'http://localhost:8000', changeOrigin: true },
    },
  },
});
