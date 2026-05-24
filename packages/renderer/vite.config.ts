import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5190, strictPort: false },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  plugins: [
    // jspanel4 ships a /*# sourceMappingURL=jspanel.css.map */ annotation but
    // not the .map file. Vite logs a noisy ENOENT every time it loads the CSS.
    // Strip the annotation before Vite tries to resolve it.
    {
      name: 'strip-jspanel-css-sourcemap',
      enforce: 'pre',
      transform(code: string, id: string) {
        if (id.includes('jspanel4') && id.endsWith('.css')) {
          return {
            code: code.replace(/\/\*[#@]\s*sourceMappingURL=[^*]*\*\//g, ''),
            map: null,
          };
        }
        return null;
      },
    },
  ],
});
