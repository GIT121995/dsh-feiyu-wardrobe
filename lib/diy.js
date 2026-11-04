/**
 * 大肥鱼衣橱 · DIY 上传宿主代理（生成层 + 预算护栏 + 缓存 + 成本日志 + 本地路由）
 *
 * 架构（task-7 D1；M0 结论见 `.scratch/m0-diy/REPORT.md`）：
 *   浏览器（换装间 DIY 面板） --同源 POST--> 本机宿主路由 `/feiyu/diy/generate`
 *     → 内容守卫（词表；reject 不送 API）→ 预算/确认 → hash 去重缓存
 *     → Seedream 出 1×look + 1×flat-color-out（#808080）→ 图片 data URL 回浏览器 → 本地成层。
 *
 * 硬约束：
 *   - 默认关闭（`diy.enabled=false`），关闭时路由只回 status，不做任何网络调用；
 *   - API key 只从宿主 env/配置文件读取（见 diy-provider.js），不进前端/日志/错误响应；
 *   - 每日图片数/金额上限 + 单次预估确认；重试 ≤2；失败/超预算返回明确错误码；
 *   - 成本日志 JSONL：结构化、无 key、无原图、无原始描述（只记 sha256 摘要）。
 *
 * @module dsh-feiyu-wardrobe/diy
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	CONSERVATIVE_CONSTRAINTS,
	DIY_CATEGORIES,
	DIY_CATEGORY_LABELS,
	DIY_GUARD_VERSION,
	NEGATIVE_TERMS,
	categorySlot,
	checkGarmentDescription,
	contentPolicyTag,
	isDiyCategory,
	MAX_DESCRIPTION_LENGTH,
} from '../docs/dress-up/diy-guard.js';
import {
	MAX_IMAGE_BYTES,
	sanitizeProviderError,
	createSeedreamClient,
	imageToDataUrl,
	loadArkKey,
} from './diy-provider.js';
import { atomicWriteBuffer, atomicWriteJson, ensureParent, readJsonFile } from './util.js';

/** DIY 路由前缀（与静态换装间路由并列）。 */
export const DIY_PATH = '/feiyu/diy';

/** prompt 包版本：模板变更时递增（写进缓存 key / 成本日志 / UI 元数据）。 */
export const DIY_PROMPT_VERSION = 'diy-m1-v1';

/** 一次 DIY 生成固定 2 张图（look + flat-color-out）。 */
export const DEFAULT_IMAGES_PER_REQUEST = 2;

/** 请求体上限（含 base64 上传图）；浏览器端已把上传图压到 ~1MB 内。 */
export const DEFAULT_MAX_BODY_BYTES = 8 * 1024 * 1024;

/** 客户端上传图上限（解码后字节数）。 */
export const DEFAULT_MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

/** 预算/记录默认值（与 .scratch/m0-diy 的成本口径一致）。 */
export const DEFAULT_PRICE_PER_IMAGE_YUAN = 0.3;
export const DEFAULT_DAILY_IMAGE_LIMIT = 40;
export const DEFAULT_DAILY_BUDGET_YUAN = 10;
export const DEFAULT_UNIT_COST_LOW_YUAN = 0.21;

/** 缓存保留条目上限（超了按最旧淘汰）。 */
export const DEFAULT_CACHE_MAX_ENTRIES = 80;

/**
 * 宿主 DIY 错误：code 给路由/UI 分类，message 面向用户且不含 key/上游原文。
 */
export class DiyError extends Error {
	/**
	 * @param {string} code
	 * @param {string} message
	 * @param {number} [status]
	 * @param {Record<string, unknown>} [details]
	 */
	constructor(code, message, status = 400, details = {}) {
		super(message);
		this.name = 'DiyError';
		this.code = code;
		this.status = status;
		this.details = details;
	}
}

/**
 * 默认 DIY 数据目录（在 wardrobe state 同目录下）。
 * @param {string} statePath
 * @returns {string}
 */
export function defaultDiyDir(statePath) {
	return join(dirname(statePath), 'diy');
}

/* ---------------- prompt 包（M0 模板 + 保守约束 + 负向词） ---------------- */

/** 角色一致性锁定（M0 `KEEP`，逐字保留其有效约束）。 */
export const CHARACTER_LOCK =
	'保持与参考图1完全相同的角色外观（脸、蓝色渐变长发、头顶呆毛卷成圆环、两侧鲸鱼耳鳍、蓝色大眼睛、鲸鱼尾巴）' +
	'和完全相同的Q版站姿、位置、比例；全身正面站立，纯白背景，平涂上色（赛璐璐），深色描边，干净简洁，' +
	'不改变角色年龄感与表情；无文字、无 logo、无水印。';

/** 品类穿着说明（下装/上装互斥，与游戏槽位一致）。 */
export const WEAR_NOTE = {
	top: '不穿裙子、不穿裤子，下半身保持白色连体泳衣；',
	bottom: '上半身保持白色连体泳衣原样、不穿外衣；',
	dress: '',
	coat: '外套直接穿在白色连体泳衣外（不穿其它衣物）；',
	outfit: '',
};

/**
 * 保守 prompt 片段：负向词 + 保守版型约束（拼进每条 prompt）。
 * @returns {string}
 */
export function conservativePromptSuffix() {
	return `服装必须为${CONSERVATIVE_CONSTRAINTS}禁止出现：${NEGATIVE_TERMS.slice(0, 14).join('、')}。`;
}

/**
 * 生成 look 的 prompt（参考图1=素体，参考图2=用户上传衣服）。
 * 描述必须已经过内容守卫（`checkGarmentDescription` 的 description）。
 * @param {{ category: 'top'|'bottom'|'dress'|'coat'|'outfit', description: string }} input
 * @returns {string}
 */
export function buildLookPrompt(input) {
	const wear = WEAR_NOTE[input.category] || '';
	return (
		`参考图1是这个角色的素体（白色无肩带连体泳衣）。参考图2是用户上传的一件衣服：${input.description}。` +
		'请让参考图1的角色穿上参考图2这件衣服，尽量还原它的版型、颜色、图案和细节；' +
		`${wear}不戴头饰、光脚。若参考图2是人物照，只取其中的衣服，不要复制人物、脸、手或背景。` +
		`${conservativePromptSuffix()}${CHARACTER_LOCK}`
	);
}

/**
 * 生成 flat-color-out 的 prompt（参考图1=已经穿上衣服的 look）。
 * M0 结论：纯白 whiteout 对白/浅色衣服 diff 退化，必须改用高反差平涂色（默认 #808080）。
 * @param {{ category: 'top'|'bottom'|'dress'|'coat'|'outfit', description: string, color?: string }} input
 * @returns {string}
 */
