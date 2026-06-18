import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import path from 'path';

export default defineConfig({
  plugins: [react(), tailwindcss(), basicSsl()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    host: '0.0.0.0', // Allow access from network
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      '/socket.io': {
        target: 'http://localhost:3000',
        ws: true,
      },
      // Uploaded files (chat images, voice notes) and avatars physically live
      // in the PRODUCTION volume, not on the dev machine — the local backend's
      // upload dir is empty. Point these at production so local dev shows the
      // real assets instead of 404s. DEV-ONLY (this config never ships in the
      // production build). Trade-off: a file you upload WHILE running locally
      // won't display in dev (it's saved to the local backend) — rare.
      '/uploads': {
        target: 'https://icp.balasorealloys.in',
        changeOrigin: true,
        secure: true,
      },
      '/avatars': {
        target: 'https://icp.balasorealloys.in',
        changeOrigin: true,
        secure: true,
      },
      '/wss-proxy': {
        target: 'ws://localhost:3000',
        ws: true,
      },
    },
  },
});
