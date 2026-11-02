import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'apps/web',
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 4317,
    strictPort: true,
    proxy: {
      '/api': {
        target: process.env.LIGHTMAO_API_URL || `http://127.0.0.1:${process.env.API_PORT || 4318}`,
        changeOrigin: true,
      },
      '/local': {
        target: `http://127.0.0.1:${process.env.AGENT_PORT || 4319}`,
        changeOrigin: true,
      },
    },
  },
  build: { outDir: '../../dist/web', emptyOutDir: true },
});
