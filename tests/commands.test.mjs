import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { executeFishCommand, formatStatus, formatWardrobe, registerFishCommand } from '../lib/commands.js';
import { validateConfig } from '../lib/config.js';
import { WardrobeRuntime } from '../lib/runtime.js';

const NOW = Date.parse('2026-10-30T05:00:00Z');

function setup() {
	const dir = mkdtempSync(join(tmpdir(), 'feiyu-cmd-'));
	const config = validateConfig({ statePath: join(dir, 'state.json'), fishName: '命令鱼' });
	const runtime = new WardrobeRuntime(config, { clock: () => NOW });
	return {
		runtime,
		config,
		dir,
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

test('status output mentions the fish, coins and mood', () => {
	const { runtime, cleanup } = setup();
	try {
		const text = formatStatus(runtime, NOW);
		assert.match(text, /命令鱼/);
		assert.match(text, /鱼粮币/);
		assert.match(text, /心情/);
		assert.match(text, /亲密度/);
	} finally {
		cleanup();
	}
});

test('wardrobe listing groups by slot and marks ownership', () => {
	const { runtime, cleanup } = setup();
	try {
		const text = formatWardrobe(runtime);
		assert.match(text, /衣柜/);
		assert.match(text, /【头部】/);
		assert.match(text, /小叶子/);
		assert.match(text, /王冠/);
		assert.match(text, /600 币/);
	} finally {
		cleanup();
	}
});

test('buy / wear / takeoff / rename through the command surface', () => {
	const { runtime, cleanup } = setup();
	try {
		runtime.state.coins = 200;
		const bought = executeFishCommand(runtime, 'buy 红围巾', { now: NOW });
		assert.equal(bought.kind, 'success');
		assert.match(bought.text, /买到了/);

		const worn = executeFishCommand(runtime, 'wear hat-leaf', { now: NOW });
		assert.equal(worn.kind, 'success');

		const takenOff = executeFishCommand(runtime, 'takeoff hat', { now: NOW });
		assert.equal(takenOff.kind, 'success');

		const renamed = executeFishCommand(runtime, 'rename 小鲸', { now: NOW });
		assert.equal(renamed.kind, 'success');
		assert.equal(runtime.state.fishName, '小鲸');
	} finally {
		cleanup();
	}
});

test('report subcommand writes the card and returns its path', () => {
	const { runtime, dir, cleanup } = setup();
	try {
		const result = executeFishCommand(runtime, 'report', { now: NOW });
		assert.equal(result.kind, 'success');
		const path = join(dir, 'report.html');
		assert.ok(result.text.includes(path));
		assert.ok(existsSync(path));
	} finally {
		cleanup();
	}
});

test('help and unknown inputs behave', () => {
	const { runtime, cleanup } = setup();
	try {
		assert.match(executeFishCommand(runtime, 'help', { now: NOW }).text, /\/fish list/);
		const unknown = executeFishCommand(runtime, 'dance', { now: NOW });
		assert.equal(unknown.kind, 'error');
		assert.match(unknown.text, /看不懂/);
		assert.equal(executeFishCommand(runtime, 'buy', { now: NOW }).kind, 'error');
	} finally {
		cleanup();
	}
});

test('a bare item name falls back to wear-or-buy help', () => {
	const { runtime, cleanup } = setup();
	try {
		const owned = executeFishCommand(runtime, '小叶子', { now: NOW });
		assert.equal(owned.kind, 'success');
		assert.match(owned.text, /小叶子/);
		runtime.state.coins = 200;
		const unowned = executeFishCommand(runtime, '草帽', { now: NOW });
		assert.match(unowned.text, /120 币/);
	} finally {
		cleanup();
	}
});

test('registerFishCommand wires a /fish handler', () => {
	const { runtime, cleanup } = setup();
	try {
		let registered = null;
		const commands = {
			register(definition) {
				registered = definition;
				return () => undefined;
			},
		};
		const dispose = registerFishCommand(commands, runtime);
		assert.equal(typeof dispose, 'function');
		assert.equal(registered.name, 'fish');
		assert.equal(registered.recordInput, false);
		const result = registered.handler({ rawInput: 'status' });
		assert.match(result.text, /命令鱼/);
	} finally {
		cleanup();
	}
});
