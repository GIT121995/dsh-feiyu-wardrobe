/**
 * `/fish` command surface: status, wardrobe, buying, wearing, renaming and
 * generating the shareable report card.
 * @module dsh-feiyu-wardrobe/commands
 */

import { ITEMS, RARITIES, SLOT_ORDER, findItem, rarityLabel, slotLabel } from './catalog.js';
import { summaryOf } from './economy.js';
import { renderFishPng } from './image.js';
import { writeReportCard } from './report.js';
import { atomicWriteBuffer, formatCNY, formatCoins, formatTokens } from './util.js';
import { dirname, join } from 'node:path';

const USAGE = [
	'/fish                    看鱼今天的状态',
	'/fish list               逛衣柜（已拥有 / 可买）',
	'/fish buy <名字|id>       用鱼粮币买下并穿上',
	'/fish wear <名字|id>      换上已拥有的衣服',
	'/fish takeoff <部位>      脱掉某个部位（bg/body/neck/face/hand/hat）',
	'/fish rename <名字>       给鱼改名',
	'/fish png [尺寸]          渲染当前穿搭的 PNG（默认 768，可直接发群）',
	'/fish report             生成一张可晒的饲养报告卡',
	'/fish help               显示这份说明',
].join('\n');

/**
 * @param {import('./runtime.js').WardrobeRuntime} runtime
 * @param {number} [now]
 * @returns {string}
 */
export function formatStatus(runtime, now = runtime.clock()) {
	const summary = summaryOf(runtime.state, now, runtime.config);
	const state = runtime.state;
	const tokensTotal =
		summary.tokens.total || summary.tokens.input + summary.tokens.cacheRead + summary.tokens.cacheWrite + summary.tokens.output;
	const coins = runtime.outfitLabel();
	return [
		`🐋 ${state.fishName} · 今天也在吃白饭`,
		'────────────────────────',
		`💰 累计投喂 ${formatCNY(summary.costCNY)}（今日 ${formatCNY(summary.today.costCNY)}）`,
		`🍚 干饭 ${summary.meals} 顿 · 吃掉 ${formatTokens(tokensTotal)} token`,
		`💬 互动 ${summary.interactions} 次 · 连续 ${summary.streakDays} 天`,
		`❤️ 亲密度 ${summary.intimacy.score}/100 · ${summary.intimacy.emoji} ${summary.intimacy.title}`,
		`😋 心情 ${summary.mood.emoji} ${summary.mood.label}（${summary.mood.score}/100）`,
		`🪙 鱼粮币 ${formatCoins(summary.coins)} · 养了 ${summary.daysAlive} 天 · ${state.sessions.length} 个会话`,
		`👗 穿搭：${coins}`,
		'用 /fish list 逛衣柜，/fish report 出卡片。',
	].join('\n');
}

/**
 * @param {import('./runtime.js').WardrobeRuntime} runtime
 * @returns {string}
 */
export function formatWardrobe(runtime) {
	const state = runtime.state;
	const coins = formatCoins(state.coins);
	const owned = state.owned.length;
	const lines = [`🐋 衣柜（已拥有 ${owned}/${ITEMS.length}） · 鱼粮币 ${coins}`];
	for (const slot of SLOT_ORDER) {
		const items = ITEMS.filter((item) => item.slot === slot);
		if (items.length === 0) continue;
		lines.push(`【${slotLabel(slot)}】`);
		for (const item of items) {
			const isOwned = state.owned.includes(item.id);
			const isWorn = state.equipped[item.slot] === item.id;
			const marker = isWorn ? '★' : isOwned ? '·' : ' ';
			const rarity = RARITIES[item.rarity]?.label ?? '';
			const price = isOwned ? (isWorn ? '穿着中' : '已拥有') : `${item.price} 币`;
			lines.push(` ${marker} ${item.name}（${rarity}，${price}）`);
		}
	}
	lines.push('用法：/fish buy <名字> 或 /fish wear <名字>');
	return lines.join('\n');
}

/**
 * @param {import('./runtime.js').WardrobeRuntime} runtime
 * @param {string} rawInput
 * @param {{ now?: number }} [options]
 * @returns {{ kind: 'success' | 'error', text: string }}
 */
