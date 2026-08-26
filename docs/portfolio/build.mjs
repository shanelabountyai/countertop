// Builds the portfolio page (C-032): `node docs/portfolio/build.mjs`.
//
// The page is published as a private Claude artifact, which must be entirely
// self-contained — no external requests except Google Fonts. So the eleven
// screenshots in `docs/screenshots/` are inlined as data URIs here rather than
// linked, and the output is ~1.1 MB and deliberately NOT committed.
//
// Two fragments and a script instead of one big HTML file, for the same reason
// the app keeps its prices in one module: the head carries the design tokens
// and nothing else, the body carries the words, and the images are wired in by
// name so a renamed screenshot fails loudly here rather than rendering a
// broken image on a portfolio page.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const shots = join(here, '..', 'screenshots');

/** Which screenshot fills which slot in the body. */
const IMAGES = {
  IMG_CARD: '06-kitchen-card.png',
  IMG_QUEUE: '10-kitchen-viewport.png',
  IMG_REPORT_MID: '07-report-midservice.png',
  IMG_REPORT_AFTER: '11-report-after.png',
  IMG_COMPOSER: '02-composer.png',
  IMG_CONFIRM: '09-price-confirm.png',
  IMG_SETTINGS: '08-settings.png',
};

const head = readFileSync(join(here, 'head.html'), 'utf8');
let body = readFileSync(join(here, 'body.html'), 'utf8');

for (const [token, file] of Object.entries(IMAGES)) {
  if (!body.includes(token)) throw new Error(`${token} is not used by body.html`);
  const data = readFileSync(join(shots, file)).toString('base64');
  body = body.replaceAll(token, `data:image/png;base64,${data}`);
}

const out = join(here, 'countertop.html');
writeFileSync(out, `${head}\n${body}`);
console.log(`${out} — ${(Buffer.byteLength(head + body) / 1024 / 1024).toFixed(2)} MB`);