export function buildFlatoutPrompt(input) {
	const color = input.color || '纯灰色 #808080';
	return (
		`参考图1是一个穿着${input.description}的角色。请把这件衣服整体改成${color}（平涂、无图案、无 logo、无装饰色），` +
		'只保留版型、轮廓、褶皱和深色描边；其他所有内容（脸、五官、头发、耳鳍、尾巴、皮肤、姿势、位置、比例、纯白背景）' +
		'保持与参考图1完全一致，不要移动、不要缩放、不要重新居中；无文字、无水印。'
	);
}

/**
 * 构建一次生成的完整 prompt 包（look + flatout + 负向词），并派生确定性 seed。
 * @param {{ category: 'top'|'bottom'|'dress'|'coat'|'outfit', description: string, imageDigest: string, reroll?: number }} input
 * @returns {{ lookPrompt: string, flatoutPrompt: string, negative: string, seed: number, promptVersion: string, slot: string }}
 */
export function buildPromptPack(input) {
	const slot = categorySlot(input.category);
	if (!slot) throw new DiyError('invalid_category', `不支持的品类：${input.category}`, 400);
	const reroll = Math.max(0, Math.min(9, Math.floor(input.reroll || 0)));
	const baseSeed = Number.parseInt(String(input.imageDigest || '').slice(0, 8), 16) % 2_000_000_000;
	return {
		lookPrompt: buildLookPrompt(input),
		flatoutPrompt: buildFlatoutPrompt(input),
		negative: NEGATIVE_TERMS.join('、'),
		seed: baseSeed + reroll * 100_003,
		promptVersion: DIY_PROMPT_VERSION,
		slot: slot.slot,
	};
}

/**
 * 单次生成的费用预估（¥）。
 * @param {{ pricePerImageYuan?: number, images?: number }} [options]
 * @returns {{ images: number, costYuan: number, costRangeYuan: [number, number], note: string }}
 */
export function estimateDiyCost(options = {}) {
	const price = Number(options.pricePerImageYuan ?? DEFAULT_PRICE_PER_IMAGE_YUAN);
	const images = Number(options.images ?? DEFAULT_IMAGES_PER_REQUEST);
	const low = Math.min(DEFAULT_UNIT_COST_LOW_YUAN, price);
	return {
		images,
		costYuan: Number((images * price).toFixed(2)),
		costRangeYuan: [Number((images * low).toFixed(2)), Number((images * price).toFixed(2))],
		note: '按 Seedream flash 1152×2048 单张 ¥0.21–0.30 估算，实际以火山方舟账单为准；命中缓存/失败重试不额外计费。',
	};
}

/* ---------------- 预算台账 + 成本日志 ---------------- */

/**
 * 北京时间（或配置时区）的自然日 key。
 * @param {number} now 毫秒时间戳
 * @param {number} [offsetMinutes]
 * @returns {string} `YYYY-MM-DD`
 */
export function diyDayKey(now, offsetMinutes = 480) {
	const shifted = new Date(now + offsetMinutes * 60_000);
	return shifted.toISOString().slice(0, 10);
}

/**
 * 预算台账：每日图片数/金额 + 累计；状态文件原子写；成本日志 JSONL。
 * @param {{
 *   statePath: string,
 *   costLogPath: string,
 *   pricePerImageYuan?: number,
 *   dailyImageLimit?: number,
 *   dailyBudgetYuan?: number,
 *   timezoneOffsetMinutes?: number,
 *   now?: () => number,
 * }} options
 */
export function createDiyLedger(options) {
	const statePath = options.statePath;
	const costLogPath = options.costLogPath;
	const price = Number(options.pricePerImageYuan ?? DEFAULT_PRICE_PER_IMAGE_YUAN);
	const dailyImageLimit = Number(options.dailyImageLimit ?? DEFAULT_DAILY_IMAGE_LIMIT);
	const dailyBudgetYuan = Number(options.dailyBudgetYuan ?? DEFAULT_DAILY_BUDGET_YUAN);
	const tzOffset = Number(options.timezoneOffsetMinutes ?? 480);
	const now = options.now || Date.now;

	/** @type {{ version: number, totals: { images: number, costYuan: number, requests: number }, days: Record<string, { images: number, costYuan: number, requests: number }>, updatedAt: string }} */
	let state = normalizeLedger(readJsonFile(statePath, null), now, tzOffset);

	/**
	 * @param {unknown} raw
	 * @param {() => number} clock
	 * @param {number} offset
	 */
	function normalizeLedger(raw, clock, offset) {
		const fallback = {
			version: 1,
			totals: { images: 0, costYuan: 0, requests: 0 },
			days: {},
			updatedAt: new Date(clock()).toISOString(),
		};
		if (!raw || typeof raw !== 'object') return fallback;
		const input = /** @type {any} */ (raw);
		const days = input.days && typeof input.days === 'object' ? input.days : {};
		const today = diyDayKey(clock(), offset);
		/** @type {Record<string, { images: number, costYuan: number, requests: number }>} */
		const cleaned = {};
		// 只保留最近 14 天，避免状态文件无限增长
		for (const [key, value] of Object.entries(days)) {
			if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue;
			if (key < diyDayKey(clock() - 14 * 86_400_000, offset)) continue;
			if (!value || typeof value !== 'object') continue;
			const entry = /** @type {any} */ (value);
			cleaned[key] = {
				images: Math.max(0, Math.floor(Number(entry.images) || 0)),
				costYuan: Math.max(0, Number(entry.costYuan) || 0),
				requests: Math.max(0, Math.floor(Number(entry.requests) || 0)),
			};
		}
		if (!cleaned[today]) cleaned[today] = { images: 0, costYuan: 0, requests: 0 };
		const totalsRaw = input.totals && typeof input.totals === 'object' ? input.totals : {};
		return {
			version: 1,
			totals: {
				images: Math.max(0, Math.floor(Number(totalsRaw.images) || 0)),
				costYuan: Math.max(0, Number(totalsRaw.costYuan) || 0),
				requests: Math.max(0, Math.floor(Number(totalsRaw.requests) || 0)),
			},
			days: cleaned,
			updatedAt: typeof input.updatedAt === 'string' ? input.updatedAt : new Date(clock()).toISOString(),
		};
	}

	/**
	 * 当日快照 + 剩余额度。
	 * @param {number} [extraImages] 预留中的图片数（并发请求防超支）
	 * @returns {{ dayKey: string, images: number, costYuan: number, requests: number, totals: { images: number, costYuan: number, requests: number }, limits: { dailyImageLimit: number, dailyBudgetYuan: number, pricePerImageYuan: number }, remainingImages: number, remainingBudgetYuan: number }}
	 */
	function snapshot(extraImages = 0) {
		const key = diyDayKey(now(), tzOffset);
		if (!state.days[key]) state.days[key] = { images: 0, costYuan: 0, requests: 0 };
		const day = state.days[key];
		return {
			dayKey: key,
			images: day.images,
			costYuan: Number(day.costYuan.toFixed(2)),
			requests: day.requests,
			totals: {
				images: state.totals.images,
				costYuan: Number(state.totals.costYuan.toFixed(2)),
				requests: state.totals.requests,
			},
			limits: { dailyImageLimit, dailyBudgetYuan, pricePerImageYuan: price },
			remainingImages: Math.max(0, dailyImageLimit - day.images - extraImages),
			remainingBudgetYuan: Math.max(0, Number((dailyBudgetYuan - day.costYuan - extraImages * price).toFixed(2))),
		};
	}

	/**
	 * 是否可以再花 `images` 张图。
	 * @param {number} images
	 * @returns {{ ok: boolean, code?: string, message?: string, snapshot: ReturnType<typeof snapshot> }}
	 */
	function canSpend(images) {
		const snap = snapshot(images);
		if (snap.images + images > dailyImageLimit) {
			return {
				ok: false,
				code: 'daily_image_limit',
				message: `今日 DIY 图片额度已用完（${snap.images}/${dailyImageLimit}）`,
				snapshot: snap,
			};
		}
		if (snap.costYuan + images * price > dailyBudgetYuan + 1e-9) {
			return {
				ok: false,
				code: 'daily_budget_exceeded',
				message: `今日 DIY 预算已用完（¥${snap.costYuan.toFixed(2)}/¥${dailyBudgetYuan.toFixed(2)}）`,
				snapshot: snap,
			};
		}
		return { ok: true, snapshot: snap };
	}

	/**
	 * 记录一次事件：更新当日/累计额度并追加 JSONL（不含 key / 原图 / 原始描述）。
	 * @param {{ event: string, images?: number, costYuan?: number, requests?: number } & Record<string, unknown>} record
	 * @returns {Record<string, unknown>} 落盘记录
	 */
	function record(record) {
		const timestamp = now();
		const key = diyDayKey(timestamp, tzOffset);
		if (!state.days[key]) state.days[key] = { images: 0, costYuan: 0, requests: 0 };
		const images = Math.max(0, Math.floor(Number(record.images) || 0));
		const costYuan = Math.max(0, Number(record.costYuan) || 0);
		const requests = Math.max(0, Math.floor(Number(record.requests) || 0));
		state.days[key].images += images;
		state.days[key].costYuan += costYuan;
		state.days[key].requests += requests;
		state.totals.images += images;
		state.totals.costYuan += costYuan;
		state.totals.requests += requests;
		const entry = {
			ts: new Date(timestamp).toISOString(),
			dayKey: key,
			...record,
			images,
			costYuan: Number(costYuan.toFixed(2)),
		};
		// 成本日志：结构化 JSONL（不含 key/原图/原始描述；调用方传入的字段已脱敏）
		ensureParent(costLogPath);
		appendFileSync(costLogPath, `${JSON.stringify(entry)}\n`, 'utf8');
		state.updatedAt = new Date(timestamp).toISOString();
		atomicWriteJson(statePath, state);
		return entry;
	}

	/** @returns {typeof state} */
	function raw() {
		return state;
	}

	return { snapshot, canSpend, record, raw, statePath, costLogPath, pricePerImageYuan: price };
}

