// Run video without the dead air: frames come from Chromium's screencast (only when the
// screen changes) and are encoded with Playwright's bundled ffmpeg. Any stretch where
// nothing moves, like the model thinking for a minute, is cut down to a short hold.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CDPSession, Page } from 'playwright';

const FPS = 25;
/** Longest still stretch kept in the video, in seconds. */
export const MAX_HOLD_S = 0.8;
/** How long the last frame stays at the end of the video, in seconds. */
const END_HOLD_S = 1.5;

/** Playwright's ffmpeg (installed by `npm run browsers`), or undefined when it is missing. */
export function findFfmpeg(): string | undefined {
  const base =
    process.env.PLAYWRIGHT_BROWSERS_PATH ||
    (process.platform === 'darwin'
      ? join(homedir(), 'Library', 'Caches', 'ms-playwright')
      : process.platform === 'win32'
        ? join(process.env.LOCALAPPDATA ?? homedir(), 'ms-playwright')
        : join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'ms-playwright'));
  const exe = process.platform === 'darwin' ? 'ffmpeg-mac' : process.platform === 'win32' ? 'ffmpeg-win64.exe' : 'ffmpeg-linux';
  let dirs: string[];
  try {
    dirs = readdirSync(base).filter((d) => /^ffmpeg-\d+$/.test(d));
  } catch {
    return undefined;
  }
  dirs.sort((a, z) => Number(z.slice(7)) - Number(a.slice(7)));
  for (const d of dirs) {
    const file = join(base, d, exe);
    if (existsSync(file)) return file;
  }
  return undefined;
}

/**
 * Maps wall-clock frame arrival times to output frames. Each frame is held until
 * the next one arrives, but never longer than maxHold.
 */
export class Timeline {
  private written = 0;
  private outTime = 0;
  private lastAt: number | undefined;

  constructor(
    private readonly fps = FPS,
    private readonly maxHold = MAX_HOLD_S,
  ) {}

  /** A new frame arrived at `at` seconds: how many copies of the previous frame to write first. */
  next(at: number): number {
    if (this.lastAt === undefined) {
      this.lastAt = at;
      return 0;
    }
    this.outTime += Math.min(Math.max(at - this.lastAt, 0), this.maxHold);
    this.lastAt = at;
    return this.flush();
  }

  /** Copies of the last frame to write when the recording ends. */
  end(hold = END_HOLD_S): number {
    if (this.lastAt === undefined) return 0;
    this.outTime += hold;
    return Math.max(1, this.flush());
  }

  private flush(): number {
    const target = Math.round(this.outTime * this.fps);
    const count = Math.max(0, target - this.written);
    this.written += count;
    return count;
  }
}

export class ScreenRecorder {
  private readonly timeline = new Timeline();
  private last: Buffer | undefined;
  private paused = false;
  /** Newest frame seen while paused; shown from the moment recording resumes. */
  private pending: Buffer | undefined;
  private readonly done: Promise<number | null>;

  private constructor(
    private readonly cdp: CDPSession,
    private readonly ffmpeg: ChildProcess,
    readonly path: string,
  ) {
    this.done = new Promise((resolve) => {
      ffmpeg.on('close', (code) => resolve(code));
      ffmpeg.on('error', () => resolve(null));
    });
    ffmpeg.stdin?.on('error', () => undefined);
  }

  static async start(page: Page, ffmpegPath: string, path: string): Promise<ScreenRecorder> {
    const { width, height } = page.viewportSize() ?? { width: 1280, height: 800 };
    const ffmpeg = spawn(
      ffmpegPath,
      [
        '-loglevel', 'error',
        '-f', 'image2pipe',
        '-c:v', 'mjpeg',
        '-framerate', String(FPS),
        '-i', 'pipe:0',
        '-an',
        '-vf', `scale=${width}:${height},format=yuv420p`,
        '-c:v', 'libvpx-vp9',
        '-deadline', 'realtime',
        '-cpu-used', '8',
        '-row-mt', '1',
        '-b:v', '0',
        '-crf', '30',
        '-y', path,
      ],
      { stdio: ['pipe', 'ignore', 'ignore'] },
    );
    const cdp = await page.context().newCDPSession(page);
    const recorder = new ScreenRecorder(cdp, ffmpeg, path);
    cdp.on('Page.screencastFrame', (frame) => {
      void cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => undefined);
      recorder.onFrame(Buffer.from(frame.data, 'base64'));
    });
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 85, maxWidth: width, maxHeight: height });
    return recorder;
  }

  private onFrame(jpeg: Buffer): void {
    if (this.paused) {
      this.pending = jpeg;
      return;
    }
    this.write(jpeg);
  }

  private write(jpeg: Buffer): void {
    const copies = this.timeline.next(Date.now() / 1000);
    if (this.last) for (let i = 0; i < copies; i++) this.ffmpeg.stdin?.write(this.last);
    this.last = jpeg;
  }

  /** Stops adding time: the screen while paused (e.g. the model thinking) collapses to one short hold. */
  pause(): void {
    this.paused = true;
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    if (this.pending) this.write(this.pending);
    this.pending = undefined;
  }

  /** Ends the recording; returns the video path, or undefined when encoding failed. */
  async stop(): Promise<string | undefined> {
    await this.cdp.send('Page.stopScreencast').catch(() => undefined);
    await this.cdp.detach().catch(() => undefined);
    this.resume();
    const copies = this.timeline.end();
    if (this.last) for (let i = 0; i < copies; i++) this.ffmpeg.stdin?.write(this.last);
    this.ffmpeg.stdin?.end();
    const code = await this.done;
    return code === 0 && this.last ? this.path : undefined;
  }
}
