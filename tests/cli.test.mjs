import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const BIN = new URL('../bin/feiyu-report.mjs', import.meta.url).pathname;

/**
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} [env]
 */
function run(args, env = {}) {
	return spawnSync(process.execPath, [BIN, ...args], {
		encoding: 'utf8',
		env: { ...process.env, ...env },
	});
}

test('--version prints the package version', () => {
	const result = run(['--version']);
	assert.equal(result.status, 0);
	assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+$/);
});

test('--help prints usage', () => {
	const result = run(['--help']);
	assert.equal(result.status, 0);
	assert.match(result.stdout, /dsh-feiyu-report/);
	assert.match(result.stdout, /--demo/);
});

test('--demo renders a preview card without a fish', () => {
	const dir = mkdtempSync(join(tmpdir(), 'feiyu-cli-'));
	try {
		const out = join(dir, 'card.html');
		const result = run(['--demo', '--out', out]);
		assert.equal(result.status, 0);
		assert.equal(result.stdout.trim(), out);
		assert.ok(existsSync(out));
		const html = readFileSync(out, 'utf8');
		assert.ok(html.includes('饲养报告'));
		assert.ok(html.includes('干饭鲸'));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('--sheet renders the wardrobe catalog', () => {
	const dir = mkdtempSync(join(tmpdir(), 'feiyu-cli-sheet-'));
	try {
		const out = join(dir, 'wardrobe.html');
		const result = run(['--sheet', '--out', out]);
		assert.equal(result.status, 0);
		assert.ok(readFileSync(out, 'utf8').includes('衣柜'));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('without a fish the CLI explains itself and exits 1', () => {
	const dir = mkdtempSync(join(tmpdir(), 'feiyu-cli-empty-'));
	try {
		const result = run([], { DSH_HOME: dir });
		assert.equal(result.status, 1);
		assert.match(result.stderr, /还没有鱼/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('unknown flags are rejected', () => {
	const result = run(['--nope']);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /未知参数/);
});