/* ---------------- hash 去重缓存 ---------------- */

/**
 * 文件缓存：key = sha256(上传图 + prompt 包 + 模型/尺寸/版本)；命中时零 API 费用。
 * @param {{ cacheDir: string, maxEntries?: number }} options
 */
export function createDiyCache(options) {
	const cacheDir = join(options.cacheDir, 'entries');
	const maxEntries = Math.max(4, Number(options.maxEntries ?? DEFAULT_CACHE_MAX_ENTRIES));

	/**
	 * @param {{ imageDigest: string, lookPrompt: string, flatoutPrompt: string, model: string, size: string, promptVersion: string }} input
	 * @returns {string}
	 */
	function keyFor(input) {
		return createHash('sha256')
			.update(
				[
					'feiyu-diy-cache-v2',
					input.imageDigest,
					input.model,
					input.size,
					input.promptVersion,
					input.lookPrompt,
					input.flatoutPrompt,
				].join('\u0000'),
			)
			.digest('hex');
	}

	/**
	 * @param {string} key
	 * @returns {{ look: Buffer, flatout: Buffer, meta: Record<string, unknown> } | null}
	 */
	function lookup(key) {
		const metaPath = join(cacheDir, `${key}.json`);
		if (!existsSync(metaPath)) return null;
		try {
			const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
			const look = readFileSync(join(cacheDir, `${key}-look.png`));
			const flatout = readFileSync(join(cacheDir, `${key}-flatout.png`));
			if (look.length < 1000 || flatout.length < 1000) return null;
			return { look, flatout, meta };
		} catch {
			return null;
		}
	}

	/**
	 * @param {string} key
	 * @param {{ look: Buffer, flatout: Buffer, meta: Record<string, unknown> }} value
	 */
	function store(key, value) {
		mkdirSync(cacheDir, { recursive: true });
		atomicWriteBuffer(join(cacheDir, `${key}-look.png`), value.look);
		atomicWriteBuffer(join(cacheDir, `${key}-flatout.png`), value.flatout);
		atomicWriteJson(join(cacheDir, `${key}.json`), {
			...value.meta,
			key,
			createdAt: new Date().toISOString(),
		});
		prune();
	}

	/** 条目数超上限时按 meta.createdAt 最旧淘汰（尽力而为，失败不影响生成）。 */
	function prune() {
		try {
			const entries = readdirSync(cacheDir)
				.filter((name) => name.endsWith('.json'))
				.map((name) => ({ name, mtime: statSync(join(cacheDir, name)).mtimeMs }))
				.sort((a, b) => b.mtime - a.mtime);
			for (const stale of entries.slice(maxEntries)) {
				const key = stale.name.slice(0, -'.json'.length);
				for (const suffix of ['.json', '-look.png', '-flatout.png']) {
					const target = join(cacheDir, `${key}${suffix}`);
					if (existsSync(target)) unlinkSync(target);
				}
			}
		} catch {
			/* 缓存清理失败不影响主流程 */
		}
	}

	/** @returns {{ entries: number, dir: string }} */
	function stats() {
		try {
			return {
				entries: readdirSync(cacheDir).filter((name) => name.endsWith('.json')).length,
				dir: cacheDir,
			};
		} catch {
			return { entries: 0, dir: cacheDir };
		}
	}

	return { keyFor, lookup, store, stats };
}

/* ---------------- 上传图解码 ---------------- */

