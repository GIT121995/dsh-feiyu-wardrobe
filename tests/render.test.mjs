import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ITEMS, ITEM_BY_ID, RARITIES, SLOTS, findItem, itemsForSlot, rarityLabel, slotLabel } from '../lib/catalog.js';
import { validateConfig } from '../lib/config.js';
import { createDemoState } from '../lib/demo.js';
import { renderCardHtml, renderWardrobeSheetHtml, sceneSvg, faceSvg, weekBarsSvg } from '../lib/render.js';
import { writeReportCard } from '../lib/report.js';
import { createState } from '../lib/state.js';

const NOW = Date.parse('2026-10-30T05:00:00Z');
const config = validateConfig({ statePath: '/tmp/feiyu-render/state.json' });

test('catalog is well-formed', () => {
	assert.equal(ITEMS.length, 21);
	const ids = new Set(ITEMS.map((item) => item.id));
	assert.equal(ids.size, ITEMS.length, 'ids are unique');
	for (const item of ITEMS) {
		assert.ok(item.svg.includes('<'), `${item.id} has svg markup`);
		assert.ok(item.price >= 0, `${item.id} price is non-negative`);
		assert.ok(RARITIES[item.rarity], `${item.id} rarity is known`);
		assert.ok(SLOTS.some((slot) => slot.id === item.slot), `${item.id} slot is known`);
		assert.ok(!/<script|<img|https?:\/\//i.test(item.svg), `${item.id} svg has no external refs`);
		assert.ok(item.desc.length > 0);
	}
	for (const slot of SLOTS) assert.ok(itemsForSlot(slot.id).length > 0, `slot ${slot.id} is populated`);
	assert.equal(ITEM_BY_ID.size, ITEMS.length);
});

test('findItem resolves id, exact name and unique substring', () => {
	assert.equal(findItem('hat-crown')?.name, '王冠');
	assert.equal(findItem('王冠')?.id, 'hat-crown');
	assert.equal(findItem('围巾')?.id, 'neck-scarf');
	assert.equal(findItem('不存在的衣服'), null);
	assert.equal(findItem(''), null);
	assert.equal(slotLabel('hat'), '头部');
	assert.equal(rarityLabel('epic'), '史诗');
});

test('scene renders the whale and worn layers', () => {
	const state = createDemoState(config, NOW);
	const svg = sceneSvg(state);
	assert.ok(svg.startsWith('<svg'));
	assert.ok(svg.includes('viewBox="0 0 360 360"'));
	assert.ok(svg.includes('#8ECFF5'), 'whale body color');
});

test('mood face variants differ', () => {
	const calm = faceSvg('calm');
	const happy = faceSvg('happy');
	const hungry = faceSvg('hungry');
	assert.notEqual(calm, happy);
	assert.notEqual(calm, hungry);
	assert.ok(happy.length > 0 && hungry.length > 0);
});

test('the share card is self-contained and carries the stats', () => {
	const state = createDemoState(config, NOW);
	const html = renderCardHtml(state, config, { now: NOW });
	assert.ok(html.startsWith('<!doctype html>'));
	assert.ok(html.includes('干饭鲸'));
	assert.ok(html.includes('饲养报告'));
	assert.ok(html.includes('1080px'));
	assert.ok(html.includes('投喂金额'));
	assert.ok(html.includes('近 7 天伙食'));
	assert.ok(html.includes('今日穿搭'));
	assert.ok(html.includes('非官方二创'));
	assert.ok(!html.includes('<script'), 'no scripts');
	assert.ok(!html.includes('<img'), 'no images');
	assert.ok(!html.includes('@import'), 'no external fonts');
	assert.ok(!html.includes('src="http'), 'no remote sources');
});

test('empty wardrobe still renders a card', () => {
	const state = createState(config, NOW);
	const html = renderCardHtml(state, config, { now: NOW });
	assert.ok(html.includes('素鱼一条'));
	assert.ok(html.includes(config.fishName));
});

test('week bars render seven columns', () => {
	const state = createDemoState(config, NOW);
	const svg = weekBarsSvg(state, config, NOW);
	assert.equal((svg.match(/<rect /g) ?? []).length, 7);
});

test('wardrobe sheet lists every item', () => {
	const html = renderWardrobeSheetHtml();
	assert.ok(html.includes('衣柜'));
	for (const item of ITEMS) assert.ok(html.includes(item.name), `sheet contains ${item.name}`);
});

test('writeReportCard writes html next to the state file', () => {
	const dir = mkdtempSync(join(tmpdir(), 'feiyu-report-'));
	try {
		const local = validateConfig({ statePath: join(dir, 'state.json'), fishName: '报告鱼' });
		const state = createState(local, NOW);
		const path = writeReportCard(state, local, { now: NOW });
		const html = readFileSync(path, 'utf8');
		assert.ok(html.includes('报告鱼'));
		assert.ok(path.endsWith('report.html'));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
