'use strict';
/* A minimal PNG reader, used only by the icon tooling.
 *
 * There is no image library on this machine and this project installs nothing,
 * so the few hundred bytes of decoding needed to measure an image's real
 * content bounds are done here. Node ships the inflate half of the problem in
 * zlib; the rest is undoing the per-scanline filters the format applies.
 *
 * Scope is deliberately narrow: eight-bit, non-interlaced, truecolour with or
 * without alpha. That covers what the icon tooling is pointed at. Anything else
 * raises rather than returning approximate pixels, because a silently wrong
 * decode would produce a silently wrong crop.
 */

const zlib = require('zlib');

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function decode(buffer) {
  if (!buffer.subarray(0, 8).equals(SIGNATURE)) throw new Error('That file is not a PNG.');

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const data = [];

  let offset = 8;
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const start = offset + 8;

    if (type === 'IHDR') {
      width = buffer.readUInt32BE(start);
      height = buffer.readUInt32BE(start + 4);
      bitDepth = buffer[start + 8];
      colorType = buffer[start + 9];
      interlace = buffer[start + 12];
    } else if (type === 'IDAT') {
      data.push(buffer.subarray(start, start + length));
    } else if (type === 'IEND') {
      break;
    }
    offset = start + length + 4;
  }

  if (bitDepth !== 8) throw new Error('Only eight-bit PNGs are handled; this one is ' + bitDepth + '-bit.');
  if (interlace !== 0) throw new Error('Interlaced PNGs are not handled.');
  if (colorType !== 2 && colorType !== 6) {
    throw new Error('Only truecolour PNGs are handled; this one is colour type ' + colorType + '.');
  }

  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = zlib.inflateSync(Buffer.concat(data));
  const out = Buffer.alloc(height * stride);

  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const target = out.subarray(y * stride, (y + 1) * stride);
    const above = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;

    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? target[x - channels] : 0;
      const up = above ? above[x] : 0;
      const upLeft = above && x >= channels ? above[x - channels] : 0;
      const value = line[x];

      switch (filter) {
        case 0: target[x] = value; break;
        case 1: target[x] = (value + left) & 0xff; break;
        case 2: target[x] = (value + up) & 0xff; break;
        case 3: target[x] = (value + ((left + up) >> 1)) & 0xff; break;
        case 4: target[x] = (value + paeth(left, up, upLeft)) & 0xff; break;
        default: throw new Error('Unknown PNG scanline filter: ' + filter);
      }
    }
  }

  return { width, height, channels, pixels: out };
}

/* The bounding box of everything brighter than a threshold.
 *
 * Measured rather than eyeballed, so the crop can be recomputed if the artwork
 * is ever replaced. The mark this is pointed at is a bright rim on a near-black
 * ground, so luminance separates content from margin cleanly. */
function contentBounds(image, threshold) {
  const limit = threshold == null ? 40 : threshold;
  const { width, height, channels, pixels } = image;

  let top = height;
  let bottom = -1;
  let left = width;
  let right = -1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * channels;
      const alpha = channels === 4 ? pixels[at + 3] : 255;
      if (alpha < 8) continue;
      /* Rec. 601 luma, integer weights to keep this a whole-number comparison. */
      const luma = (pixels[at] * 299 + pixels[at + 1] * 587 + pixels[at + 2] * 114) / 1000;
      if (luma < limit) continue;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
      if (x < left) left = x;
      if (x > right) right = x;
    }
  }

  if (bottom < 0) return { x: 0, y: 0, width, height, empty: true };
  return { x: left, y: top, width: right - left + 1, height: bottom - top + 1, empty: false };
}

module.exports = { decode, contentBounds };
