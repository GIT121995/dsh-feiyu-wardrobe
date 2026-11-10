/**
 * 大肥鱼衣橱 · 2.5D runtime 纯逻辑（浏览器 / Node 单测共用，无 WebGL / DOM 依赖）
 *
 * 这里放「能脱离 WebGL 验证」的产品逻辑（v2：2.5D-only，无渲染模式开关）：
 *   - 画质档与降级、DPR/物理频率上限
 *   - 参数总线（head follow / 眨眼 / 口型 / 呼吸 / 摆动）的默认值与钳制
 *   - 换装组合解析（套装、上衣+下装动态组合、缺件回退）
 *   - 当前可见 drawable 列表（含 face 部件状态机）
 *   - 固定步长累加器（与 runtime 同一实现，单测复刻 POC 数据）
 *   - 内存/首屏 payload 估算
 *
 * runtime-2d5.js 只做「GL 资源 + 渲染循环 + 事件」，逻辑一律走本模块，
 * 这样 2.5D 的关键行为在 node tests 里有覆盖（无需真实 GPU）。
 *
 * @module dsh-feiyu-wardrobe/runtime-2d5-core
 */

/** 2.5D runtime 数据/接口版本（M3 产品化第 1 版；M4/M6 资产替换保持兼容）。 */
export const RUNTIME_2D5_VERSION = 1;

/** 2.5D 画布逻辑尺寸（与 DOM 分层素材同构：675×1200 9:16）。 */
export const BASE_CANVAS = { width: 675, height: 1200 };

/** 画质档：DPR / 物理频率 / mask pass / mipmap。 */
export const QUALITY_PRESETS = {
	high: { dpr: 2, physicsHz: 60, maskPass: false, mipmaps: true },
	medium: { dpr: 1.5, physicsHz: 30, maskPass: false, mipmaps: true },
	low: { dpr: 1, physicsHz: 30, maskPass: false, mipmaps: false },
};

/** 物理步进参数（与 POC 一致：maxSubsteps=8、单帧墙钟上限 100ms）。 */
export const PHYSICS = { maxSubsteps: 8, dtCapMs: 100, minHz: 15, maxHz: 120 };

/** DPR 允许范围（0.5–3，与 POC 一致）。 */
export const DPR_LIMITS = { min: 0.5, max: 3 };

/** 参数总线默认值（POC `state.p` 同口径；M5 互动沿用这些键）。 */
export const DEFAULT_2D5_PARAMS = {
	headX: 0,
	headY: 0,
	headZ: 0,
	breath: 0.6,
	eyeOpen: 1,
	eyeSmile: 0,
	mouthOpen: 0,
	hairSway: 0.55,
	skirtSway: 0.5,
};

/** 参数总线允许范围。头角度用 POC QA 的 ±25° 安全包络（产品常规远小于此）。 */
export const PARAM_LIMITS = {
	headX: [-25, 25],
	headY: [-25, 25],
	headZ: [-25, 25],
	breath: [0, 1],
	eyeOpen: [0, 1],
	eyeSmile: [0, 1],
	mouthOpen: [0, 1],
	hairSway: [0, 1],
	skirtSway: [0, 1],
};

/** head follow 包络（鼠标/触摸移动到画布边缘时头部的最大偏转，度）。 */
export const HEAD_FOLLOW_LIMITS = { yaw: 8, pitch: 6 };

/** 2.5D face 部件的兜底状态键（rig 缺省时使用）。 */
export const FACE_FALLBACK = {
	eye: ['open', 'half', 'closed', 'smile'],
	mouth: ['closed', 'small', 'mid', 'open', 'smile'],
};

/**
 * 画质档解析：显式档位优先，`auto`/非法值按设备能力挑档。
 * 覆盖项（URL/API 单开）优先于档位。
 * @param {unknown} quality
 * @param {{ dpr?: unknown, physicsHz?: unknown, maskPass?: unknown, mipmaps?: unknown }} [overrides]
 * @param {{ deviceMemory?: number|null, hardwareConcurrency?: number|null }} [device]
 * @returns {{ quality: 'high'|'medium'|'low', dpr: number, physicsHz: number, maskPass: boolean, mipmaps: boolean }}
 */
export function resolveQuality(quality, overrides = {}, device = {}) {
	const requested = typeof quality === 'string' ? quality.trim().toLowerCase() : 'auto';
	const tier = requested === 'high' || requested === 'medium' || requested === 'low'
		? /** @type {'high'|'medium'|'low'} */ (requested)
		: pickQualityTier(device);
	const preset = { ...QUALITY_PRESETS[tier] };
	if (Number.isFinite(overrides.dpr)) preset.dpr = clampNumber(overrides.dpr, DPR_LIMITS.min, DPR_LIMITS.max);
	if (Number.isFinite(overrides.physicsHz)) preset.physicsHz = clampPhysicsHz(overrides.physicsHz);
	if (typeof overrides.maskPass === 'boolean') preset.maskPass = overrides.maskPass;
	if (typeof overrides.mipmaps === 'boolean') preset.mipmaps = overrides.mipmaps;
	return { quality: tier, ...preset };
}

/**
 * 设备能力 → 画质档（保守：低内存/少核给 low；高配才 high；其余 medium）。
 * 真机未测，产品默认 medium；用户可在页面切换档位。
 * @param {{ deviceMemory?: number|null, hardwareConcurrency?: number|null }} [device]
 * @returns {'high'|'medium'|'low'}
 */
export function pickQualityTier(device = {}) {
	const memory = Number(device.deviceMemory);
	const cores = Number(device.hardwareConcurrency);
	if ((Number.isFinite(memory) && memory > 0 && memory < 2) || (Number.isFinite(cores) && cores > 0 && cores < 4)) {
		return 'low';
	}
	if (Number.isFinite(memory) && memory >= 8 && Number.isFinite(cores) && cores >= 8) return 'high';
	return 'medium';
}

/* ------------------------------------------------ 资产 tier（v2.6.1 2x） -- */

