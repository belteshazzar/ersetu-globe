import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig(({ command }) => ({
  plugins: [react()],
  // GitHub Pages serves a project site from a subdirectory, so built asset
  // URLs need that prefix. The dev server still runs at the root.
  base: command === 'build' ? '/ersetu-globe/' : '/',
}))
