import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

const clientRoot = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, clientRoot, '');
  const apiOrigin = env.VITE_API_ORIGIN ?? 'http://127.0.0.1:5181';
  const wsOrigin = apiOrigin.replace(/^http/, 'ws');
  return {
    root: clientRoot,
    plugins: [react()],
    build: { outDir: '../dist/client', emptyOutDir: true },
    server: {
      host: '0.0.0.0',
      port: 5173,
      proxy: {
        '/api': { target: apiOrigin, changeOrigin: false },
        '/ws/client': { target: wsOrigin, ws: true },
      },
    },
  };
});