/**
 * 资产档位：`lo` = 现有 1x 资产（`art/2d5/{shape}/`）；`hi` = 2x 高 DPI 资产
 * （`art/2d5/{shape}-hi/`，body/hair/face/tail 2x + 服装 1x，两页图集）。
 * 页面向 runtime 传 tierOverride（URL ?feiyuTier= / localStorage）用于调试强制。
 */
export const ASSET_TIERS = ['lo', 'hi'];
/** hi tier 要求设备 DPR ≥ 2（按 `window.devicePixelRatio`，与画质档 dpr 无关）。 */
export const HI_MIN_DPR = 2;
/** hi tier 要求 navigator.deviceMemory ≥ 4（GiB）或 hardwareConcurrency ≥ 4。 */
export const HI_MIN_DEVICE_MEMORY = 4;
/** hi tier 要求 navigator.hardwareConcurrency ≥ 4（deviceMemory 缺失时的弱机判据）。 */
export const HI_MIN_HARDWARE_CONCURRENCY = 4;
/** hi tier 要求 WebGL MAX_TEXTURE_SIZE ≥ 4096（两页图集每页 ≤4096）。 */
export const HI_MIN_TEXTURE_SIZE = 4096;

/**
 * 资产目录名：lo → `{shape}`；hi → `{shape}-hi`（图集/rig 同目录，运行时只换前缀）。
 * @param {string} shape
 * @param {string} [tier]
 * @returns {string}
 */
export function assetDirForTier(shape, tier = 'lo') {
	const base = typeof shape === 'string' && shape ? shape : 'chibi';
	return tier === 'hi' ? `${base}-hi` : base;
}

/**
 * 资产 tier 决策（纯函数，node 单测覆盖）：
 *   hi = DPR≥2 且（deviceMemory≥4 或 hardwareConcurrency≥4）且 MAX_TEXTURE_SIZE≥4096；
 *   否则 lo。显式 override（URL/localStorage/API 调试）优先，值非法时忽略。
 * 真机未测：弱机/DPR1 一律 lo，hi 加载失败由 runtime 自动回退 lo（见 runtime-2d5.js）。
 *
 * @param {{
 *   device?: { deviceMemory?: number|null, hardwareConcurrency?: number|null },
 *   dpr?: unknown,
 *   maxTextureSize?: unknown,
 *   override?: unknown,
 *   overrideSource?: string,
 * }} [options]
 * @returns {{
 *   tier: 'lo'|'hi',
 *   reason: string,
 *   override: { tier: 'lo'|'hi', source: string }|null,
 *   signals: { dpr: number, deviceMemory: number|null, hardwareConcurrency: number|null, maxTextureSize: number|null },
 * }}
 */
export function resolveAssetTier(options = {}) {
	const device = options.device || {};
	const positive = (value) => {
		const number = Number(value);
		return Number.isFinite(number) && number > 0 ? number : null;
	};
	const signals = {
		dpr: positive(options.dpr) || 1,
		deviceMemory: positive(device.deviceMemory),
		hardwareConcurrency: positive(device.hardwareConcurrency),
		maxTextureSize: positive(options.maxTextureSize),
	};
	const rawOverride = typeof options.override === 'string' ? options.override.trim().toLowerCase() : '';
	if (ASSET_TIERS.includes(rawOverride)) {
		const source = typeof options.overrideSource === 'string' && options.overrideSource ? options.overrideSource : 'explicit';
		const tier = /** @type {'lo'|'hi'} */ (rawOverride);
		return { tier, reason: `override:${source}`, override: { tier, source }, signals };
	}
	const failures = [];
	if (!(signals.dpr >= HI_MIN_DPR)) failures.push(`dpr<${HI_MIN_DPR}`);
	const memoryOk = signals.deviceMemory !== null && signals.deviceMemory >= HI_MIN_DEVICE_MEMORY;
	const coresOk = signals.hardwareConcurrency !== null && signals.hardwareConcurrency >= HI_MIN_HARDWARE_CONCURRENCY;
	// 任一为强（内存或核数）即可；两者都未知时才判弱机（iPadOS/Safari 无 deviceMemory 时看核数）。
	if (!memoryOk && !coresOk) failures.push('device-weak');
	if (!(signals.maxTextureSize !== null && signals.maxTextureSize >= HI_MIN_TEXTURE_SIZE)) failures.push(`max-texture<${HI_MIN_TEXTURE_SIZE}`);
	if (failures.length > 0) return { tier: 'lo', reason: `auto:${failures.join(',')}`, override: null, signals };
	return { tier: 'hi', reason: 'auto:capable', override: null, signals };
}

/** @param {unknown} value @param {number} min @param {number} max @returns {number} */
function clampNumber(value, min, max) {
	const number = Number(value);
	if (!Number.isFinite(number)) return min;
	return Math.min(max, Math.max(min, number));
}

/** @param {unknown} value @returns {number} */
export function clampPhysicsHz(value) {
	const number = Math.round(Number(value));
	if (!Number.isFinite(number)) return 60;
	return Math.min(PHYSICS.maxHz, Math.max(PHYSICS.minHz, number));
}

/**
 * 参数总线钳制：以 base 为底合并 partial，按 PARAM_LIMITS 收敛；未知键忽略。
 * @param {Record<string, number>} [base]
 * @param {Record<string, number>|null|undefined} [partial]
 * @returns {Record<string, number>}
 */
export function clampParams(base = DEFAULT_2D5_PARAMS, partial = {}) {
	/** @type {Record<string, number>} */
	const out = {};
	for (const key of Object.keys(DEFAULT_2D5_PARAMS)) {
		const limits = PARAM_LIMITS[/** @type {keyof typeof PARAM_LIMITS} */ (key)];
		const candidate = partial && Number.isFinite(partial[key]) ? Number(partial[key]) : base[key];
		const value = Number.isFinite(candidate) ? Number(candidate) : DEFAULT_2D5_PARAMS[/** @type {keyof typeof DEFAULT_2D5_PARAMS} */ (key)];
		out[key] = Math.min(limits[1], Math.max(limits[0], value));
	}
	return out;
}