/**
 * 解码浏览器上传的 data URL（只接受 png/jpeg/webp）。
 * @param {unknown} dataUrl
 * @param {number} [maxBytes]
 * @returns {{ buffer: Buffer, mime: string, digest: string, bytes: number }}
 */
export function decodeUploadImage(dataUrl, maxBytes = DEFAULT_MAX_UPLOAD_BYTES) {
	if (typeof dataUrl !== 'string' || dataUrl.length < 32) {
		throw new DiyError('invalid_image', '上传图片格式非法（需要 data:image/...;base64）', 400);
	}
	const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(dataUrl);
	if (!match) {
		throw new DiyError('invalid_image', '上传图片格式非法（只支持 png/jpeg/webp）', 400);
	}
	if (dataUrl.length > maxBytes * 1.4) {
		throw new DiyError('image_too_large', '上传图片过大（请先压缩到 4MB 以内）', 413);
	}
	const buffer = Buffer.from(match[2], 'base64');
	if (buffer.length < 1000) throw new DiyError('invalid_image', '上传图片内容为空或损坏', 400);
	if (buffer.length > maxBytes) throw new DiyError('image_too_large', '上传图片过大（请先压缩到 4MB 以内）', 413);
	return {
		buffer,
		mime: `image/${match[1]}`,
		digest: createHash('sha256').update(buffer).digest('hex'),
		bytes: buffer.length,
	};
}

/* ---------------- 生成服务（预算 + 缓存 + 守卫 + provider） ---------------- */

/**
 * 读取并缓存素体参考图（data URL）。
 * @param {string} baseRefPath
 * @returns {string}
 */
function loadBaseReference(baseRefPath) {
	if (!baseRefPath || !existsSync(baseRefPath)) {
		throw new DiyError('base_reference_missing', '宿主缺少 DIY 素体参考图（docs/dress-up/art/diy/base-chibi.png）', 503);
	}
	const buffer = readFileSync(baseRefPath);
	if (buffer.length < 1000 || buffer.length > MAX_IMAGE_BYTES) {
		throw new DiyError('base_reference_invalid', '宿主 DIY 素体参考图无效', 503);
	}
	return imageToDataUrl(buffer, 'image/png');
}

/**
 * 创建 DIY 生成服务（可在测试中注入 provider/ledger/cache）。
 *
 * @param {{
 *   config: import('./config.js').FeiyuConfig,
 *   now?: () => number,
 *   fetchImpl?: typeof fetch,
 *   sleep?: (ms: number) => Promise<void>,
 *   env?: NodeJS.ProcessEnv,
 *   logger?: { info?: Function, warn?: Function, error?: Function },
 *   provider?: ReturnType<typeof createSeedreamClient>,
 *   ledger?: ReturnType<typeof createDiyLedger>,
 *   cache?: ReturnType<typeof createDiyCache>,
 *   diyHome?: string,
 * }} options
 */
