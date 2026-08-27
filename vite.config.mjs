import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  root: path.resolve('client'),
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8080',
      '/health': 'http://127.0.0.1:8080'
    }
  },
  build: {
    outDir: path.resolve('src/public'),
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('recharts') || id.includes('d3-')) return 'charts';
          if (id.includes('@tanstack')) return 'query';
          return undefined;
        }
      }
    }
  },
  test: {
    root: path.resolve('.'),
    environment: 'jsdom',
    setupFiles: ['./client/src/test/setup.ts'],
    exclude: ['tests/e2e/**', 'node_modules/**']
  }
});
