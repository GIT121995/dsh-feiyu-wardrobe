#!/usr/bin/env node
/**
 * Regenerate the README previews (docs/preview/card.png + wardrobe.png).
 * Uses the demo fish, so it never touches a real state file.
 *
 *   node scripts/preview.mjs
 *
 * Chrome/Chromium is optional: without it the HTML previews are still written.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'docs', 'preview');
mkdirSync(outDir, { recursive: true });

const node = process.execPath;
const report = join(root, 'bin', 'feiyu-report.mjs');
const cardHtml = join(outDir, 'card.html');
const wardrobeHtml = join(outDir, 'wardrobe.html');

execFileSync(node, [report, '--demo', '--out', cardHtml], { stdio: 'inherit' });
execFileSync(node, [report, '--sheet', '--out', wardrobeHtml], { stdio: 'inherit' });

const chromeCandidates = ['google-chrome', 'chromium', 'chromium-browser'];
let chrome = null;
for (const candidate of chromeCandidates) {
	try {
		execFileSync('which', [candidate], { stdio: 'ignore' });
		chrome = candidate;
		break;
	} catch {
		// try the next candidate
	}
}

if (!chrome) {
	console.log('Chrome not found — HTML previews written, PNGs skipped.');
	process.exit(0);
}

const shots = [
	{ url: cardHtml, png: join(outDir, 'card.png'), size: '1080,1440' },
	{ url: wardrobeHtml, png: join(outDir, 'wardrobe.png'), size: '1400,1010' },
];
for (const shot of shots) {
	execFileSync(
		chrome,
		[
			'--headless=new',
			'--disable-gpu',
			'--no-sandbox',
			'--hide-scrollbars',
			'--force-device-scale-factor=1',
			`--window-size=${shot.size}`,
			`--screenshot=${shot.png}`,
			`file://${shot.url}`,
		],
		{ stdio: 'ignore' },
	);
	console.log(`wrote ${shot.png}`);
}
