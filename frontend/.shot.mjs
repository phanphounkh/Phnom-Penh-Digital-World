import { chromium } from '@playwright/test';
const [url, out, sel, w, h] = process.argv.slice(2);
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: +w || 1400, height: +h || 760 } });
const errors = []; p.on('pageerror', (e) => errors.push(e.message)); p.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
await p.goto(url); if (sel) await p.locator(sel).waitFor({ timeout: 60000 }); await p.waitForTimeout(1500);
await p.screenshot({ path: out }); await b.close(); console.log(errors.length ? 'ERRORS: ' + errors.join(' | ') : 'ok');
