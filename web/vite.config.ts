import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// В dev-режиме запросы к API проксируются на Fastify (npm run dev:server).
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: { port: 5173, proxy: { '/tasks': 'http://localhost:3000', '/health': 'http://localhost:3000' } },
});
