/**
 * 大肥鱼衣橱 · DIY 宿主侧流水线（S2）
 *
 * 把 S1 spike 验证过的「自动绑定」产品化为 agent 可调用的宿主管线：
 *
 *   plan    → 输入校验（图片/品类/形状/内容守卫）+ 费用预估 + 预算检查 + 建 job
 *   generate→ Seedream look + flatout（复用 lib/diy-provider；预算/缓存/重试/脱敏沿用 M1）
 *   split   → tools/diy/split_layers.py（Python 移植 M1 浏览器成层算法；宿主无浏览器依赖）
 *   bind    → tools/diy/bind_layers.py（增量 outfit pack；格式见 .scratch/diy2/S2-S3-PACK-SPEC.md）
 *   qa      → 宿主结构 QA（格式/网格/权重/UV/纹理/覆盖率/成层分级）；未过 → fallback=static
 *   install → 写 <diy-home>/packs/<itemId> + registry.json（原子写；--dry-run 不落盘）
 *
 * 默认关闭（config.diy.enabled），失败零污染；单行 JSON 输出由 bin/dsh-feiyu-diy.mjs 负责。
 * 安全：API key 只在宿主进程内使用，不写日志/不返回；错误信息经 sanitizeProviderError 脱敏。
 *
 * @module dsh-feiyu-wardrobe/diy-pipeline
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	copyFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	createSeedreamClient,
	loadArkKey,
	referenceToDataUrl,
	sanitizeProviderError,
} from './diy-provider.js';
import {
	DIY_PROMPT_VERSION,
	buildPromptPack,
	createDiyCache,
	createDiyLedger,
	defaultBaseRefPath,
} from './diy.js';
import { validateConfig } from './config.js';
import {
	DIY_CATEGORIES,
	DIY_GUARD_VERSION,
	checkGarmentDescription,
	contentPolicyTag,
} from '../docs/dress-up/diy-guard.js';

/** 流水线版本（进 job/registry，便于后续兼容）。 */
export const DIY_PIPELINE_VERSION = 1;

/** 增量 outfit pack 格式（与 S3 约定；见 .scratch/diy2/S2-S3-PACK-SPEC.md）。 */
export const DIY_PACK_FORMAT = 'feiyu-diy-pack';
export const DIY_PACK_FORMAT_VERSION = 1;

/** 流水线阶段（顺序执行；`run --stage` 可指定起点）。 */
export const DIY_STAGES = ['generate', 'split', 'bind', 'qa', 'install'];

/** 阶段中文名（人类可读输出/错误提示用）。 */
export const DIY_STAGE_LABELS = {
	generate: '生成 look/flatout',
	split: '自动成层',
	bind: '自动绑定',
	qa: '自动 QA',
	install: '安装到本地衣柜',
};

/** 支持的身形（骨架从 base rig 动态读取；旧 job 的 pack 允许骨架前缀兼容，见 qa.base_skeleton）。 */
export const DIY_SUPPORTED_SHAPES = ['chibi'];

/** 尺寸上限（与 M1 一致；文件字节，PNG/JPEG/WebP）。 */
const MAX_IMAGE_FILE_BYTES = 12 * 1024 * 1024;

/** 宿主侧 DIY 错误（code 供 CLI/agent 分类；message 已脱敏）。 */
export class DiyPipelineError extends Error {
	/**
	 * @param {string} code
	 * @param {string} message
	 * @param {Record<string, unknown>} [details]
	 */
	constructor(code, message, details = {}) {
		super(message);
		this.name = 'DiyPipelineError';
		this.code = code;
		this.details = details;
	}
}

/* ----------------------------------------------------------------- helpers -- */

/** @param {string} path */
function guessMimeFromMagic(path) {
	try {
		const buffer = readFileSync(path).subarray(0, 16);
		if (buffer.length >= 8 && buffer.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') return 'image/png';
		if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
		if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
	} catch {
		/* 读失败返回空 */
	}
	return '';
}

/**
 * ASCII slug（itemId 用于 URL/目录/registry 键；中文名落到品类前缀，不丢可读名）。
 * @param {string} value
 * @returns {string} 可能为空串
 */
function slugify(value) {
	return String(value || '')
		.normalize('NFKD')
		.replace(/[^\w-]+/g, '-')
		.replace(/_/g, '-')
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '')
		.toLowerCase()
		.slice(0, 24);
}

