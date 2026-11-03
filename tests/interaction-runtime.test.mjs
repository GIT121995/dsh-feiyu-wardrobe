/** M5 runtime.interact / interactionStatus：宿主唯一写入、失败不写盘、status 口径一致。 */
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { validateConfig } from '../lib/config.js';
import { WardrobeRuntime } from '../lib/runtime.js';

const NOW = Date.parse('2026-11-03T04:00:00Z');

function makeRuntime() {
	const dir = mkdtempSync(join(tmpdir(), 'feiyu-m5-rt-'));
	const config = validateConfig({ statePath: join(dir, 'state.json'), fishName: '测试鱼' });
	const clock = { now: NOW };
	const runtime = new WardrobeRuntime(config, { clock: () => clock.now });
	return { runtime, config, dir, clock, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('interact(feed)：扣鱼粮/记账/落盘；重新加载可见', () => {
	const { runtime, config, cleanup } = makeRuntime();
	try {
		const start = runtime.state.coins;
		const result = runtime.interact('feed', { tier: 'small' });
		assert.equal(result.ok, true);
		assert.equal(result.state.coins, start - 3);
		assert.equal(result.state.today.feeds, 1);
		const reloaded = new WardrobeRuntime(config, { clock: () => NOW });
		assert.equal(reloaded.state.coins, start - 3);
		assert.equal(reloaded.state.totals.coinsSpent, 3);
	} finally {
		cleanup();
	}
});

test('interact 拒绝路径零变更且不写盘（冷却）', () => {
	const { runtime, config, dir, cleanup } = makeRuntime();
	try {
		runtime.interact('feed', { tier: 'small' });
		const before = readFileSync(config.statePath, 'utf8');
		const rejected = runtime.interact('feed', { tier: 'small' });
		assert.equal(rejected.ok, false);
		assert.equal(rejected.reason, 'cooldown');
		assert.ok(rejected.retryInMs > 0);
		assert.equal(readFileSync(config.statePath, 'utf8'), before, '拒绝不应写盘');
		assert.ok(dir);
	} finally {
		cleanup();
	}
});

test('interact(pat/greet/bad-kind)', () => {
	const { runtime, cleanup } = makeRuntime();
	try {
		assert.equal(runtime.interact('pat').ok, true);
		assert.equal(runtime.interact('pat').ok, false, '20s 冷却');
		const greet = runtime.interact('greet');
		assert.equal(greet.ok, true);
		assert.equal(runtime.interact('greet').ok, false, '每日一次');
		assert.equal(runtime.interact('nope').ok, false);
		assert.equal(runtime.interact('nope').reason, 'bad-kind');
	} finally {
		cleanup();
	}
});

test('interactionStatus 与 status().interactions 口径一致（mood/intimacy/coins/today）', () => {
	const { runtime, cleanup } = makeRuntime();
	try {
		runtime.interact('pat');
		const a = runtime.interactionStatus();
		const b = runtime.status().interactionState;
		assert.deepEqual(a, b);
		assert.equal(a.ok, undefined); // summary 本身无 ok 包装（端点加）
		assert.equal(typeof a.mood.label, 'string');
		assert.equal(typeof a.intimacy.title, 'string');
		assert.equal(a.limits.patDailyMax, 12);
	} finally {
		cleanup();
	}
});

test('聊天事件路径不变：user/message 只加 interactions 计数，不写互动账本', () => {
	const { runtime, cleanup } = makeRuntime();
	try {
		const before = JSON.parse(JSON.stringify(runtime.state.interactions));
		runtime.handleSessionEvent({ id: 's1' }, { type: 'user/message', data: { source: { kind: 'user' }, content: 'hi' } });
		assert.equal(runtime.state.totals.interactions, 1);
		assert.deepEqual(runtime.state.interactions, before, '聊天不写 pat/feed/greet 账本');
	} finally {
		cleanup();
	}
});

test('disabled 配置：interactionStatus.enabled=false 且 interact 被拒', () => {
	const dir = mkdtempSync(join(tmpdir(), 'feiyu-m5-rt2-'));
	try {
		const config = validateConfig({
			statePath: join(dir, 'state.json'),
			dressUp: { interaction: { enabled: false } },
		});
		const runtime = new WardrobeRuntime(config, { clock: () => NOW });
		assert.equal(runtime.interactionStatus().enabled, false);
		assert.equal(runtime.interact('pat').ok, false);
		assert.equal(runtime.interact('pat').reason, 'disabled');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
