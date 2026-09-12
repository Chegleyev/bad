import { defineConfig } from 'vite';

export default defineConfig({
  // Relative base so a build can be dropped on any static host or opened from a
  // subdirectory without rewriting paths.
  base: './',
  server: { host: '127.0.0.1', port: 5173, open: false },
  build: { outDir: 'dist', assetsInlineLimit: 0, target: 'es2022' },
});