export function createDiyService(options) {
	const config = options.config;
	const diy = config.diy;
	const now = options.now || Date.now;
	/** 已安装 DIY pack 的数据目录（S3 页面消费；与 S2 CLI 共用）。 */
	const diyHome = resolve(options.diyHome || resolveDiyHome(config));
	const packsDir = join(diyHome, 'packs');
	const registryPath = join(diyHome, 'registry.json');
	const logger = options.logger || {};
	/** @type {(message: string, ...args: unknown[]) => void} */
	const warn = typeof logger.warn === 'function' ? logger.warn.bind(logger) : () => {};
	const ledgerOptions = {
		statePath: diy.statePath,
		costLogPath: diy.costLogPath,
		pricePerImageYuan: diy.pricePerImageYuan,
		dailyImageLimit: diy.dailyImageLimit,
		dailyBudgetYuan: diy.dailyBudgetYuan,
		timezoneOffsetMinutes: config.timezoneOffsetMinutes,
		now,
	};
	const ledger = options.ledger || createDiyLedger(ledgerOptions);
	const cache = options.cache || createDiyCache({ cacheDir: diy.cacheDir, maxEntries: diy.cacheMaxEntries });
	const provider =
		options.provider ||
		createSeedreamClient({
			apiKey: loadArkKey({ env: options.env, envFile: diy.apiKeyFile || undefined }),
			model: diy.model,
			size: diy.size,
			retries: diy.retries,
			timeoutMs: diy.timeoutMs,
			fetchImpl: options.fetchImpl,
			sleep: options.sleep,
		});
	/** @type {string | null} */
	let baseReferenceCache = null;
	/** 预留中的图片数：并发请求时先占额度，避免多请求同时通过预算检查。 */
	let inflightImages = 0;

	/**
	 * 读取已安装 DIY registry（缺失 → 空 registry；不暴露宿主绝对路径）。
	 * @returns {{ ok: boolean, version: number, updatedAt: string|null, items: Record<string, any> }}
	 */
	function readRegistry() {
		const raw = /** @type {any} */ (readJsonFile(registryPath, null));
		if (!raw || typeof raw !== 'object' || !raw.items || typeof raw.items !== 'object') {
			return { ok: true, version: 1, updatedAt: null, items: {} };
		}
		return { ok: true, version: Number(raw.version) || 1, updatedAt: raw.updatedAt || null, items: raw.items };
	}

	/**
	 * 校验并读取 `packs/<id>/<file>`（仅 GET 路由用；拒绝目录穿越/隐藏文件）。
	 * @param {string} relativePath 例 `packs/<id>/diy-pack.json`
	 * @returns {{ buffer: Buffer, mime: string, bytes: number } | null}
	 */
	function readPackFile(relativePath) {
		const raw = String(relativePath || '');
		if (!/^packs\/[a-z0-9][a-z0-9-]{2,80}\/(diy-pack\.json|tex\/[A-Za-z0-9._-]+\.(webp|png)|static\/[A-Za-z0-9._-]+\.png)$/.test(raw)) {
			return null;
		}
		const abs = resolve(join(diyHome, raw));
		if (!abs.startsWith(packsDir + sep) || !existsSync(abs) || !statSync(abs).isFile()) return null;
		const ext = abs.endsWith('.json') ? 'application/json; charset=utf-8' : abs.endsWith('.webp') ? 'image/webp' : 'image/png';
		return { buffer: readFileSync(abs), mime: ext, bytes: statSync(abs).size };
	}

	/**
	 * 移除一个已安装 DIY pack（registry + 目录；失败零副作用）。
	 * @param {string} itemId
	 * @returns {{ ok: boolean, itemId: string, removed: boolean }}
	 */
	function removePack(itemId) {
		if (!diy.enabled) throw new DiyError('diy_disabled', 'DIY 未开启（默认关闭）', 403);
		const id = String(itemId || '');
		if (!/^[a-z0-9][a-z0-9-]{2,80}$/.test(id)) throw new DiyError('invalid_id', 'itemId 非法', 400);
		const registry = readRegistry();
		if (!registry.items[id]) throw new DiyError('not_found', `没有已安装的 ${id}`, 404);
		const target = resolve(join(packsDir, id));
		if (!target.startsWith(packsDir + sep)) throw new DiyError('bad_path', 'pack 路径非法', 400);
		if (existsSync(target)) rmSync(target, { recursive: true, force: true });
		delete registry.items[id];
		atomicWriteJson(registryPath, { version: 1, updatedAt: new Date(now()).toISOString(), items: registry.items });
		return { ok: true, itemId: id, removed: true };
	}

	/**
	 * 导入 `.dshskin`（S3：页面导出→导入；宿主写 packs + registry）。
	 * bundle = { format:'feiyu-diy-skin', version:1, entry:{id,name,shape,category,animated,...},
	 *            pack:{...feiyu-diy-pack}, textures:[{path,dataURL}], static?:[{path,dataURL}] }
	 * @param {unknown} input
	 * @returns {{ ok: boolean, itemId: string, animated: boolean, fallback: string }}
	 */
	function importPack(input) {
		if (!diy.enabled) throw new DiyError('diy_disabled', 'DIY 未开启（默认关闭）', 403);
		const bundle = /** @type {any} */ (input);
		if (!bundle || bundle.format !== 'feiyu-diy-skin' || Number(bundle.version) !== 1) {
			throw new DiyError('invalid_skin', '不是支持的 .dshskin 格式', 400);
		}
		const pack = bundle.pack;
		if (!pack || pack.format !== 'feiyu-diy-pack' || Number(pack.formatVersion) !== 1) {
			throw new DiyError('invalid_skin', '皮肤包内缺少有效 feiyu-diy-pack', 400);
		}
		const id = String((bundle.entry && bundle.entry.id) || pack.item || '');
		if (!/^[a-z0-9][a-z0-9-]{2,80}$/.test(id)) throw new DiyError('invalid_id', 'itemId 非法', 400);
		if (pack.item !== id) throw new DiyError('invalid_skin', 'pack.item 与 entry.id 不一致', 400);
		if (pack.shape !== 'chibi') throw new DiyError('unsupported_shape', 'S3 仅支持 chibi', 400);
		if (!Array.isArray(pack.drawables) || pack.drawables.length < 1 || pack.drawables.length > 2) {
			throw new DiyError('invalid_skin', 'pack.drawables 数量非法', 400);
		}
		const textures = Array.isArray(bundle.textures) ? bundle.textures : [];
		if (textures.length !== pack.drawables.length) throw new DiyError('invalid_skin', '纹理数量与 drawables 不一致', 400);
		const target = resolve(join(packsDir, id));
		if (!target.startsWith(packsDir + sep)) throw new DiyError('bad_path', 'pack 路径非法', 400);
		const staticFiles = Array.isArray(bundle.static) ? bundle.static : [];
		const written = [];
		try {
			mkdirSync(join(target, 'tex'), { recursive: true });
			for (const drawable of pack.drawables) {
				const found = textures.find((item) => item && item.path === drawable.texture);
				if (!found || typeof found.dataURL !== 'string' || !/^data:image\/(png|webp);base64,/.test(found.dataURL)) {
					throw new DiyError('invalid_skin', `缺少纹理：${drawable.texture}`, 400);
				}
				const buffer = Buffer.from(found.dataURL.split(',')[1], 'base64');
				if (buffer.length < 512 || buffer.length > 4 * 1024 * 1024) throw new DiyError('invalid_skin', '纹理体积非法', 400);
				atomicWriteBuffer(join(target, drawable.texture), buffer);
				written.push(drawable.texture);
			}
			atomicWriteJson(join(target, 'diy-pack.json'), pack);
			if (staticFiles.length) {
				mkdirSync(join(target, 'static'), { recursive: true });
				for (const file of staticFiles) {
					if (!file || !/^static\/[A-Za-z0-9._-]+\.png$/.test(String(file.path)) || typeof file.dataURL !== 'string') continue;
					atomicWriteBuffer(join(target, String(file.path)), Buffer.from(file.dataURL.split(',')[1], 'base64'));
				}
			}
		} catch (error) {
			if (existsSync(target)) rmSync(target, { recursive: true, force: true });
			throw error;
		}
		const entry = bundle.entry || {};
		const animated = entry.animated !== false;
		const registry = readRegistry();
		registry.items[id] = {
			id, name: String(entry.name || pack.name || id).slice(0, 40),
			shape: 'chibi', category: String(entry.category || pack.category || 'top'),
			createdAt: String(entry.createdAt || new Date(now()).toISOString()),
			updatedAt: new Date(now()).toISOString(),
			packDir: `packs/${id}`,
			animated, fallback: animated ? 'none' : 'static',
			qa: entry.qa || { pass: animated, grade: animated ? 'pass' : 'fallback' },
			source: 'dshskin',
			static: staticFiles.length && !animated
				? { body: 'static/body.png', sleeve: staticFiles.some((f) => f && f.path === 'static/sleeve.png') ? 'static/sleeve.png' : null }
				: undefined,
		};
		atomicWriteJson(registryPath, { version: 1, updatedAt: new Date(now()).toISOString(), items: registry.items });
		return { ok: true, itemId: id, animated, fallback: registry.items[id].fallback };
	}

	/**
	 * 服务/隐私/预算状态（浏览器 UI 用；不含 key）。
	 * @returns {Record<string, unknown>}
	 */
	function status() {
		const snapshot = ledger.snapshot(inflightImages);
		const estimate = estimateDiyCost({ pricePerImageYuan: diy.pricePerImageYuan });
		return {
			ok: true,
			service: 'feiyu-diy',
			shape: 'chibi',
			enabled: Boolean(diy.enabled),
			available: Boolean(diy.enabled) && Boolean(provider.configured),
			hasApiKey: Boolean(provider.configured),
			model: diy.model,
			size: diy.size,
			promptVersion: DIY_PROMPT_VERSION,
			guardVersion: DIY_GUARD_VERSION,
			consentRequired: true,
			imagesPerRequest: DEFAULT_IMAGES_PER_REQUEST,
			estimate,
			daily: snapshot,
			cache: { ...cache.stats(), hitCostYuan: 0 },
			guard: {
				categories: DIY_CATEGORIES,
				categoryLabels: DIY_CATEGORY_LABELS,
				maxDescriptionLength: MAX_DESCRIPTION_LENGTH,
				note: '文本词表硬拦截（客户端+宿主双重）；图像分类器为后续项，不宣称完全防护。',
			},
			storage: { backend: 'indexeddb', format: '.dshskin', name: 'diy-local-wardrobe' },
			notes: [
				'默认关闭；开启后会把上传的衣服图发给云端图像 API（火山方舟 Seedream），并产生费用。',
				'纯离线换装路径不受影响：不开启/不生成时没有任何网络请求。',
			],
		};
	}

	/**
	 * 生成一次 DIY（look + flatout），返回 data URL 供浏览器本地成层。
	 *
	 * @param {{
	 *   category: unknown,
	 *   description: unknown,
	 *   imageDataUrl: unknown,
	 *   consent?: unknown,
	 *   confirmCost?: unknown,
	 *   reroll?: unknown,
	 * }} request
	 * @returns {Promise<Record<string, unknown>>}
	 */
	async function generate(request) {
		const requestId = randomBytes(6).toString('hex');
		if (!diy.enabled) {
			throw new DiyError('diy_disabled', 'DIY 上传功能未开启（需在宿主配置中显式开启，默认关闭）', 403);
		}
		if (!provider.configured) {
			throw new DiyError('missing_api_key', '宿主未配置 ARK_API_KEY，无法调用云端图像 API', 503);
		}
		if (request.consent !== true) {
			throw new DiyError('consent_required', '首次使用需显式同意（会把衣服图发送到云端图像 API 并产生费用）', 403);
		}
		if (!isDiyCategory(request.category)) {
			throw new DiyError('invalid_category', `不支持的品类：${String(request.category)}`, 400);
		}
		const guard = checkGarmentDescription(request.description);
		const descriptionHash = createHash('sha256').update(String(request.description ?? '')).digest('hex').slice(0, 16);
		if (guard.action === 'reject') {
			ledger.record({
				event: 'guard_reject',
				requestId,
				category: String(request.category),
				guardAction: 'reject',
				guardHits: guard.hits,
				descriptionSha256: descriptionHash,
				images: 0,
				costYuan: 0,
			});
			throw new DiyError('content_rejected', guard.reasons.join('；') || '内容不符合保守着装规范', 422, {
				guard: { action: guard.action, hits: guard.hits, reasons: guard.reasons },
			});
		}
		const category = /** @type {'top'|'bottom'|'dress'|'coat'|'outfit'} */ (request.category);
		const upload = decodeUploadImage(request.imageDataUrl, diy.maxUploadBytes);
		const promptPack = buildPromptPack({
			category,
			description: guard.description,
			imageDigest: upload.digest,
			reroll: Number(request.reroll) || 0,
		});
		// seed 进 key：同一张图“重抽”会换 seed → 换 cache key，真正重新生成；
		// 同一张图同一 reroll 次数重复提交才命中缓存（去重省费用）。
		const cacheKey = cache.keyFor({
			imageDigest: upload.digest,
			lookPrompt: promptPack.lookPrompt,
			flatoutPrompt: promptPack.flatoutPrompt,
			model: diy.model,
			size: diy.size,
			promptVersion: `${promptPack.promptVersion}:r${Math.max(0, Math.min(9, Math.floor(Number(request.reroll) || 0)))}`,
		});
		const guardTag = contentPolicyTag(guard.action === 'downgrade' ? 'downgrade' : 'pass');
		const cached = cache.lookup(cacheKey);
		if (cached) {
			ledger.record({
				event: 'cache_hit',
				requestId,
				category,
				guardAction: guard.action,
				cacheKey: cacheKey.slice(0, 16),
				images: 0,
				costYuan: 0,
				requests: 1,
			});
			return buildSuccessPayload({
				requestId,
				category,
				guard,
				promptPack,
				cached,
				cacheHit: true,
				latencyMs: 0,
				attempts: { look: 0, flatout: 0 },
				seed: promptPack.seed,
			});
		}
		if (request.confirmCost !== true) {
			const estimate = estimateDiyCost({ pricePerImageYuan: diy.pricePerImageYuan });
			throw new DiyError('cost_confirmation_required', '需确认本次生成的费用预估后才能调用云端 API', 400, {
				estimate,
			});
		}
		const canSpend = ledger.canSpend(DEFAULT_IMAGES_PER_REQUEST);
		if (!canSpend.ok) {
			ledger.record({
				event: 'budget_block',
				requestId,
				category,
				guardAction: guard.action,
				code: canSpend.code,
				images: 0,
				costYuan: 0,
			});
			throw new DiyError(canSpend.code || 'budget_exhausted', canSpend.message || '预算不足', 429, {
				daily: canSpend.snapshot,
			});
		}
		const estimate = estimateDiyCost({ pricePerImageYuan: diy.pricePerImageYuan });
		inflightImages += DEFAULT_IMAGES_PER_REQUEST;
		let spentImages = 0;
		let lookResult = null;
		let flatResult = null;
		const startedAt = now();
		try {
			baseReferenceCache = baseReferenceCache || loadBaseReference(diy.baseRefPath);
			lookResult = await provider.generate({
				prompt: promptPack.lookPrompt,
				references: [baseReferenceCache, imageToDataUrl(upload.buffer, upload.mime)],
				seed: promptPack.seed,
			});
			spentImages = 1;
			flatResult = await provider.generate({
				prompt: promptPack.flatoutPrompt,
				references: [imageToDataUrl(lookResult.image, lookResult.mime)],
				seed: promptPack.seed + 1,
			});
			spentImages = 2;
		} catch (error) {
			inflightImages -= DEFAULT_IMAGES_PER_REQUEST;
			const causeCode = error && typeof error === 'object' && 'code' in error ? String(/** @type {any} */ (error).code) : 'generation_failed';
			const message = sanitizeProviderError(
				error instanceof Error ? error.message : String(error),
				'',
			);
			const cost = Number((spentImages * diy.pricePerImageYuan).toFixed(2));
			ledger.record({
				event: 'generate_failed',
				requestId,
				category,
				guardAction: guard.action,
				code: causeCode,
				message: message.slice(0, 200),
				images: spentImages,
				costYuan: cost,
				requests: 1,
				latencyMs: now() - startedAt,
			});
			warn('[feiyu-diy] 生成失败 code=%s request=%s', causeCode, requestId);
			throw new DiyError('generation_failed', `云端生成失败：${message}`, 502, {
				causeCode,
				requestId,
				spentImages,
				spentCostYuan: cost,
			});
		}
		inflightImages -= DEFAULT_IMAGES_PER_REQUEST;
		const latencyMs = now() - startedAt;
		const attempts = { look: lookResult.attempts, flatout: flatResult.attempts };
		const cost = Number((DEFAULT_IMAGES_PER_REQUEST * diy.pricePerImageYuan).toFixed(2));
		ledger.record({
			event: 'generate',
			requestId,
			category,
			guardAction: guard.action,
			model: diy.model,
			size: diy.size,
			promptVersion: promptPack.promptVersion,
			cacheKey: cacheKey.slice(0, 16),
			seed: promptPack.seed,
			images: DEFAULT_IMAGES_PER_REQUEST,
			costYuan: cost,
			requests: 1,
			latencyMs,
			attempts,
			lookLatencyMs: lookResult.latencyMs,
			flatoutLatencyMs: flatResult.latencyMs,
		});
		try {
			cache.store(cacheKey, {
				look: lookResult.image,
				flatout: flatResult.image,
				meta: {
					category,
					model: diy.model,
					size: diy.size,
					promptVersion: promptPack.promptVersion,
					guardTag,
					seed: promptPack.seed,
				},
			});
		} catch {
			/* 缓存写失败不影响本次结果 */
		}
		return buildSuccessPayload({
			requestId,
			category,
			guard,
			promptPack,
			cached: {
				look: lookResult.image,
				flatout: flatResult.image,
				meta: { category, model: diy.model, size: diy.size, promptVersion: promptPack.promptVersion },
			},
			cacheHit: false,
			latencyMs,
			attempts,
			seed: promptPack.seed,
			estimate,
			guardTag,
		});
	}

	/**
	 * 组装成功响应（不含 key / 上游 URL / 原始描述原文之外的敏感信息）。
	 * @param {{
	 *   requestId: string,
	 *   category: string,
	 *   guard: ReturnType<typeof checkGarmentDescription>,
	 *   promptPack: ReturnType<typeof buildPromptPack>,
	 *   cached: { look: Buffer, flatout: Buffer, meta: Record<string, unknown> },
	 *   cacheHit: boolean,
	 *   latencyMs: number,
	 *   attempts: { look: number, flatout: number },
	 *   seed: number,
	 *   estimate?: ReturnType<typeof estimateDiyCost>,
	 *   guardTag?: string,
	 * }} input
	 */
	function buildSuccessPayload(input) {
		return {
			ok: true,
			look: { dataUrl: imageToDataUrl(input.cached.look, 'image/png'), bytes: input.cached.look.length },
			flatout: { dataUrl: imageToDataUrl(input.cached.flatout, 'image/png'), bytes: input.cached.flatout.length },
			meta: {
				requestId: input.requestId,
				category: input.category,
				slot: input.promptPack.slot,
				shape: 'chibi',
				guard: {
					action: input.guard.action,
					hits: input.guard.hits,
					reasons: input.guard.reasons,
					description: input.guard.description,
					version: input.guard.guardVersion,
				},
				contentPolicyTag: input.guardTag || contentPolicyTag(input.guard.action === 'downgrade' ? 'downgrade' : 'pass'),
				model: diy.model,
				size: diy.size,
				promptVersion: input.promptPack.promptVersion,
				guardVersion: input.guard.guardVersion,
				seed: input.seed,
				latencyMs: input.latencyMs,
				attempts: input.attempts,
				cacheHit: input.cacheHit,
				cost: input.cacheHit
					? { images: 0, costYuan: 0, note: '命中本地 hash 缓存，未调用云端 API' }
					: {
							images: DEFAULT_IMAGES_PER_REQUEST,
							costYuan: Number((DEFAULT_IMAGES_PER_REQUEST * diy.pricePerImageYuan).toFixed(2)),
							estimate: input.estimate || estimateDiyCost({ pricePerImageYuan: diy.pricePerImageYuan }),
						},
			},
		};
	}

	/** 测试/QA 用：暴露注入的对象。 */
	const internals = { ledger, cache, provider };

	return { status, generate, readRegistry, readPackFile, removePack, importPack, diyHome, config, diy };
}