/** @param {number} timestamp */
function stamp(timestamp) {
	const date = new Date(timestamp);
	const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
	return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/** @param {string} path */
function readJsonSafe(path) {
	try {
		return JSON.parse(readFileSync(path, 'utf8'));
	} catch {
		return null;
	}
}

/**
 * 原子写 JSON（临时文件 + rename；同目录保证 rename 原子）。
 * @param {string} path
 * @param {unknown} value
 */
function writeJsonAtomic(path, value) {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
	writeFileSync(tmp, `${JSON.stringify(value, null, 1)}\n`, 'utf8');
	renameSync(tmp, path);
}

/** @param {string} file */
function sha256File(file) {
	return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/* --------------------------------------------------------------- pipeline -- */

/**
 * 创建 DIY 宿主流水线（无网络/无文件副作用，直到调用阶段方法）。
 *
 * @param {{
 *   config: import('./config.js').FeiyuConfig,
 *   home?: string,
 *   enabledOverride?: boolean,
 *   provider?: ReturnType<typeof createSeedreamClient> | null,
 *   ledger?: ReturnType<typeof createDiyLedger>,
 *   cache?: ReturnType<typeof createDiyCache>,
 *   now?: () => number,
 *   repoRoot?: string,
 *   python?: string,
 *   runPython?: (args: { script: string, argv: string[], cwd: string, timeoutMs: number }) => { status: number | null, stdout: string, stderr: string },
 *   logger?: { info?: (msg: string) => void, warn?: (msg: string) => void, error?: (msg: string) => void },
 * }} options
 */
export function createDiyPipeline(options) {
	if (!options || !options.config) throw new DiyPipelineError('bad_argument', 'createDiyPipeline 需要 config');
	const config = options.config;
	const now = options.now || Date.now;
	const repoRoot = options.repoRoot || fileURLToPath(new URL('..', import.meta.url));
	const python = options.python || process.env.DSH_FEIYU_PYTHON || 'python3';
	const logger = options.logger || {};
	const runPython = options.runPython || defaultRunPython;

	/** DIY 数据目录：默认 ~/.dsh/feiyu/diy（可用 home/环境变量覆盖；见 docs）。 */
	const home = resolve(
		options.home
		|| process.env.DSH_FEIYU_DIY_HOME
		|| join(dirname(config.statePath), '..', 'feiyu', 'diy'),
	);
	const jobsDir = join(home, 'jobs');
	const packsDir = join(home, 'packs');
	const registryPath = join(home, 'registry.json');

	/** @type {Map<string, { file: string, bones: number, boneNames: string[], rigVersion: unknown } | null>} */
	const baseRigCache = new Map();
	/** 读 base rig 骨架元数据（各 shape 动态；不写死 59 骨）。 @param {string} shape */
	function readBaseRigInfo(shape) {
		const file = join(repoRoot, 'docs', 'dress-up', 'art', '2d5', shape, 'rig.json');
		if (baseRigCache.has(file)) return baseRigCache.get(file);
		const rig = readJsonSafe(file);
		const bones = rig && rig.skeleton && Array.isArray(rig.skeleton.bones) ? rig.skeleton.bones : null;
		const info = bones && bones.length > 0
			? { file, bones: bones.length, boneNames: bones.map((bone) => String(bone.id)), rigVersion: rig.version }
			: null;
		baseRigCache.set(file, info);
		return info;
	}

	const ledger = options.ledger || createDiyLedger({
		statePath: config.diy.statePath,
		costLogPath: config.diy.costLogPath,
		pricePerImageYuan: config.diy.pricePerImageYuan,
		dailyImageLimit: config.diy.dailyImageLimit,
		dailyBudgetYuan: config.diy.dailyBudgetYuan,
		timezoneOffsetMinutes: config.timezoneOffsetMinutes,
		now,
	});
	const cache = options.cache || createDiyCache({
		cacheDir: config.diy.cacheDir,
		maxEntries: config.diy.cacheMaxEntries,
	});
	/** @type {ReturnType<typeof createSeedreamClient> | null} */
	let provider = options.provider || null;
	/**
	 * 懒创建 Seedream 客户端（plan/status 不触发凭证读取）。
	 * @returns {ReturnType<typeof createSeedreamClient>}
	 */
	function getProvider() {
		if (provider) return provider;
		const apiKey = loadArkKey(config.diy.apiKeyFile ? { envFile: config.diy.apiKeyFile } : {});
		provider = createSeedreamClient({
			apiKey,
			model: config.diy.model,
			size: config.diy.size,
			retries: config.diy.retries,
			timeoutMs: config.diy.timeoutMs,
		});
		return provider;
	}

	/** 是否允许执行产生费用的动作（默认关闭；--enabled / enabledOverride 显式开启）。 */
	function assertEnabled() {
		if (!config.diy.enabled && !options.enabledOverride) {
			throw new DiyPipelineError(
				'diy_disabled',
				'DIY 默认关闭：请先在宿主编排配置中设置 diy.enabled=true（或显式加 --enabled）',
			);
		}
	}

	/**
	 * 相对 diy home 的安全路径（拒绝 ../ 逃逸）。
	 * @param {string} path
	 * @returns {string}
	 */
	function homeRelative(path) {
		const rel = relative(home, path);
		if (!rel || rel.startsWith('..') || rel.includes(`..${sep}`)) {
			throw new DiyPipelineError('bad_path', '路径必须位于 DIY 数据目录内');
		}
		return rel.split(sep).join('/');
	}

	/** @param {string} jobId */
	function jobDir(jobId) {
		if (!/^[a-z0-9][a-z0-9-]{2,80}$/.test(String(jobId || ''))) {
			throw new DiyPipelineError('bad_argument', 'job id 非法');
		}
		return join(jobsDir, jobId);
	}

	/** @param {string} jobId */
	function loadJob(jobId) {
		const path = join(jobDir(jobId), 'job.json');
		const job = readJsonSafe(path);
		if (!job) throw new DiyPipelineError('job_not_found', `找不到 job：${jobId}`);
		return job;
	}

	/** @param {any} job */
	function saveJob(job) {
		job.updatedAt = new Date(now()).toISOString();
		writeJsonAtomic(join(jobDir(job.id), 'job.json'), job);
	}

	/* --------------------------------------------------------------- plan --- */

	/**
	 * plan：校验输入 + 费用预估 + 预算检查；创建 job 记录（不产生费用）。
	 * @param {{ image: string, name?: string, category?: string, description?: string, shape?: string, reroll?: number }} input
	 */
	function plan(input) {
		const imagePath = resolve(String(input && input.image ? input.image : ''));
		if (!existsSync(imagePath) || !statSync(imagePath).isFile()) {
			throw new DiyPipelineError('image_missing', '找不到输入衣服图片');
		}
		const bytes = statSync(imagePath).size;
		if (bytes < 512) throw new DiyPipelineError('image_too_small', '图片体积异常（<512B）');
		if (bytes > MAX_IMAGE_FILE_BYTES) throw new DiyPipelineError('image_too_large', '图片超过 12MB 上限');
		const mime = guessMimeFromMagic(imagePath);
		if (!mime) throw new DiyPipelineError('image_unsupported', '仅支持 PNG / JPEG / WebP 图片');
		const shape = String(input.shape || 'chibi');
		if (!DIY_SUPPORTED_SHAPES.includes(shape)) {
			throw new DiyPipelineError('unsupported_shape', `S2 仅支持 chibi 身形（收到 ${shape}）`);
		}
		let category = String(input.category || 'auto');
		const warnings = [];
		if (category === 'auto') {
			category = 'top';
			warnings.push('category_auto_default_top(尚无图像分类器，默认按 top；可显式 --category)');
		}
		if (!DIY_CATEGORIES.includes(category)) {
			throw new DiyPipelineError('unsupported_category', `不支持的品类：${category}（可选 ${DIY_CATEGORIES.join('/')}）`);
		}
		const fallbackName = imagePath.split(sep).pop() || 'DIY 套装';
		const name = String(input.name || fallbackName.replace(/\.[^.]+$/, '')).trim().slice(0, 40) || 'DIY 套装';
		const description = String(input.description || `${name} 日常服装`).trim().slice(0, 160);
		const guard = checkGarmentDescription(description);
		if (guard.action === 'reject') {
			throw new DiyPipelineError('guard_rejected', guard.reasons.join('；') || '内容不符合保守着装规范', {
				guard: { action: guard.action, hits: guard.hits, reasons: guard.reasons },
			});
		}
		if (guard.action === 'downgrade') warnings.push('guard_downgrade(描述已按保守规则收敛)');
		const budget = ledger.canSpend(2);
		const estimate = {
			images: 2,
			costYuan: Number((2 * config.diy.pricePerImageYuan).toFixed(2)),
			etaSec: 40,
		};
		const itemId = `diy-${slugify(name) || category}-${stamp(now())}`;
		let jobId = itemId;
		for (let suffix = 2; existsSync(jobDir(jobId)); suffix += 1) jobId = `${itemId}-${suffix}`;
		mkdirSync(jobDir(jobId), { recursive: true });
		const guardedDescription = guard.action === 'downgrade' ? guard.description : description;
		const job = {
			version: DIY_PIPELINE_VERSION,
			id: jobId,
			itemId,
			createdAt: new Date(now()).toISOString(),
			updatedAt: new Date(now()).toISOString(),
			status: 'planned',
			input: {
				imagePath,
				imageDigest: sha256File(imagePath),
				name,
				description: guardedDescription,
				category,
				shape,
				reroll: Math.max(0, Math.min(9, Math.floor(Number(input.reroll) || 0))),
				mime,
				bytes,
			},
			guard: { version: DIY_GUARD_VERSION, action: guard.action, hits: guard.hits },
			warnings,
			stages: {},
		};
		saveJob(job);
		return {
			ok: true,
			job: jobId,
			itemId,
			stage: 'plan',
			category,
			shape,
			name,
			estimate,
			guard: { pass: true, action: guard.action, hits: guard.hits },
			budget: { ok: budget.ok, code: budget.code || null, snapshot: budget.snapshot },
			warnings,
			hints: [`dsh-feiyu-diy run --job ${jobId}`],
		};
	}

	/* ----------------------------------------------------------- generate --- */

	/**
	 * generate：Seedream 生成 look + flatout（2 张/件；缓存命中零费用）。
	 * @param {any} job
	 */
	async function generate(job) {
		assertEnabled();
		const promptPack = buildPromptPack({
			category: job.input.category,
			description: job.input.description,
			imageDigest: job.input.imageDigest,
			reroll: job.input.reroll,
		});
		const client = getProvider();
		if (!client.configured) {
			throw new DiyPipelineError('missing_api_key', '宿主未配置 ARK_API_KEY（~/.config/seedream/env 或环境变量）');
		}
		const cacheKey = cache.keyFor({
			imageDigest: job.input.imageDigest,
			lookPrompt: promptPack.lookPrompt,
			flatoutPrompt: promptPack.flatoutPrompt,
			model: config.diy.model,
			size: config.diy.size,
			promptVersion: DIY_PROMPT_VERSION,
		});
		const genDir = join(jobDir(job.id), 'gen');
		mkdirSync(genDir, { recursive: true });
		const lookPath = join(genDir, 'look.png');
		const flatPath = join(genDir, 'flatout.png');
		const cached = cache.lookup(cacheKey);
		if (cached) {
			writeFileSync(lookPath, cached.look);
			writeFileSync(flatPath, cached.flatout);
			ledger.record({ event: 'diy_cache_hit', job: job.id, images: 0, costYuan: 0, requests: 0 });
			logger.info?.(`[diy] ${job.id} generate: cache hit`);
			return { stage: 'generate', cacheHit: true, images: 0, costYuan: 0,
				artifacts: { look: 'gen/look.png', flatout: 'gen/flatout.png' } };
		}
		const budget = ledger.canSpend(2);
		if (!budget.ok) {
			throw new DiyPipelineError(budget.code || 'budget_exceeded', budget.message || '今日 DIY 预算不足', {
				budget: budget.snapshot,
			});
		}
		const references = [config.diy.baseRefPath || defaultBaseRefPath(), job.input.imagePath].map((item) =>
			referenceToDataUrl(item),
		);
		let images = 0;
		let costYuan = 0;
		try {
			const look = await client.generate({
				prompt: promptPack.lookPrompt,
				references,
				seed: promptPack.seed,
			});
			writeFileSync(lookPath, look.image);
			images += 1;
			costYuan += config.diy.pricePerImageYuan;
			ledger.record({ event: 'diy_generate', job: job.id, part: 'look', images: 1,
				costYuan: config.diy.pricePerImageYuan, requests: 1, latencyMs: look.latencyMs });
			const flatout = await client.generate({
				prompt: promptPack.flatoutPrompt,
				references: [referenceToDataUrl(lookPath)],
				seed: promptPack.seed,
			});
			writeFileSync(flatPath, flatout.image);
			images += 1;
			costYuan += config.diy.pricePerImageYuan;
			ledger.record({ event: 'diy_generate', job: job.id, part: 'flatout', images: 1,
				costYuan: config.diy.pricePerImageYuan, requests: 1, latencyMs: flatout.latencyMs });
		} catch (error) {
			const message = sanitizeProviderError(error instanceof Error ? error.message : String(error));
			if (error && typeof error === 'object' && 'code' in error) {
				const code = String(/** @type {any} */ (error).code);
				throw new DiyPipelineError(code === 'missing_api_key' ? 'missing_api_key' : 'api_failed', message, {
					images, costYuan, providerCode: code,
				});
			}
			throw new DiyPipelineError('api_failed', message, { images, costYuan });
		}
		cache.store(cacheKey, {
			look: readFileSync(lookPath),
			flatout: readFileSync(flatPath),
			meta: { job: job.id, category: job.input.category, promptVersion: DIY_PROMPT_VERSION },
		});
		logger.info?.(`[diy] ${job.id} generate: ${images} images ¥${costYuan.toFixed(2)}`);
		return {
			stage: 'generate', cacheHit: false, images, costYuan: Number(costYuan.toFixed(2)),
			artifacts: { look: 'gen/look.png', flatout: 'gen/flatout.png' },
		};
	}

	/* -------------------------------------------------------------- split --- */

	/**
	 * split：宿主侧 Python 成层（无浏览器）。
	 * @param {any} job
	 * @param {{ force?: boolean }} [runOptions]
	 */
	function split(job, runOptions = {}) {
		const out = join(jobDir(job.id), 'layers');
		mkdirSync(out, { recursive: true });
		const args = [
			join(repoRoot, 'tools', 'diy', 'split_layers.py'),
			'--look', join(jobDir(job.id), 'gen', 'look.png'),
			'--flatout', join(jobDir(job.id), 'gen', 'flatout.png'),
			'--hair', join(repoRoot, 'docs', 'dress-up', 'art', 'diy', 'masks', 'chibi', 'hair.webp'),
			'--arms', join(repoRoot, 'docs', 'dress-up', 'art', 'diy', 'masks', 'chibi', 'arms.webp'),
			'--category', job.input.category,
			'--out', out,
		];
		const result = runPython({ script: args[0], argv: args.slice(1), cwd: repoRoot, timeoutMs: 180_000 });
		const parsed = parseLastJsonLine(result.stdout) || parseLastJsonLine(result.stderr);
		if (!parsed) {
			throw new DiyPipelineError('split_failed', `split 没有返回 JSON（exit ${result.status}）`, {
				stderr: sanitizeProviderError(result.stderr).slice(-400),
			});
		}
		if (parsed.ok !== true || result.status !== 0) {
			throw new DiyPipelineError('split_failed', parsed.reason || '自动成层失败', {
				reason: parsed.reason || null,
				grade: parsed.grade || 'fail',
				defects: parsed.defects || [],
			});
		}
		logger.info?.(`[diy] ${job.id} split: grade=${parsed.grade} threshold=${parsed.qa && parsed.qa.threshold}`);
		return {
			stage: 'split',
			grade: parsed.grade || 'pass',
			defects: parsed.defects || [],
			qa: parsed.qa || null,
			hasSleeve: Boolean(parsed.hasSleeve),
			artifacts: { layers: 'layers' },
			force: runOptions.force === true,
		};
	}

	/* --------------------------------------------------------------- bind --- */

	/**
	 * bind：增量 outfit pack（不复制 base rig）。
	 * @param {any} job
	 * @param {{ force?: boolean }} [runOptions]
	 */
	function bind(job, runOptions = {}) {
		const out = join(jobDir(job.id), 'pack');
		const args = [
			join(repoRoot, 'tools', 'diy', 'bind_layers.py'),
			'--layers', join(jobDir(job.id), 'layers'),
			'--base-rig', join(repoRoot, 'docs', 'dress-up', 'art', '2d5', job.input.shape, 'rig.json'),
			'--item-id', job.id,
			'--category', job.input.category,
			'--name', job.input.name,
			'--out', out,
		];
		const result = runPython({ script: args[0], argv: args.slice(1), cwd: repoRoot, timeoutMs: 180_000 });
		const parsed = parseLastJsonLine(result.stdout) || parseLastJsonLine(result.stderr);
		if (!parsed || parsed.ok !== true || result.status !== 0) {
			throw new DiyPipelineError('bind_failed', (parsed && parsed.message) || '自动绑定失败', {
				errors: (parsed && parsed.errors) || [],
				stderr: sanitizeProviderError(result.stderr).slice(-400),
			});
		}
		const report = readJsonSafe(join(out, 'bind-report.json')) || {};
		const pack = readJsonSafe(join(out, 'diy-pack.json')) || {};
		const baseRig = readBaseRigInfo(job.input.shape);
		const packBones = Number(pack.base && pack.base.skeletonBones) || 0;
		const baseBones = baseRig ? baseRig.bones : 0;
		const skeleton = { packBones, baseBones, legacy: Boolean(baseBones && packBones > 0 && packBones < baseBones) };
		logger.info?.(`[diy] ${job.id} bind: verts=${parsed.verts} tris=${parsed.tris} coverage=${parsed.coverage && parsed.coverage.alphaCovered} skeleton=${packBones}/${baseBones}`);
		return {
			stage: 'bind',
			itemId: job.id,
			verts: parsed.verts,
			tris: parsed.tris,
			coverage: parsed.coverage || report.coverage || null,
			drawables: report.drawables || [],
			skirtCfg: report.skirtCfg || null,
			skeleton,
			artifacts: { pack: 'pack' },
			force: runOptions.force === true,
		};
	}

	/* ----------------------------------------------------------------- qa --- */

	/**
	 * qa：宿主结构 QA；未过 → fallback=static（不阻塞安装）。
	 * @param {any} job
	 * @param {{ force?: boolean }} [runOptions]
	 */
	function qa(job, runOptions = {}) {
		const packDir = join(jobDir(job.id), 'pack');
		const checks = [];
		/** @param {string} name @param {boolean} ok @param {unknown} [value] */
		const add = (name, ok, value) => checks.push({ name, ok, value: value === undefined ? null : value });
		const warnings = [];
		const splitData = readJsonSafe(join(jobDir(job.id), 'layers', 'split.json')) || {};
		const bindReport = readJsonSafe(join(packDir, 'bind-report.json')) || {};
		const pack = readJsonSafe(join(packDir, 'diy-pack.json'));
		add('split_grade', splitData.ok === true && splitData.grade !== 'fail', splitData.grade || null);
		add('pack_present', Boolean(pack), null);
		if (pack) {
			add('pack_format', pack.format === DIY_PACK_FORMAT && pack.formatVersion === DIY_PACK_FORMAT_VERSION, pack.formatVersion || null);
			const drawables = Array.isArray(pack.drawables) ? pack.drawables : [];
			add('drawables_present', drawables.length >= 1 && drawables.length <= 2, drawables.length);
			const bones = Number(pack.base && pack.base.skeletonBones) || 0;
			const baseRig = readBaseRigInfo(job.input.shape);
			const baseBones = baseRig ? baseRig.bones : 0;
			const legacySkeleton = Boolean(baseBones && bones > 0 && bones < baseBones);
			const skeletonOk = baseBones ? bones > 0 && bones <= baseBones : bones > 0;
			add('base_skeleton', skeletonOk, { packBones: bones, baseBones, legacy: legacySkeleton });
			if (legacySkeleton) warnings.push(`legacy_skeleton:${bones}<${baseBones}`);
			if (baseRig && Array.isArray(pack.base && pack.base.boneNames)) {
				const packBoneNames = pack.base.boneNames;
				const namesOk = packBoneNames.length === bones
					&& packBoneNames.every((name, i) => String(name) === baseRig.boneNames[i]);
				add('skeleton_names', namesOk, packBoneNames.length);
			}
			let meshOk = true;
			let texOk = true;
			let texBytes = 0;
			let totalVerts = 0;
			let totalTris = 0;
			for (const drawable of drawables) {
				if (!drawable || !drawable.mesh || !drawable.texture || !drawable.rect || !drawable.texSize) {
					meshOk = false;
					continue;
				}
				const mesh = drawable.mesh;
				const verts = Array.isArray(mesh.positions) ? mesh.positions.length : 0;
				totalVerts += verts;
				totalTris += Array.isArray(mesh.indices) ? Math.floor(mesh.indices.length / 3) : 0;
				meshOk = meshOk && verts > 0
					&& Array.isArray(mesh.uvs) && mesh.uvs.length === verts
					&& Array.isArray(mesh.bones) && mesh.bones.length === verts
					&& Array.isArray(mesh.weights) && mesh.weights.length === verts
					&& Array.isArray(mesh.indices) && mesh.indices.length % 3 === 0;
				if (!meshOk) continue;
				for (const uv of mesh.uvs) {
					if (!Array.isArray(uv) || uv.length !== 2 || uv[0] < 0 || uv[0] > 1 || uv[1] < 0 || uv[1] > 1) {
						meshOk = false;
						break;
					}
				}
				for (const index of mesh.indices) {
					if (!Number.isInteger(index) || index < 0 || index >= verts) {
						meshOk = false;
						break;
					}
				}
				for (const [rowBones, rowWeights] of mesh.bones.map((row, i) => [row, mesh.weights[i]])) {
					if (!Array.isArray(rowBones) || rowBones.length !== 4 || !Array.isArray(rowWeights) || rowWeights.length !== 4) {
						meshOk = false;
						break;
					}
					if (rowBones.some((bone) => !Number.isInteger(bone) || bone < 0 || bone >= bones)) {
						meshOk = false;
						break;
					}
					const sum = rowWeights.reduce((total, weight) => total + Number(weight), 0);
					if (Math.abs(sum - 1) > 0.02) {
						meshOk = false;
						break;
					}
				}
				const texPath = join(packDir, drawable.texture);
				if (!existsSync(texPath) || statSync(texPath).size < 512) {
					texOk = false;
				} else {
					texBytes += statSync(texPath).size;
				}
			}
			add('mesh_valid', meshOk, { totalVerts, totalTris });
			add('textures_valid', texOk, { texBytes });
			const coverage = bindReport.coverage || {};
			add('alpha_coverage', Number(coverage.alphaCovered) >= 0.97, coverage.alphaCovered ?? null);
			add('coverage_iou', Number(coverage.coverageIoU) >= 0.75, coverage.coverageIoU ?? null);
			add('alpha_area', Number(coverage.alphaAreaFrac) >= 0.004 && Number(coverage.alphaAreaFrac) <= 0.32, coverage.alphaAreaFrac ?? null);
			const outfits = pack.outfits && typeof pack.outfits === 'object' ? Object.entries(pack.outfits) : [];
			add('outfit_present', outfits.length === 1 && outfits[0][0].startsWith('diy-'), outfits.length);
			if (outfits.length === 1) {
				const outfit = outfits[0][1];
				const ids = new Set(drawables.map((item) => item.id));
				const referenced = [outfit.topBody, outfit.bottom, outfit.sleeve, outfit.topUnder].flat().filter(Boolean);
				add('outfit_refs', referenced.some((id) => ids.has(id)), referenced.length);
			}
			if (splitData.defects && splitData.defects.length) warnings.push(...splitData.defects.map((defect) => `split:${defect}`));
			if (bindReport.alphaClean && bindReport.alphaClean.body && bindReport.alphaClean.body.removedComponents > 0) {
				warnings.push(`alpha 清理移除 ${bindReport.alphaClean.body.removedComponents} 个残留小块`);
			}
		}
		const pass = checks.every((check) => check.ok);
		const baseRig = readBaseRigInfo(job.input.shape);
		const packBones = Number(pack && pack.base && pack.base.skeletonBones) || 0;
		const baseBones = baseRig ? baseRig.bones : 0;
		const result = {
			version: 1,
			pass,
			grade: splitData.grade || (pass ? 'pass' : 'fail'),
			fallback: pass ? 'none' : 'static',
			animated: pass,
			skeleton: { packBones, baseBones, legacy: Boolean(baseBones && packBones > 0 && packBones < baseBones) },
			checks,
			warnings,
			metrics: {
				coverage: bindReport.coverage || null,
				drawables: bindReport.drawables || [],
				split: splitData.qa || null,
				sleeve: Boolean(bindReport.sleeve),
			},
		};
		writeJsonAtomic(join(jobDir(job.id), 'qa', 'qa.json'), result);
		logger.info?.(`[diy] ${job.id} qa: ${pass ? 'pass' : 'FAIL → fallback=static'}`);
		return { stage: 'qa', ...result, artifacts: { qa: 'qa/qa.json' }, force: runOptions.force === true };
	}

	/* ------------------------------------------------------------ install --- */

	/**
	 * install：复制 pack 到 packs/<itemId> + 原子更新 registry.json（--dry-run 只返回计划）。
	 * @param {any} jobInput job 对象或 job id
	 * @param {{ dryRun?: boolean, force?: boolean }} [installOptions]
	 */
	function install(jobInput, installOptions = {}) {
		const job = typeof jobInput === 'string' ? loadJob(jobInput) : jobInput;
		const qaResult = readJsonSafe(join(jobDir(job.id), 'qa', 'qa.json'));
		if (!qaResult) throw new DiyPipelineError('qa_missing', 'QA 未运行或已失效，不能安装');
		const itemId = job.itemId || job.id;
		if (!/^[a-z0-9][a-z0-9-]{2,80}$/.test(itemId)) throw new DiyPipelineError('bad_argument', 'itemId 非法');
		const targetDir = join(packsDir, itemId);
		const registry = readJsonSafe(registryPath) || { version: 1, items: {} };
		if (!registry.items || typeof registry.items !== 'object') registry.items = {};
		const entry = {
			id: itemId,
			name: job.input.name,
			shape: job.input.shape,
			category: job.input.category,
			createdAt: job.createdAt,
			updatedAt: new Date(now()).toISOString(),
			packDir: `packs/${itemId}`,
			animated: qaResult.pass === true,
			fallback: qaResult.pass === true ? 'none' : 'static',
			skeleton: qaResult.skeleton || null,
			qa: {
				pass: qaResult.pass === true,
				grade: qaResult.grade,
				coverage: qaResult.metrics && qaResult.metrics.coverage,
				split: qaResult.metrics && qaResult.metrics.split,
				checks: Array.isArray(qaResult.checks) ? qaResult.checks.map((check) => check.name) : [],
			},
			policy: contentPolicyTag('pass'),
			guardVersion: DIY_GUARD_VERSION,
			seedream: {
				images: job.stages && job.stages.generate && job.stages.generate.data ? job.stages.generate.data.images || 0 : 0,
				costYuan: job.stages && job.stages.generate && job.stages.generate.data ? job.stages.generate.data.costYuan || 0 : 0,
				hitCache: Boolean(job.stages && job.stages.generate && job.stages.generate.data && job.stages.generate.data.cacheHit),
			},
		};
		if (qaResult.pass !== true) {
			const layers = join(jobDir(job.id), 'layers');
			entry.static = { body: 'static/body.png', sleeve: existsSync(join(layers, 'sleeve.png')) ? 'static/sleeve.png' : null };
		}
		if (installOptions.dryRun) {
			return {
				ok: true, dryRun: true, itemId, animated: entry.animated, fallback: entry.fallback,
				packDir: `packs/${itemId}`, registry: homeRelative(registryPath), wouldCopy: [jobDir(job.id) + '/pack'],
			};
		}
		mkdirSync(packsDir, { recursive: true });
		if (existsSync(targetDir)) rmSync(targetDir, { recursive: true, force: true });
		cpSync(join(jobDir(job.id), 'pack'), targetDir, { recursive: true });
		if (entry.static) {
			mkdirSync(join(targetDir, 'static'), { recursive: true });
			const layers = join(jobDir(job.id), 'layers');
			copyFileSync(join(layers, 'body.png'), join(targetDir, 'static', 'body.png'));
			if (entry.static.sleeve) copyFileSync(join(layers, 'sleeve.png'), join(targetDir, 'static', 'sleeve.png'));
		}
		registry.version = 1;
		registry.updatedAt = new Date(now()).toISOString();
		registry.items[itemId] = entry;
		writeJsonAtomic(registryPath, registry);
		writeJsonAtomic(join(jobDir(job.id), 'install.json'), {
			itemId, installedAt: entry.updatedAt, packDir: entry.packDir, registry: homeRelative(registryPath),
		});
		logger.info?.(`[diy] ${job.id} install: ${itemId} animated=${entry.animated} fallback=${entry.fallback}`);
		return {
			ok: true, itemId, animated: entry.animated, fallback: entry.fallback,
			packDir: entry.packDir, registry: homeRelative(registryPath),
			static: entry.static || null,
		};
	}

	/* ------------------------------------------------------------- run/status -- */

	/**
	 * run：按阶段顺序执行（幂等；已完成阶段跳过，--force 重跑）。
	 * @param {{ job: string, stage?: string, force?: boolean }} input
	 */
	async function run(input) {
		try {
			assertEnabled();
		} catch (error) {
			const pipelineError = toPipelineError(error);
			return {
				ok: false, job: String(input.job || ''), itemId: null, stage: 'preflight',
				code: pipelineError.code, message: pipelineError.message,
				stages: null, hints: pipelineHints(pipelineError.code),
			};
		}
		const job = loadJob(input.job);
		const startStage = input.stage && input.stage !== 'all' ? String(input.stage) : 'generate';
		if (!DIY_STAGES.includes(startStage)) {
			throw new DiyPipelineError('bad_argument', `未知阶段：${startStage}（可选 ${DIY_STAGES.join('/')}/all）`);
		}
		const from = DIY_STAGES.indexOf(startStage);
		const results = {};
		job.status = 'running';
		saveJob(job);
		for (const stage of DIY_STAGES.slice(from)) {
			const previous = job.stages[stage];
			if (previous && previous.status === 'success' && !input.force) {
				results[stage] = { status: 'skipped', data: previous.data || null };
				continue;
			}
			const startedAt = now();
			try {
				let data;
				if (stage === 'generate') data = await generate(job);
				else if (stage === 'split') data = split(job);
				else if (stage === 'bind') data = bind(job);
				else if (stage === 'qa') data = qa(job);
				else data = install(job);
				job.stages[stage] = {
					status: 'success',
					startedAt: new Date(startedAt).toISOString(),
					endedAt: new Date(now()).toISOString(),
					ms: now() - startedAt,
					data,
				};
				results[stage] = { status: 'success', data };
				saveJob(job);
			} catch (error) {
				const pipelineError = toPipelineError(error);
				job.stages[stage] = {
					status: 'failed',
					startedAt: new Date(startedAt).toISOString(),
					endedAt: new Date(now()).toISOString(),
					ms: now() - startedAt,
					code: pipelineError.code,
					message: pipelineError.message,
					details: pipelineError.details,
				};
				job.status = 'failed';
				saveJob(job);
				return {
					ok: false,
					job: job.id,
					stage,
					code: pipelineError.code,
					message: pipelineError.message,
					details: pipelineError.details,
					stages: stageStatuses(job),
					hints: pipelineHints(pipelineError.code),
				};
			}
		}
		job.status = 'done';
		saveJob(job);
		const installed = job.stages.install && job.stages.install.status === 'success' ? job.stages.install.data : null;
		const qaResult = readJsonSafe(join(jobDir(job.id), 'qa', 'qa.json'));
		return {
			ok: true,
			job: job.id,
			itemId: job.itemId,
			stage: 'all',
			stages: stageStatuses(job),
			qa: qaResult ? { pass: qaResult.pass, grade: qaResult.grade, fallback: qaResult.fallback } : null,
			install: installed,
			results,
		};
	}

	/** @param {any} job */
	function stageStatuses(job) {
		/** @type {Record<string, string>} */
		const out = {};
		for (const stage of DIY_STAGES) {
			const entry = job.stages && job.stages[stage];
			out[stage] = entry ? entry.status || 'unknown' : 'pending';
		}
		return out;
	}

	/**
	 * status：读 job 记录 + 可选 QA/install 产物。
	 * @param {{ job: string }} input
	 */
	function status(input) {
		const job = loadJob(input.job);
		const qaResult = readJsonSafe(join(jobDir(job.id), 'qa', 'qa.json'));
		const installData = readJsonSafe(join(jobDir(job.id), 'install.json'));
		return {
			ok: true,
			job: job.id,
			itemId: job.itemId,
			status: job.status,
			category: job.input.category,
			name: job.input.name,
			stages: stageStatuses(job),
			stageData: Object.fromEntries(DIY_STAGES.map((stage) => [stage, job.stages && job.stages[stage] ? job.stages[stage].data || null : null])),
			qa: qaResult ? {
				pass: qaResult.pass, grade: qaResult.grade, fallback: qaResult.fallback,
				checks: Array.isArray(qaResult.checks) ? qaResult.checks.filter((check) => !check.ok) : [],
				metrics: qaResult.metrics || null, warnings: qaResult.warnings || [],
			} : null,
			install: installData,
			artifacts: collectArtifacts(jobDir(job.id)),
			warnings: job.warnings || [],
		};
	}

	/** @param {string} dir */
	function collectArtifacts(dir) {
		/** @type {Record<string, string>} */
		const artifacts = {};
		for (const rel of ['gen/look.png', 'gen/flatout.png', 'layers/body.png', 'layers/sleeve.png', 'layers/split.json', 'pack/diy-pack.json', 'pack/bind-report.json', 'qa/qa.json', 'install.json']) {
			if (existsSync(join(dir, rel))) artifacts[rel] = join(dir, rel);
		}
		return artifacts;
	}

	/** list：registry 里的已安装项。 */
	function list() {
		const registry = readJsonSafe(registryPath) || { version: 1, items: {} };
		const items = Object.values(registry.items || {});
		items.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
		return {
			ok: true,
			home,
			registry: homeRelative(registryPath),
			count: items.length,
			items: items.map((item) => ({
				id: item.id, name: item.name, shape: item.shape, category: item.category,
				animated: item.animated, fallback: item.fallback,
				qa: item.qa ? { pass: item.qa.pass, grade: item.qa.grade } : null,
				packDir: item.packDir, updatedAt: item.updatedAt, seedream: item.seedream,
			})),
		};
	}

	/**
	 * remove：删除 registry 项与 pack 目录（--dry-run 只返回计划）。
	 * @param {{ id: string, dryRun?: boolean }} input
	 */
	function remove(input) {
		const id = String(input.id || '');
		if (!/^[a-z0-9][a-z0-9-]{2,80}$/.test(id)) throw new DiyPipelineError('bad_argument', 'itemId 非法');
		const registry = readJsonSafe(registryPath) || { version: 1, items: {} };
		const entry = registry.items && registry.items[id];
		if (!entry) throw new DiyPipelineError('not_found', `已安装衣柜里没有 ${id}`);
		const target = resolve(home, entry.packDir || `packs/${id}`);
		if (!target.startsWith(packsDir + sep)) throw new DiyPipelineError('bad_path', 'pack 目录不在 DIY 数据目录内');
		if (input.dryRun) {
			return { ok: true, dryRun: true, id, wouldDelete: homeRelative(target), registry: homeRelative(registryPath) };
		}
		if (existsSync(target)) rmSync(target, { recursive: true, force: true });
		delete registry.items[id];
		registry.updatedAt = new Date(now()).toISOString();
		writeJsonAtomic(registryPath, registry);
		return { ok: true, id, removed: true, registry: homeRelative(registryPath) };
	}

	return {
		version: DIY_PIPELINE_VERSION,
		home,
		jobsDir,
		packsDir,
		registryPath,
		plan,
		run,
		status,
		install,
		list,
		remove,
		/** 测试/诊断用：只跑单阶段（不写 job 状态）。 */
		stages: { generate, split, bind, qa, install },
	};
}

/* ------------------------------------------------------------------ utils -- */

/**
 * @param {string} stdout
 * @returns {any | null}
 */
function parseLastJsonLine(stdout) {
	const lines = String(stdout || '').trim().split(/\r?\n/).filter(Boolean);
	for (let i = lines.length - 1; i >= 0; i -= 1) {
		try {
			return JSON.parse(lines[i]);
		} catch {
			/* 继续找上一行 */
		}
	}
	return null;
}

/**
 * @param {unknown} error
 * @returns {DiyPipelineError}
 */
function toPipelineError(error) {
	if (error instanceof DiyPipelineError) return error;
	const message = sanitizeProviderError(error instanceof Error ? error.message : String(error));
	return new DiyPipelineError('internal_error', message || 'DIY 流水线内部错误');
}

/**
 * 错误码 → agent 可执行的下一步建议。
 * @param {string} code
 * @returns {string[]}
 */
function pipelineHints(code) {
	const hints = {
		diy_disabled: ['在 cordis.patch.yml 的 diy.enabled=true 后重试（默认关闭是安全设计）'],
		guard_rejected: ['换一件更保守的日常服装图片，或换个描述再试'],
		missing_api_key: ['在宿主 ~/.config/seedream/env 配置 ARK_API_KEY（不要把 key 发给 agent/前端）'],
		api_failed: ['稍后重试；同一张图重抽可用 --reroll N 换 seed'],
		split_failed: ['换一张白底/挂拍衣服图；或降低复杂度（纯色/简单图案）'],
		bind_failed: ['自动绑定失败，可回退静态贴片路径；把 job 目录发给开发者'],
		qa_failed: ['QA 未过：检查 qa/qa.json 的 failed checks；可回退静态贴片'],
		budget_exceeded: ['检查 dailyImageLimit/dailyBudgetYuan；或明天再试'],
		daily_image_limit: ['今日图片额度已用完，明天再试或调高 dailyImageLimit'],
		daily_budget_exceeded: ['今日预算已用完，明天再试或调高 dailyBudgetYuan'],
		image_missing: ['给出图片的本地绝对路径'],
		image_unsupported: ['转成 PNG/JPEG/WebP 再试'],
		unsupported_category: ['--category 选 top/bottom/dress/coat/outfit'],
		unsupported_shape: ['S2 仅 chibi 身形'],
		job_not_found: ['先 dsh-feiyu-diy plan --image <path>，再用返回的 job id'],
		not_found: ['dsh-feiyu-diy list 查看已安装项'],
		diy_disabled_install: ['DIY 未开启时不能安装'],
	};
	return hints[code] || ['查看 job 目录的 job.json / qa.json 排查'];
}

/**
 * @param {{ script: string, argv: string[], cwd: string, timeoutMs: number }} args
 */
function defaultRunPython(args) {
	const result = spawnSync(process.env.DSH_FEIYU_PYTHON || 'python3', [args.script, ...args.argv], {
		cwd: args.cwd,
		timeout: args.timeoutMs,
		encoding: 'utf8',
		maxBuffer: 8 * 1024 * 1024,
	});
	return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

/**
 * 便捷：构造 pipeline 的默认配置（CLI/测试用；不读 profile）。
 * @param {{ statePath?: string }} [overrides]
 */
export function defaultPipelineConfig(overrides = {}) {
	return validateConfig(overrides);
}

/** 默认 DIY 数据目录（与 CLI/文档一致；~/.dsh/feiyu/diy）。 */
export function defaultDiyHome() {
	return join(homedir(), '.dsh', 'feiyu', 'diy');
}
