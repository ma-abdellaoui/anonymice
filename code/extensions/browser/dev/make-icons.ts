/**
 * Generates the extension icons. No image dependency: PNG is a container around
 * deflate, and a flat-colour glyph is a few dozen lines of pixel maths.
 *
 * The mark is the product in one picture — a light-red highlight over a line of
 * text (SPEC §4's `#ffdada` on the page's own words).
 *
 *   node dev/make-icons.ts
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';

const OUT = new URL('../platform/chrome/icons/', import.meta.url).pathname;
const SIZES = [16, 32, 48, 128];

type RGBA = [number, number, number, number];
const PAPER: RGBA = [0xff, 0xff, 0xff, 0xff];
const EDGE: RGBA = [0xc0, 0x39, 0x2b, 0xff];
const HIGHLIGHT: RGBA = [0xff, 0xda, 0xda, 0xff];
const INK: RGBA = [0x33, 0x33, 0x33, 0xff];
const CLEAR: RGBA = [0, 0, 0, 0];

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length, false);
  out.set([...type].map((c) => c.charCodeAt(0)), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)), false);
  return out;
}

function png(size: number, pixel: (x: number, y: number) => RGBA): Uint8Array {
  const raw = new Uint8Array(size * (size * 4 + 1));
  let i = 0;
  for (let y = 0; y < size; y++) {
    raw[i++] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y);
      raw[i++] = r;
      raw[i++] = g;
      raw[i++] = b;
      raw[i++] = a;
    }
  }
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, size, false);
  view.setUint32(4, size, false);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', new Uint8Array(deflateSync(raw, { level: 9 }))),
    chunk('IEND', new Uint8Array(0)),
  ];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** A page with three lines of text, the middle one highlighted. */
function mark(size: number) {
  const u = size / 16; // design grid
  const radius = 2.5 * u;
  const inset = 1 * u;
  const lines = [
    { y: 4.5 * u, from: 3.5 * u, to: 12 * u, highlighted: false },
    { y: 8 * u, from: 3.5 * u, to: 12.5 * u, highlighted: true },
    { y: 11.5 * u, from: 3.5 * u, to: 10 * u, highlighted: false },
  ];
  const thickness = Math.max(1, 1.4 * u);

  return (x: number, y: number): RGBA => {
    const px = x + 0.5;
    const py = y + 0.5;
    const min = inset;
    const max = size - inset;
    // Rounded-rectangle test.
    const cx = Math.min(Math.max(px, min + radius), max - radius);
    const cy = Math.min(Math.max(py, min + radius), max - radius);
    const dist = Math.hypot(px - cx, py - cy);
    if (px < min || px > max || py < min || py > max || dist > radius) return CLEAR;
    if (dist > radius - Math.max(1, u)) return EDGE;

    for (const line of lines) {
      if (Math.abs(py - line.y) > thickness / 2) continue;
      if (px < line.from || px > line.to) continue;
      return line.highlighted ? INK : INK;
    }
    // The highlight band sits behind the middle line and is a little taller.
    const band = lines[1]!;
    if (Math.abs(py - band.y) <= thickness && px >= band.from - 0.5 * u && px <= band.to + 0.5 * u) {
      return HIGHLIGHT;
    }
    return PAPER;
  };
}

mkdirSync(OUT, { recursive: true });
for (const size of SIZES) {
  writeFileSync(`${OUT}icon-${size}.png`, png(size, mark(size)));
  console.log(`wrote icons/icon-${size}.png`);
}