/**
 * 头跟随：鼠标/触摸在画布内的归一化位置（-1..1）→ 头部偏转（度）。
 * nx>0 = 右侧，ny>0 = 下方。无输入返回 0（回正）。
 * @param {number|null|undefined} nx
 * @param {number|null|undefined} ny
 * @returns {{ headY: number, headX: number }}
 */
export function headFollowParams(nx, ny) {
	if (!Number.isFinite(nx) || !Number.isFinite(ny)) return { headY: 0, headX: 0 };
	return {
		headY: Math.min(HEAD_FOLLOW_LIMITS.yaw, Math.max(-HEAD_FOLLOW_LIMITS.yaw, Number(nx) * HEAD_FOLLOW_LIMITS.yaw)) || 0,
		headX: Math.min(HEAD_FOLLOW_LIMITS.pitch, Math.max(-HEAD_FOLLOW_LIMITS.pitch, -Number(ny) * HEAD_FOLLOW_LIMITS.pitch)) || 0,
	};
}

/**
 * 固定步长累加器（runtime 每帧调用；node 单测用同一实现复刻 POC 数据）。
 *
 * - 每帧先按 dtCap 截断墙钟 dt（默认 100ms，<10fps 时物理会慢于墙钟，如实保留）；
 * - 按 1/hz 固定步长结算，单帧最多 maxSubsteps 步；
 * - 超出 maxSubsteps 的 backlog 丢弃并计入 dropped（防死亡螺旋）。
 *
 * @param {{ acc: number, dtWall: number, hz?: number, maxSubsteps?: number }} input
 * @returns {{ acc: number, ticks: number, dropped: number }}
 */
export function accumulateTicks({ acc, dtWall, hz = 60, maxSubsteps = PHYSICS.maxSubsteps }) {
	const step = 1 / clampPhysicsHz(hz);
	let nextAcc = Math.max(0, Number(acc) || 0) + Math.max(0, Number(dtWall) || 0);
	let ticks = 0;
	while (nextAcc >= step - 1e-9 && ticks < maxSubsteps) {
		nextAcc -= step;
		ticks += 1;
	}
	let dropped = 0;
	if (nextAcc >= step - 1e-9) {
		dropped = Math.floor(nextAcc / step);
		nextAcc = 0;
	}
	return { acc: nextAcc, ticks, dropped };
}

/** 眨眼相位（POC 同口径：0.14s 内 half → closed → half）。 */
export const BLINK_DURATION = 0.14;   // 秒
export const BLINK_CLOSE = 0.13;      // 同 POC：触发眨眼时 blinkT = 0.13
export const SMILE_HOLD = 1.8;        // 同 POC：触发笑眼时 smileT = 1.8

/**
 * 眨眼进行中的眼态（art-v2 有 open/half/closed/smile 四态）。
 * @param {number} blinkT 剩余眨眼时间（秒）
 * @returns {'half'|'closed'}
 */
export function blinkEyeKey(blinkT) {
	const phase = Math.min(1, Math.max(0, 1 - Number(blinkT || 0) / BLINK_DURATION));
	return phase < 0.3 ? 'half' : phase < 0.72 ? 'closed' : 'half';
}

/**
 * 目标眼态（POC desiredEye 同口径，纯函数）。
 * @param {{ params: Record<string, number>, blinkT: number, smileT: number, override?: string|null, parts?: boolean }} input
 * @returns {string}
 */
export function desiredEyeKey({ params, blinkT, smileT, override = null, parts = true }) {
	if (override) return override;
	if (Number(params.eyeOpen) < 0.5) return parts ? 'closed' : 'blink';
	if (blinkT > 0) return parts ? blinkEyeKey(blinkT) : 'blink';
	if (smileT > 0 || Number(params.eyeSmile) > 0.5) return 'smile';
	return 'open';
}

/**
 * 目标口型（POC desiredMouth 同口径，纯函数）。
 * @param {{ params: Record<string, number>, talking?: boolean, talkT?: number, time: number, override?: string|null, parts?: boolean }} input
 * @returns {string}
 */
export function desiredMouthKey({ params, talking = false, talkT = 0, time = 0, override = null, parts = true }) {
	if (override) return override;
	if (talking || talkT > 0) {
		const phase = Math.floor(Number(time) * 9) % (parts ? 4 : 3);
		if (parts) return ['closed', 'small', 'mid', 'open'][phase];
		return phase === 0 ? 'closed' : phase === 1 ? 'mid' : 'open';
	}
	const mouth = Number(params.mouthOpen);
	if (parts) {
		return mouth >= 0.75 ? 'open' : mouth >= 0.5 ? 'mid' : mouth >= 0.2 ? 'small' : 'closed';
	}
	return mouth >= 0.75 ? 'open' : mouth >= 0.2 ? 'mid' : 'closed';
}

/**
 * face 部件当前应显示的 drawable id 列表。
 * @param {any} rig
 * @param {string} eyeKey
 * @param {string} mouthKey
 * @returns {string[]}
 */
export function faceDrawableIds(rig, eyeKey, mouthKey) {
	const face = (rig && rig.slots && rig.slots.face) || {};
	/** @type {string[]} */
	const out = [];
	for (const id of face.brow || []) out.push(id);
	const eyeParts = (face.eye && face.eye[eyeKey]) || (face.eye && face.eye.open) || [];
	for (const id of eyeParts) out.push(id);
	const mouthParts = (face.mouth && face.mouth[mouthKey]) || (face.mouth && face.mouth.closed) || [];
	for (const id of mouthParts) out.push(id);
	return out;
}

/** rig 支持的 face 状态键（缺省给兜底表）。 */
export function faceStateKeys(rig) {
	const face = (rig && rig.slots && rig.slots.face) || {};
	return {
		mode: face.mode === 'parts' ? 'parts' : 'legacy',
		eye: Object.keys(face.eye || {}).length ? Object.keys(face.eye) : FACE_FALLBACK.eye.slice(),
		mouth: Object.keys(face.mouth || {}).length ? Object.keys(face.mouth) : FACE_FALLBACK.mouth.slice(),
	};
}

