// Scene screenshots for review. Usage: node tools/shoot.mjs <prefix> [scrollFractions...]
// URL=http://localhost:5175/?livery=navy node tools/shoot.mjs navy   locks one livery across every scene.
import { chromium } from 'playwright';
const exe = process.env.CHROME || '/Users/varunsanjeev/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const [prefix = 'scene', ...fr] = process.argv.slice(2);
import { mkdirSync } from 'node:fs';
mkdirSync('livery/shots', { recursive: true });
// Hold points per scene at 1440x900: hero, problem, ingest, reason, control, system, product.
const fractions = fr.length ? fr.map(Number) : [0, 0.12, 0.265, 0.41, 0.555, 0.7, 0.85];
const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-webgl'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text().slice(0, 300)}`); });
page.on('pageerror', e => errors.push(`[pageerror] ${e.message}`));
await page.goto(process.env.URL || 'http://localhost:5175/', { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);
const gl = await page.evaluate(() => { const c = document.createElement('canvas'); const g = c.getContext('webgl2'); if (!g) return 'NO WEBGL'; const d = g.getExtension('WEBGL_debug_renderer_info'); return d ? g.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'webgl2 ok'; });
console.log('renderer:', gl);
const total = await page.evaluate(() => document.documentElement.scrollHeight - innerHeight);
for (const f of fractions) {
  await page.evaluate(y => window.scrollTo({ top: y, behavior: 'instant' }), Math.round(total * f));
  await page.waitForTimeout(1600);
  await page.screenshot({ path: `livery/shots/${prefix}-${String(Math.round(f * 100)).padStart(3, '0')}.png` });
}
console.log('scrollHeight total:', total);
console.log(errors.slice(0, 15).join('\n') || 'no console errors');
await browser.close();
