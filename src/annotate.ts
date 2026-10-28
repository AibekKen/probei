import { inflateSync, deflateSync } from 'node:zlib';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 0);
  crc.copy(out, 8 + data.length);
  return out;
}

interface ParsedPng {
  width: number;
  height: number;
  colorType: number;
  channels: number;
  chunks: { type: string; data: Buffer }[];
  pixels: Buffer;
}

/** Minimal PNG reader: 8-bit non-interlaced truecolor(+alpha), as Playwright saves. */
function parsePng(raw: Buffer): ParsedPng {
  if (raw.length < 8 || !raw.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('not a PNG');
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const chunks: { type: string; data: Buffer }[] = [];
  const idat: Buffer[] = [];
  let pos = 8;
  while (pos + 8 <= raw.length) {
    const len = raw.readUInt32BE(pos);
    const type = raw.toString('ascii', pos + 4, pos + 8);
    const data = raw.subarray(pos + 8, pos + 8 + len);
    if (data.length !== len) throw new Error('truncated PNG');
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else {
      chunks.push({ type, data: Buffer.from(data) });
    }
    pos += 12 + len;
    if (type === 'IEND') break;
  }
  if (!width || !height) throw new Error('missing IHDR');
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`unsupported PNG format (depth ${bitDepth}, type ${colorType})`);
  }
  if (interlace !== 0) throw new Error('interlaced PNG not supported');
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const inflated = inflateSync(Buffer.concat(idat));
  if (inflated.length !== height * (stride + 1)) throw new Error('bad IDAT size');

  // Undo the per-row filters.
  const pixels = Buffer.alloc(height * stride);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = inflated[y * (stride + 1)];
    const row = inflated.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = pixels.subarray(y * stride, (y + 1) * stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? out[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let v: number;
      switch (filter) {
        case 1:
          v = row[i] + a;
          break;
        case 2:
          v = row[i] + b;
          break;
        case 3:
          v = row[i] + ((a + b) >> 1);
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          v = row[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default:
          v = row[i];
      }
      out[i] = v & 0xff;
    }
    prev = out;
  }
  return { width, height, colorType, channels, chunks, pixels };
}

function encodePng(png: ParsedPng): Buffer {
  const stride = png.width * png.channels;
  const raw = Buffer.alloc(png.height * (stride + 1));
  for (let y = 0; y < png.height; y++) {
    raw[y * (stride + 1)] = 0; // no filter; simple and always valid
    png.pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(png.width, 0);
  ihdr.writeUInt32BE(png.height, 4);
  ihdr[8] = 8;
  ihdr[9] = png.colorType;
  const parts = [PNG_SIGNATURE, chunk('IHDR', ihdr)];
  for (const c of png.chunks) {
    if (c.type === 'IEND') continue;
    parts.push(chunk(c.type, c.data));
  }
  parts.push(chunk('IDAT', deflateSync(raw)));
  parts.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

function setPixel(png: ParsedPng, x: number, y: number, r: number, g: number, b: number): void {
  if (x < 0 || y < 0 || x >= png.width || y >= png.height) return;
  const i = y * png.width * png.channels + x * png.channels;
  png.pixels[i] = r;
  png.pixels[i + 1] = g;
  png.pixels[i + 2] = b;
  if (png.channels === 4) png.pixels[i + 3] = 255;
}

/**
 * Draws a red target ring with a white outline and center dot at (x, y),
 * leaving the page visible inside the ring. Returns the re-encoded PNG,
 * or throws when the input is not a supported PNG.
 */
export function markClick(raw: Buffer, x: number, y: number): Buffer {
  const png = parsePng(raw);
  const cx = Math.round(x);
  const cy = Math.round(y);
  for (let dy = -20; dy <= 20; dy++) {
    for (let dx = -20; dx <= 20; dx++) {
      const d = Math.hypot(dx, dy);
      if (d <= 3) setPixel(png, cx + dx, cy + dy, 255, 255, 255);
      else if (d <= 9) continue; // keep the page visible inside the ring
      else if (d <= 14) setPixel(png, cx + dx, cy + dy, 220, 38, 38);
      else if (d <= 18) setPixel(png, cx + dx, cy + dy, 255, 255, 255);
    }
  }
  return encodePng(png);
}
