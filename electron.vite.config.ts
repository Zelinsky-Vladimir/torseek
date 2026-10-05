import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {},
  preload: {
    // Sandboxed preloads can't be ES modules
    build: { rollupOptions: { output: { format: 'cjs', entryFileNames: '[name].cjs' } } },
  },
  renderer: {
    // Don't resolve through symlinks/redirected folders (e.g. MSIX-virtualized AppData),
    // otherwise index.html resolves outside the project root
    resolve: { preserveSymlinks: true },
    plugins: [react(), tailwindcss()],
  },
})
