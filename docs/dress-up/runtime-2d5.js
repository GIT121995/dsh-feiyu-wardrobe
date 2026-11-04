/**
 * 大肥鱼衣橱 · 2.5D runtime（自研 WebGL2，无第三方运行时）· M3 产品化版
 *
 * 来源：`.scratch/m2-full/poc/c-poc.js`（M2-full POC，服务器侧 gate 全绿）。
 * 产品化改动（相对 POC）：
 *   - ES 模块 + 工厂函数 `createRuntime2D5()`，无全局状态、无 URL 解析、无 DOM id 依赖；
 *   - 资产按需加载：`setShape(shape)` 才 fetch `art/2d5/<shape>/rig.json` + 图集（未开启零请求）；
 *   - 每身形 1–2 张 lossless WebP 图集（`tools/build_2d5.py` 构建；v2.2 cutout 支持多图集，
 *     每 drawable 用 `atlas` 指定归属；旧单图集 rig 向后兼容）；
 *   - 全部纯逻辑（换装组合/可视列表/参数/固定步长/face 状态机）走 runtime-2d5-core.js（node 单测覆盖）；
 *   - 对外 API：setShape / setLook / addOutfitPack / removeOutfitPack / getOutfitPacks / setParams /
 *     setHeadFollow / triggerBlink / triggerSmile /
 *     setTalking / tap / setQuality / setDPR / setPhysicsHz / setMaskPass / setMipmaps /
 *     freeze / step / advance / renderFrame / renderToCanvas / toDataURL / getMemory / getState /
 *     destroy；固定 60Hz 物理步进 + 降级开关 + 按需加载/释放（复用 POC 逻辑）。
 *
 * 渲染约定：逻辑画布 675×1200（9:16，与 DOM 分层素材同坐标），透明底，
 * 页面背景/特效仍在 DOM 层（CSS），canvas 只画角色。
 *
 * 注意：FPS/内存数字在服务器 headless（SwiftShader 无 GPU）下不可代表真机。
 *
 * @module dsh-feiyu-wardrobe/runtime-2d5
 */

import {
	BASE_CANVAS,
	DPR_LIMITS,
	PHYSICS,
	accumulateTicks,
	clampPhysicsHz,
	clampParams,
	desiredEyeKey,
	desiredMouthKey,
	DIY_PACK_FORMAT,
	DIY_PACK_FORMAT_VERSION,
	faceStateKeys,
	headFollowParams,
	normalizeAtlases,
	migrateDiyPackOutfits,
	normalizeDiyPack,
	registerDiyPack,
	resolveDrawableAtlas,
	resolveLook,
	resolveQuality,
	summarizeInitialPayload,
	CUTOUT_SLOTS,
	LEGACY_OUTFIT_SLOTS,
	unregisterDiyPack,
	visibleDrawables,
} from './runtime-2d5-core.js?v=19';

/** 单个 spring 链节点相对 rest 的最大偏移（px，安全包络，POC 同值）。 */
const CHAIN_OFFSET_LIMIT = 42;
/** 换装/切身形过渡的最小保险时间（app 侧用 CSS 过渡，这里只给建议值）。 */
export const TRANSITION_MS = 260;
/** tap 预留脉冲时长（秒）。M5 互动在此基础上扩展。 */
const TAP_DURATION = 0.45;

/* ---------------------------------------------------------------- shaders -- */

const MAX_BONES = 64;

const VERT = `#version 300 es
precision highp float;
layout(location=0) in vec2 aPos;
layout(location=1) in vec2 aUV;
layout(location=2) in vec4 aBone;
layout(location=3) in vec4 aBoneW;
layout(location=4) in vec2 aDeform;
uniform vec4 uB0[${MAX_BONES}];
uniform vec4 uB1[${MAX_BONES}];
uniform vec4 uCam;
uniform vec4 uHeadCfg;
uniform vec4 uPitchCfg;
uniform vec4 uBreathCfg;
uniform vec3 uWarp;
out vec2 vUV;
void main() {
  vec3 p = vec3(aPos, 1.0);
  vec3 s = vec3(0.0);
  for (int i = 0; i < 4; i++) {
    int bi = int(aBone[i] + 0.5);
    vec4 r0 = uB0[bi];
    vec4 r1 = uB1[bi];
    float w = aBoneW[i];
    s.x += w * (r0.x * p.x + r0.y * p.y + r0.z);
    s.y += w * (r1.x * p.x + r1.y * p.y + r1.z);
  }
  float headW = aDeform.x;
  float chestW = aDeform.y;
  float yaw = uWarp.x, pitch = uWarp.y, breath = uWarp.z;
  s.x = uHeadCfg.x + (s.x - uHeadCfg.x) * (1.0 - uHeadCfg.w * abs(yaw) * headW)
        + uHeadCfg.z * yaw * headW;
  s.y += 0.10 * abs(yaw) * headW;
  s.y += uPitchCfg.x * pitch * headW;
  s.x = uBreathCfg.x + (s.x - uBreathCfg.x) * (1.0 + uBreathCfg.y * breath * chestW);
  s.y -= uBreathCfg.z * breath * chestW;
  vec2 c = vec2((s.x - uCam.x) / uCam.z * 2.0 - 1.0,
                1.0 - 2.0 * (s.y - uCam.y) / uCam.w);
  gl_Position = vec4(c, 0.0, 1.0);
  vUV = aUV;
}`;