/**
 * rig 里可用的 drawable id 集合。
 * @param {any} rig
 * @returns {Set<string>}
 */
export function drawableIdsOf(rig) {
	const ids = new Set();
	for (const drawable of (rig && rig.drawables) || []) {
		if (drawable && typeof drawable.id === 'string') ids.add(drawable.id);
	}
	return ids;
}

/** 2.5D 服装单件 → drawable 组合（与 rig 的 role 命名约定一致）。 */
export const GARMENTS = {
	top: {
		hoodie: { slot: 'topBody', body: 'hoodie-body', sleeve: 'hoodie-sleeve' },
		sailor: { slot: 'topUnder', body: 'sailor-body', sleeve: 'sailor-sleeve' },
	},
	bottom: {
		plaid: { slot: 'bottom', body: 'bottom-plaid' },
		pleated: { slot: 'bottom', body: 'bottom-pleated' },
	},
};

/**
 * B 方案 cutout（v2.2）drawOrder 槽位。
 *
 * - `BODY_DRAW_SLOTS`：身体部件/头发等常驻层（来自 rig.slots；旧 rig 缺省 → 空）；
 * - `OUTFIT_SLOTS`：随 outfit/look 解析的服装槽位；新增 `sleeveUpper/sleeveFore/collar` 供 cutout 服装；
 * - `legacy` 四个槽位（topUnder/bottom/topBody/sleeve）语义保持不变（getState().look.slots 向后兼容）。
 */
export const BODY_DRAW_SLOTS = [
	'hairBack', 'strands', 'body', 'legs', 'arms', 'armUpper', 'armFore', 'hand', 'hair', 'hairFront', 'collar',
];
export const OUTFIT_SLOTS = ['topUnder', 'bottom', 'topBody', 'sleeve', 'sleeveUpper', 'sleeveFore', 'collar'];
/** v2.2 cutout 新增槽位（旧 rig 不出现即空，不影响既有渲染）。 */
export const CUTOUT_SLOTS = ['legs', 'armUpper', 'armFore', 'hand', 'collar', 'sleeveUpper', 'sleeveFore'];
/** 旧版四个服装槽位（向后兼容基线）。 */
export const LEGACY_OUTFIT_SLOTS = ['topUnder', 'bottom', 'topBody', 'sleeve'];
/** 每身心最多图集数（cutout 首版；单张超过 4096 时可拆 2 张）。 */
export const MAX_ATLASES = 2;
/** DIY pack 旧槽位别名（S1/S2 早期产物可能用 arms 等命名）。 */
export const DIY_SLOT_ALIASES = { arms: 'sleeve', arm: 'sleeve', sleeves: 'sleeve' };

/**
 * 空 look slots（含 cutout 新槽位；旧 4 键保持数组语义）。
 * @returns {Record<string, string[]>}
 */
export function emptyLookSlots() {
	/** @type {Record<string, string[]>} */
	const slots = {};
	for (const slot of OUTFIT_SLOTS) slots[slot] = [];
	return slots;
}

/**
 * 规范化图集列表：支持旧 rig 单图集（rig.atlas）与新 rig 多图集（rig.atlases）。
 * @param {any} rig
 * @returns {{ ok: boolean, errors: string[], legacy: boolean, atlases: Array<{ id: string, file: string, width: number, height: number, index: number }> }}
 */
export function normalizeAtlases(rig) {
	const errors = [];
	/** @type {Array<{ id: string, file: string, width: number, height: number, index: number }>} */
	const atlases = [];
	if (rig && Array.isArray(rig.atlases) && rig.atlases.length > 0) {
		if (rig.atlases.length > MAX_ATLASES) errors.push('too_many_atlases');
		const seen = new Set();
		rig.atlases.forEach((/** @type {any} */ entry, i) => {
			const id = String((entry && entry.id) || `atlas${i}`);
			if (seen.has(id)) errors.push(`duplicate_atlas_id:${id}`);
			seen.add(id);
			const file = entry && typeof entry.file === 'string' && entry.file ? entry.file : '';
			if (!file) errors.push(`atlas_file_missing:${id}`);
			atlases.push({
				id, file, index: i,
				width: Math.max(0, Number(entry && entry.width) || 0),
				height: Math.max(0, Number(entry && entry.height) || 0),
			});
		});
		return { ok: errors.length === 0, errors, legacy: false, atlases };
	}
	const atlas = (rig && rig.atlas) || {};
	atlases.push({
		id: 'default', index: 0,
		file: typeof atlas.file === 'string' && atlas.file ? atlas.file : 'atlas.webp',
		width: Math.max(0, Number(atlas.width) || 0),
		height: Math.max(0, Number(atlas.height) || 0),
	});
	return { ok: true, errors, legacy: true, atlases };
}

/**
 * 解析 drawable 归属的图集下标（drawable.atlas 支持 id / 下标 / 文件名；缺省第一张）。
 * @param {any} drawable
 * @param {Array<{ id: string, file: string, index: number }>} atlases
 * @returns {number}
 */
export function resolveDrawableAtlas(drawable, atlases) {
	if (!Array.isArray(atlases) || atlases.length === 0) return 0;
	const ref = drawable ? drawable.atlas : undefined;
	if (typeof ref === 'number' && Number.isInteger(ref) && ref >= 0 && ref < atlases.length) return ref;
	if (typeof ref === 'string' && ref) {
		const byId = atlases.findIndex((atlas) => atlas.id === ref);
		if (byId >= 0) return byId;
		const byFile = atlases.findIndex((atlas) => atlas.file === ref);
		if (byFile >= 0) return byFile;
	}
	return 0;
}

/**
 * 把换装页状态解析成 2.5D 组合：套装优先；否则「上衣 + 下装」动态组合；
 * 缺件时按「同槽位最近可用 → rig 默认套装」回退，并把原因记进 warnings。
 *
 * @param {any} rig 2.5D rig JSON
 * @param {{ outfit?: string, top?: string, bottom?: string, bare?: boolean }} state 换装页状态子集
 * @returns {{
 *   slots: Record<string, string[]>,
 *   outfit: string|null, label: string, fallback: string|null, warnings: string[],
 * }}
 */
