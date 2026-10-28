import { chromium } from 'playwright';
import { askJSON, type Usage } from './llm.js';
import { isPublicHost } from './netguard.js';

export interface PageLink {
  text: string;
  href: string;
}

export interface PageSnapshot {
  url: string;
  title: string;
  headings: string[];
  links: PageLink[];
  buttons: string[];
  inputs: string[];
  text: string;
}

export interface AppReview {
  startUrl: string;
  pages: PageSnapshot[];
}

export interface SuggestedScenario {
  title: string;
  scenario: string;
  url: string;
}

const MAX_TEXT_CHARS = 2500;
const MAX_SCENARIOS = 10;

/** Renders one crawled page as compact text for the model prompt. */
export function compactSnapshot(page: PageSnapshot): string {
  const lines = [`## ${page.url}`, `Title: ${page.title || '(none)'}`];
  if (page.headings.length) lines.push(`Headings: ${page.headings.slice(0, 20).join(' | ')}`);
  if (page.buttons.length) lines.push(`Buttons: ${page.buttons.slice(0, 30).join(' | ')}`);
  if (page.inputs.length) lines.push(`Inputs: ${page.inputs.slice(0, 20).join(' | ')}`);
  if (page.links.length) {
    lines.push('Links:');
    for (const l of page.links.slice(0, 40)) lines.push(`- ${l.text || '(no text)'} → ${l.href}`);
  }
  const text = page.text.length > MAX_TEXT_CHARS ? `${page.text.slice(0, MAX_TEXT_CHARS)}…` : page.text;
  if (text.trim()) lines.push(`Text:\n${text}`);
  return lines.join('\n');
}

