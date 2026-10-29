// Deploy detection for the web UI: poll a project's app URL and notice when it changes.
// A fingerprint prefers stable HTTP validators (ETag, Last-Modified) and falls back
// to a hash of the response body, so plain static servers work too.
import { createHash } from 'node:crypto';

export const DEPLOY_FETCH_TIMEOUT_MS = 10_000;
/** Only the start of the body is hashed; deploys change the head (assets, markup) first. */
export const DEPLOY_BODY_LIMIT = 512 * 1024;

/** Short stable hash of a response body. */
export function hashBody(body: Buffer | string): string {
  const buf = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  return createHash('sha256').update(buf.subarray(0, DEPLOY_BODY_LIMIT)).digest('hex').slice(0, 32);
}

/**
 * One comparable fingerprint for a fetched page. ETag wins when present,
 * then Last-Modified, otherwise the body hash. Null means the fetch failed
 * and must never count as a deploy.
 */
export function fingerprintResponse(parts: { etag?: string | null; lastModified?: string | null; body: Buffer | string }): string {
  const etag = parts.etag?.trim();
  if (etag) return `etag:${etag.slice(0, 128)}`;
  const lastModified = parts.lastModified?.trim();
  if (lastModified) return `lm:${lastModified.slice(0, 128)}`;
  return `body:${hashBody(parts.body)}`;
}

/**
 * True when the app was redeployed: both fingerprints exist and differ.
 * A missing baseline (first check) or a failed fetch is never a deploy.
 */
export function isNewDeploy(previous: string | null | undefined, current: string | null | undefined): boolean {
  if (!previous || !current) return false;
  return previous !== current;
}

/** GETs the URL and returns its deploy fingerprint, or null when unreachable. */
export async function fetchFingerprint(url: string, timeoutMs = DEPLOY_FETCH_TIMEOUT_MS): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Probei-deploy-watch/1.0', Accept: 'text/html,*/*' },
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) return null;
    return fingerprintResponse({
      etag: res.headers.get('etag'),
      lastModified: res.headers.get('last-modified'),
      body: buf,
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
