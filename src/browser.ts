import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

export const VIEWPORT = { width: 1280, height: 800 } as const;

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => undefined);
  await page.waitForTimeout(300);
}

/** One browser tab driven by the agent, with video recording and error capture. */
export class BrowserSession {
  private errors: string[] = [];

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

  static async start(url: string, videoDir: string, headless: boolean): Promise<BrowserSession> {
    const browser = await chromium.launch({ headless });
    const context = await browser.newContext({
      viewport: VIEWPORT,
      recordVideo: { dir: videoDir, size: VIEWPORT },
    });
    const page = await context.newPage();
    const session = new BrowserSession(browser, context, page);
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
    return this.page.screenshot({ path });
  }

  async click(x: number, y: number): Promise<void> {
    await this.page.mouse.click(x, y);
    await settle(this.page);
  }

  async type(text: string): Promise<void> {
    await this.page.keyboard.type(text, { delay: 20 });
    await settle(this.page);
  }

  async press(key: string): Promise<void> {
    await this.page.keyboard.press(key);
    await settle(this.page);
  }

  async scroll(dy: number): Promise<void> {
    await this.page.mouse.move(VIEWPORT.width / 2, VIEWPORT.height / 2);
    await this.page.mouse.wheel(0, dy);
    await settle(this.page);
  }

  async wait(ms: number): Promise<void> {
    await this.page.waitForTimeout(Math.min(ms, 10_000));
  }

  /** Closes the browser and returns the path of the recorded video, if any. */
  async close(): Promise<string | undefined> {
    const video = this.page.video();
    await this.context.close();
    await this.browser.close();
    return video ? video.path() : undefined;
  }
}
