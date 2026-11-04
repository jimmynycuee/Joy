import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'
import { createServiceWorkerSource } from './src/pwa.js'

function localPwaPlugin(): Plugin {
  const publicAssets = ['manifest.webmanifest', 'joy-icon-192.png', 'joy-icon-512.png']

  return {
    name: 'joy-local-pwa',
    apply: 'build',
    generateBundle(_options, bundle) {
      const entries = Object.entries(bundle).sort(([first], [second]) => first.localeCompare(second))
      const precacheUrls = [
        ...entries
          .map(([fileName]) => fileName)
          .filter((fileName) => !fileName.endsWith('.map') && fileName !== 'service-worker.js')
          .map((fileName) => (fileName === 'index.html' ? '/' : `/${fileName}`)),
        ...publicAssets.map((fileName) => `/${fileName}`),
      ]
      const revision = createHash('sha256')
      for (const [fileName, output] of entries) {
        revision.update(fileName)
        revision.update('\0')
        revision.update(output.type === 'chunk' ? output.code : output.source)
        revision.update('\0')
      }
      for (const fileName of publicAssets) {
        revision.update(fileName)
        revision.update('\0')
        revision.update(readFileSync(new URL(`./public/${fileName}`, import.meta.url)))
        revision.update('\0')
      }
      this.emitFile({
        type: 'asset',
        fileName: 'service-worker.js',
        source: createServiceWorkerSource(precacheUrls, revision.digest('hex').slice(0, 12)),
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), localPwaPlugin()],
  server: {
    host: '127.0.0.1',
    proxy: {
      '/api': 'http://127.0.0.1:4317',
      '/ws': { target: 'ws://127.0.0.1:4317', ws: true },
    },
  },
})