export function resolveLook(rig, state = {}) {
	const available = drawableIdsOf(rig);
	const outfits = (rig && rig.outfits) || {};
	/** @type {Record<string, string[]>} */
	const slots = emptyLookSlots();
	const warnings = [];
	const outfitId = typeof state.outfit === 'string' ? state.outfit : '';

	// 0) DIY 静态贴片模式（bare=true）：只保留身体/头发/脸，不渲染任何服装层，
	//    避免「基础造型衣服 + DIY 贴片」叠成两层衣服（v2.0.1 修复）。
	if (state && state.bare === true) {
		return { slots, outfit: null, label: 'DIY 静态造型', fallback: null, warnings };
	}

	// 1) 套装命中（M3 页面只有 maid；M4/M6 若扩展套装也走这里）
	if (outfitId && outfitId !== 'none' && outfits[outfitId]) {
		const outfit = outfits[outfitId];
		for (const slot of OUTFIT_SLOTS) {
			for (const id of outfit[slot] || []) if (available.has(id)) slots[slot].push(id);
		}
		return { slots, outfit: outfitId, label: outfit.name || outfitId, fallback: null, warnings };
	}

	// 2a) 上衣 + 下装动态组合（v2.2 cutout：优先命中组合套装 `<top>-<bottom>`）
	let top = typeof state.top === 'string' ? state.top : '';
	let bottom = typeof state.bottom === 'string' ? state.bottom : '';
	const comboId = top && bottom ? `${top}-${bottom}` : '';
	const comboOutfit = comboId && outfits[comboId] ? outfits[comboId] : null;
	if (comboOutfit) {
		for (const slot of OUTFIT_SLOTS) {
			for (const id of comboOutfit[slot] || []) if (available.has(id)) slots[slot].push(id);
		}
		return {
			slots,
			outfit: null,
			label: `${topLabel(top)} + ${bottomLabel(bottom)}`,
			fallback: null,
			warnings,
		};
	}
	// 2b) 旧 rig（v2.1 及以前）：generic 上衣/下装 drawable 拼装（向后兼容）
	const topDef = GARMENTS.top[/** @type {keyof typeof GARMENTS.top} */ (top)] || null;
	const bottomDef = GARMENTS.bottom[/** @type {keyof typeof GARMENTS.bottom} */ (bottom)] || null;
	let missing = false;
	if (!topDef || !available.has(topDef.body)) {
		missing = true;
		// 缺件回退：优先同身形可用的连帽卫衣（POC 素材最完整），否则 rig 默认套装
		if (available.has('hoodie-body') && top !== 'hoodie') {
			top = 'hoodie';
			warnings.push(`top:${state.top || '?'}→hoodie`);
		} else {
			top = '';
			warnings.push(`top:${state.top || '?'} 不可用`);
		}
	}
	if (!bottomDef || !available.has(bottomDef.body)) {
		missing = true;
		if (available.has('bottom-plaid') && bottom !== 'plaid') {
			bottom = 'plaid';
			warnings.push(`bottom:${state.bottom || '?'}→plaid`);
		} else {
			bottom = '';
			warnings.push(`bottom:${state.bottom || '?'} 不可用`);
		}
	}
	const chosenTop = GARMENTS.top[/** @type {keyof typeof GARMENTS.top} */ (top)] || null;
	const chosenBottom = GARMENTS.bottom[/** @type {keyof typeof GARMENTS.bottom} */ (bottom)] || null;
	if (chosenTop) {
		slots[chosenTop.slot].push(chosenTop.body);
		if (chosenTop.sleeve && available.has(chosenTop.sleeve)) slots.sleeve.push(chosenTop.sleeve);
	}
	if (chosenBottom) slots[chosenBottom.slot].push(chosenBottom.body);

	// 3) 组合为空（两个都不可用）→ rig 默认套装兜底
	if (!slots.topBody.length && !slots.topUnder.length) {
		const fallbackId = (rig && rig.defaults && rig.defaults.outfit) || Object.keys(outfits)[0] || null;
		const fallbackOutfit = fallbackId ? outfits[fallbackId] : null;
		if (fallbackOutfit) {
			for (const slot of OUTFIT_SLOTS) {
				for (const id of fallbackOutfit[slot] || []) if (available.has(id)) slots[slot].push(id);
			}
			warnings.push(`fallback:${fallbackId}`);
			return {
				slots,
				outfit: fallbackId,
				label: (fallbackOutfit.name || fallbackId) + '（回退）',
				fallback: fallbackId,
				warnings,
			};
		}
	}

	const parts = [];
	if (chosenTop) parts.push(topLabel(top));
	if (chosenBottom) parts.push(bottomLabel(bottom));
	const label = parts.length ? parts.join(' + ') : '默认造型';
	return {
		slots,
		outfit: null,
		label: missing ? label + '（部分回退）' : label,
		fallback: missing ? 'partial' : null,
		warnings,
	};
}

/** @param {string} id */
function topLabel(id) {
	return /** @type {Record<string, string>} */ ({ hoodie: '白卫衣', sailor: '水手服' })[id] || id;
}

/** @param {string} id */
function bottomLabel(id) {
	return /** @type {Record<string, string>} */ ({ plaid: '格纹裙', pleated: '深蓝裙' })[id] || id;
}

/**
 * 当前帧应绘制的 drawable 列表：身形/发丝/服装槽位 + face 部件，按 z 升序（同 z 按 id）。
 * 与 POC buildActive 同口径（阴影/补边层靠 z 排）。
 *
 * @param {any} rig
 * @param {{ slots: Record<string, string[]> }} look
 * @param {{ eye?: string, mouth?: string }} [faceKeys]
 * @returns {{ id: string, z: number }[]}
 */
