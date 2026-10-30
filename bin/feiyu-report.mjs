#!/usr/bin/env node
/**
 * dsh-feiyu-report — render the 1080×1440 share card for the local fish.
 *
 * Usage:
 *   dsh-feiyu-report                 # card from the real state file
 *   dsh-feiyu-report --demo          # preview with a demo fish
 *   dsh-feiyu-report --out card.html # custom output path
 *   dsh-feiyu-report --open          # open the card in the default browser
 *   dsh-feiyu-report --sheet         # render the full wardrobe catalog sheet
 */

import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { renderFishPng } from '../lib/image.js';
import { renderWardrobeSheetHtml } from '../lib/render.js';
import { createDemoState } from '../lib/demo.js';
import { validateConfig } from '../lib/config.js';
import { loadState } from '../lib/state.js';
import { defaultReportPath, writeReportCard } from '../lib/report.js';
import { atomicWriteBuffer, atomicWriteFile } from '../lib/util.js';

const PACKAGE = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const VERSION = PACKAGE.version ?? '0.0.0';

const HELP = `dsh-feiyu-report — 大肥鱼衣橱饲养报告卡

用法:
  dsh-feiyu-report                 从本机 state 生成报告卡
  dsh-feiyu-report --demo          用演示鱼生成一张预览卡
  dsh-feiyu-report --sheet         渲染整个衣柜目录页
  dsh-feiyu-report --png <path>    渲染当前穿搭的 PNG（可直接发 QQ 群）
  dsh-feiyu-report --size <像素>   PNG 边长（256–1600，默认 768）
  dsh-feiyu-report --out <path>    指定 HTML 输出路径
  dsh-feiyu-report --state <path>  指定 state.json
  dsh-feiyu-report --open          生成后用默认浏览器打开
  dsh-feiyu-report --version       版本号
  dsh-feiyu-report --help          本说明
`;

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
	const options = {
		demo: false,
		sheet: false,
		open: false,
		help: false,
		version: false,
		out: null,
		png: null,
		size: null,
		state: null,
	};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		switch (arg) {
			case '--demo':
				options.demo = true;
				break;
			case '--sheet':
				options.sheet = true;
				break;
			case '--open':
				options.open = true;
				break;
			case '--help':
			case '-h':
				options.help = true;
				break;
			case '--version':
			case '-v':
				options.version = true;
				break;
			case '--out': {
				options.out = argv[index + 1] ?? null;
				index += 1;
				break;
			}
			case '--png': {
				options.png = argv[index + 1] ?? null;
				index += 1;
				break;
			}
			case '--size': {
				options.size = argv[index + 1] ?? null;
				index += 1;
				break;
			}
			case '--state': {
				options.state = argv[index + 1] ?? null;
				index += 1;
				break;
			}
			default:
				throw new Error(`未知参数：${arg}（--help 查看用法）`);
		}
	}
	return options;
}

/**
 * @param {string} path
 */
function openInBrowser(path) {
	const command =
		process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
	const args = process.platform === 'win32' ? ['/c', 'start', '', path] : [path];
	try {
		const child = spawn(command, args, { detached: true, stdio: 'ignore' });
		child.on('error', () => undefined);
		child.unref();
	} catch {
		// opening is a convenience; the printed path is the contract
	}
}

function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		process.stdout.write(HELP);
		return;
	}
	if (options.version) {
		process.stdout.write(`${VERSION}\n`);
		return;
	}
	const config = validateConfig(options.state ? { statePath: options.state } : {});
	if (options.sheet) {
		const outPath = resolve(options.out ?? join(dirname(config.statePath), 'wardrobe.html'));
		atomicWriteFile(outPath, renderWardrobeSheetHtml());
		process.stdout.write(`${outPath}\n`);
		if (options.open) openInBrowser(outPath);
		return;
	}
	let state;
	if (options.demo) {
		state = createDemoState(config);
	} else {
		if (!existsSync(config.statePath)) {
			process.stderr.write(
				`还没有鱼：找不到 ${config.statePath}\n先在 DSH 里和它说句话（或运行 dsh-feiyu-report --demo 看预览）。\n`,
			);
			process.exitCode = 1;
			return;
		}
		const loaded = loadState(config.statePath, config);
		state = loaded.state;
	}
	if (options.png) {
		const sizeValue = options.size == null ? undefined : Number(options.size);
		if (sizeValue !== undefined && (!Number.isFinite(sizeValue) || sizeValue < 256 || sizeValue > 1600)) {
			throw new Error('--size 需要 256–1600 之间的整数');
		}
		const png = renderFishPng(state, config, {
			...(sizeValue === undefined ? {} : { size: sizeValue }),
		});
		const pngPath = resolve(options.png);
		atomicWriteBuffer(pngPath, png);
		process.stdout.write(`${pngPath}\n`);
		if (options.open) openInBrowser(pngPath);
		return;
	}
	const outPath = writeReportCard(state, config, {
		...(options.out ? { outPath: resolve(options.out) } : {}),
	});
	process.stdout.write(`${outPath}\n`);
	if (options.open) openInBrowser(outPath);
}

try {
	main();
} catch (cause) {
	process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
	process.exitCode = 1;
}