/* ---------------- HTTP 路由 ---------------- */

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} payload
 */
function sendJson(res, status, payload) {
	const body = Buffer.from(JSON.stringify(payload));
	res.writeHead(status, {
		'content-type': 'application/json; charset=utf-8',
		'content-length': String(body.byteLength),
		'cache-control': 'no-store',
	});
	res.end(body);
}

/**
 * 读取 JSON 请求体（带硬上限）。
 * @param {import('node:http').IncomingMessage} req
 * @param {number} maxBytes
 * @returns {Promise<unknown>}
 */
async function readJsonBody(req, maxBytes) {
	/** @type {Buffer[]} */
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += buffer.length;
		if (size > maxBytes) throw new DiyError('body_too_large', '请求体过大', 413);
		chunks.push(buffer);
	}
	if (size === 0) throw new DiyError('invalid_json', '请求体为空', 400);
	let parsed;
	try {
		parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
	} catch {
		throw new DiyError('invalid_json', '请求体不是合法 JSON', 400);
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new DiyError('invalid_json', '请求体必须是 JSON 对象', 400);
	}
	return parsed;
}

/**
 * 同源校验：浏览器 DIY 面板与宿主同源；挡掉跨站 CSRF 触发付费调用。
 * @param {import('node:http').IncomingMessage} req
 * @returns {boolean}
 */