export function visibleDrawables(rig, look, faceKeys = {}) {
	const byId = new Map();
	for (const drawable of (rig && rig.drawables) || []) byId.set(drawable.id, drawable);
	/** @type {Map<string, any>} */
	const chosen = new Map();
	const add = (/** @type {string} */ id) => {
		const drawable = byId.get(id);
		if (drawable && !chosen.has(id)) chosen.set(id, drawable);
	};
	const slots = (rig && rig.slots) || {};
	for (const slot of BODY_DRAW_SLOTS) {
		for (const id of slots[slot] || []) add(id);
	}
	for (const slot of OUTFIT_SLOTS) {
		for (const id of (look && look.slots && look.slots[slot]) || []) add(id);
	}
	const eyeKey = faceKeys.eye || 'open';
	const mouthKey = faceKeys.mouth || 'closed';
	for (const id of faceDrawableIds(rig, eyeKey, mouthKey)) add(id);
	return [...chosen.values()]
		.sort((a, b) => (Number(a.z) || 0) - (Number(b.z) || 0) || String(a.id).localeCompare(String(b.id)))
		.map((drawable) => ({ id: drawable.id, z: Number(drawable.z) || 0 }));
}

/**
 * 纹理内存估算（RGBA8；mipmap 开启时 ×4/3，与 POC `memoryInfo` 口径一致）。
 * @param {Array<{ width: number, height: number }>} textures
 * @param {boolean} [mipmaps]
 * @returns {{ texBytes: number, texMiB: number, texMiBwithMipmap: number }}
 */
export function estimateTextureMemory(textures, mipmaps = true) {
	let texBytes = 0;
	for (const texture of textures) {
		const width = Math.max(0, Number(texture.width) || 0);
		const height = Math.max(0, Number(texture.height) || 0);
		texBytes += width * height * 4;
	}
	const withMip = mipmaps ? Math.round((texBytes * 4) / 3) : texBytes;
	return {
		texBytes,
		texMiB: Math.round((texBytes / 1048576) * 100) / 100,
		texMiBwithMipmap: Math.round((withMip / 1048576) * 100) / 100,
	};
}

/**
 * 首屏 payload 汇总（实测的 resource timing 或构建期字节数都走这里格式化）。
 * @param {{ rigBytes: number, rigTransferBytes?: number, atlasBytes: number, codeBytes?: number }} input
 * @returns {{ rawBytes: number, transferBytes: number, rawMiB: number, transferMiB: number }}
 */
export function summarizeInitialPayload({ rigBytes, rigTransferBytes, atlasBytes, codeBytes = 0 }) {
	const rawBytes = (Number(rigBytes) || 0) + (Number(atlasBytes) || 0) + (Number(codeBytes) || 0);
	const transferBytes = (Number(rigTransferBytes) || Number(rigBytes) || 0) +
		(Number(atlasBytes) || 0) + (Number(codeBytes) || 0);
	return {
		rawBytes,
		transferBytes,
		rawMiB: Math.round((rawBytes / 1048576) * 100) / 100,
		transferMiB: Math.round((transferBytes / 1048576) * 100) / 100,
	};
}


/* ------------------------------------------------------- DIY 增量 outfit pack ---
 * S3：运行时动态加载 S2 产出的 feiyu-diy-pack v1（不复制 base rig；多纹理）。
 * 纯函数（无 GL）：runtime-2d5.js 负责 VAO/纹理上传与释放；node 单测覆盖本段。
 */

/** 增量 pack 格式标识（与 .scratch/diy2/S2-S3-PACK-SPEC.md 一致）。 */
export const DIY_PACK_FORMAT = 'feiyu-diy-pack';
export const DIY_PACK_FORMAT_VERSION = 1;

/**
 * 校验并规范化增量 DIY pack（不修改输入）。
 *
 * @param {any} pack
 * @param {{ bones?: number, shape?: string, boneNames?: string[] }} [options]
 * @returns {{ ok: boolean, errors: string[], packId: string, drawables: any[], outfits: Record<string, any>, textures: string[], packBones: number, sceneBones: number, legacyBones: boolean }}
 */
