// Plain selector-based check for the redesign test: node zoo/selectors.mjs <url>
// Uses the old shop's classes and DOM positions on purpose — the way many real
// e2e suites do. Passes on /shop/, breaks on the restyled /shop2/.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const url = process.argv[2];
if (!url?.startsWith('http')) {
  console.error('Usage: node zoo/selectors.mjs <url>');
  process.exit(2);
}

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(url, { waitUntil: 'domcontentloaded' });

  // Add the first two products via their card positions in the grid.
  await page.locator('main section .products .card:nth-child(1) button').click();
  await page.locator('main section .products .card:nth-child(2) button').click();

  // Header counter, cart lines and total via the old classes.
  assert.equal(await page.locator('header > span').textContent(), 'Cart: 2');
  assert.equal(await page.locator('main aside .cart .line').count(), 2);
  assert.match(await page.locator('.cart .total').textContent(), /6\s?500/);

  console.log(`SELECTORS PASS on ${url}`);
} catch (err) {
  console.log(`SELECTORS FAIL on ${url}: ${(err.message ?? err).split('\n')[0]}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