const FRAG = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uTex;
uniform sampler2D uMask;
uniform int uUseMask;
uniform int uSolid;
uniform vec2 uViewport;
out vec4 outColor;
void main() {
  vec4 c = texture(uTex, vUV);
  if (c.a < 0.004) discard;
  if (uSolid == 1) { outColor = vec4(c.a); return; }
  if (uUseMask == 1) {
    vec2 muv = gl_FragCoord.xy / uViewport;
    float m = texture(uMask, muv).a;
    c.a *= smoothstep(0.05, 0.55, m);
    if (c.a < 0.004) discard;
  }
  outColor = vec4(c.rgb * c.a, c.a);
}`;

/* ----------------------------------------------------------------- utils --- */

/** @param {number} value @param {number} min @param {number} max */
function clamp(value, min, max) {
	return value < min ? min : value > max ? max : value;
}

/**
 * @param {WebGL2RenderingContext} gl
 * @param {string} vertexSource
 * @param {string} fragmentSource
 */
function compile(gl, vertexSource, fragmentSource) {
	const program = gl.createProgram();
	for (const [type, source] of [[gl.VERTEX_SHADER, vertexSource], [gl.FRAGMENT_SHADER, fragmentSource]]) {
		const shader = gl.createShader(type);
		if (!shader) throw new Error('shader 创建失败');
		gl.shaderSource(shader, source);
		gl.compileShader(shader);
		if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
			const log = gl.getShaderInfoLog(shader);
			gl.deleteShader(shader);
			throw new Error(`shader 编译失败：${log || 'unknown'}`);
		}
		gl.attachShader(program, shader);
	}
	gl.linkProgram(program);
	if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
		throw new Error(`program 链接失败：${gl.getProgramInfoLog(program) || 'unknown'}`);
	}
	return program;
}

/**
 * @param {WebGL2RenderingContext} gl
 * @param {number} width
 * @param {number} height
 */
function makeMaskFBO(gl, width, height) {
	const tex = gl.createTexture();
	gl.bindTexture(gl.TEXTURE_2D, tex);
	gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
	const fbo = gl.createFramebuffer();
	gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
	gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
	gl.bindFramebuffer(gl.FRAMEBUFFER, null);
	return { tex, fbo, w: width, h: height };
}

/* ------------------------------------------------------------ runtime init -- */

/**
 * 创建 2.5D runtime（只初始化 GL；资产在 setShape 时按需加载）。
 *
 * @param {{
 *   canvas: HTMLCanvasElement,
 *   assetRoot?: string,
 *   assetVersion?: string,
 *   quality?: string,
 *   dpr?: number,
 *   physicsHz?: number,
 *   maskPass?: boolean,
 *   mipmaps?: boolean,
 *   device?: { deviceMemory?: number|null, hardwareConcurrency?: number|null },
 *   maxDpr?: number,
 *   onContextLost?: (info: { reason: string }) => void,
 * }} options
 * @returns {Promise<ReturnType<typeof buildApi>>}
 */
export async function createRuntime2D5(options) {
	const canvas = options && options.canvas;
	if (!canvas) throw new Error('createRuntime2D5 需要 canvas');
	const gl = canvas.getContext('webgl2', {
		alpha: true,
		antialias: false,
		premultipliedAlpha: true,
		preserveDrawingBuffer: false,
		powerPreference: 'high-performance',
	});
	if (!gl) throw new Error('WebGL2 不可用');

	const settings = resolveQuality(options.quality, {
		dpr: options.dpr,
		physicsHz: options.physicsHz,
		maskPass: options.maskPass,
		mipmaps: options.mipmaps,
	}, options.device || {});
	const maxDpr = Number.isFinite(options.maxDpr) ? Number(options.maxDpr) : DPR_LIMITS.max;

	/** @type {any} */
	const rt = {
		gl,
		canvas,
		prog: null,
		u: {},
		assetRoot: typeof options.assetRoot === 'string' && options.assetRoot ? options.assetRoot.replace(/\/?$/, '/') : 'art/2d5/',
		assetVersion: typeof options.assetVersion === 'string' && options.assetVersion ? options.assetVersion : '',
		device: options.device || {},
		baseW: BASE_CANVAS.width,
		baseH: BASE_CANVAS.height,
		camera: { x: 0, y: 0, w: BASE_CANVAS.width, h: BASE_CANVAS.height },
		viewW: BASE_CANVAS.width,
		viewH: BASE_CANVAS.height,
		dpr: clamp(Number(settings.dpr) || 1.5, DPR_LIMITS.min, maxDpr),
		quality: settings.quality,
		physicsHz: settings.physicsHz,
		maskPass: settings.maskPass,
		mipmaps: settings.mipmaps,
		maxSubsteps: PHYSICS.maxSubsteps,
		dtCap: PHYSICS.dtCapMs / 1000,
		physAcc: 0,
		tickCount: 0,
		droppedTicks: 0,
		time: 0,
		paused: false,
		frozen: false,
		raf: 0,
		lastNow: 0,
		fps: 0,
		frames: 0,
		fpsT0: 0,
		mode: 'anim',
		params: clampParams(),
		follow: { headX: 0, headY: 0, headZ: 0, targetY: 0, targetX: 0, active: false },
		blinkT: 0,
		smileT: 0,
		talkT: 0,
		talking: false,
		nextBlink: 2.5,
		auto: true,
		eyeKey: 'open',
		mouthKey: 'closed',
		faceOverride: { eye: null, mouth: null },
		collision: true,
		collStress: 1,
		collStats: { preNodes: 0, preDepth: 0, preMax: 0, postNodes: 0, postDepth: 0, postMax: 0 },
		collPeak: { preNodes: 0, preDepth: 0, preMax: 0, postNodes: 0, postDepth: 0, postMax: 0 },
		scenes: new Map(),
		loading: new Map(),
		shape: '',
		requestedShape: '',
		scene: null,
		bones: [],
		boneIndex: {},
		M: [],
		S: [],
		chainByBone: {},
		chains: [],
		drawableById: {},
		headCfg: null,
		headPivot: null,
		pitchCfg: null,
		breathCfg: null,
		breathPivot: null,
		look: { slots: { topUnder: [], bottom: [], topBody: [], sleeve: [] }, outfit: null, label: '', fallback: null, warnings: [] },
		active: [],
		activeIds: [],
		stats: { draws: 0, tris: 0, maskPasses: 0, verts: 0, texBytes: 0, vboBytes: 0 },
		art: null,
		mask: null,
		glRes: { textures: 0, vbos: 0 },
		loadMs: {},
		releaseMs: {},
		shapeSwitches: 0,
		chainSnaps: {},
		assetInfo: {},
		contextLost: false,
		destroyed: false,
		maxDpr: maxDpr,
		onContextLost: typeof options.onContextLost === 'function' ? options.onContextLost : null,
		tapT: 0,
		breathNow: 0,
	};

	rt.prog = compile(gl, VERT, FRAG);
	for (const name of ['uB0', 'uB1', 'uCam', 'uHeadCfg', 'uPitchCfg', 'uBreathCfg', 'uWarp', 'uTex', 'uMask', 'uUseMask', 'uSolid', 'uViewport']) {
		rt.u[name] = gl.getUniformLocation(rt.prog, name);
	}
	if (!rt.mask) rt.mask = makeMaskFBO(gl, Math.round(rt.baseW * rt.dpr), Math.round(rt.baseH * rt.dpr));
	resizeCanvas(rt);

	gl.disable(gl.DEPTH_TEST);
	gl.disable(gl.CULL_FACE);
	gl.enable(gl.BLEND);
	gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

	canvas.addEventListener('webglcontextlost', (event) => {
		event.preventDefault();
		rt.contextLost = true;
		stop(rt);
		if (rt.onContextLost) rt.onContextLost({ reason: 'webglcontextlost' });
	}, false);

	return buildApi(rt);
}

/**
 * 公开 API（挂在闭包上，方法见各自注释）。
 * @param {any} rt
 */
function buildApi(rt) {
	const api = {
		/** runtime 版本/画布约定。 */
		get info() {
			return {
				version: 1,
				canvas: { width: rt.baseW, height: rt.baseH },
				quality: rt.quality,
				assetRoot: rt.assetRoot,
			};
		},

		/**
		 * 按需加载并切换身形（先加载目标 → 激活 → 释放旧身形；参数/时间/物理链状态保留）。
		 * @param {string} shape
		 * @returns {Promise<{ shape: string, loaded: boolean, loadMs: number, switchMs: number }>}
		 */
		async setShape(shape) {
			if (rt.destroyed) throw new Error('runtime 已销毁');
			const target = typeof shape === 'string' ? shape : 'chibi';
			rt.requestedShape = target;
			const t0 = performance.now();
			const loadedBefore = rt.scenes.has(target);
			if (!loadedBefore) await loadScene(rt, target);
			// 并发切身形：加载期间又切到别的身形 → 本次结果作废（不激活/不释放，避免来回抖动）
			if (rt.requestedShape !== target) {
				return { shape: target, loaded: !loadedBefore, loadMs: rt.loadMs[target] || 0, switchMs: performance.now() - t0, stale: true };
			}
			const prev = rt.shape;
			if (!activateScene(rt, target)) throw new Error(`activateScene 失败：${target}`);
			if (prev && prev !== target) {
				releaseScene(rt, prev);
				rt.shapeSwitches += 1;
			}
			const loadMs = rt.loadMs[target] || 0;
			const switchMs = performance.now() - t0;
			if (prev && prev !== target) rt.loadMs[`switch_${target}`] = switchMs;
			return { shape: target, loaded: !loadedBefore, loadMs, switchMs };
		},

		/**
		 * 设置当前造型：套装优先，否则上衣+下装动态组合（缺件回退见 core.resolveLook）。
		 * @param {{ outfit?: string, top?: string, bottom?: string, bare?: boolean }} state
		 * @returns {{ slots: any, outfit: string|null, label: string, fallback: string|null, warnings: string[] }}
		 */
		setLook(state) {
			rt.lastLookState = state || {};
			if (!rt.scene) return rt.look;
			rt.look = resolveLook(rt.scene, rt.lastLookState);
			buildActive(rt);
			return rt.look;
		},

		/** @returns {any} 当前造型解析结果（label/fallback/warnings）。 */
		getLook() {
			return rt.look;
		},

		/** 当前可用服装/套装 id（UI 能力探测用）。 */
		getOutfits() {
			return Object.keys((rt.scene && rt.scene.outfits) || {});
		},

		/**
		 * 动态叠加一个 DIY 增量 outfit pack（S3；格式见 docs/dress-up/DIY-PACK.md）。
		 * 不重载 base rig/图集；参数/物理/时间/当前造型状态保持不变（随后按 lastLookState 重算 look）。
		 * @param {{ pack: any, packId?: string, assetBase?: string, textures?: Record<string, HTMLImageElement> }} options
		 * @returns {Promise<{ ok: boolean, packId: string, reused?: boolean, drawableIds?: string[], outfits?: string[], textures?: number, textureBytes?: number, memory?: any }>}
		 */
		async addOutfitPack(options = {}) {
			if (rt.destroyed) throw new Error('runtime 已销毁');
			const scene = rt.scene;
			if (!scene) throw new Error('先 setShape 再 addOutfitPack');
			const pack = options.pack;
			const packId = String(options.packId || (pack && pack.item) || '');
			const normalized = normalizeDiyPack(pack, { bones: scene.skeleton.bones.length, shape: rt.shape });
			if (!normalized.ok || !packId) {
				const error = new Error(`DIY pack 校验失败：${normalized.errors.join(',') || 'packId_missing'}`);
				error.code = 'pack_invalid';
				error.errors = normalized.errors;
				throw error;
			}
			if (scene.diyPacks && scene.diyPacks.has(packId)) {
				return { ok: true, packId, reused: true, memory: memoryInfo(rt) };
			}
			// v2.2 cutout 兼容：旧 pack 的 v2.1 base 引用按槽位迁移到 v2.2 现有部件（不污染 pack 原对象）
			const migration = migrateDiyPackOutfits(
				normalized.outfits,
				scene.drawableById,
				normalized.drawables.map((drawable) => drawable.id),
				{ category: pack && pack.category ? String(pack.category) : '' },
			);
			const normalizedForRegister = { ...normalized, outfits: migration.outfits };
			const assetBase = typeof options.assetBase === 'string' && options.assetBase
				? options.assetBase.replace(/\/?$/, '/')
				: '';
			const provided = options.textures || null;
			const gl = rt.gl;
			const stats = { texBytes: 0, vboBytes: 0, verts: 0, tris: 0 };
			try {
				for (const drawable of normalized.drawables) {
					uploadDrawable(rt, drawable);
					const key = drawable.texture;
					let image = provided && provided[key] ? provided[key] : null;
					if (!image) {
						if (!assetBase) throw new Error(`缺少纹理 ${key}（需要 assetBase 或 textures）`);
						image = await loadImage(`${assetBase}${key}`);
					}
					drawable.image = image;
					drawable.tex = textureFromImage(rt, image);
					drawable.diy = true;
					drawable.packId = packId;
					stats.texBytes += image.naturalWidth * image.naturalHeight * 4;
					stats.vboBytes += drawable.vboBytes || 0;
					stats.verts += drawable.verts || 0;
					stats.tris += drawable.tris || 0;
				}
				const registered = registerDiyPack(scene, packId, normalizedForRegister);
				if (!registered.ok) throw new Error(`DIY pack 注册失败：${registered.code}`);
				scene.stats.texBytes += stats.texBytes;
				scene.stats.vboBytes += stats.vboBytes;
				scene.stats.verts += stats.verts;
				scene.stats.tris += stats.tris;
				rt.look = resolveLook(scene, rt.lastLookState || {});
				buildActive(rt);
				return {
					ok: true, packId, reused: false,
					drawableIds: normalized.drawables.map((drawable) => drawable.id),
					outfits: Object.keys(normalized.outfits),
					textures: normalized.drawables.length,
					textureBytes: stats.texBytes,
					memory: memoryInfo(rt),
					migration: {
						warnings: migration.warnings,
						unmapped: migration.unmapped,
						migrated: migration.warnings.length > 0 || migration.unmapped.length > 0,
					},
				};
			} catch (error) {
				for (const drawable of normalized.drawables) {
					if (drawable.vao) gl.deleteVertexArray(drawable.vao);
					if (drawable.vbo) gl.deleteBuffer(drawable.vbo);
					if (drawable.ibo) gl.deleteBuffer(drawable.ibo);
					if (drawable.tex) deleteTexture(rt, drawable.tex);
					if (drawable.vbo) rt.glRes.vbos = Math.max(0, rt.glRes.vbos - 2);
				}
				throw error;
			}
		},

		/**
		 * 移除一个动态 DIY pack：释放其 VAO/VBO/纹理，删除 outfit；若当前正在穿它则回退到可用造型。
		 * @param {string} packId
		 * @returns {{ ok: boolean, packId?: string, code?: string, removedDrawables?: number, memory?: any }}
		 */
		removeOutfitPack(packId) {
			const scene = rt.scene;
			const id = String(packId || '');
			if (!scene || !scene.diyPacks) return { ok: false, code: 'pack_not_found' };
			const result = unregisterDiyPack(scene, id);
			if (!result.ok) return result;
			const gl = rt.gl;
			for (const drawable of result.entry.drawables) {
				if (drawable.vao) gl.deleteVertexArray(drawable.vao);
				if (drawable.vbo) gl.deleteBuffer(drawable.vbo);
				if (drawable.ibo) gl.deleteBuffer(drawable.ibo);
				if (drawable.tex) deleteTexture(rt, drawable.tex);
				if (drawable.vbo) rt.glRes.vbos = Math.max(0, rt.glRes.vbos - 2);
				scene.stats.texBytes -= drawable.image ? drawable.image.naturalWidth * drawable.image.naturalHeight * 4 : 0;
				scene.stats.vboBytes -= drawable.vboBytes || 0;
				scene.stats.verts -= drawable.verts || 0;
				scene.stats.tris -= drawable.tris || 0;
				drawable.vao = null;
				drawable.vbo = null;
				drawable.ibo = null;
				drawable.tex = null;
			}
			rt.look = resolveLook(scene, rt.lastLookState || {});
			buildActive(rt);
			return {
				ok: true, packId: id,
				removedDrawables: result.entry.drawableIds.length,
				memory: memoryInfo(rt),
			};
		},

		/** 已加载的动态 DIY pack 摘要（页面/E2E 用）。 */
		getOutfitPacks() {
			const scene = rt.scene;
			if (!scene || !scene.diyPacks) return [];
			return [...scene.diyPacks.entries()].map(([packId, entry]) => ({
				packId,
				drawableIds: entry.drawableIds.slice(),
				outfits: entry.outfitIds.slice(),
			}));
		},

		/**
		 * 参数总线（M5 互动接口）：未知键忽略、越界钳制。
		 * @param {Record<string, number>} partial
		 */
		setParams(partial) {
			rt.params = clampParams(rt.params, partial || {});
			syncFace(rt, true);
			return rt.params;
		},

		/** @returns {Record<string, number>} */
		getParams() {
			return { ...rt.params };
		},

		/**
		 * head follow：传入画布归一化位置（-1..1，null=回正），内部阻尼跟随。
		 * @param {number|null} nx
		 * @param {number|null} ny
		 */
		setHeadFollow(nx, ny) {
			const target = headFollowParams(nx, ny);
			rt.follow.targetY = target.headY;
			rt.follow.targetX = target.headX;
			rt.follow.active = Number.isFinite(nx) && Number.isFinite(ny);
		},

		/** 眨眼（QA/互动手动触发）。 */
		triggerBlink() {
			rt.blinkT = 0.14;
			syncFace(rt, true);
		},

		/** 笑眼（互动手动触发）。 */
		triggerSmile(duration = 1.8) {
			rt.smileT = Math.max(0.2, Number(duration) || 1.8);
			syncFace(rt, true);
		},

		/** 口型：气泡显示期间设为 true，气泡隐藏设 false（M5 说话/喂食也走这里）。 */
		setTalking(on) {
			rt.talking = !!on;
			if (!rt.talking) rt.talkT = 0;
			syncFace(rt, true);
		},

		/** QA/E2E：强制脸态（eye/mouth 为 null 时清除），便于确定性截图。 */
		setFaceOverride(overrides = {}) {
			rt.faceOverride = {
				eye: typeof overrides.eye === 'string' ? overrides.eye : null,
				mouth: typeof overrides.mouth === 'string' ? overrides.mouth : null,
			};
			syncFace(rt, true);
			return { ...rt.faceOverride };
		},

		/** QA/E2E：清除脸态覆盖。 */
		clearFaceOverride() {
			rt.faceOverride = { eye: null, mouth: null };
			syncFace(rt, true);
		},

		/** 定时口型（自动结束），用于一次性台词。 */
		triggerTalk(duration = 1.2) {
			rt.talkT = Math.max(0.1, Number(duration) || 1.2);
			syncFace(rt, true);
		},

		/** 触摸 tap 预留（M5 互动）：轻点头 + 笑眼 + 眨眼一次（不改变穿搭状态）。 */
		tap() {
			rt.tapT = TAP_DURATION;
			rt.smileT = Math.max(rt.smileT, 0.9);
			rt.blinkT = 0.14;
			syncFace(rt, true);
		},

		/** 画质档（high/medium/low/auto）与单项覆盖；切换 mipmap 会重传图集。 */
		setQuality(quality) {
			const preset = resolveQuality(quality, {}, rt.device);
			applyQuality(rt, preset);
			reuploadTextures(rt);
			resizeCanvas(rt);
			return getQuality(rt);
		},

		getQuality() {
			return getQuality(rt);
		},

		/** @param {number} value */
		setDPR(value) {
			rt.dpr = clamp(Number(value) || 1, DPR_LIMITS.min, rt.maxDpr);
			resizeCanvas(rt);
			return rt.dpr;
		},

		/** @param {number} hz 15–120 */
		setPhysicsHz(hz) {
			rt.physicsHz = clampPhysicsHz(hz);
			rt.physAcc = 0;
			return rt.physicsHz;
		},

		/** @param {boolean} on */
		setMaskPass(on) {
			rt.maskPass = !!on;
			return rt.maskPass;
		},

		/** @param {boolean} on */
		setMipmaps(on) {
			rt.mipmaps = !!on;
			reuploadTextures(rt);
			return rt.mipmaps;
		},

		/** @param {number} ms 固定步长单帧墙钟上限（16–500ms） */
		setFixedStepCap(ms) {
			rt.dtCap = clamp(Number(ms) / 1000 || 0.1, 0.016, 0.5);
			return rt.dtCap * 1000;
		},

		/**
		 * 静态对比模式（QA 用）：物理链固定在 rest、时间不推进，用于与 POC/DOM 静态帧对齐。
		 * @param {boolean} on
		 */
		setStatic(on) {
			rt.mode = on ? 'static' : 'anim';
			if (rt.mode === 'static') resetPhysics(rt);
			rt.physAcc = 0;
			return rt.mode;
		},

		/**
		 * 自动动画开关（随机眨眼等；QA 确定性截图可关）。
		 * @param {boolean} on
		 */
		setAuto(on) {
			rt.auto = !!on;
			rt.nextBlink = rt.auto ? 2.2 + Math.random() * 2.8 : Number.POSITIVE_INFINITY;
			return rt.auto;
		},

		/** 启动 rAF 渲染循环。 */
		start() {
			if (rt.destroyed || rt.raf || rt.frozen) return;
			rt.lastNow = performance.now();
			rt.fpsT0 = rt.lastNow;
			rt.frames = 0;
			const loop = (now) => {
				if (rt.destroyed || rt.paused) { rt.raf = 0; return; }
				rt.raf = requestAnimationFrame(loop);
				const dt = Math.min(rt.dtCap, (now - rt.lastNow) / 1000 || 1 / 60);
				rt.lastNow = now;
				if (!rt.frozen) {
					advanceWall(rt, dt);
					render(rt);
				}
				rt.frames += 1;
				if (now - rt.fpsT0 >= 500) {
					rt.fps = (rt.frames * 1000) / (now - rt.fpsT0);
					rt.frames = 0;
					rt.fpsT0 = now;
				}
			};
			rt.raf = requestAnimationFrame(loop);
		},

		/** 暂停（保留 GL 资源，可再 start）。 */
		stop() {
			stop(rt);
		},

		/** 页面隐藏时暂停渲染（省电）。 */
		setPaused(paused) {
			rt.paused = !!paused;
			if (rt.paused) stop(rt);
			else if (!rt.frozen) api.start();
		},

		/**
		 * 冻结时间推进（QA/E2E 截图确定性）：冻结后只能 step/advance/renderFrame。
		 * @param {boolean} frozen
		 */
		freeze(frozen) {
			rt.frozen = !!frozen;
			if (rt.frozen) stop(rt);
			else if (!rt.paused) api.start();
		},

		/**
		 * 确定性步进（固定步长累加器 + 渲染一帧）。
		 * @param {number} [dt] 墙钟秒
		 * @returns {number} 本步物理 tick 数
		 */
		step(dt = 1 / 60) {
			const ticks = advanceWall(rt, dt);
			render(rt);
			return ticks;
		},

		/**
		 * 快进 n 帧（每帧墙钟 dt），只渲染最后一次。
		 * @param {number} [n]
		 * @param {number} [dt]
		 */
		advance(n = 60, dt = 1 / 60) {
			const frames = Math.max(0, Math.round(n));
			for (let i = 0; i < frames; i += 1) advanceWall(rt, dt);
			render(rt);
			return rt.tickCount;
		},

		/** 按当前状态渲染一帧（不推进时间）。 */
		renderFrame() {
			render(rt);
		},

		/**
		 * 把当前帧画到外部 2D canvas（立绘卡合成）：调用前会 render 一帧。
		 * @param {CanvasRenderingContext2D} ctx2d
		 * @param {number} dx
		 * @param {number} dy
		 * @param {number} dw
		 * @param {number} dh
		 */
		renderToCanvas(ctx2d, dx, dy, dw, dh) {
			render(rt);
			if (ctx2d && typeof ctx2d.drawImage === 'function') ctx2d.drawImage(rt.canvas, dx, dy, dw, dh);
		},

		/**
		 * 当前帧导出 data URL（透明底；悬浮鲸鱼小图用）。
		 * @param {{ width?: number, height?: number, type?: string, quality?: number }} [opts]
		 * @returns {string} dataURL；环境不支持时返回 ''
		 */
		toDataURL(opts = {}) {
			const width = Math.max(1, Math.round(Number(opts.width) || 184));
			const height = Math.max(1, Math.round(Number(opts.height) || 328));
			try {
				const target = document.createElement('canvas');
				target.width = width;
				target.height = height;
				const ctx = target.getContext('2d');
				if (!ctx) return '';
				render(rt);
				ctx.drawImage(rt.canvas, 0, 0, width, height);
				return target.toDataURL(opts.type || 'image/webp', opts.quality || 0.85);
			} catch {
				return '';
			}
		},

		/** 内存/资源统计（texBytes、VBO、按需加载耗时、切换次数）。 */
		getMemory() {
			return memoryInfo(rt);
		},

		/** 物理 tick/降级状态。 */
		getTickInfo() {
			return {
				physicsHz: rt.physicsHz,
				physAcc: rt.physAcc,
				tickCount: rt.tickCount,
				droppedTicks: rt.droppedTicks,
				maxSubsteps: rt.maxSubsteps,
				dtCapMs: rt.dtCap * 1000,
				time: rt.time,
			};
		},

		/** 首屏资产信息（rig 字节数 / 图集 URL / 图集约字节数）。 */
		getAssetInfo() {
			return { ...rt.assetInfo };
		},

		/** 运行状态快照（QA/E2E 断言用）。 */
		getState() {
			return {
				ready: !!rt.scene,
				shape: rt.shape,
				shapeName: (rt.scene && rt.scene.name) || rt.shape,
				look: { ...rt.look, slots: cloneSlots(rt.look.slots) },
				outfits: api.getOutfits(),
				diyPacks: api.getOutfitPacks(),
				time: rt.time,
				fps: rt.fps,
				eye: rt.eyeKey,
				mouth: rt.mouthKey,
				params: { ...rt.params },
				follow: { headX: rt.follow.headX, headY: rt.follow.headY, headZ: rt.follow.headZ },
				active: rt.activeIds.slice(),
				draws: rt.stats.draws,
				tris: rt.stats.tris,
				quality: getQuality(rt),
				tick: api.getTickInfo(),
				memory: memoryInfo(rt),
				art: rt.art,
				contextLost: rt.contextLost,
			};
		},

		/** 设备能力（调试/报告用）。 */
		getDevice() {
			return { ...rt.device, maxTextureSize: glMaxTextureSize(rt) };
		},

		/** 是否已加载某身形。 */
		hasShape(shape) {
			return rt.scenes.has(shape);
		},

		/** 释放全部 GL 资源并停止循环。 */
		destroy() {
			if (rt.destroyed) return;
			stop(rt);
			for (const shape of [...rt.scenes.keys()]) releaseScene(rt, shape);
			if (rt.mask) {
				rt.gl.deleteTexture(rt.mask.tex);
				rt.gl.deleteFramebuffer(rt.mask.fbo);
				rt.mask = null;
			}
			if (rt.prog) rt.gl.deleteProgram(rt.prog);
			rt.scene = null;
			rt.destroyed = true;
			const lose = rt.gl.getExtension('WEBGL_lose_context');
			if (lose && typeof lose.loseContext === 'function') lose.loseContext();
		},
	};
	return api;
}

/* ------------------------------------------------------------- GL resources -- */

/** @param {any} rt @param {HTMLImageElement} img */
function textureFromImage(rt, img) {
	const gl = rt.gl;
	const tex = gl.createTexture();
	rt.glRes.textures += 1;
	gl.bindTexture(gl.TEXTURE_2D, tex);
	gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
	gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
	if (rt.mipmaps) {
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
		gl.generateMipmap(gl.TEXTURE_2D);
	} else {
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
	}
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
	return tex;
}

/** @param {any} rt @param {WebGLTexture|null} tex */
function deleteTexture(rt, tex) {
	if (!tex) return;
	rt.gl.deleteTexture(tex);
	rt.glRes.textures = Math.max(0, rt.glRes.textures - 1);
}

/** @param {any} rt @param {any} drawable */
function uploadDrawable(rt, drawable) {
	const gl = rt.gl;
	const positions = drawable.mesh.positions;
	const vertexCount = positions.length;
	const stride = 14;
	const buffer = new Float32Array(vertexCount * stride);
	let offset = 0;
	for (let i = 0; i < vertexCount; i += 1) {
		const position = positions[i];
		const uv = drawable.mesh.uvs[i];
		const bone = drawable.mesh.bones[i];
		const weight = drawable.mesh.weights[i];
		const deform = drawable.mesh.deform[i];
		buffer[offset++] = position[0]; buffer[offset++] = position[1];
		buffer[offset++] = uv[0]; buffer[offset++] = uv[1];
		buffer[offset++] = bone[0]; buffer[offset++] = bone[1]; buffer[offset++] = bone[2]; buffer[offset++] = bone[3];
		buffer[offset++] = weight[0]; buffer[offset++] = weight[1]; buffer[offset++] = weight[2]; buffer[offset++] = weight[3];
		buffer[offset++] = deform[0]; buffer[offset++] = deform[1];
	}
	const vbo = gl.createBuffer();
	gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
	gl.bufferData(gl.ARRAY_BUFFER, buffer, gl.STATIC_DRAW);
	const ibo = gl.createBuffer();
	const vao = gl.createVertexArray();
	gl.bindVertexArray(vao);
	gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
	gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(drawable.mesh.indices), gl.STATIC_DRAW);
	gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
	const FLOAT = 4;
	gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, stride * FLOAT, 0);
	gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride * FLOAT, 2 * FLOAT);
	gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 4, gl.FLOAT, false, stride * FLOAT, 4 * FLOAT);
	gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 4, gl.FLOAT, false, stride * FLOAT, 8 * FLOAT);
	gl.enableVertexAttribArray(4); gl.vertexAttribPointer(4, 2, gl.FLOAT, false, stride * FLOAT, 12 * FLOAT);
	gl.bindVertexArray(null);
	gl.bindBuffer(gl.ARRAY_BUFFER, null);
	drawable.vao = vao;
	drawable.ibo = ibo;
	drawable.vbo = vbo;
	drawable.verts = vertexCount;
	drawable.tris = drawable.mesh.indices.length / 3;
	drawable.vboBytes = buffer.byteLength;
	rt.glRes.vbos += 2;
}

/* ------------------------------------------------------------ scene loading -- */

/**
 * 加载身形资产：rig JSON（按需 fetch）+ 单张图集纹理解码上传。
 * @param {any} rt
 * @param {string} shape
 */
async function loadScene(rt, shape) {
	if (rt.scenes.has(shape)) return rt.scenes.get(shape);
	if (rt.loading.has(shape)) return rt.loading.get(shape);
	const task = (async () => {
		const loadT0 = performance.now();
		const assetQuery = rt.assetVersion ? `?v=${encodeURIComponent(rt.assetVersion)}` : '';
		const rigUrl = `${rt.assetRoot}${shape}/rig.json${assetQuery}`;
		const response = await fetch(rigUrl);
		if (!response.ok) throw new Error(`rig 加载失败 HTTP ${response.status}：${rigUrl}`);
		const text = await response.text();
		const rig = JSON.parse(text);
		if (!rig || !Array.isArray(rig.drawables)) throw new Error(`rig 格式非法：${rigUrl}`);
		for (const drawable of rig.drawables) uploadDrawable(rt, drawable);
		// 多图集（v2.2 cutout）：rig.atlases 1–2 张；旧 rig.atlas 单张向后兼容。
		const atlasSet = normalizeAtlases(rig);
		if (!atlasSet.ok) throw new Error(`图集配置非法：${atlasSet.errors.join(',')}`);
		/** @type {Array<{ id: string, file: string, width: number, height: number, index: number, url: string, image: HTMLImageElement, texture: WebGLTexture, bytes: number }>} */
		const atlases = [];
		for (const def of atlasSet.atlases) {
			const atlasUrl = `${rt.assetRoot}${shape}/${def.file}${assetQuery}`;
			const image = await loadImage(atlasUrl);
			const width = def.width || image.naturalWidth;
			const height = def.height || image.naturalHeight;
			if (image.naturalWidth !== width || image.naturalHeight !== height) {
				throw new Error(`图集尺寸不符：${atlasUrl} ${image.naturalWidth}x${image.naturalHeight} != ${width}x${height}`);
			}
			atlases.push({
				id: def.id, file: def.file, index: def.index, url: atlasUrl, image,
				width, height, texture: textureFromImage(rt, image), bytes: width * height * 4,
			});
		}
		rig.atlases = atlases;
		rig.atlasesLegacy = atlasSet.legacy;
		rig.image = atlases[0].image;
		rig.texture = atlases[0].texture;
		rig.atlasWidth = atlases[0].width;
		rig.atlasHeight = atlases[0].height;
		for (const drawable of rig.drawables) {
			const atlasIndex = resolveDrawableAtlas(drawable, atlases);
			drawable.atlasIndex = atlasIndex;
			drawable.atlasId = atlases[atlasIndex].id;
			drawable.tex = atlases[atlasIndex].texture;
		}
		rig.texBytes = atlases.reduce((sum, atlas) => sum + atlas.bytes, 0);

		// 场景运行时结构（与 POC 同口径）
		rig.shape = shape;
		rig.drawableById = Object.fromEntries(rig.drawables.map((drawable) => [drawable.id, drawable]));
		rig.diyPacks = new Map();
		rig.file = `${shape}/rig.json`;
		rig.stats = {
			texBytes: rig.texBytes,
			verts: rig.drawables.reduce((sum, drawable) => sum + drawable.verts, 0),
			vboBytes: rig.drawables.reduce((sum, drawable) => sum + drawable.vboBytes, 0),
			tris: rig.drawables.reduce((sum, drawable) => sum + drawable.tris, 0),
		};
		rig.bones = rig.skeleton.bones.map((bone, index) => ({ ...bone, index }));
		rig.boneIndex = Object.fromEntries(rig.bones.map((bone) => [bone.id, bone.index]));
		rig.M = rig.bones.map(() => null);
		rig.S = rig.bones.map(() => new Float32Array(8));
		rig.chainByBone = {};
		for (const physics of rig.physics) {
			for (const boneId of physics.chain) rig.chainByBone[boneId] = physics.id;
		}
		rig.chains = rig.physics.map((physics, index) => {
			const nodes = physics.nodes;
			const segLen = [];
			for (let i = 0; i < nodes.length - 1; i += 1) {
				segLen.push(Math.hypot(nodes[i + 1][0] - nodes[i][0], nodes[i + 1][1] - nodes[i][1]));
			}
			return {
				id: physics.id,
				def: physics,
				nodes,
				segLen,
				p: nodes.map((node) => [node[0], node[1]]),
				v: nodes.map(() => [0, 0]),
				rest: nodes.map((node) => [node[0], node[1]]),
				inited: false,
				phase: (index * 1.7) % 6.28,
			};
		});
		for (const chain of rig.chains) setupChainColliders(rig, chain);
		const snapshot = rt.chainSnaps[shape];
		if (snapshot) restoreChainSnapshot(rig, snapshot);

		const deformers = Object.fromEntries(rig.deformers.map((deformer) => [deformer.id, deformer]));
		if (!deformers.headYawWarp || !deformers.headPitchWarp || !deformers.breathChest) {
			throw new Error(`rig 缺少 deformers：${rigUrl}`);
		}
		rig.headCfg = deformers.headYawWarp.bind;
		rig.headPivot = deformers.headYawWarp.pivot;
		rig.pitchCfg = deformers.headPitchWarp.bind;
		rig.breathCfg = deformers.breathChest.bind;
		rig.breathPivot = deformers.breathChest.pivot;

		rt.scenes.set(shape, rig);
		rt.loadMs[shape] = performance.now() - loadT0;
		rt.assetInfo[shape] = {
			rigUrl,
			rigBytes: text.length,
			// 兼容旧字段（第一张图集）+ 多图集明细（cutout）
			atlasUrl: atlases[0].url,
			atlasWidth: atlases[0].width,
			atlasHeight: atlases[0].height,
			atlasBytesApprox: atlases[0].bytes,
			atlases: atlases.map((atlas) => ({
				id: atlas.id, file: atlas.file, url: atlas.url,
				width: atlas.width, height: atlas.height, bytes: atlas.bytes,
			})),
			legacyAtlas: atlasSet.legacy,
			textureBytes: rig.texBytes,
			loadMs: Math.round(rt.loadMs[shape]),
		};
		return rig;
	})();
	rt.loading.set(shape, task);
	try {
		return await task;
	} finally {
		rt.loading.delete(shape);
	}
}

/**
 * @param {string} url
 * @returns {Promise<HTMLImageElement>}
 */
function loadImage(url) {
	return new Promise((resolve, reject) => {
		const image = new Image();
		image.decoding = 'async';
		image.onload = () => {
			if (typeof image.decode === 'function') {
				image.decode().then(() => resolve(image), () => resolve(image));
			} else {
				resolve(image);
			}
		};
		image.onerror = () => reject(new Error(`图集加载失败：${url}`));
		image.src = url;
	});
}

/**
 * @param {any} rt
 * @param {string} shape
 * @returns {boolean}
 */
function activateScene(rt, shape) {
	const scene = rt.scenes.get(shape);
	if (!scene) return false;
	rt.shape = shape;
	rt.scene = scene;
	rt.bones = scene.bones;
	rt.boneIndex = scene.boneIndex;
	rt.M = scene.M;
	rt.S = scene.S;
	rt.chainByBone = scene.chainByBone;
	rt.chains = scene.chains;
	rt.drawableById = scene.drawableById;
	rt.headCfg = scene.headCfg;
	rt.headPivot = scene.headPivot;
	rt.pitchCfg = scene.pitchCfg;
	rt.breathCfg = scene.breathCfg;
	rt.breathPivot = scene.breathPivot;
	rt.art = {
		specVersion: scene.specVersion || 1,
		artSource: scene.artSource || 'v2',
		name: scene.name || shape,
		file: scene.file,
		atlas: scene.atlases && scene.atlases.length ? { width: scene.atlases[0].width, height: scene.atlases[0].height } : null,
		atlases: (scene.atlases || []).map((atlas) => ({ id: atlas.id, file: atlas.file, width: atlas.width, height: atlas.height })),
		drawables: scene.drawables.length,
		bones: scene.skeleton.bones.length,
		chains: scene.physics.length,
		texMiB: Math.round((scene.stats.texBytes / 1048576) * 100) / 100,
	};
	rt.stats = {
		draws: 0, tris: 0, maskPasses: 0,
		verts: scene.stats.verts,
		texBytes: scene.stats.texBytes,
		vboBytes: scene.stats.vboBytes,
	};
	rt.look = resolveLook(scene, rt.lastLookState || {});
	buildActive(rt);
	syncFace(rt, true);
	return true;
}

/**
 * @param {any} rt
 * @param {string} shape
 * @returns {number|null}
 */
function releaseScene(rt, shape) {
	const scene = rt.scenes.get(shape);
	if (!scene) return null;
	const gl = rt.gl;
	const t0 = performance.now();
	rt.chainSnaps[shape] = snapshotChains(scene);
	for (const drawable of scene.drawables) {
		if (drawable.vao) gl.deleteVertexArray(drawable.vao);
		if (drawable.vbo) gl.deleteBuffer(drawable.vbo);
		if (drawable.ibo) gl.deleteBuffer(drawable.ibo);
		if (drawable.tex && drawable.tex !== scene.texture) deleteTexture(rt, drawable.tex);
	}
	for (const atlas of scene.atlases || []) {
		if (atlas.texture) deleteTexture(rt, atlas.texture);
	}
	if (scene.texture && !(scene.atlases || []).some((atlas) => atlas.texture === scene.texture)) deleteTexture(rt, scene.texture);
	rt.glRes.vbos = Math.max(0, rt.glRes.vbos - scene.drawables.length * 2);
	rt.scenes.delete(shape);
	rt.releaseMs[shape] = performance.now() - t0;
	return rt.releaseMs[shape];
}

/** @param {any} scene @returns {any[]} */
function snapshotChains(scene) {
	return scene.chains.map((chain) => ({
		id: chain.id,
		p: chain.p.map((point) => point.slice()),
		v: chain.v.map((point) => point.slice()),
		inited: chain.inited,
	}));
}

/** @param {any} scene @param {any[]} snapshot */
function restoreChainSnapshot(scene, snapshot) {
	for (const chain of scene.chains) {
		const saved = snapshot.find((entry) => entry.id === chain.id);
		if (!saved) continue;
		for (let i = 0; i < chain.p.length && i < saved.p.length; i += 1) {
			chain.p[i] = saved.p[i].slice();
			chain.v[i] = saved.v[i].slice();
		}
		chain.inited = saved.inited;
	}
}

/* ------------------------------------------------------------- quality/DPR -- */

/** @param {any} rt @param {any} preset */
function applyQuality(rt, preset) {
	rt.quality = preset.quality;
	rt.dpr = clamp(Number(preset.dpr) || 1.5, DPR_LIMITS.min, DPR_LIMITS.max);
	rt.physicsHz = clampPhysicsHz(preset.physicsHz);
	rt.maskPass = !!preset.maskPass;
	rt.mipmaps = !!preset.mipmaps;
	rt.physAcc = 0;
}

/** @param {any} rt */
function resizeCanvas(rt) {
	const width = Math.round(rt.baseW * rt.dpr);
	const height = Math.round(rt.baseH * rt.dpr);
	if (rt.canvas.width !== width || rt.canvas.height !== height) {
		rt.canvas.width = width;
		rt.canvas.height = height;
	}
	rt.viewW = rt.canvas.width;
	rt.viewH = rt.canvas.height;
	if (rt.gl && rt.mask) {
		rt.gl.deleteTexture(rt.mask.tex);
		rt.gl.deleteFramebuffer(rt.mask.fbo);
		rt.mask = makeMaskFBO(rt.gl, rt.viewW, rt.viewH);
	}
}

/** @param {any} rt */
function reuploadTextures(rt) {
	for (const scene of rt.scenes.values()) {
		if (!scene.atlases || scene.atlases.length === 0) continue;
		for (const atlas of scene.atlases) {
			if (atlas.texture) deleteTexture(rt, atlas.texture);
			atlas.texture = textureFromImage(rt, atlas.image);
		}
		scene.texture = scene.atlases[0].texture;
		for (const drawable of scene.drawables) {
			// DIY 动态 drawable 自带纹理：mipmap/画质切换时按各自图片重传，不落回 base 图集
			if (drawable.image) {
				if (drawable.tex) deleteTexture(rt, drawable.tex);
				drawable.tex = textureFromImage(rt, drawable.image);
			} else {
				const atlas = scene.atlases[drawable.atlasIndex || 0] || scene.atlases[0];
				drawable.tex = atlas.texture;
			}
		}
	}
}

/** @param {any} rt */
function getQuality(rt) {
	return {
		quality: rt.quality,
		dpr: rt.dpr,
		canvas: [rt.viewW, rt.viewH],
		physicsHz: rt.physicsHz,
		maxSubsteps: rt.maxSubsteps,
		dtCapMs: rt.dtCap * 1000,
		maskPass: rt.maskPass,
		mipmaps: rt.mipmaps,
	};
}

/** @param {any} rt */
function glMaxTextureSize(rt) {
	try {
		return rt.gl.getParameter(rt.gl.MAX_TEXTURE_SIZE);
	} catch {
		return null;
	}
}

/** @param {any} rt */
function memoryInfo(rt) {
	let texBytes = 0;
	let vboBytes = 0;
	let drawables = 0;
	for (const scene of rt.scenes.values()) {
		texBytes += scene.stats.texBytes;
		vboBytes += scene.stats.vboBytes;
		drawables += scene.drawables.length;
	}
	return {
		scenesLoaded: [...rt.scenes.keys()],
		drawables,
		textures: rt.glRes.textures,
		texBytes,
		texMiB: Math.round((texBytes / 1048576) * 100) / 100,
		texMiBwithMipmap: Math.round(((texBytes * 4) / 3 / 1048576) * 100) / 100,
		vboBytes,
		vboKiB: Math.round(vboBytes / 1024),
		glTextures: rt.glRes.textures,
		glVbos: rt.glRes.vbos,
		loadMs: { ...rt.loadMs },
		releaseMs: { ...rt.releaseMs },
		shapeSwitches: rt.shapeSwitches,
	};
}

/* ------------------------------------------------------------------ physics -- */

/** @param {any} scene @param {any} chain */
function setupChainColliders(scene, chain) {
	chain.kind = chainKind(chain.id);
	chain.colliderRules = [];
	for (const collider of scene.colliders || []) {
		if (!(collider.affects || []).includes(chain.kind)) continue;
		const allow = chain.nodes.map((node) => {
			const distance = colliderBindDistance(scene, collider, node[0], node[1]);
			return Math.max(0, collider.radius - distance);
		});
		chain.colliderRules.push({ col: collider, allow });
	}
	chain.pre = { nodes: 0, depth: 0, max: 0 };
	chain.post = { nodes: 0, depth: 0, max: 0 };
}

/** @param {string} id @returns {'hair'|'skirt'|'tail'} */
function chainKind(id) {
	if (/^(hair|strand|bangs|hairBack)/.test(id)) return 'hair';
	if (/^skirt/.test(id)) return 'skirt';
	return 'tail';
}

/** @param {number} px @param {number} py @param {number} ax @param {number} ay @param {number} bx @param {number} by */
function closestPointOnSegment(px, py, ax, ay, bx, by) {
	const dx = bx - ax;
	const dy = by - ay;
	const lengthSquared = dx * dx + dy * dy || 1e-9;
	let t = ((px - ax) * dx + (py - ay) * dy) / lengthSquared;
	t = clamp(t, 0, 1);
	return [ax + dx * t, ay + dy * t];
}

/** @param {any} scene @param {any} collider */
function bindColliderCenter(scene, collider) {
	if (collider.type !== 'sphere') return null;
	if (collider.bone) {
		const bone = scene.bones[scene.boneIndex[collider.bone]];
		return [bone.base[0] + collider.offset[0], bone.base[1] + collider.offset[1]];
	}
	return collider.center;
}

/** @param {any} scene @param {any} collider @param {number} x @param {number} y */
function colliderBindDistance(scene, collider, x, y) {
	if (collider.type === 'sphere') {
		const center = bindColliderCenter(scene, collider);
		return Math.hypot(x - center[0], y - center[1]);
	}
	const point = closestPointOnSegment(x, y, collider.a[0], collider.a[1], collider.b[0], collider.b[1]);
	return Math.hypot(x - point[0], y - point[1]);
}

/** @param {any} rt */
function resetPhysics(rt) {
	for (const chain of rt.chains) {
		chain.inited = false;
		for (let i = 0; i < chain.p.length; i += 1) {
			chain.p[i][0] = chain.nodes[i][0];
			chain.p[i][1] = chain.nodes[i][1];
			chain.v[i][0] = 0;
			chain.v[i][1] = 0;
		}
	}
}

/** @param {any} rt */
function updateColliderWorld(rt) {
	const scene = rt.scene;
	for (const collider of scene.colliders || []) {
		if (collider.type !== 'sphere') continue;
		if (collider.bone) {
			const matrix = rt.M[scene.boneIndex[collider.bone]];
			collider.wx = matrix.a * collider.offset[0] + matrix.c * collider.offset[1] + matrix.tx;
			collider.wy = matrix.b * collider.offset[0] + matrix.d * collider.offset[1] + matrix.ty;
		} else {
			collider.wx = collider.center[0];
			collider.wy = collider.center[1];
		}
	}
}

/** @param {any} collider @param {number} x @param {number} y */
function colliderClosest(collider, x, y) {
	if (collider.type === 'sphere') return [collider.wx, collider.wy];
	return closestPointOnSegment(x, y, collider.a[0], collider.a[1], collider.b[0], collider.b[1]);
}

/** @param {any} chain @returns {{nodes:number,depth:number,max:number}} */
function penetrationStats(chain) {
	let nodes = 0;
	let depth = 0;
	let max = 0;
	for (const rule of chain.colliderRules) {
		const collider = rule.col;
		for (let i = 1; i < chain.p.length; i += 1) {
			if (i < (collider.minIndex || 1)) continue;
			const closest = colliderClosest(collider, chain.p[i][0], chain.p[i][1]);
			const distance = Math.hypot(chain.p[i][0] - closest[0], chain.p[i][1] - closest[1]);
			const minDistance = collider.radius - rule.allow[i];
			const extra = minDistance - distance;
			if (extra > 1) {
				nodes += 1;
				depth += extra;
				if (extra > max) max = extra;
			}
		}
	}
	return { nodes, depth: Math.round(depth * 10) / 10, max: Math.round(max * 10) / 10 };
}

/** @param {any} chain */
function resolveCollisions(chain) {
	for (const rule of chain.colliderRules) {
		const collider = rule.col;
		for (let i = 1; i < chain.p.length; i += 1) {
			if (i < (collider.minIndex || 1)) continue;
			const closest = colliderClosest(collider, chain.p[i][0], chain.p[i][1]);
			let dx = chain.p[i][0] - closest[0];
			let dy = chain.p[i][1] - closest[1];
			let distance = Math.hypot(dx, dy);
			const minDistance = collider.radius - rule.allow[i];
			if (distance >= minDistance) continue;
			if (distance < 1e-4) { dx = 0; dy = 1; distance = 1; }
			const nx = dx / distance;
			const ny = dy / distance;
			chain.p[i][0] = closest[0] + nx * minDistance;
			chain.p[i][1] = closest[1] + ny * minDistance;
			const normalVelocity = chain.v[i][0] * nx + chain.v[i][1] * ny;
			if (normalVelocity < 0) {
				chain.v[i][0] -= normalVelocity * nx;
				chain.v[i][1] -= normalVelocity * ny;
			}
		}
	}
}

/** @param {any} rt @param {number} dtTick */
function simulateChains(rt, dtTick) {
	const scene = rt.scene;
	const bones = scene.bones;
	for (const chain of rt.chains) {
		const definition = chain.def;
		const parentBone = bones[rt.boneIndex[definition.parent]];
		const parentMatrix = rt.M[parentBone.index];
		const lastIndex = chain.p.length - 1;
		for (let i = 0; i <= lastIndex; i += 1) {
			const rest = applyMatrix(parentMatrix,
				chain.nodes[i][0] - parentBone.base[0],
				chain.nodes[i][1] - parentBone.base[1]);
			chain.rest[i][0] = rest[0];
			chain.rest[i][1] = rest[1];
		}
		if (!chain.inited || rt.mode === 'static') {
			for (let i = 0; i <= lastIndex; i += 1) {
				chain.p[i][0] = chain.rest[i][0];
				chain.p[i][1] = chain.rest[i][1];
				chain.v[i][0] = 0;
				chain.v[i][1] = 0;
			}
			chain.inited = true;
			chain.pre = { nodes: 0, depth: 0, max: 0 };
			chain.post = { nodes: 0, depth: 0, max: 0 };
		} else {
			const steps = definition.substeps || 2;
			const dt = dtTick / steps;
			const isHair = chain.kind === 'hair';
			const isTail = chain.kind === 'tail';
			const sway = isHair ? rt.params.hairSway : isTail ? rt.params.hairSway * 0.8 : rt.params.skirtSway;
			const amplitude = (isHair ? 1050 : isTail ? 800 : 1500) * sway;
			const applyDistance = () => {
				chain.p[0][0] = chain.rest[0][0];
				chain.p[0][1] = chain.rest[0][1];
				for (let i = 1; i <= lastIndex; i += 1) {
					let dx = chain.p[i][0] - chain.p[i - 1][0];
					let dy = chain.p[i][1] - chain.p[i - 1][1];
					const distance = Math.hypot(dx, dy) || 1e-6;
					const length = chain.segLen[i - 1];
					dx = (dx / distance) * length;
					dy = (dy / distance) * length;
					chain.p[i][0] = chain.p[i - 1][0] + dx;
					chain.p[i][1] = chain.p[i - 1][1] + dy;
				}
			};
			const windScale = rt.collStress;
			for (let s = 0; s < steps; s += 1) {
				const tickTime = rt.time + s * dt;
				for (let i = 1; i <= lastIndex; i += 1) {
					const phase = chain.phase + i * 0.8;
					const windX = amplitude * windScale *
						(0.62 * Math.sin(tickTime * 1.7 + phase) + 0.38 * Math.sin(tickTime * 0.83 + phase * 1.7));
					const windY = isHair ? amplitude * windScale * 0.10 * Math.sin(tickTime * 1.1 + phase) : 0;
					const stiffness = definition.stiffness;
					const drag = definition.drag;
					const accelX = -stiffness * (chain.p[i][0] - chain.rest[i][0]) - drag * chain.v[i][0] + windX;
					const accelY = -stiffness * (chain.p[i][1] - chain.rest[i][1]) - drag * chain.v[i][1]
						+ definition.gravity * definition.gravityScale + windY;
					chain.v[i][0] += accelX * dt;
					chain.v[i][1] += accelY * dt;
					chain.p[i][0] += chain.v[i][0] * dt;
					chain.p[i][1] += chain.v[i][1] * dt;
				}
				applyDistance();
				if (s === steps - 1) chain.pre = penetrationStats(chain);
				if (rt.collision) {
					const iterations = isHair ? 4 : 2;
					for (let iteration = 0; iteration < iterations; iteration += 1) {
						resolveCollisions(chain);
						applyDistance();
					}
				}
				if (s === steps - 1) chain.post = rt.collision ? penetrationStats(chain) : chain.pre;
			}
			for (let i = 1; i <= lastIndex; i += 1) {
				const offsetX = chain.p[i][0] - chain.rest[i][0];
				const offsetY = chain.p[i][1] - chain.rest[i][1];
				const distance = Math.hypot(offsetX, offsetY);
				if (distance > CHAIN_OFFSET_LIMIT) {
					chain.p[i][0] = chain.rest[i][0] + (offsetX / distance) * CHAIN_OFFSET_LIMIT;
					chain.p[i][1] = chain.rest[i][1] + (offsetY / distance) * CHAIN_OFFSET_LIMIT;
				}
			}
			if (rt.collision) {
				resolveCollisions(chain);
				chain.post = penetrationStats(chain);
			}
		}
		const parentRotation = worldRotation(parentMatrix);
		let accumulated = parentRotation;
		for (let i = 0; i < definition.chain.length; i += 1) {
			const boneId = definition.chain[i];
			const bone = bones[rt.boneIndex[boneId]];
			const angle = Math.atan2(
				chain.p[i + 1][1] - chain.p[i][1],
				chain.p[i + 1][0] - chain.p[i][0],
			);
			const theta = angle - (bone.angle * Math.PI) / 180 - accumulated;
			accumulated += theta;
			const matrix = i === 0 ? parentMatrix : rt.M[rt.boneIndex[definition.chain[i - 1]]];
			const parent = i === 0 ? parentBone : bones[rt.boneIndex[definition.chain[i - 1]]];
			const cos = Math.cos(theta);
			const sin = Math.sin(theta);
			const dx = bone.base[0] - parent.base[0];
			const dy = bone.base[1] - parent.base[1];
			rt.M[bone.index] = {
				a: matrix.a * cos + matrix.c * sin,
				b: matrix.b * cos + matrix.d * sin,
				c: -matrix.a * sin + matrix.c * cos,
				d: -matrix.b * sin + matrix.d * cos,
				tx: matrix.a * dx + matrix.c * dy + matrix.tx,
				ty: matrix.b * dx + matrix.d * dy + matrix.ty,
			};
		}
	}
	const aggregate = { preNodes: 0, preDepth: 0, preMax: 0, postNodes: 0, postDepth: 0, postMax: 0 };
	for (const chain of rt.chains) {
		if (!chain.pre || !chain.colliderRules || !chain.colliderRules.length) continue;
		aggregate.preNodes += chain.pre.nodes;
		aggregate.preDepth += chain.pre.depth;
		aggregate.preMax = Math.max(aggregate.preMax, chain.pre.max);
		aggregate.postNodes += chain.post.nodes;
		aggregate.postDepth += chain.post.depth;
		aggregate.postMax = Math.max(aggregate.postMax, chain.post.max);
	}
	aggregate.preDepth = Math.round(aggregate.preDepth * 10) / 10;
	aggregate.postDepth = Math.round(aggregate.postDepth * 10) / 10;
	rt.collStats = aggregate;
	for (const key of Object.keys(aggregate)) {
		rt.collPeak[key] = Math.max(rt.collPeak[key], aggregate[key]);
	}
}

/* --------------------------------------------------------------- skinning --- */

/** @param {any} rt */
function computeCoreMatrices(rt) {
	const bones = rt.scene.bones;
	const matrices = rt.M;
	const theta = {};
	const headZ = (rt.params.headZ + rt.follow.headZ) * Math.PI / 180;
	theta.head = headZ;
	const time = rt.time;
	const armSway = rt.mode === 'anim' ? Math.sin(time * 1.25) * 0.006 : 0;
	theta.upperArmL = armSway;
	theta.upperArmR = -armSway;
	for (const bone of bones) {
		if (rt.chainByBone[bone.id]) continue;
		const angle = theta[bone.id] || 0;
		const cos = Math.cos(angle);
		const sin = Math.sin(angle);
		if (!bone.parent) {
			matrices[bone.index] = { a: cos, b: sin, c: -sin, d: cos, tx: bone.base[0], ty: bone.base[1] };
		} else {
			const parentMatrix = matrices[rt.boneIndex[bone.parent]];
			const parent = rt.scene.bones[rt.boneIndex[bone.parent]];
			const dx = bone.base[0] - parent.base[0];
			const dy = bone.base[1] - parent.base[1];
			matrices[bone.index] = {
				a: parentMatrix.a * cos + parentMatrix.c * sin,
				b: parentMatrix.b * cos + parentMatrix.d * sin,
				c: -parentMatrix.a * sin + parentMatrix.c * cos,
				d: -parentMatrix.b * sin + parentMatrix.d * cos,
				tx: parentMatrix.a * dx + parentMatrix.c * dy + parentMatrix.tx,
				ty: parentMatrix.b * dx + parentMatrix.d * dy + parentMatrix.ty,
			};
		}
	}
}

/** @param {any} rt */
function computeSkinMatrices(rt) {
	for (const bone of rt.scene.bones) {
		const matrix = rt.M[bone.index];
		if (!matrix) continue;
		const baseX = bone.base[0];
		const baseY = bone.base[1];
		const skin = rt.S[bone.index];
		skin[0] = matrix.a;
		skin[1] = matrix.c;
		skin[2] = matrix.tx - matrix.a * baseX - matrix.c * baseY;
		skin[3] = 0;
		skin[4] = matrix.b;
		skin[5] = matrix.d;
		skin[6] = matrix.ty - matrix.b * baseX - matrix.d * baseY;
		skin[7] = 0;
	}
}

/** @param {any} matrix @param {number} x @param {number} y */
function applyMatrix(matrix, x, y) {
	return [
		matrix.a * x + matrix.c * y + matrix.tx,
		matrix.b * x + matrix.d * y + matrix.ty,
	];
}

/** @param {any} matrix @returns {number} */
function worldRotation(matrix) {
	return Math.atan2(matrix.b, matrix.a);
}

/* ------------------------------------------------------------- fixed step --- */

/**
 * 固定步长物理累加器（逻辑在 core.accumulateTicks，便于单测）。
 * @param {any} rt
 * @param {number} dtWall
 * @returns {number} 本帧物理 tick 数
 */
function tickSim(rt, dtWall) {
	if (rt.mode === 'static') {
		computeCoreMatrices(rt);
		updateColliderWorld(rt);
		simulateChains(rt, 1 / rt.physicsHz);
		computeSkinMatrices(rt);
		rt.physAcc = 0;
		return 0;
	}
	const result = accumulateTicks({
		acc: rt.physAcc,
		dtWall,
		hz: rt.physicsHz,
		maxSubsteps: rt.maxSubsteps,
	});
	let ticks = result.ticks;
	rt.physAcc = result.acc;
	if (result.dropped > 0) {
		rt.droppedTicks += result.dropped;
		// 保留一次姿态推进，避免画面冻住（POC 同行为）
		simFrame(rt, 1 / rt.physicsHz);
		ticks += 1;
	}
	for (let i = 0; i < result.ticks; i += 1) simFrame(rt, 1 / rt.physicsHz);
	rt.tickCount += ticks;
	return ticks;
}

/**
 * @param {any} rt
 * @param {number} dtWall
 * @returns {number}
 */
function advanceWall(rt, dtWall) {
	updateAuto(rt, dtWall);
	return tickSim(rt, dtWall);
}

/**
 * 一帧模拟：核心骨矩阵 → 碰撞体世界坐标 → spring 链 → 蒙皮矩阵。
 * @param {any} rt
 * @param {number} [dt]
 */
function simFrame(rt, dt = 1 / 60) {
	computeCoreMatrices(rt);
	updateColliderWorld(rt);
	simulateChains(rt, dt);
	computeSkinMatrices(rt);
}

/* ------------------------------------------------------------------ render -- */

/** @param {any} rt */
function updateUniforms(rt) {
	const gl = rt.gl;
	const u = rt.u;
	const camera = rt.camera;
	gl.useProgram(rt.prog);
	const bones0 = new Float32Array(MAX_BONES * 4);
	const bones1 = new Float32Array(MAX_BONES * 4);
	for (let i = 0; i < rt.S.length && i < MAX_BONES; i += 1) {
		bones0.set(rt.S[i].subarray(0, 4), i * 4);
		bones1.set(rt.S[i].subarray(4, 8), i * 4);
	}
	gl.uniform4fv(u.uB0, bones0);
	gl.uniform4fv(u.uB1, bones1);
	gl.uniform4f(u.uCam, camera.x, camera.y, camera.w, camera.h);
	const headCfg = rt.headCfg;
	const headPivot = rt.headPivot;
	const pitchCfg = rt.pitchCfg;
	const breathCfg = rt.breathCfg;
	const breathPivot = rt.breathPivot;
	gl.uniform4f(u.uHeadCfg, headPivot[0], headPivot[1], headCfg.shiftX, headCfg.squashX);
	gl.uniform4f(u.uPitchCfg, pitchCfg.shiftY, 0, 0, 0);
	gl.uniform4f(u.uBreathCfg, breathPivot[0], breathCfg.scaleX, breathCfg.liftY, 0);
	const breath = rt.mode === 'static' ? 0 : rt.params.breath * (0.5 + 0.5 * Math.sin(rt.time * 1.15));
	gl.uniform3f(u.uWarp,
		rt.params.headY + rt.follow.headY,
		rt.params.headX + rt.follow.headX,
		breath);
	gl.uniform2f(u.uViewport, rt.viewW, rt.viewH);
	gl.uniform1i(u.uSolid, 0);
	rt.breathNow = breath;
}

/** @param {any} rt @param {any} drawable @param {WebGLTexture|null} maskTex */
function drawDrawable(rt, drawable, maskTex) {
	const gl = rt.gl;
	const u = rt.u;
	gl.bindVertexArray(drawable.vao);
	gl.bindTexture(gl.TEXTURE_2D, drawable.tex || (rt.scene && rt.scene.texture));
	gl.uniform1i(u.uTex, 0);
	if (maskTex) {
		gl.activeTexture(gl.TEXTURE1);
		gl.bindTexture(gl.TEXTURE_2D, maskTex);
		gl.uniform1i(u.uMask, 1);
		gl.uniform1i(u.uUseMask, 1);
		gl.activeTexture(gl.TEXTURE0);
	} else {
		gl.uniform1i(u.uUseMask, 0);
	}
	gl.drawElements(gl.TRIANGLES, drawable.mesh.indices.length, gl.UNSIGNED_SHORT, 0);
	rt.stats.draws += 1;
	rt.stats.tris += drawable.tris;
}

/** @param {any} rt @param {string[]} maskIds */
function renderMask(rt, maskIds) {
	const gl = rt.gl;
	const mask = rt.mask;
	gl.bindFramebuffer(gl.FRAMEBUFFER, mask.fbo);
	gl.viewport(0, 0, mask.w, mask.h);
	gl.clearColor(0, 0, 0, 0);
	gl.clear(gl.COLOR_BUFFER_BIT);
	gl.activeTexture(gl.TEXTURE1);
	gl.bindTexture(gl.TEXTURE_2D, null);
	gl.activeTexture(gl.TEXTURE0);
	gl.blendFunc(gl.ONE, gl.ONE);
	gl.uniform1i(rt.u.uSolid, 1);
	for (const id of maskIds) {
		const drawable = rt.drawableById[id];
		if (drawable) drawDrawable(rt, drawable, null);
	}
	gl.uniform1i(rt.u.uSolid, 0);
	gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
	gl.bindFramebuffer(gl.FRAMEBUFFER, null);
	gl.viewport(0, 0, rt.viewW, rt.viewH);
	rt.stats.maskPasses += 1;
}

/** @param {any} rt @param {boolean} [skipSim] @param {number} [dtWall] */
function render(rt, skipSim = true, dtWall = 1 / 60) {
	const gl = rt.gl;
	if (!rt.scene) return;
	const started = performance.now();
	rt.stats = { draws: 0, tris: 0, maskPasses: 0, verts: rt.stats.verts, texBytes: rt.stats.texBytes, vboBytes: rt.stats.vboBytes };
	if (!skipSim) advanceWall(rt, dtWall);
	updateUniforms(rt);

	gl.bindFramebuffer(gl.FRAMEBUFFER, null);
	gl.viewport(0, 0, rt.viewW, rt.viewH);
	gl.clearColor(0, 0, 0, 0);
	gl.clear(gl.COLOR_BUFFER_BIT);

	const masked = new Set();
	for (const drawable of rt.active) {
		if (drawable.mask && drawable.mask.length && rt.maskPass) {
			const key = drawable.mask.join(',');
			if (!masked.has(key)) {
				renderMask(rt, drawable.mask);
				masked.add(key);
			}
			drawDrawable(rt, drawable, rt.mask.tex);
		} else {
			drawDrawable(rt, drawable, null);
		}
	}
	rt.cpuMs = performance.now() - started;
}

/* --------------------------------------------------------------- animation -- */

/** @param {any} rt @param {number} dt */
function updateAuto(rt, dt) {
	rt.blinkT = Math.max(0, rt.blinkT - dt);
	rt.smileT = Math.max(0, rt.smileT - dt);
	rt.talkT = Math.max(0, rt.talkT - dt);
	rt.tapT = Math.max(0, rt.tapT - dt);
	// head follow 阻尼
	const followSpeed = Math.min(1, dt * 8);
	rt.follow.headY += (rt.follow.targetY - rt.follow.headY) * followSpeed;
	rt.follow.headX += (rt.follow.targetX - rt.follow.headX) * followSpeed;
	rt.follow.headZ += (0 - rt.follow.headZ) * followSpeed;
	if (rt.tapT > 0) {
		rt.follow.headZ = 4 * Math.sin(Math.PI * (1 - rt.tapT / TAP_DURATION));
	}
	if (rt.mode !== 'static') {
		rt.time += dt;
		rt.nextBlink -= dt;
		if (rt.auto && rt.nextBlink <= 0) {
			rt.blinkT = 0.13;
			rt.nextBlink = 2.2 + Math.random() * 2.8;
			if (Math.random() < 0.18) rt.nextBlink = 0.32; // 连续眨眼
		}
	}
	syncFace(rt, false);
}

/** @param {any} rt @param {boolean} force */
function syncFace(rt, force) {
	if (!rt.scene) return;
	const face = faceStateKeys(rt.scene);
	const parts = face.mode === 'parts';
	const eye = desiredEyeKey({
		params: rt.params,
		blinkT: rt.blinkT,
		smileT: rt.smileT,
		override: rt.faceOverride.eye,
		parts,
	});
	const mouth = desiredMouthKey({
		params: rt.params,
		talking: rt.talking,
		talkT: rt.talkT,
		time: rt.time,
		override: rt.faceOverride.mouth,
		parts,
	});
	if (force || eye !== rt.eyeKey || mouth !== rt.mouthKey) {
		rt.eyeKey = eye;
		rt.mouthKey = mouth;
		buildActive(rt);
	}
}

/** @param {any} rt */
function buildActive(rt) {
	if (!rt.scene) return;
	const entries = visibleDrawables(rt.scene, rt.look, { eye: rt.eyeKey, mouth: rt.mouthKey });
	/** @type {any[]} */
	const list = [];
	for (const entry of entries) {
		const drawable = rt.drawableById[entry.id];
		if (drawable) {
			drawable.z = entry.z;
			list.push(drawable);
		}
	}
	rt.active = list;
	rt.activeIds = list.map((drawable) => drawable.id);
	rt.scene.activeIds = rt.activeIds;
}

/* ---------------------------------------------------------------- helpers --- */

/** @param {any} slots @returns {any} */
function cloneSlots(slots) {
	const source = slots || {};
	/** @type {Record<string, string[]>} 旧 4 键始终存在（语义不变）；cutout 新槽位仅非空时出现 */
	const out = {};
	for (const slot of LEGACY_OUTFIT_SLOTS) out[slot] = (source[slot] || []).slice();
	for (const slot of CUTOUT_SLOTS) {
		const values = source[slot] || [];
		if (values.length) out[slot] = values.slice();
	}
	return out;
}

/** @param {any} rt */
function stop(rt) {
	if (rt.raf) cancelAnimationFrame(rt.raf);
	rt.raf = 0;
}

export { summarizeInitialPayload, TRANSITION_MS as transitionMs };