export function executeFishCommand(runtime, rawInput, options = {}) {
	const now = options.now ?? runtime.clock();
	const input = String(rawInput ?? '').trim();
	const tokens = input.length === 0 ? [] : input.split(/\s+/);
	const operation = (tokens.shift() ?? 'status').toLowerCase();
	try {
		switch (operation) {
			case 'status':
			case 'show':
				return { kind: 'success', text: formatStatus(runtime, now) };
			case 'list':
			case 'wardrobe':
			case 'shop':
			case 'ls':
				return { kind: 'success', text: formatWardrobe(runtime) };
			case 'buy': {
				const query = tokens.join(' ');
				if (query.length === 0) return { kind: 'error', text: '用法：/fish buy <名字|id>' };
				const result = runtime.buy(query, now);
				return { kind: result.ok ? 'success' : 'error', text: result.message };
			}
			case 'wear':
			case 'equip': {
				const query = tokens.join(' ');
				if (query.length === 0) return { kind: 'error', text: '用法：/fish wear <名字|id>' };
				const result = runtime.wear(query, now);
				return { kind: result.ok ? 'success' : 'error', text: result.message };
			}
			case 'takeoff':
			case 'remove': {
				const result = runtime.takeOff(tokens[0] ?? '', now);
				return { kind: result.ok ? 'success' : 'error', text: result.message };
			}
			case 'rename': {
				const result = runtime.rename(tokens.join(' '), now);
				return { kind: result.ok ? 'success' : 'error', text: result.message };
			}
			case 'png':
			case 'image':
			case 'img': {
				const requested = Number(tokens[0]);
				const size = Number.isFinite(requested) && requested >= 256 ? Math.min(1600, Math.round(requested)) : undefined;
				const png = renderFishPng(runtime.state, runtime.config, { now, ...(size ? { size } : {}) });
				const stamp = new Date(now).toISOString().replace(/[:.]/g, '-').slice(0, 19);
				const outPath = join(dirname(runtime.config.statePath), `fish-${stamp}.png`);
				atomicWriteBuffer(outPath, png);
				return {
					kind: 'success',
					text: `出图了：${outPath}\n直接把这张 PNG 发到 QQ 群 / B站评论区即可。`,
				};
			}
			case 'report':
			case 'card': {
				const path = writeReportCard(runtime.state, runtime.config, { now });
				return {
					kind: 'success',
					text: `饲养报告已生成：${path}\n用浏览器打开它，可直接截图发小红书 / QQ 群（1080×1440）。`,
				};
			}
			case 'help':
			case '?':
				return { kind: 'success', text: USAGE };
			default: {
				const item = findItem(operation);
				if (item) {
					const isOwned = runtime.state.owned.includes(item.id);
					if (isOwned) return executeFishCommand(runtime, `wear ${operation}`, options);
					return {
						kind: 'success',
						text: `你要找的是「${item.name}」吗？${isOwned ? '已经拥有了。' : `它要 ${item.price} 币，/fish buy ${item.id} 可以买。`}\n\n${USAGE}`,
					};
				}
				return { kind: 'error', text: `看不懂「${operation}」。\n\n${USAGE}` };
			}
		}
	} catch (cause) {
		return { kind: 'error', text: `/fish 出错了：${cause instanceof Error ? cause.message : String(cause)}` };
	}
}

/**
 * Register the `/fish` command on the harness command runtime.
 * @param {{ register: (definition: any) => () => void }} commands
 * @param {import('./runtime.js').WardrobeRuntime} runtime
 * @returns {() => void}
 */
export function registerFishCommand(commands, runtime) {
	return commands.register({
		name: 'fish',
		description: '大肥鱼衣橱：投喂 token 赚鱼粮币，给鱼换装并生成饲养报告卡',
		input: { hint: 'status | list | buy <名字> | wear <名字> | takeoff <部位> | rename <名字> | report' },
		recordInput: false,
		handler: (/** @type {{ rawInput?: string }} */ context) =>
			executeFishCommand(runtime, context?.rawInput ?? ''),
	});
}

/* ---------------------------------------------------------------- DIY ---- */

/**
 * 解析 `diy` 命令的原始参数（简单空白切分；支持 --key value / --key=value / 布尔 flag）。
 * @param {string} rawInput
 * @returns {Record<string, string | boolean>}
 */