export function normalizeDiyPack(pack, options = {}) {
	const errors = [];
	const bones = Number(options.bones) || 0;
	const boneNames = Array.isArray(options.boneNames) ? options.boneNames : null;
	const shape = String(options.shape || '');
	const empty = { ok: false, errors, packId: '', drawables: [], outfits: {}, textures: [], packBones: 0, sceneBones: bones, legacyBones: false };
	if (!pack || typeof pack !== 'object') return { ...empty, errors: ['pack_invalid'] };
	if (pack.format !== DIY_PACK_FORMAT) errors.push('format_invalid');
	if (Number(pack.formatVersion) !== DIY_PACK_FORMAT_VERSION) errors.push('version_invalid');
	if (!pack.item || typeof pack.item !== 'string') errors.push('item_missing');
	if (shape && pack.shape && pack.shape !== shape) errors.push('shape_mismatch');
	const packBones = Number(pack.base && pack.base.skeletonBones) || 0;
	// 骨架版本兼容（v2.4）：允许 packBones ≤ sceneBones 的「前缀骨架」（旧 59 骨 pack 可用于 65/68 骨场景）；
	// packBones 缺失/超出场景骨数仍拒绝；pack 若带 boneNames 则要求与场景骨架前缀逐名一致。
	let legacyBones = false;
	if (bones > 0) {
		if (!packBones || packBones > bones) {
			errors.push('skeleton_mismatch');
		} else {
			legacyBones = packBones < bones;
			const packBoneNames = pack.base && Array.isArray(pack.base.boneNames) ? pack.base.boneNames : null;
			if (packBoneNames && packBoneNames.length !== packBones) {
				errors.push('skeleton_names_invalid');
			} else if (packBoneNames && boneNames) {
				for (let i = 0; i < packBoneNames.length; i += 1) {
					if (String(packBoneNames[i]) !== String(boneNames[i])) {
						errors.push('skeleton_name_mismatch');
						break;
					}
				}
			}
		}
	}
	const boneLimit = packBones > 0 ? Math.min(packBones, bones || packBones) : bones;
	const rawDrawables = Array.isArray(pack.drawables) ? pack.drawables : [];
	/** @type {any[]} */
	const drawables = rawDrawables.map((drawable) => {
		if (!drawable || typeof drawable !== 'object') return drawable;
		const slot = DIY_SLOT_ALIASES[drawable.slot] || drawable.slot;
		return slot === drawable.slot ? drawable : { ...drawable, slot };
	});
	if (drawables.length < 1 || drawables.length > 2) errors.push('drawables_count');
	const textures = [];
	const seenIds = new Set();
	for (const drawable of drawables) {
		if (!drawable || typeof drawable !== 'object') {
			errors.push('drawable_invalid');
			continue;
		}
		const id = String(drawable.id || '');
		if (!id) errors.push('drawable_id_missing');
		if (seenIds.has(id)) errors.push('drawable_duplicate');
		seenIds.add(id);
		if (!OUTFIT_SLOTS.includes(drawable.slot)) errors.push(`slot_invalid:${id}`);
		if (!Number.isFinite(Number(drawable.z))) errors.push(`z_invalid:${id}`);
		if (typeof drawable.texture !== 'string' || !/\.(webp|png)$/i.test(drawable.texture)) errors.push(`texture_invalid:${id}`);
		else textures.push(drawable.texture);
		const mesh = drawable.mesh;
		if (!mesh || !Array.isArray(mesh.positions) || mesh.positions.length === 0) {
			errors.push(`mesh_missing:${id}`);
			continue;
		}
		const count = mesh.positions.length;
		if (!Array.isArray(mesh.uvs) || mesh.uvs.length !== count
			|| !Array.isArray(mesh.bones) || mesh.bones.length !== count
			|| !Array.isArray(mesh.weights) || mesh.weights.length !== count
			|| !Array.isArray(mesh.deform) || mesh.deform.length !== count
			|| !Array.isArray(mesh.indices) || mesh.indices.length % 3 !== 0) {
			errors.push(`mesh_attr_length:${id}`);
			continue;
		}
		for (let i = 0; i < count; i += 1) {
			const uv = mesh.uvs[i];
			if (!Array.isArray(uv) || uv.length !== 2 || uv[0] < 0 || uv[0] > 1 || uv[1] < 0 || uv[1] > 1) {
				errors.push(`uv_out_of_range:${id}`);
				break;
			}
		}
		for (const index of mesh.indices) {
			if (!Number.isInteger(index) || index < 0 || index >= count) {
				errors.push(`index_out_of_range:${id}`);
				break;
			}
		}
		for (let i = 0; i < count; i += 1) {
			const rowBones = mesh.bones[i];
			const rowWeights = mesh.weights[i];
			if (!Array.isArray(rowBones) || rowBones.length !== 4 || !Array.isArray(rowWeights) || rowWeights.length !== 4) {
				errors.push(`four_influence:${id}`);
				break;
			}
			if (boneLimit && rowBones.some((bone) => !Number.isInteger(bone) || bone < 0 || bone >= boneLimit)) {
				errors.push(`bone_out_of_range:${id}`);
				break;
			}
			const sum = rowWeights.reduce((total, weight) => total + Number(weight), 0);
			if (Math.abs(sum - 1) > 0.02) {
				errors.push(`weights_not_normalized:${id}`);
				break;
			}
		}
	}
	const outfits = pack.outfits && typeof pack.outfits === 'object' ? pack.outfits : {};
	const outfitIds = Object.keys(outfits);
	if (outfitIds.length === 0) errors.push('outfit_missing');
	for (const outfitId of outfitIds) {
		if (!outfitId.startsWith('diy-')) errors.push(`outfit_bad_name:${outfitId}`);
		const outfit = outfits[outfitId] || {};
		const refs = OUTFIT_SLOTS.flatMap((slot) => outfit[slot] || []);
		if (!refs.some((ref) => seenIds.has(ref))) errors.push(`outfit_refs_missing:${outfitId}`);
	}
	return {
		ok: errors.length === 0,
		errors,
		packId: String(pack.item || ''),
		drawables,
		outfits,
		textures,
		packBones,
		sceneBones: bones,
		legacyBones,
	};
}

/**
 * v2.1 → v2.2 cutout 的 base 引用迁移表（旧 DIY pack 的 pairing 引用 v2.1 generic drawable）。
 * 目标 id 是 v2.2 production rig 的部件；运行时按目标 drawable 的 slot 自动落槽。
 */
export const LEGACY_V21_BASE_REFS = {
	// v2.7.0 下架毛衣后：旧 v2.1 的毛衣/裙子引用改映射到现有连帽卫衣套（hoodie-plaid）
	'bottom-plaid': ['hoodie-plaid-skirt', 'hoodie-plaid-skirt-under'],
	'bottom-pleated': ['hoodie-pleated-skirt', 'hoodie-pleated-skirt-under'],
	'sweater-body': ['hoodie-plaid-torso'],
	'sweater-sleeve': [
		'hoodie-plaid-sleeve-upper-L', 'hoodie-plaid-sleeve-upper-R',
		'hoodie-plaid-sleeve-fore-L', 'hoodie-plaid-sleeve-fore-R',
	],
	'hoodie-body': ['hoodie-plaid-torso'],
	'hoodie-sleeve': [
		'hoodie-plaid-sleeve-upper-L', 'hoodie-plaid-sleeve-upper-R',
		'hoodie-plaid-sleeve-fore-L', 'hoodie-plaid-sleeve-fore-R',
	],
	'maid-body': ['maid-torso'],
	'maid-sleeve': [
		'maid-sleeve-upper-L', 'maid-sleeve-upper-R',
		'maid-sleeve-fore-L', 'maid-sleeve-fore-R',
	],
	'sailor-body': ['sailor-plaid-torso'],
	'sailor-sleeve': ['sailor-plaid-sleeve-upper-L', 'sailor-plaid-sleeve-upper-R'],
};

