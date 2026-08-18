import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Listed before '@shared', which Vite would otherwise match first.
      // The real loader does `import(url)` against a served path; jsdom has no
      // server to answer it, so tests get the version that resolves a stdlib
      // URL to the widget's TSX source. Aliasing here rather than exporting a
      // setter keeps the test seam out of the shipped bundle: nothing in src/
      // can swap the loader, and no test has to remember to install one.
      '@shared/utils/widgetModuleLoader': path.resolve(__dirname, 'widgets/widgetModuleLoader.ts'),
      '@hmi': path.resolve(__dirname, 'src/hmi'),
      '@config': path.resolve(__dirname, 'src/config'),
      '@shared': path.resolve(__dirname, 'src/shared'),
      // Tests always run against the open-source stub — see vite.config.ts.
      '@enterprise': path.resolve(__dirname, 'src/enterprise/registry.ts'),
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: './src/test-setup.ts',
    globals: true,
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
