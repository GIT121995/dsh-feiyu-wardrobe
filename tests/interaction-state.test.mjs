/** M5 state v2：interactions 账本迁移 / 修复 / prune / 持久化（无台词文本）。 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { validateConfig } from '../lib/config.js';
import { createState, loadState, normalizeState, pruneDaily, saveState } from '../lib/state.js';

const NOW = Date.parse('2026-11-03T02:00:00Z');
const config = validateConfig({ statePath: '/tmp/feiyu-m5-state.json' });

test('v1 状态迁移到 v2：interactions 默认零值、coinsSpent 默认 0', () => {
	const v1 = createState(config, NOW);
	delete v1.interactions;
	delete v1.totals.coinsSpent;
	v1.version = 1;
	const state = normalizeState(v1, config, NOW);
	assert.equal(state.version, 2);
	assert.deepEqual(state.interactions.lifetime, { pats: 0, feeds: 0, greets: 0, coinsSpent: 0 });
	assert.deepEqual(state.interactions.last, { patAt: null, feedAt: null, greetDay: null });
	assert.deepEqual(state.interactions.daily, {});
	assert.equal(state.totals.coinsSpent, 0);
});

test('normalizeState 修复损坏的 interactions（负数/NaN/非法日期键/越权数据）', () => {
	const raw = createState(config, NOW);
	raw.interactions = {
		lifetime: { pats: -3, feeds: 1.9, greets: NaN, coinsSpent: -1 },
		last: { patAt: 'nope', feedAt: NOW, greetDay: 'not-a-day' },
		daily: {
			'2026-11-01': { pats: 2.7, feeds: -1, greets: 0, coinsSpent: NaN },
			'bad-key': { pats: 9 },
		},
	};
	const state = normalizeState(raw, config, NOW);
	assert.equal(state.interactions.lifetime.pats, 0);
	assert.equal(state.interactions.lifetime.feeds, 1);
	assert.equal(state.interactions.lifetime.greets, 0);
	assert.equal(state.interactions.lifetime.coinsSpent, 0);
	assert.equal(state.interactions.last.patAt, null);
	assert.equal(state.interactions.last.feedAt, NOW);
	assert.equal(state.interactions.last.greetDay, null);
	assert.deepEqual(state.interactions.daily, {
		'2026-11-01': { pats: 2, feeds: 0, greets: 0, coinsSpent: 0 },
	});
});

test('pruneDaily 同步裁剪 interactions.daily；daily 为空时也不漏裁', () => {
	const raw = createState(config, NOW);
	raw.daily = {
		'2026-10-30': { costCNY: 0, meals: 1, interactions: 0 },
		'2026-11-01': { costCNY: 0, meals: 1, interactions: 0 },
		'2026-11-03': { costCNY: 0, meals: 1, interactions: 0 },
	};
	raw.interactions.daily = {
		'2026-10-30': { pats: 1, feeds: 0, greets: 0, coinsSpent: 0 },
		'2026-11-01': { pats: 2, feeds: 0, greets: 0, coinsSpent: 0 },
		'2026-11-03': { pats: 3, feeds: 0, greets: 0, coinsSpent: 0 },
	};
	const state = normalizeState(raw, config, NOW);
	const removed = pruneDaily(state, { ...config, dailyRetentionDays: 2 }, NOW);
	assert.ok(removed >= 1);
	assert.deepEqual(Object.keys(state.daily), ['2026-11-01', '2026-11-03']);
	assert.deepEqual(Object.keys(state.interactions.daily), ['2026-11-01', '2026-11-03']);
});

test('save/load 往返保留 interactions；state.json 不含台词文本字段', () => {
	const dir = mkdtempSync(join(tmpdir(), 'feiyu-m5-state-'));
	const path = join(dir, 'state.json');
	const cfg = validateConfig({ statePath: path });
	const state = createState(cfg, NOW);
	state.coins = 42;
	state.interactions.lifetime = { pats: 3, feeds: 1, greets: 2, coinsSpent: 8 };
	state.interactions.last = { patAt: NOW, feedAt: NOW, greetDay: '2026-11-03' };
	state.interactions.daily = { '2026-11-03': { pats: 3, feeds: 1, greets: 2, coinsSpent: 8 } };
	saveState(path, state, NOW);
	const { state: loaded } = loadState(path, cfg, NOW);
	assert.deepEqual(loaded.interactions, state.interactions);
	assert.equal(loaded.totals.coinsSpent, 0);
	const text = readFileSync(path, 'utf8');
	assert.ok(!/摸摸头|开饭啦|台词|dialog/i.test(text), 'state 不应落任何台词文本');
	assert.ok(text.includes('"pats"'));
});
