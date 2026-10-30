import assert from 'node:assert/strict';
import test from 'node:test';

import { validateConfig } from '../lib/config.js';
import { createDemoState } from '../lib/demo.js';
import { buildPngSvg, pngSize, renderFishPng } from '../lib/image.js';

const NOW = Date.parse('2026-10-30T05:00:00Z');
const config = validateConfig({ statePath: '/tmp/feiyu-image/state.json', fishName: '出图鱼' });

test('buildPngSvg carries the scene, name and repo watermark', () => {
	const state = createDemoState(config, NOW);
	const { svg, width, height } = buildPngSvg(state, config, { now: NOW, size: 512 });
	assert.equal(width, 512);
	assert.ok(height > 512);
	assert.ok(svg.includes('github.com/GIT121995/dsh-feiyu-wardrobe'));
	assert.ok(svg.includes('出图鱼') || svg.includes('干饭鲸'));
	assert.ok(svg.includes('viewBox="0 0 512'));
});

test('watermark can be disabled', () => {
	const state = createDemoState(config, NOW);
	const { svg, height } = buildPngSvg(state, config, { now: NOW, size: 512, watermark: false });
	assert.equal(height, 512);
	assert.ok(!svg.includes('github.com/GIT121995'));
});

test('renderFishPng produces a valid PNG buffer', () => {
	const state = createDemoState(config, NOW);
	const png = renderFishPng(state, config, { now: NOW, size: 512 });
	assert.ok(Buffer.isBuffer(png));
	assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
	const size = pngSize(png);
	assert.equal(size.width, 512);
	assert.ok(size.height > 512);
	assert.ok(png.length > 5000, `png too small: ${png.length}`);
});

test('pngSize rejects non-PNG buffers', () => {
	assert.deepEqual(pngSize(Buffer.from('not a png')), { width: 0, height: 0 });
});
