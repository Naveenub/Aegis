import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vite.dev/config/
export default defineConfig({
  // Served by server.js under /app: unprefixed paths such as /workflows and
  // /tenants are API routes, so the SPA cannot own the origin root.
  base: '/app/',
  plugins: [react()],
});
