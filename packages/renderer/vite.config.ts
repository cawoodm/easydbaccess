import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5190, strictPort: false },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
