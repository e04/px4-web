import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: './',
  plugins: [react()],
  // web-bml ships CommonJS; its data worker entry is not always discovered by the dep scan.
  optimizeDeps: { include: ['web-bml', 'web-bml/ts'] },
  server: { host: '127.0.0.1', port: 4173, strictPort: true },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true },
});
