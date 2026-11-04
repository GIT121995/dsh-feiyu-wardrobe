#!/usr/bin/env node
/**
 * dsh-feiyu-diy — DIY 宿主流水线 CLI（agent 可调用；**所有命令输出单行 JSON**）。
 *
 * 命令：
 *   plan    --image <path> [--name <str>] [--category top|bottom|dress|coat|outfit|auto]
 *           [--shape chibi] [--description <str>] [--reroll 0-9]
 *   run     --job <id> [--stage generate|split|bind|qa|install|all] [--force]
 *   status  --job <id>
 *   install --job <id> [--dry-run]
 *   list
 *   remove  --id <itemId> [--dry-run]
 *   version
 *
 * 公共参数：--home <diy数据目录> --state <state.json> --enabled（显式开启，默认关闭时必需）
 *          --verbose（进度写 stderr；stdout 仍只有一行 JSON）
 *
 * 安全：不输出 API key/图片 base64/原始描述到 stdout；错误信息已脱敏。
 */

import {
	DiyPipelineError,
	defaultPipelineConfig,
	createDiyPipeline,
} from '../lib/diy-pipeline.js';

/** @param {string[]} argv */
function parseArgs(argv) {
	/** @type {Record<string, string | boolean>} */
	const options = {};
	/** @type {string[]} */
	const positional = [];
	for (let i = 0; i < argv.length; i += 1) {
		const token = argv[i];
		if (!token.startsWith('--')) {
			positional.push(token);
			continue;
		}
		const eq = token.indexOf('=');
		if (eq > 2) {
			options[token.slice(2, eq)] = token.slice(eq + 1);
			continue;
		}
		const key = token.slice(2);
		const next = argv[i + 1];
		if (typeof next === 'string' && !next.startsWith('--')) {
			options[key] = next;
			i += 1;
		} else {
			options[key] = true;
		}
	}
	return { options, positional };
}

/** @param {unknown} value */
function emit(value) {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}

/** @param {any} error */
function errorPayload(error) {
	if (error instanceof DiyPipelineError) {
		return { ok: false, code: error.code, message: error.message, details: error.details || {} };
	}
	return { ok: false, code: 'internal_error', message: error instanceof Error ? error.message : String(error) };
}

const USAGE = {
	ok: true,
	usage: [
		'dsh-feiyu-diy plan --image <path> [--name][--category][--shape chibi][--description][--reroll]',
		'dsh-feiyu-diy run --job <id> [--stage generate|split|bind|qa|install|all] [--force]',
		'dsh-feiyu-diy status --job <id>',
		'dsh-feiyu-diy install --job <id> [--dry-run]',
		'dsh-feiyu-diy list',
		'dsh-feiyu-diy remove --id <itemId> [--dry-run]',
	],
	note: '所有命令输出单行 JSON；DIY 默认关闭，run/install 需 config.diy.enabled=true 或显式 --enabled',
};

async function main() {
	const { options, positional } = parseArgs(process.argv.slice(2));
	const command = positional[0] || (options.help ? 'help' : '');
	if (!command || command === 'help' || options.help) {
		emit(USAGE);
		return 0;
	}
	if (command === 'version') {
		emit({ ok: true, name: 'dsh-feiyu-diy', pipelineVersion: 1 });
		return 0;
	}
	const home = typeof options.home === 'string' ? options.home : undefined;
	const statePath = typeof options.state === 'string' ? options.state : home ? `${home}/state.json` : undefined;
	const config = defaultPipelineConfig(statePath ? { statePath } : {});
	const verbose = options.verbose === true;
	const logger = verbose
		? { info: (/** @type {string} */ message) => process.stderr.write(`${message}\n`) }
		: undefined;
	const pipeline = createDiyPipeline({
		config,
		home,
		enabledOverride: options.enabled === true,
		logger,
	});
	switch (command) {
		case 'plan':
			emit(pipeline.plan({
				image: String(options.image || ''),
				name: options.name === undefined ? undefined : String(options.name),
				category: options.category === undefined ? undefined : String(options.category),
				description: options.description === undefined ? undefined : String(options.description),
				shape: options.shape === undefined ? undefined : String(options.shape),
				reroll: options.reroll === undefined ? 0 : Number(options.reroll),
			}));
			return 0;
		case 'run': {
			const result = await pipeline.run({
				job: String(options.job || ''),
				stage: options.stage === undefined ? 'all' : String(options.stage),
				force: options.force === true,
			});
			emit(trimRun(result));
			return result.ok ? 0 : 1;
		}
		case 'status':
			emit(pipeline.status({ job: String(options.job || '') }));
			return 0;
		case 'install': {
			if (options['dry-run'] === true) {
				emit(pipeline.install(String(options.job || ''), { dryRun: true }));
				return 0;
			}
			const result = await pipeline.run({ job: String(options.job || ''), stage: 'install', force: false });
			emit(trimRun(result));
			return result.ok ? 0 : 1;
		}
		case 'list':
			emit(pipeline.list());
			return 0;
		case 'remove':
			emit(pipeline.remove({ id: String(options.id || ''), dryRun: options['dry-run'] === true }));
			return 0;
		default:
			emit({ ok: false, code: 'bad_argument', message: `未知命令：${command}`, usage: USAGE.usage });
			return 2;
	}
}

/** run 输出裁剪：不返回每个 stage 的完整中间数据（可能很大），只保留摘要。 */
function trimRun(result) {
	if (!result || result.ok === false) return result;
	const summary = {};
	for (const [stage, entry] of Object.entries(result.results || {})) {
		summary[stage] = entry.status === 'success' ? 'success' : entry.status;
	}
	return {
		ok: true,
		job: result.job,
		itemId: result.itemId,
		stages: result.stages,
		summary,
		qa: result.qa,
		install: result.install,
	};
}

try {
	const code = await main();
	process.exitCode = code;
} catch (error) {
	emit(errorPayload(error));
	process.exitCode = 1;
}
