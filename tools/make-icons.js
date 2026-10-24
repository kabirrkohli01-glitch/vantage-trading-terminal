'use strict';
/* Generate the application icons from the source artwork.
 *
 * No image library is installed and none will be. Rasterising is done by the
 * copy of Chrome already on this machine, driven with --screenshot against a
 * self-contained local page; measuring is done by tools/png.js. The Windows
 * .ico container is assembled here, because since Windows Vista an icon
 * directory may hold PNG frames directly, which makes the file a short header
 * followed by the images already produced.
 *
 * THE CROP IS MEASURED, NOT EYEBALLED. The source has a wide black margin and
 * a bright rim, so scanning for the bounding box of everything above a
 * luminance threshold finds the artwork's real edges. The measurement is
 * recomputed on every run, so replacing the artwork does not mean editing
 * numbers in this file.
 *
 * The clipping frame is sized to the SCALED CROP rather than to the output
 * tile. Sizing it to the tile lets whatever sits outside the crop bleed back in
 * around the edges, which is invisible at 512 pixels and obvious at 32.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const png = require('./png');
const brand = require('../src/core/brand');

const SOURCE = process.argv[2];
if (!SOURCE) {
  console.error('Usage: node tools/make-icons.js <path-to-logo.png>');
  process.exit(1);
}
const OUT_DIR = path.join(__dirname, '..', 'web', 'assets');

/* Sizes a Windows shell actually asks for. 256 is what the desktop and large
   icon views use; 16 is the title bar and the alt-tab list. */
const ICO_SIZES = [256, 128, 64, 48, 32, 16];
/* Additional standalone files the interface loads directly. */
const PNG_SIZES = [512, 256, 128, 64, 32];

/* The corner clip. The artwork is already a rounded tile, so this rounds the
   opaque black that surrounds it to match, leaving genuinely transparent
   corners rather than black ones on a light desktop background. */
const CORNER_RATIO = 0.225;

/* How much breathing room to leave around the measured mark. 1 crops tight to
   the content edge-to-edge; anything above that pads evenly on all sides so
   the mark reads as sitting inside the tile rather than filling it. */
const MARK_PADDING_RATIO = 1.14;

function findChrome() {
  const candidates = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
  ];
  return candidates.find(p => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } }) || null;
}

/* A square crop centred on the measured content.
 *
 * The artwork's glow extends further vertically than horizontally, so the
 * measured box is taller than it is wide. Taking the width as the square edge
 * and centring on the content's midpoint keeps the tile centred without
 * including the extra glow as if it were part of the shape. */
function squareCrop(image) {
  const bounds = png.contentBounds(image, 40);
  if (bounds.empty) throw new Error('The source image appears to be blank.');

  const tight = Math.min(bounds.width, bounds.height, image.width, image.height);
  const edge = Math.min(Math.round(tight * MARK_PADDING_RATIO), image.width, image.height);
  const centreX = bounds.x + bounds.width / 2;
  const centreY = bounds.y + bounds.height / 2;

  let x = Math.round(centreX - edge / 2);
  let y = Math.round(centreY - edge / 2);
  x = Math.max(0, Math.min(x, image.width - edge));
  y = Math.max(0, Math.min(y, image.height - edge));

  return { x, y, edge, bounds };
}

function page(dataUri, crop, size, sourceWidth) {
  const scale = size / crop.edge;
  const frame = Math.round(crop.edge * scale);
  const imageWidth = Math.round(sourceWidth * scale);
  const offsetX = Math.round(-crop.x * scale);
  const offsetY = Math.round(-crop.y * scale);

  return '<!doctype html><html><head><meta charset="utf-8"><style>' +
    'html,body{margin:0;padding:0;background:transparent;}' +
    '.frame{position:relative;width:' + frame + 'px;height:' + frame + 'px;' +
    'overflow:hidden;border-radius:' + (size * CORNER_RATIO).toFixed(2) + 'px;}' +
    '.frame img{position:absolute;left:' + offsetX + 'px;top:' + offsetY + 'px;' +
    'width:' + imageWidth + 'px;height:auto;image-rendering:auto;}' +
    '</style></head><body><div class="frame"><img src="' + dataUri + '"></div></body></html>';
}

