/**
 * `/fish` command surface: status, wardrobe, buying, wearing, renaming and
 * generating the shareable report card.
 * @module dsh-feiyu-wardrobe/commands
 */

import { ITEMS, RARITIES, SLOT_ORDER, findItem, rarityLabel, slotLabel } from './catalog.js';
import { summaryOf } from './economy.js';
import { writeReportCard } from './report.js';
import { formatCNY, formatCoins, formatTokens } from './util.js';

const USAGE = [
	'/fish                    看鱼今天的状态',
	'/fish list               逛衣柜（已拥有 / 可买）',
	'/fish buy <名字|id>       用鱼粮币买下并穿上',
	'/fish wear <名字|id>      换上已拥有的衣服',
	'/fish takeoff <部位>      脱掉某个部位（bg/body/neck/face/hand/hat）',
	'/fish rename <名字>       给鱼改名',
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