function isSameOrigin(req) {
	const origin = req.headers.origin;
	if (typeof origin === 'string' && origin) {
		try {
			const parsed = new URL(origin);
			if (!req.headers.host || parsed.host !== req.headers.host) return false;
		} catch {
			return false;
		}
	}
	const site = req.headers['sec-fetch-site'];
	if (typeof site === 'string' && site && site !== 'same-origin' && site !== 'none') return false;
	return true;
}

/**
 * 创建宿主 DIY 路由 handler（挂到 webServer 的 `/feiyu/diy` prefix）。
 *
 * @param {ReturnType<typeof createDiyService>} service
 * @param {{ maxBodyBytes?: number, logger?: { warn?: Function, error?: Function } }} [options]
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function createDiyHandler(service, options = {}) {
	const maxBodyBytes = Number(options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES);
	const logger = options.logger || {};
	/** @type {(message: string, ...args: unknown[]) => void} */
	const warn = typeof logger.warn === 'function' ? logger.warn.bind(logger) : () => {};
	/** @type {(message: string, ...args: unknown[]) => void} */
	const error = typeof logger.error === 'function' ? logger.error.bind(logger) : () => {};

	return async function diyHandler(req, res) {
		const method = req.method || 'GET';
		/** @type {URL} */
		let url;
		try {
			url = new URL(req.url || '/', 'http://localhost');
		} catch {
			sendJson(res, 400, { ok: false, code: 'bad_request', message: '非法 URL' });
			return;
		}
		const pathname = url.pathname.replace(/\/+$/, '');
		// ---- S3：页面消费已安装 DIY（默认关闭时最小暴露：404） ----
		if (pathname === `${DIY_PATH}/registry.json`) {
			if (method !== 'GET' && method !== 'HEAD') {
				res.writeHead(405, { allow: 'GET, HEAD' });
				res.end();
				return;
			}
			if (!service.diy.enabled) {
				sendJson(res, 404, { ok: false, code: 'diy_disabled' });
				return;
			}
			const registry = service.readRegistry();
			if (method === 'HEAD') {
				const body = Buffer.from(JSON.stringify(registry));
				res.writeHead(200, {
					'content-type': 'application/json; charset=utf-8',
					'content-length': String(body.byteLength),
					'cache-control': 'no-store',
				});
				res.end();
				return;
			}
			res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
			res.end(JSON.stringify(registry));
			return;
		}
		if (pathname.startsWith(`${DIY_PATH}/packs/`)) {
			if (method !== 'GET' && method !== 'HEAD') {
				res.writeHead(405, { allow: 'GET, HEAD' });
				res.end();
				return;
			}
			if (!service.diy.enabled) {
				sendJson(res, 404, { ok: false, code: 'diy_disabled' });
				return;
			}
			const file = service.readPackFile(pathname.slice(DIY_PATH.length + 1));
			if (!file) {
				sendJson(res, 404, { ok: false, code: 'not_found' });
				return;
			}
			res.writeHead(200, {
				'content-type': file.mime,
				'content-length': String(file.bytes),
				'cache-control': 'no-store',
			});
			if (method === 'HEAD') res.end();
			else res.end(file.buffer);
			return;
		}
		if (pathname === `${DIY_PATH}/remove` || pathname === `${DIY_PATH}/import`) {
			if (method !== 'POST') {
				res.writeHead(405, { allow: 'POST' });
				res.end();
				return;
			}
			try {
				if (req.headers['x-feiyu-diy'] !== '1') {
					throw new DiyError('forbidden', '缺少 DIY 同源请求头', 403);
				}
				if (!isSameOrigin(req)) {
					throw new DiyError('forbidden', '只接受同源请求', 403);
				}
				const contentType = String(req.headers['content-type'] || '');
				if (!contentType.toLowerCase().startsWith('application/json')) {
					throw new DiyError('invalid_content_type', '需要 application/json', 415);
				}
				const body = /** @type {Record<string, unknown>} */ (await readJsonBody(req, maxBodyBytes));
				const result = pathname === `${DIY_PATH}/remove`
					? service.removePack(String(body.id || ''))
					: service.importPack(body.bundle);
				sendJson(res, 200, result);
			} catch (caught) {
				if (caught instanceof DiyError) {
					sendJson(res, caught.status, { ok: false, code: caught.code, message: caught.message });
					return;
				}
				error(
					'[feiyu-diy] pack route failed: %s',
					sanitizeProviderError(caught instanceof Error ? caught.message : String(caught)),
				);
				sendJson(res, 500, { ok: false, code: 'internal_error', message: '宿主内部错误' });
			}
			return;
		}
		if (pathname === `${DIY_PATH}/status`) {
			if (method !== 'GET' && method !== 'HEAD') {
				res.writeHead(405, { allow: 'GET, HEAD' });
				res.end();
				return;
			}
			const payload = service.status();
			if (method === 'HEAD') {
				const body = Buffer.from(JSON.stringify(payload));
				res.writeHead(200, {
					'content-type': 'application/json; charset=utf-8',
					'content-length': String(body.byteLength),
					'cache-control': 'no-store',
				});
				res.end();
				return;
			}
			sendJson(res, 200, payload);
			return;
		}
		if (pathname === `${DIY_PATH}/generate`) {
			if (method !== 'POST') {
				res.writeHead(405, { allow: 'POST' });
				res.end();
				return;
			}
			try {
				if (req.headers['x-feiyu-diy'] !== '1') {
					throw new DiyError('forbidden', '缺少 DIY 同源请求头', 403);
				}
				if (!isSameOrigin(req)) {
					throw new DiyError('forbidden', '只接受同源请求', 403);
				}
				const contentType = String(req.headers['content-type'] || '');
				if (!contentType.toLowerCase().startsWith('application/json')) {
					throw new DiyError('invalid_content_type', '需要 application/json', 415);
				}
				const body = /** @type {Record<string, unknown>} */ (await readJsonBody(req, maxBodyBytes));
				const result = await service.generate(/** @type {any} */ (body));
				sendJson(res, 200, result);
			} catch (caught) {
				if (caught instanceof DiyError) {
					if (caught.status >= 500) {
						error(
							'[feiyu-diy] %s request failed: %s',
							caught.code,
							sanitizeProviderError(caught.message),
						);
					}
					sendJson(res, caught.status, {
						ok: false,
						code: caught.code,
						message: caught.message,
						...caught.details,
					});
					return;
				}
				error(
					'[feiyu-diy] internal error: %s',
					sanitizeProviderError(caught instanceof Error ? caught.message : String(caught)),
				);
				warn('[feiyu-diy] 未预期错误已脱敏记录');
				sendJson(res, 500, { ok: false, code: 'internal_error', message: '宿主内部错误' });
			}
			return;
		}
		sendJson(res, 404, { ok: false, code: 'not_found', message: '未知 DIY 路由' });
	};
}

