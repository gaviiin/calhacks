// Renders the clay reference sheets that liveries are painted onto.
// Usage: node tools/ortho-sheets.mjs [px]   (dev server must be running on 5175)
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const px = Number(process.argv[2]) || 4096;
const height = Math.round(px / (21 / 9));
const exe = process.env.CHROME || '/Users/varunsanjeev/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
mkdirSync('livery/ref', { recursive: true });
const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: px, height: height + 8 }, deviceScaleFactor: 1 });
page.on('pageerror', e => console.error('[pageerror]', e.message));
for (const view of ['side', 'top']) {
  await page.goto(`http://localhost:5175/?ortho=${view}&px=${px}`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__orthoReady === true, null, { timeout: 60000 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `livery/ref/${view}.png`, omitBackground: true, clip: { x: 0, y: 0, width: px, height } });
  console.log(`wrote livery/ref/${view}.png (${px}x${height})`);
}
writeFileSync(
  'livery/ref/frames.json',
  JSON.stringify({ px, height, aspect: 21 / 9, canvas: { side: { x0: -3.0, x1: 3.1, y0: -0.1, y1: -0.1 + 6.1 / (21 / 9) }, top: { x0: -3.0, x1: 3.1, zBottom: 6.1 / (21 / 9) / 2, zTop: -6.1 / (21 / 9) / 2 } }, sheet: { side: { x0: -3.0, y0: -0.05, x1: 3.1, y1: 1.2 }, top: { x0: -3.0, zBottom: 1.1, x1: 3.1, zTop: -1.1 } } }, null, 2)
);
await browser.close();
