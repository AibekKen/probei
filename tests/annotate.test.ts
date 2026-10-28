import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync, inflateSync } from 'node:zlib';
import { markClick } from '../src/annotate.js';
import { describeAction } from '../src/agent.js';

// --- Minimal independent PNG helpers (filter-0 rows only) for assertions. ---

const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** Solid-color WxH image, colorType 2 (RGB) or 6 (RGBA). */
function makePng(w: number, h: number, colorType: 2 | 6, rgb: [number, number, number]): Buffer {
  const channels = colorType === 6 ? 4 : 3;
  const stride = w * channels;
  const raw = Buffer.alloc(h * (stride + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const i = y * (stride + 1) + 1 + x * channels;
      raw[i] = rgb[0];
      raw[i + 1] = rgb[1];
      raw[i + 2] = rgb[2];
      if (channels === 4) raw[i + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function chunksOf(png: Buffer): { type: string; data: Buffer }[] {
  assert.ok(png.subarray(0, 8).equals(SIG), 'PNG signature');
  const out: { type: string; data: Buffer }[] = [];
  let pos = 8;
  while (pos + 12 <= png.length) {
    const len = png.readUInt32BE(pos);
    const type = png.toString('ascii', pos + 4, pos + 8);
    const data = png.subarray(pos + 8, pos + 8 + len);
    const want = png.readUInt32BE(pos + 8 + len);
    const got = crc32(Buffer.concat([png.subarray(pos + 4, pos + 8), data]));
    assert.equal(got, want, `CRC of ${type}`);
    out.push({ type, data: Buffer.from(data) });
    pos += 12 + len;
    if (type === 'IEND') break;
  }
  return out;
}

function pixelsOf(png: Buffer): { w: number; h: number; channels: number; px: Buffer } {
  const chunks = chunksOf(png);
  const ihdr = chunks.find((c) => c.type === 'IHDR')!.data;
  const w = ihdr.readUInt32BE(0);
  const h = ihdr.readUInt32BE(4);
  const channels = ihdr[9] === 6 ? 4 : 3;
  const stride = w * channels;
  const raw = inflateSync(Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data)));
  const px = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    assert.equal(raw[y * (stride + 1)], 0, 'test helper only reads filter-0 rows');
    raw.copy(px, y * stride, y * (stride + 1) + 1, (y + 1) * (stride + 1));
  }
  return { w, h, channels, px };
}

function at(img: { w: number; channels: number; px: Buffer }, x: number, y: number): [number, number, number] {
  const i = y * img.w * img.channels + x * img.channels;
  return [img.px[i], img.px[i + 1], img.px[i + 2]];
}

describe('markClick', () => {
  it('draws a red ring with white outline and center on RGB', () => {
    const out = pixelsOf(markClick(makePng(128, 80, 2, [10, 20, 30]), 64, 40));
    assert.deepEqual(at(out, 64, 40), [255, 255, 255]); // center dot
    assert.deepEqual(at(out, 64 + 12, 40), [220, 38, 38]); // red ring
    assert.deepEqual(at(out, 64 + 16, 40), [255, 255, 255]); // white outline
    assert.deepEqual(at(out, 64 + 5, 40), [10, 20, 30]); // page visible inside
    assert.deepEqual(at(out, 0, 0), [10, 20, 30]); // far pixels untouched
    assert.deepEqual(at(out, 127, 79), [10, 20, 30]);
  });

  it('works on RGBA screenshots', () => {
    const out = pixelsOf(markClick(makePng(100, 100, 6, [200, 200, 200]), 50, 50));
    assert.deepEqual(at(out, 50, 50), [255, 255, 255]);
    assert.deepEqual(at(out, 50, 50 - 12), [220, 38, 38]);
    assert.deepEqual(at(out, 0, 99), [200, 200, 200]);
  });

  it('keeps dimensions and valid chunk CRCs', () => {
    const out = pixelsOf(markClick(makePng(128, 80, 2, [1, 2, 3]), 10, 10));
    assert.equal(out.w, 128);
    assert.equal(out.h, 80);
  });

  it('clips markers at the image edges', () => {
    const out = pixelsOf(markClick(makePng(60, 60, 2, [9, 9, 9]), 0, 0));
    assert.deepEqual(at(out, 0, 0), [255, 255, 255]);
    assert.deepEqual(at(out, 59, 59), [9, 9, 9]);
  });

  it('rejects non-PNG input', () => {
    assert.throws(() => markClick(Buffer.from('hello'), 1, 1), /not a PNG/);
  });
});

describe('describeAction', () => {
  it('renders clicks with coordinates and target', () => {
    assert.equal(describeAction({ type: 'click', x: 640, y: 320, target: 'Buy' }), 'click (640, 320) on "Buy"');
    assert.equal(describeAction({ type: 'type', text: 'hi', clear: true }), 'type "hi" (replacing field text)');
    assert.equal(describeAction({ type: 'bug', title: 'T', severity: 'major', expected: 'e', actual: 'a', summary: 's' }), 'bug: T');
  });
});