function parseDiyArgs(rawInput) {
	/** @type {Record<string, string | boolean>} */
	const options = {};
	const tokens = String(rawInput || '').trim().split(/[\s\u3000]+/).filter(Boolean);
	for (let i = 0; i < tokens.length; i += 1) {
		const token = tokens[i];
		if (!token.startsWith('--')) continue;
		const eq = token.indexOf('=');
		if (eq > 2) {
			options[token.slice(2, eq)] = token.slice(eq + 1);
			continue;
		}
		const key = token.slice(2);
		const next = tokens[i + 1];
		if (typeof next === 'string' && !next.startsWith('--')) {
			options[key] = next;
			i += 1;
		} else {
			options[key] = true;
		}
	}
	return options;
}

/**
 * 执行 `/diy` 命令（agent 可直接调用；与 `dsh-feiyu-diy` CLI 同一条流水线）。
 *
 * 子命令：plan / run / status / install / list / remove
 * 输出：单行 JSON（与 CLI 契约一致，便于 agent 解析）。
 *
 * @param {ReturnType<import('./diy-pipeline.js').createDiyPipeline>} pipeline
 * @param {string} rawInput `diy` 之后的参数文本
 * @returns {Promise<{ kind: 'success' | 'error', text: string }>}
 */
export async function executeDiyCommand(pipeline, rawInput) {
	const trimmed = String(rawInput || '').trim();
	const options = parseDiyArgs(trimmed);
	const sub = trimmed.split(/[\s\u3000]+/).filter(Boolean).find((token) => !token.startsWith('--')) || 'help';
	const emit = (/** @type {unknown} */ value) => `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;
	try {
		switch (sub) {
			case 'plan': {
				const result = pipeline.plan({
					image: String(options.image || ''),
					name: options.name === undefined ? undefined : String(options.name),
					category: options.category === undefined ? undefined : String(options.category),
					description: options.description === undefined ? undefined : String(options.description),
					shape: options.shape === undefined ? undefined : String(options.shape),
					reroll: options.reroll === undefined ? 0 : Number(options.reroll),
				});
				return { kind: 'success', text: emit(result) };
			}
			case 'run': {
				const result = await pipeline.run({
					job: String(options.job || ''),
					stage: options.stage === undefined ? 'all' : String(options.stage),
					force: options.force === true,
				});
				return { kind: result.ok ? 'success' : 'error', text: emit(result) };
			}
			case 'status':
				return { kind: 'success', text: emit(pipeline.status({ job: String(options.job || '') })) };
			case 'install': {
				if (options['dry-run'] === true) {
					return { kind: 'success', text: emit(pipeline.install(String(options.job || ''), { dryRun: true })) };
				}
				const result = await pipeline.run({ job: String(options.job || ''), stage: 'install' });
				return { kind: result.ok ? 'success' : 'error', text: emit(result) };
			}
			case 'list':
				return { kind: 'success', text: emit(pipeline.list()) };
			case 'remove':
				return {
					kind: 'success',
					text: emit(pipeline.remove({ id: String(options.id || ''), dryRun: options['dry-run'] === true })),
				};
			default:
				return {
					kind: 'error',
					text: '`/diy` 子命令：plan --image <路径> [--name][--category] | run --job <id> [--stage] | status --job <id> | install --job <id> [--dry-run] | list | remove --id <id>',
				};
		}
	} catch (cause) {
		const error = /** @type {any} */ (cause);
		return {
			kind: 'error',
			text: `\`\`\`json\n${JSON.stringify({ ok: false, code: error.code || 'internal_error', message: error.message || String(cause) })}\n\`\`\``,
		};
	}
}

/**
 * 在 harness command runtime 上注册 `/diy`（agent 可调用；默认关闭由 pipeline 把关）。
 * @param {{ register: (definition: any) => () => void }} commands
 * @param {ReturnType<import('./diy-pipeline.js').createDiyPipeline>} pipeline
 * @returns {() => void}
 */
export function registerDiyCommand(commands, pipeline) {
	return commands.register({
		name: 'diy',
		description: 'DIY 衣服流水线：图片 → AI look/flatout → 自动成层 → 自动绑定 → QA → 安装为可动 2.5D 套装（默认关闭）',
		input: { hint: 'plan --image <路径> [--name][--category] | run --job <id> [--stage] | status --job <id> | install --job <id> [--dry-run] | list | remove --id <id>' },
		recordInput: false,
		handler: async (/** @type {{ rawInput?: string }} */ context) =>
			executeDiyCommand(pipeline, context?.rawInput ?? ''),
	});
}
