import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { isPublicHost } from './netguard.js';
import { installOverlay, OVERLAY_HIDE_CSS } from './overlay.js';

export const VIEWPORT = { width: 1280, height: 800 } as const;

/** How long the action badge stays on screen so the run video catches it clearly. */
const MIN_VISIBLE_MS = 1200;

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => undefined);
  await page.waitForTimeout(300);
}

/** One browser tab driven by the agent, with video recording and error capture. */
export class BrowserSession {
  private errors: string[] = [];
  private markShownAt = 0;
  private cursor = { x: VIEWPORT.width / 2, y: VIEWPORT.height / 2 };

  private constructor(
    private readonly browser: Browser,
    private readonly context: BrowserContext,
    readonly page: Page,
  ) {
    page.on('pageerror', (err) => this.errors.push(`page error: ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error') this.errors.push(`console error: ${msg.text()}`);
    });
    page.on('response', (res) => {
      if (res.status() >= 500) this.errors.push(`HTTP ${res.status()} on ${res.url()}`);
    });
  }

  static async start(
    url: string,
    videoDir: string,
    headless: boolean,
    blockPrivate = false,
  ): Promise<BrowserSession> {
    const browser = await chromium.launch({ headless });
    const context = await browser.newContext({
      viewport: VIEWPORT,
      recordVideo: { dir: videoDir, size: VIEWPORT },
    });
    // tsx may wrap functions in __name(); the shim keeps the serialized script runnable in the page.
    await context.addInitScript({ content: `(() => { const __name = (f) => f; (${installOverlay})(); })();` });
    const page = await context.newPage();
    const session = new BrowserSession(browser, context, page);
    if (blockPrivate) {
      // Every request, redirects and subresources included, must go to a public address.
      await context.route('**/*', async (route) => {
        const target = new URL(route.request().url());
        if (await isPublicHost(target.hostname)) return route.continue();
        session.errors.push(`blocked request to private address: ${target.host}`);
        return route.abort('blockedbyclient');
      });
    }
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await settle(page);
    return session;
  }

  /** Errors seen since the previous call (page errors, console errors, 5xx responses). */
  takeErrors(): string[] {
    const out = this.errors;
    this.errors = [];
    return out;
  }

  async screenshot(path: string): Promise<Buffer> {
    return this.page.screenshot({ path, style: OVERLAY_HIDE_CSS });
  }

  async click(x: number, y: number, label = 'click'): Promise<void> {
    await this.showAction(label).catch(() => undefined);
    await this.glideTo(x, y).catch(() => undefined);
    await this.page.mouse.down();
    await this.page.waitForTimeout(80);
    await this.page.mouse.up();
    await settle(this.page);
    // A click may load a new document; moving again brings its cursor back.
    await this.page.mouse.move(x, y).catch(() => undefined);
    await this.hideAction().catch(() => undefined);
  }

  /** Glides the cursor from where it last was to (x, y) so the video shows the movement. */
  private async glideTo(x: number, y: number): Promise<void> {
    const { x: fromX, y: fromY } = this.cursor;
    const steps = Math.max(8, Math.min(30, Math.round(Math.hypot(x - fromX, y - fromY) / 25)));
    await this.page.mouse.move(fromX, fromY);
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const ease = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
      await this.page.mouse.move(fromX + (x - fromX) * ease, fromY + (y - fromY) * ease);
      await this.page.waitForTimeout(16);
    }
    this.cursor = { x, y };
    await this.page.waitForTimeout(120);
  }

  /** Shows the action badge in the overlay (see overlay.ts); screenshots never include it. */
  private async showAction(label: string): Promise<void> {
    this.markShownAt = Date.now();
    await this.page.evaluate((text) => window.__probeiOverlay?.badge(text), label);
  }

  /** Keeps the badge up long enough for the video to catch it, then fades it out. */
  private async hideAction(): Promise<void> {
    const wait = MIN_VISIBLE_MS - (Date.now() - this.markShownAt);
    if (wait > 0) await this.page.waitForTimeout(wait);
    await this.page.evaluate(() => window.__probeiOverlay?.clearBadge()).catch(() => undefined);
  }

  async type(text: string, clear = false, label = `type "${text}"`): Promise<void> {
    await this.showAction(label).catch(() => undefined);
    if (clear) {
      await this.page.keyboard.press('ControlOrMeta+a');
      await this.page.keyboard.press('Backspace');
    }
    await this.page.keyboard.type(text, { delay: 45 });
    await settle(this.page);
    await this.hideAction().catch(() => undefined);
  }

  async press(key: string, label = `press ${key}`): Promise<void> {
    await this.showAction(label).catch(() => undefined);
    await this.page.keyboard.press(key);
    await settle(this.page);
    await this.hideAction().catch(() => undefined);
  }

  async scroll(dy: number, label = `scroll ${dy}px`): Promise<void> {
    await this.showAction(label).catch(() => undefined);
    await this.glideTo(VIEWPORT.width / 2, VIEWPORT.height / 2).catch(() => undefined);
    await this.page.mouse.wheel(0, dy);
    await settle(this.page);
    await this.hideAction().catch(() => undefined);
  }

  async wait(ms: number, label = `wait ${ms}ms`): Promise<void> {
    await this.showAction(label).catch(() => undefined);
    await this.page.waitForTimeout(Math.min(ms, 10_000));
    await this.hideAction().catch(() => undefined);
  }

  /** Closes the browser and returns the path of the recorded video, if any. */
  async close(): Promise<string | undefined> {
    const video = this.page.video();
    await this.context.close();
    await this.browser.close();
    return video ? video.path() : undefined;
  }
}