/**
 * 在宿主 context 上挂载 DIY 代理路由（webServer 存在时才挂；默认关闭也挂，仅 status 可读）。
 * @param {any} ctx cordis 插件 context
 * @param {{ config: import('./config.js').FeiyuConfig, service?: ReturnType<typeof createDiyService>, logger?: any, maxBodyBytes?: number }} options
 * @returns {ReturnType<typeof createDiyService>}
 */
export function mountDiyRoutes(ctx, options) {
	const service = options.service || createDiyService(options);
	const handler = createDiyHandler(service, { maxBodyBytes: options.maxBodyBytes, logger: options.logger });
	ctx.inject(['webServer'], (/** @type {any} */ webCtx) => {
		webCtx.effect(
			() =>
				webCtx.webServer.register({
					kind: 'prefix',
					path: DIY_PATH,
					handler,
				}),
			'feiyu-wardrobe: diy proxy route',
		);
	});
	return service;
}

/**
 * 宿主 DIY 数据目录（与 S2 `lib/diy-pipeline.js` 同口径）：
 * 默认 `<statePath 上级>/feiyu/diy`（默认安装即 `~/.dsh/feiyu/diy`）。
 * @param {import('./config.js').FeiyuConfig} config
 * @returns {string}
 */
export function resolveDiyHome(config) {
	return resolve(join(dirname(config.statePath), '..', 'feiyu', 'diy'));
}

/**
 * 默认素体参考图路径（仓库内 docs/dress-up/art/diy/base-chibi.png）。
 * @param {string} [baseUrl]
 * @returns {string}
 */
export function defaultBaseRefPath(baseUrl = import.meta.url) {
	return fileURLToPath(new URL('../docs/dress-up/art/diy/base-chibi.png', baseUrl));
}