/**
 * 旧 DIY pack 的 outfit 引用迁移：缺失的 v2.1 base id 按迁移表映射到 v2.2 现有部件；
 * 目标部件不存在则安全置空并记 unmapped（不抛错、不改 pack 原对象）。
 *
 * @param {Record<string, any>} outfits
 * @param {Record<string, any>} drawableById 当前场景的 drawable 表（id → {slot}）
 * @param {string[]} [ownIds] 当前 pack 自带的 drawable id（注册前尚未进场景，需保留）
 * @param {{ category?: string }} [options] pack 品类（用于「空配对自动补齐」，如旧 dress/outfit pack 无下装）
 * @returns {{ outfits: Record<string, any>, warnings: string[], unmapped: string[] }}
 */
export function migrateDiyPackOutfits(outfits, drawableById = {}, ownIds = [], options = {}) {
	/** @type {string[]} */
	const warnings = [];
	/** @type {string[]} */
	const unmapped = [];
	/** @type {Record<string, any>} */
	const migrated = {};
	const own = new Set(ownIds);
	const push = (/** @type {Record<string, string[]>} */ target, /** @type {string} */ slot, /** @type {string} */ id) => {
		if (!Array.isArray(target[slot])) target[slot] = [];
		if (!target[slot].includes(id)) target[slot].push(id);
	};
	for (const [outfitId, outfit] of Object.entries(outfits || {})) {
		/** @type {Record<string, string[]>} */
		const next = {};
		for (const slot of OUTFIT_SLOTS) {
			for (const ref of Array.isArray(outfit && outfit[slot]) ? outfit[slot] : []) {
				if (typeof ref !== 'string' || !ref) continue;
				if ((drawableById && drawableById[ref]) || own.has(ref)) {
					push(next, slot, ref);
					continue;
				}
				const targets = LEGACY_V21_BASE_REFS[/** @type {keyof typeof LEGACY_V21_BASE_REFS} */ (ref)] || null;
				if (!targets) {
					unmapped.push(`${outfitId}.${slot}:${ref}`);
					continue;
				}
				let mapped = 0;
				for (const target of targets) {
					const drawable = drawableById ? drawableById[target] : null;
					if (!drawable) continue;
					const targetSlot = OUTFIT_SLOTS.includes(drawable.slot) ? drawable.slot : slot;
					push(next, targetSlot, target);
					mapped += 1;
				}
				if (mapped > 0) warnings.push(`migrated:${ref}→${mapped}`);
				else unmapped.push(`${outfitId}.${slot}:${ref}@missing-target`);
			}
		}
		// 旧 pack 的 pairing 可能整体为空（v2.1 dress/outfit 本来不带下装；bottom 可缺上衣）：
		// 按品类自动补一套 v2.2 配对部件（存在才补），避免「光腿/裸上身」。
		const category = String(options.category || '');
		if (category === 'bottom') {
			if (!(next.topBody || []).length && drawableById && drawableById['hoodie-plaid-torso']) {
				push(next, 'topBody', 'hoodie-plaid-torso');
				for (const id of ['hoodie-plaid-sleeve-upper-L', 'hoodie-plaid-sleeve-upper-R']) if (drawableById[id]) push(next, 'sleeveUpper', id);
				for (const id of ['hoodie-plaid-sleeve-fore-L', 'hoodie-plaid-sleeve-fore-R']) if (drawableById[id]) push(next, 'sleeveFore', id);
				warnings.push('migrated:auto-pair-top');
			}
		} else if (['top', 'coat', 'dress', 'outfit'].includes(category)) {
			if (!(next.bottom || []).length && drawableById) {
				const skirts = ['hoodie-plaid-skirt', 'hoodie-plaid-skirt-under'].filter((id) => drawableById[id]);
				if (skirts.length) {
					for (const id of skirts) push(next, 'bottom', id);
					warnings.push('migrated:auto-pair-bottom');
				}
			}
		}
		migrated[outfitId] = next;
	}
	return { outfits: migrated, warnings, unmapped };
}

/**
 * 把一个已校验的 DIY pack 注册进场景数据结构（不涉及 GL；runtime 在上传 VAO/纹理后调用）。
 *
 * @param {any} scene
 * @param {string} packId
 * @param {ReturnType<typeof normalizeDiyPack>} normalized
 * @returns {{ ok: boolean, code?: string, entry?: any }}
 */
export function registerDiyPack(scene, packId, normalized) {
	if (!scene || !normalized || !normalized.ok) return { ok: false, code: 'pack_invalid' };
	if (!scene.diyPacks) scene.diyPacks = new Map();
	if (scene.diyPacks.has(packId)) return { ok: false, code: 'pack_exists' };
	for (const drawable of normalized.drawables) {
		if (scene.drawableById[drawable.id]) return { ok: false, code: `drawable_id_conflict:${drawable.id}` };
	}
	for (const drawable of normalized.drawables) {
		scene.drawables.push(drawable);
		scene.drawableById[drawable.id] = drawable;
	}
	if (!scene.outfits) scene.outfits = {};
	const outfitIds = [];
	for (const [outfitId, outfit] of Object.entries(normalized.outfits)) {
		scene.outfits[outfitId] = outfit;
		outfitIds.push(outfitId);
	}
	const entry = {
		packId,
		drawableIds: normalized.drawables.map((drawable) => drawable.id),
		drawables: normalized.drawables,
		outfitIds,
		textures: normalized.textures,
	};
	scene.diyPacks.set(packId, entry);
	return { ok: true, entry };
}

/**
 * 从场景数据结构中移除一个 DIY pack（不涉及 GL；runtime 负责释放 VAO/纹理）。
 * @param {any} scene
 * @param {string} packId
 * @returns {{ ok: boolean, code?: string, entry?: any }}
 */
export function unregisterDiyPack(scene, packId) {
	const entry = scene && scene.diyPacks ? scene.diyPacks.get(packId) : null;
	if (!entry) return { ok: false, code: 'pack_not_found' };
	scene.diyPacks.delete(packId);
	const ids = new Set(entry.drawableIds);
	scene.drawables = scene.drawables.filter((drawable) => !ids.has(drawable.id));
	for (const id of entry.drawableIds) delete scene.drawableById[id];
	for (const outfitId of entry.outfitIds) delete scene.outfits[outfitId];
	return { ok: true, entry };
}
