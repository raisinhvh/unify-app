import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';

const rendererRoot = fileURLToPath(new URL('.', import.meta.url));
const engineRoot = fileURLToPath(new URL('../engine', import.meta.url));

export default defineConfig({
  root: rendererRoot,
  base: './',
  plugins: [solid()],
  resolve: {
    alias: {
      // Type-only imports of the engine protocol (src/engine/sidebar/view.ts). Never import runtime values from here.
      '@engine': engineRoot,
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: '../../dist/renderer',
    emptyOutDir: true,
    target: 'chrome120',
    sourcemap: true,
  },
});
