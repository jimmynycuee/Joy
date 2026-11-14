// Renders the PWA / notification PNG icons from the SVG artwork in apps/web/public, using the Chromium that
// Playwright already installed for the e2e tests (no extra dependency). Run it after changing the artwork:
//   pnpm exec node scripts/render-icons.mjs
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const publicDir = new URL('../apps/web/public/', import.meta.url)

// [source svg, output png, edge in px]
const JOBS = [
  ['app-icon.svg', 'icon-192.png', 192],
  ['app-icon.svg', 'icon-512.png', 512],
  ['app-icon-maskable.svg', 'icon-maskable-192.png', 192],
  ['app-icon-maskable.svg', 'icon-maskable-512.png', 512],
  // iOS masks the icon itself and fills transparent corners with black, so it gets the full-bleed artwork.
  ['app-icon-maskable.svg', 'apple-touch-icon.png', 180],
]

const browser = await chromium.launch()
try {
  for (const [source, output, edge] of JOBS) {
    const svg = await readFile(new URL(source, publicDir), 'utf8')
    const page = await browser.newPage({ viewport: { width: edge, height: edge }, deviceScaleFactor: 1 })
    await page.setContent(
      `<body style="margin:0;background:transparent"><img style="display:block" width="${edge}" height="${edge}" src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}"></body>`,
    )
    await page.locator('img').evaluate((img) => img.decode())
    const png = await page.screenshot({
      omitBackground: true,
      clip: { x: 0, y: 0, width: edge, height: edge },
    })
    await writeFile(new URL(output, publicDir), png)
    await page.close()
    console.log(`${output} (${edge}x${edge}, ${png.length} bytes) <- ${source}`)
  }
} finally {
  await browser.close()
}
console.log(`written to ${fileURLToPath(publicDir)}`)
