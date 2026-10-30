/**
 * PNG rendering: turns the 360×360 scene into a shareable image with no
 * browser and no network. This is the "visual" half of the wardrobe — the
 * output can be dropped into a QQ group, a B站 comment or a phone album.
 *
 * Uses @resvg/resvg-js (prebuilt Rust binding) so rendering is deterministic
 * and fast; the only external input is the local state file.
 * @module dsh-feiyu-wardrobe/image
 */

import { Resvg } from '@resvg/resvg-js';
import { moodOf } from './economy.js';
import { CANVAS, sceneInner } from './render.js';

export const DEFAULT_PNG_SIZE = 768;
export const FOOTER_RATIO = 0.085;

/**
 * @param {string} text
 * @returns {string}
 */
function escapeXml(text) {
	return String(text)
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&apos;');
}

/**
 * Build the full PNG-ready SVG: the scene square plus an optional footer strip
 * carrying the repo URL and the fish's name.
 * @param {import('./state.js').FishState} state
 * @param {import('./config.js').FeiyuConfig} config
 * @param {{ now?: number, size?: number, watermark?: boolean }} [options]
 * @returns {{ svg: string, width: number, height: number, footerHeight: number }}
 */
export function buildPngSvg(state, config, options = {}) {
	const size = Math.max(256, Math.min(1600, Math.round(options.size ?? DEFAULT_PNG_SIZE)));
	const watermark = options.watermark !== false;
	const now = options.now ?? Date.now();
	const mood = moodOf(state, now, config);
	const scale = size / CANVAS;
	const footerHeight = watermark ? Math.round(size * FOOTER_RATIO) : 0;
	const height = size + footerHeight;
	const fontSize = Math.max(12, Math.round(size * 0.024));
	const inner = sceneInner(state, { face: mood.face });
	const footer = watermark
		? `<g font-family="'Noto Sans CJK SC','PingFang SC','Microsoft YaHei',sans-serif">
      <rect x="0" y="${size}" width="${size}" height="${footerHeight}" fill="#0D1524"/>
      <text x="${Math.round(size * 0.035)}" y="${size + Math.round(footerHeight * 0.62)}"
        font-size="${fontSize}" fill="#9FB0C8">大肥鱼衣橱 · github.com/GIT121995/dsh-feiyu-wardrobe</text>
      <text x="${size - Math.round(size * 0.035)}" y="${size + Math.round(footerHeight * 0.62)}"
        font-size="${fontSize}" fill="#F5C542" text-anchor="end">${escapeXml(state.fishName)} · 第 ${Math.max(1, Math.ceil((now - state.bornAt) / 86_400_000))} 天</text>
    </g>`
		: '';
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${height}" viewBox="0 0 ${size} ${height}">
  <rect width="${size}" height="${height}" fill="#0D1524"/>
  <g transform="scale(${scale})">${inner}</g>
  ${footer}
</svg>`;
	return { svg, width: size, height, footerHeight };
}

/**
 * Render the dressed fish as a PNG buffer.
 * @param {import('./state.js').FishState} state
 * @param {import('./config.js').FeiyuConfig} config
 * @param {{ now?: number, size?: number, watermark?: boolean }} [options]
 * @returns {Buffer}
 */
export function renderFishPng(state, config, options = {}) {
	const { svg, width, height } = buildPngSvg(state, config, options);
	const renderer = new Resvg(svg, {
		fitTo: { mode: 'width', value: width },
		background: '#0D1524',
		font: { loadSystemFonts: true, defaultFontFamily: 'Noto Sans CJK SC' },
	});
	return Buffer.from(renderer.render().asPng());
}

/**
 * PNG IHDR dimensions (for tests and CLI logs).
 * @param {Buffer} png
 * @returns {{ width: number, height: number }}
 */
export function pngSize(png) {
	if (!Buffer.isBuffer(png) || png.length < 24) return { width: 0, height: 0 };
	const signature = png.subarray(0, 8).toString('hex');
	if (signature !== '89504e470d0a1a0a') return { width: 0, height: 0 };
	return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}
