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
		sweater: { slot: 'topBody', body: 'sweater-body', sleeve: 'sweater-sleeve' },
		hoodie: { slot: 'topBody', body: 'hoodie-body', sleeve: 'hoodie-sleeve' },
		sailor: { slot: 'topUnder', body: 'sailor-body', sleeve: 'sailor-sleeve' },
	},
	bottom: {
		plaid: { slot: 'bottom', body: 'bottom-plaid' },
		pleated: { slot: 'bottom', body: 'bottom-pleated' },
	},
};

/**
 * 把换装页状态解析成 2.5D 组合：套装优先；否则「上衣 + 下装」动态组合；
 * 缺件时按「同槽位最近可用 → rig 默认套装」回退，并把原因记进 warnings。
 *
 * @param {any} rig 2.5D rig JSON
 * @param {{ outfit?: string, top?: string, bottom?: string }} state 换装页状态子集
 * @returns {{
 *   slots: { topUnder: string[], bottom: string[], topBody: string[], sleeve: string[] },
 *   outfit: string|null, label: string, fallback: string|null, warnings: string[],
 * }}
 */
export function resolveLook(rig, state = {}) {
	const available = drawableIdsOf(rig);
	const outfits = (rig && rig.outfits) || {};
	/** @type {{ topUnder: string[], bottom: string[], topBody: string[], sleeve: string[] }} */
	const slots = { topUnder: [], bottom: [], topBody: [], sleeve: [] };
	const warnings = [];
	const outfitId = typeof state.outfit === 'string' ? state.outfit : '';

	// 1) 套装命中（M3 页面只有 maid；M4/M6 若扩展套装也走这里）
	if (outfitId && outfitId !== 'none' && outfits[outfitId]) {
		const outfit = outfits[outfitId];
		for (const slot of /** @type {const} */ (['topUnder', 'bottom', 'topBody', 'sleeve'])) {
			for (const id of outfit[slot] || []) if (available.has(id)) slots[slot].push(id);
		}
		return { slots, outfit: outfitId, label: outfit.name || outfitId, fallback: null, warnings };
	}

	// 2) 上衣 + 下装动态组合
	let top = typeof state.top === 'string' ? state.top : '';
	let bottom = typeof state.bottom === 'string' ? state.bottom : '';
	const topDef = GARMENTS.top[/** @type {keyof typeof GARMENTS.top} */ (top)] || null;
	const bottomDef = GARMENTS.bottom[/** @type {keyof typeof GARMENTS.bottom} */ (bottom)] || null;
	let missing = false;
	if (!topDef || !available.has(topDef.body)) {
		missing = true;
		// 缺件回退：优先同身形可用的毛衣（POC 素材最完整），否则 rig 默认套装
		if (available.has('sweater-body') && top !== 'sweater') {
			top = 'sweater';
			warnings.push(`top:${state.top || '?'}→sweater`);
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
			for (const slot of /** @type {const} */ (['topUnder', 'bottom', 'topBody', 'sleeve'])) {
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
	return /** @type {Record<string, string>} */ ({ sweater: '白毛衣', hoodie: '白卫衣', sailor: '水手服' })[id] || id;
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
 * @param {{ slots: { topUnder: string[], bottom: string[], topBody: string[], sleeve: string[] } }} look
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
	for (const slot of ['hairBack', 'strands', 'body', 'arms', 'hair', 'hairFront']) {
		for (const id of slots[slot] || []) add(id);
	}
	for (const slot of /** @type {const} */ (['topUnder', 'bottom', 'topBody', 'sleeve'])) {
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

