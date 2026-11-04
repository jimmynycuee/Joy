import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    // Preserve the browser's same-origin headers so the API can enforce them.
    cors: false,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4317',
        changeOrigin: false,
      },
      '/ws': {
        target: 'ws://127.0.0.1:4317',
        changeOrigin: false,
        ws: true,
      },
    },
  },
})