function shoot(chrome, html, size, outFile) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-icons-'));
  const htmlFile = path.join(work, 'icon.html');
  fs.writeFileSync(htmlFile, html, 'utf8');

  const result = spawnSync(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    /* Transparent, so the rounded corners stay rounded instead of being filled
       with white by the default page background. */
    '--default-background-color=00000000',
    '--force-device-scale-factor=1',
    '--screenshot=' + outFile,
    '--window-size=' + size + ',' + size,
    /* Correct here — a local file with one inline image settles immediately.
       It would be wrong on a page with pending network requests, which never
       settle and so never finish. */
    '--virtual-time-budget=3000',
    'file:///' + htmlFile.replace(/\\/g, '/')
  ], { stdio: 'ignore' });

  try { fs.rmSync(work, { recursive: true, force: true }); } catch (e) { /* temporary */ }

  if (result.error) throw result.error;
  if (!fs.existsSync(outFile)) throw new Error('Chrome produced no image at ' + size + 'px.');
}

/* Pack PNG frames into a Windows icon directory. */
function buildIco(frames) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);              // reserved
  header.writeUInt16LE(1, 2);              // type 1 is an icon
  header.writeUInt16LE(frames.length, 4);

  const directory = Buffer.alloc(16 * frames.length);
  let offset = header.length + directory.length;

  frames.forEach((frame, index) => {
    const at = index * 16;
    /* A dimension of 256 is written as zero; the field is a single byte. */
    directory[at] = frame.size >= 256 ? 0 : frame.size;
    directory[at + 1] = frame.size >= 256 ? 0 : frame.size;
    directory[at + 2] = 0;                 // palette colours
    directory[at + 3] = 0;                 // reserved
    directory.writeUInt16LE(1, at + 4);    // colour planes
    directory.writeUInt16LE(32, at + 6);   // bits per pixel
    directory.writeUInt32LE(frame.data.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += frame.data.length;
  });

  return Buffer.concat([header, directory, ...frames.map(f => f.data)]);
}

function main() {
  if (!fs.existsSync(SOURCE)) {
    console.error('Source artwork not found: ' + SOURCE);
    process.exit(1);
  }
  const chrome = findChrome();
  if (!chrome) {
    console.error('No Chrome or Edge found to rasterise with. Icons cannot be generated on this machine.');
    process.exit(1);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const buffer = fs.readFileSync(SOURCE);
  const image = png.decode(buffer);
  const crop = squareCrop(image);
  console.log('Source ' + image.width + '×' + image.height +
    ' — content measured at ' + crop.bounds.width + '×' + crop.bounds.height +
    ', cropping ' + crop.edge + '×' + crop.edge + ' at ' + crop.x + ',' + crop.y);

  const dataUri = 'data:image/png;base64,' + buffer.toString('base64');
  const sizes = Array.from(new Set(ICO_SIZES.concat(PNG_SIZES))).sort((a, b) => b - a);
  const rendered = new Map();

  sizes.forEach(size => {
    const out = path.join(OUT_DIR, brand.iconStem + '-' + size + '.png');
    shoot(chrome, page(dataUri, crop, size, image.width), size, out);
    rendered.set(size, fs.readFileSync(out));
    console.log('  rendered ' + size + 'px');
  });

  /* Sizes not loaded directly by the interface exist only to go into the icon
     container, so they are not left behind as files. */
  PNG_SIZES.forEach(size => { /* kept */ });
  ICO_SIZES.filter(s => PNG_SIZES.indexOf(s) === -1).forEach(size => {
    try { fs.unlinkSync(path.join(OUT_DIR, brand.iconStem + '-' + size + '.png')); } catch (e) { /* already gone */ }
  });

  const ico = buildIco(ICO_SIZES.map(size => ({ size, data: rendered.get(size) })));
  const icoPath = path.join(OUT_DIR, brand.iconStem + '.ico');
  fs.writeFileSync(icoPath, ico);
  console.log('Wrote ' + icoPath + ' (' + ICO_SIZES.length + ' frames, ' + Math.round(ico.length / 1024) + 'KB)');
}

if (require.main === module) main();

module.exports = { squareCrop, buildIco, findChrome };