function normalizeScenario(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

function firstLine(text: string, max = 60): string {
  const line = text.trim().split('\n')[0].trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function resolveUrl(raw: unknown, base: string): string {
  try {
    const u = new URL(String(raw ?? ''), base);
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.href;
  } catch {
    // fall through to the base URL
  }
  return base;
}

/**
 * Validates the model's suggestion list. Tolerant: drops blank and duplicate
 * entries, fills in title/url, caps the count. Never throws.
 */
export function parseSuggestions(data: unknown, baseUrl: string, max: number): SuggestedScenario[] {
  if (!data || typeof data !== 'object') return [];
  const list = (data as { scenarios?: unknown }).scenarios;
  if (!Array.isArray(list)) return [];
  const out: SuggestedScenario[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (out.length >= max) break;
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const scenario = typeof rec.scenario === 'string' ? rec.scenario.trim() : '';
    if (!scenario) continue;
    const key = normalizeScenario(scenario);
    if (seen.has(key)) continue;
    seen.add(key);
    const title = typeof rec.title === 'string' && rec.title.trim() ? rec.title.trim() : firstLine(scenario);
    out.push({ title, scenario, url: resolveUrl(rec.url, baseUrl) });
  }
  return out;
}

function stripHash(href: string): string {
  const hash = href.indexOf('#');
  return hash === -1 ? href : href.slice(0, hash);
}

/** Walks same-origin pages from the URL and snapshots what the app offers. */
export async function reviewApp(opts: {
  url: string;
  maxPages: number;
  headless: boolean;
  blockPrivate?: boolean;
}): Promise<{ review: AppReview; homeScreenshot: Buffer | undefined }> {
  const start = new URL(opts.url);
  if (start.protocol !== 'http:' && start.protocol !== 'https:') throw new Error('url must be an http(s) URL');
  const origin = start.origin;
  const maxPages = Math.max(1, Math.min(10, Math.floor(opts.maxPages)));

  const browser = await chromium.launch({ headless: opts.headless });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    if (opts.blockPrivate) {
      await context.route('**/*', async (route) => {
        const target = new URL(route.request().url());
        if (await isPublicHost(target.hostname)) return route.continue();
        return route.abort('blockedbyclient');
      });
    }
    const page = await context.newPage();
    const pages: PageSnapshot[] = [];
    const seen = new Set<string>();
    const queue = [stripHash(start.href)];
    let homeScreenshot: Buffer | undefined;
    let lastError = '';

    while (queue.length && pages.length < maxPages) {
      const url = queue.shift()!;
      if (seen.has(url)) continue;
      seen.add(url);
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15_000 });
        await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => undefined);
        // A string script: tsx wraps closures in __name(), which does not exist in the page.
        const snap = (await page.evaluate(`(() => {
          const textOf = (el) => (el.textContent ?? '').trim().replace(/\\s+/g, ' ');
          const headings = [...document.querySelectorAll('h1, h2, h3')].map(textOf).filter(Boolean).slice(0, 20);
          const links = [...document.querySelectorAll('a[href]')]
            .map((a) => ({ text: textOf(a).slice(0, 80), href: a.href }))
            .filter((l) => l.href.startsWith('http'))
            .slice(0, 60);
          const buttons = [...document.querySelectorAll('button, input[type="submit"], input[type="button"], [role="button"]')]
            .map((b) => (textOf(b) || b.value || '').trim().slice(0, 60))
            .filter(Boolean)
            .slice(0, 30);
          const inputs = [...document.querySelectorAll('input, textarea, select')]
            .map((el) => {
              const label = (el.name || el.id || el.placeholder || el.type || el.tagName).trim();
              return (label + ' (' + (el.type || el.tagName).toLowerCase() + ')').slice(0, 80);
            })
            .slice(0, 20);
          return {
            title: document.title,
            headings,
            links,
            buttons,
            inputs,
            text: (document.body?.innerText ?? '').slice(0, ${MAX_TEXT_CHARS + 500}),
          };
        })()`)) as {
          title: string;
          headings: string[];
          links: PageLink[];
          buttons: string[];
          inputs: string[];
          text: string;
        };
        pages.push({
          url,
          title: snap.title,
          headings: snap.headings,
          links: snap.links,
          buttons: snap.buttons,
          inputs: snap.inputs,
          text: snap.text,
        });
        if (!homeScreenshot) homeScreenshot = await page.screenshot();
        for (const link of snap.links) {
          const clean = stripHash(link.href);
          try {
            if (new URL(clean).origin === origin && !seen.has(clean) && !queue.includes(clean)) {
              queue.push(clean);
            }
          } catch {
            // ignore unparsable hrefs
          }
        }
      } catch (err) {
        // One broken page must not kill the review; the rest still inform the draft.
        lastError = err instanceof Error ? err.message : String(err);
      }
    }
    await context.close();
    if (!pages.length) {
      const detail = lastError ? `: ${lastError.split('\n')[0]}` : '';
      throw new Error(`Could not load ${start.href}${detail}`);
    }
    return { review: { startUrl: start.href, pages }, homeScreenshot };
  } finally {
    await browser.close();
  }
}

const SUGGEST_SYSTEM = `You draft QA scenarios for Probei, a visual agent that tests a web app from plain language: it opens a URL, looks at screenshots, clicks and types, and checks the result.
Reply with ONLY a JSON object: {"scenarios": [{"title": "...", "scenario": "...", "url": "..."}]}.
Each scenario is plain text: concrete steps for the agent plus what is expected (start the expectation with "Expected:").
Rules: cover the app's main flows first, then forms, navigation and edge cases; each scenario must be doable from its url in a few steps; use only pages from the review below; keep scenarios in English; at most ${MAX_SCENARIOS} scenarios.`;

/** Asks the model to draft runnable scenarios from an app review. */
export async function suggestScenarios(
  review: AppReview,
  homeScreenshot?: Buffer,
): Promise<{ scenarios: SuggestedScenario[]; usage: Usage }> {
  const prompt = [
    `The app starts at ${review.startUrl}. ${review.pages.length} page(s) were reviewed:`,
    ...review.pages.map(compactSnapshot),
    `\nDraft up to ${MAX_SCENARIOS} test scenarios for this app.`,
  ].join('\n\n');
  const { data, usage } = await askJSON(SUGGEST_SYSTEM, prompt, homeScreenshot);
  const scenarios = parseSuggestions(data, review.startUrl, MAX_SCENARIOS);
  if (!scenarios.length) throw new Error('The model returned no usable scenarios; try again.');
  return { scenarios, usage };
}
