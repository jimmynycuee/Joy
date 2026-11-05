import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const apiPort = Number(process.env.JOY_E2E_API_PORT ?? 4317)
const webPort = Number(process.env.JOY_E2E_WEB_PORT ?? 5173)

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: webPort,
    strictPort: true,
    proxy: {
      '/api': `http://127.0.0.1:${apiPort}`,
      '/ws': { target: `ws://127.0.0.1:${apiPort}`, ws: true },
    },
  },
})
