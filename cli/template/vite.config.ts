import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// In `npm run dev`, the backend (/pb) and runtime config (/__cubby) come from the Cubby server.
const cubby = JSON.parse(readFileSync(new URL('./cubby.json', import.meta.url), 'utf8'));
const toCubby = { target: cubby.server, changeOrigin: true, headers: { 'x-cubby-project': cubby.project } };

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { proxy: { '/pb': toCubby, '/__cubby': toCubby } },
});
