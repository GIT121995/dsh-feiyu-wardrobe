/**
 * 换装间本地静态路由：把 docs/dress-up 里的游戏页、图层素材从宿主本地发出去，
 * 换装间因此离线可用，不再依赖 GitHub Pages。
 *
 * 路由：`/feiyu/dress-up/*`（prefix）。只应答 GET/HEAD；拒绝目录穿越；
 * 未知路径 404；非 GET/HEAD 405。素材是公开静态文件，不做鉴权。
 *
 * @module dsh-feiyu-wardrobe/webserver
 */

import { readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants as zlibConstants, gzipSync } from 'node:zlib';

/** 换装间路由前缀（客户端半区 iframe 也用它）。 */
export const DRESS_UP_PATH = '/feiyu/dress-up';
/** 换装间入口（带尾斜杠，相对路径才能解析）。 */
export const DRESS_UP_ENTRY = `${DRESS_UP_PATH}/`;
/** 换装间客户端配置端点（v2：只含互动端点发现；静态托管时 404 → local-only）。 */
export const DRESS_UP_CLIENT_CONFIG = `${DRESS_UP_ENTRY}client-config.json`;
/** 换装间客户端配置端点版本（v4：interaction 段 + 版本化资产信息（rig.bin + 懒加载图集页），供客户端后台 prefetch）。 */
export const DRESS_UP_CONFIG_VERSION = 4;
/** M5 互动状态（只读聚合；no-store；无台词文本）。 */
export const DRESS_UP_INTERACTION_STATE = `${DRESS_UP_ENTRY}interaction-state.json`;
/** M5 互动动作（POST；宿主侧唯一经济写入）。 */
export const DRESS_UP_INTERACTION_ACTION = `${DRESS_UP_ENTRY}interaction`;
const INTERACTION_MAX_BODY_BYTES = 2048;
const INTERACTION_BUCKET_CAPACITY = 5;
const INTERACTION_REFILL_MS = 2000;

const MIME = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.webp': 'image/webp',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.svg': 'image/svg+xml',
	'.ico': 'image/x-icon',
	'.woff2': 'font/woff2',
	'.txt': 'text/plain; charset=utf-8',
	'.map': 'application/json; charset=utf-8',
};

const CACHE_CONTROL = 'public, max-age=600';
/** 带 `?v=` 的版本化静态资源：内容变更必须升版本号（页面/资产版本门禁），可安全长缓存 immutable。 */
const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';
const MISSING = new Set(['ENOENT', 'EISDIR', 'ENOTDIR', 'ENAMETOOLONG']);

/**
 * 可压缩的文本/二进制类型（2.5D 首屏 payload 关键项：rig.json / rig.bin / 图集页同源）。
 * v3.2.0：支持 brotli（br 优先；`.bin` 的 brotli 预压缩产物由构建期生成，见 tools/art/build_2d5.py）。
 */
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.json', '.svg', '.txt', '.map', '.mjs', '.bin']);
/** 压缩缓存上限（条；值形如 { buffer: Buffer, size, mtimeMs }，br/gzip 各一份缓存）。 */
const COMPRESSION_CACHE_LIMIT = 16;
/** 小于该字节数不压缩（头部开销不值得）。 */
const COMPRESS_MIN_BYTES = 1024;
/** 动态 brotli 质量（q5 在本机 ~40ms/1.6MB，q11 需 ~2.4s 不适合请求期；rig.bin 走构建期 q11 预压缩）。 */
const BROTLI_DYNAMIC_QUALITY = 5;
/** 构建期预压缩产物后缀（如 rig.bin.br）。 */
const BROTLI_PRECOMPRESSED_SUFFIX = '.br';

/**
 * 解析包内换装间素材目录（docs/dress-up）。
 * @param {string} [baseUrl] 覆盖牌 module url（测试用）
 * @returns {string}
 */
export function dressUpRoot(baseUrl = import.meta.url) {
	return fileURLToPath(new URL('../docs/dress-up/', baseUrl));
}

/**
 * 静态资源缓存头（v3.0.1）：带 `?v=` 的版本化资源长缓存 immutable（内容变了必须升版本号，
 * 浏览器/中间代理可放心沿用）；不带版本号的入口/样式等仍短缓存，保证宿主升级后能及时生效。
 * client-config/interaction 端点不走这里（仍然 no-store）。
 * @param {boolean} versioned 请求是否带 `?v=` 版本参数
 * @returns {string}
 */
export function staticCacheControl(versioned) {
	return versioned ? IMMUTABLE_CACHE_CONTROL : CACHE_CONTROL;
}

/**
 * 读取页面源码里的资产版本号（单一真相：docs/dress-up/app.js 的 RUNTIME_2D5_ASSET_VERSION）。
 * 供 client-config 下发，宿主侧后台 prefetch 时拼出与页面完全一致的 `?v=` URL（避免无效预取）。
 * @param {string} root 素材根目录（docs/dress-up 的绝对路径）
 * @returns {string | null}
 */
function readPageAssetVersion(root) {
	try {
		const source = readFileSync(join(root, 'app.js'), 'utf8');
		const match = source.match(/RUNTIME_2D5_ASSET_VERSION\s*=\s*'(\d+)'/);
		return match ? match[1] : null;
	} catch {
		return null;
	}
}

/**
 * 版本化 2.5D 资产清单（client-config 下发；客户端按连接条件后台 prefetch 用）。
 * 形状列表取自页面 manifest.json（单一真相），文件命名遵循 2.5D 构建约定。
 * @param {string} root
 * @returns {{ version: string, base: string, shapes: string[], files: { lo: string[], hi: string[] } } | null}
 */
function readAssetPrefetchInfo(root) {
	const version = readPageAssetVersion(root);
	if (!version) return null;
	/** @type {string[]} */
	let shapes = ['chibi', 'girl'];
	try {
		const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
		if (Array.isArray(manifest.shapes)) {
			const ids = manifest.shapes.map((shape) => (typeof shape === 'string' ? shape : shape && shape.id)).filter((id) => typeof id === 'string' && id);
			if (ids.length > 0) shapes = ids;
		}
	} catch {
		/* manifest 缺失时用默认两身形 */
	}
	return {
		version,
		base: `${DRESS_UP_ENTRY}art/2d5/`,
		shapes,
		// v3.2.0：rig.bin（二进制 rig，brotli 预压缩）+ lazy outfit page（base=atlas.webp，
		// 套装页 atlas-2…atlas-5；hi tier 首个图集页是 2x base 页，套装页为 1x）
		files: {
			lo: ['rig.bin', 'atlas.webp', 'atlas-2.webp', 'atlas-3.webp', 'atlas-4.webp', 'atlas-5.webp'],
			hi: ['rig.bin', 'atlas.webp'],
		},
	};
}

/**
 * 把请求路径映射成素材目录内的相对路径；非法/穿越返回 null。
 * @param {string} pathname 已解码的 URL pathname
 * @returns {string | null}
 */
function relativeAssetPath(pathname) {
	if (!pathname.startsWith(DRESS_UP_ENTRY)) return null;
	let relative = pathname.slice(DRESS_UP_ENTRY.length);
	if (relative === '') relative = 'index.html';
	else if (relative.endsWith('/')) relative += 'index.html';
	if (relative.includes('\0')) return null;
	return relative;
}

/**
 * Send a JSON response with `no-store` (interaction endpoints must not be cached).
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} payload
 * @param {boolean} [headOnly]
 */
function sendJsonNoStore(res, status, payload, headOnly = false) {
	const body = Buffer.from(JSON.stringify(payload), 'utf8');
	res.writeHead(status, {
		'content-type': 'application/json; charset=utf-8',
		'content-length': String(body.byteLength),
		'cache-control': 'no-store',
	});
	res.end(headOnly ? undefined : body);
}

/**
 * Read a bounded JSON object body (mirrors lib/diy.js readJsonBody).
 * @param {import('node:http').IncomingMessage} req
 * @param {number} maxBytes
 * @returns {Promise<Record<string, unknown>>}
 */
async function readJsonBody(req, maxBytes) {
	/** @type {Buffer[]} */
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += buffer.length;
		if (size > maxBytes) {
			const error = new Error('body_too_large');
			// @ts-expect-error status code attached for callers
			error.status = 413;
			throw error;
		}
		chunks.push(buffer);
	}
	if (size === 0) {
		const error = new Error('body_empty');
		// @ts-expect-error status code attached for callers
		error.status = 400;
		throw error;
	}
	let parsed;
	try {
		parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
	} catch {
		const error = new Error('invalid_json');
		// @ts-expect-error status code attached for callers
		error.status = 400;
		throw error;
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		const error = new Error('invalid_json');
		// @ts-expect-error status code attached for callers
		error.status = 400;
		throw error;
	}
	return parsed;
}

/**
 * Same-origin guard for interaction POST (mirrors lib/diy.js isSameOrigin).
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
 * In-process token bucket for interaction writes (best-effort CSRF/abuse guard).
 * @param {{ capacity?: number, refillMs?: number, now?: () => number }} [options]
 */
function createTokenBucket(options = {}) {
	const capacity = options.capacity ?? INTERACTION_BUCKET_CAPACITY;
	const refillMs = options.refillMs ?? INTERACTION_REFILL_MS;
	const now = options.now ?? (() => Date.now());
	let tokens = capacity;
	let last = now();
	return {
		/** @param {number} [at] */
		take(at = now()) {
			const elapsed = Math.max(0, at - last);
			tokens = Math.min(capacity, tokens + elapsed / refillMs);
			last = at;
			if (tokens >= 1) {
				tokens -= 1;
				return true;
			}
			return false;
		},
		/** @param {number} [at] */
		retryInMs(at = now()) {
			const elapsed = Math.max(0, at - last);
			const available = Math.min(capacity, tokens + elapsed / refillMs);
			return available >= 1 ? 0 : Math.ceil((1 - available) * refillMs);
		},
	};
}

/**
 * 创建一个能直接挂到 ctx.webServer.register 的 handler。
 *
 * 额外能力（v3.0.1）：
 * - `client-config.json`：换装间客户端配置（互动端点发现 + 版本化 2.5D 资产清单供 prefetch），
 *   `no-store` 保证宿主改配置后页面刷新即生效；
 * - 文本/二进制资产按 `Accept-Encoding` 压缩：brotli 优先（构建期 `.br` 预压缩产物直接用；
 *   缺失时 q5 动态压缩 + mtime+size 失效的进程内缓存），gzip 9 回退；2.5D rig 首屏传输
 *   从 1.6MB 降到 ~131KB（rig.bin.br）——v3.2.0；
 * - 带 `?v=` 的版本化静态资源返回 `public, max-age=31536000, immutable` 长缓存
 *   （内容变更必须升页面/资产版本号），入口/未版本化资源仍 10 分钟短缓存。
 *
 * @param {string} rootDir 素材根目录（docs/dress-up 的绝对路径）
 * @param {{
 *   interaction?: {
 *     enabled?: boolean,
 *     summary?: (now?: number) => object,
 *     act?: (kind: string, payload: object, now?: number) => { ok: boolean, reason?: string, retryInMs?: number, state?: object },
 *   },
 *   now?: () => number,
 * }} [options] 换装间配置（interaction 为互动端点，默认关闭除非显式传入）
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function createDressUpHandler(rootDir, options = {}) {
	const root = resolve(rootDir);
	const interaction = options.interaction || null;
	const interactionEnabled = !!(interaction && interaction.enabled !== false && typeof interaction.summary === 'function' && typeof interaction.act === 'function');
	const now = typeof options.now === 'function' ? options.now : () => Date.now();
	const bucket = createTokenBucket({ now });
	/** @type {Map<string, { buffer: Buffer, size: number, mtimeMs: number }>} */
	const brCache = new Map();
	/** @type {Map<string, { buffer: Buffer, size: number, mtimeMs: number }>} */
	const gzipCache = new Map();
	// 版本化资产信息（启动时从页面源码/manifest 读取一次；文件缺失时为 null，客户端跳过 prefetch）
	const assetPrefetch = readAssetPrefetchInfo(root);

	/** @param {import('node:http').ServerResponse} res @param {number} status */
	const end = (res, status, headers) => {
		res.writeHead(status, headers);
		res.end();
	};

	/**
	 * 读取构建期 brotli 预压缩产物（`<file>.br`）。仅当其 mtime 不早于源文件时使用，
	 * 防止构建/发布顺序错位导致发陈旧内容；读取失败返回 null 走动态压缩。
	 * @param {string} target 源文件绝对路径
	 * @param {import('node:fs').Stats} fileStat 源文件 stat
	 * @returns {Promise<Buffer | null>}
	 */
	async function readPrecompressedBrotli(target, fileStat) {
		const brPath = target + BROTLI_PRECOMPRESSED_SUFFIX;
		try {
			const [buffer, brStat] = await Promise.all([readFile(brPath), stat(brPath)]);
			if (buffer.byteLength < 16) return null;
			if (brStat.mtimeMs + 1000 < fileStat.mtimeMs) return null; // 陈旧预压缩产物：宁可动态压缩
			return buffer;
		} catch {
			return null;
		}
	}

	/**
	 * 动态 brotli 压缩（带 size+mtime 进程内缓存；失败返回 null 让调用方回退 gzip）。
	 * @param {string} target
	 * @param {Buffer} body
	 * @param {import('node:fs').Stats} fileStat
	 * @param {Map<string, { buffer: Buffer, size: number, mtimeMs: number }>} cache
	 * @returns {Promise<Buffer | null>}
	 */
	async function dynamicBrotli(target, body, fileStat, cache) {
		const cached = cache.get(target);
		if (cached && cached.size === body.byteLength && cached.mtimeMs === fileStat.mtimeMs) return cached.buffer;
		try {
			const buffer = brotliCompressSync(body, {
				params: {
					[zlibConstants.BROTLI_PARAM_QUALITY]: BROTLI_DYNAMIC_QUALITY,
					[zlibConstants.BROTLI_PARAM_MODE]: zlibConstants.BROTLI_MODE_TEXT,
					[zlibConstants.BROTLI_PARAM_SIZE_HINT]: body.byteLength,
				},
			});
			cache.set(target, { buffer, size: body.byteLength, mtimeMs: fileStat.mtimeMs });
			if (cache.size > COMPRESSION_CACHE_LIMIT) {
				const oldest = cache.keys().next().value;
				if (oldest !== undefined) cache.delete(oldest);
			}
			return buffer;
		} catch {
			return null;
		}
	}

	/**
	 * gzip 压缩（带 size+mtime 进程内缓存；v3.0.1 行为，作为 br 不可用时的回退）。
	 * @param {string} target
	 * @param {Buffer} body
	 * @param {import('node:fs').Stats} fileStat
	 * @param {Map<string, { buffer: Buffer, size: number, mtimeMs: number }>} cache
	 * @returns {Buffer}
	 */
	function dynamicGzip(target, body, fileStat, cache) {
		const cached = cache.get(target);
		if (cached && cached.size === body.byteLength && cached.mtimeMs === fileStat.mtimeMs) return cached.buffer;
		const buffer = gzipSync(body, { level: 9 });
		cache.set(target, { buffer, size: body.byteLength, mtimeMs: fileStat.mtimeMs });
		if (cache.size > COMPRESSION_CACHE_LIMIT) {
			const oldest = cache.keys().next().value;
			if (oldest !== undefined) cache.delete(oldest);
		}
		return buffer;
	}

	return async function dressUpHandler(req, res) {
		const method = req.method || 'GET';
		/** @type {URL} */
		let url;
		try {
			url = new URL(req.url || '/', 'http://localhost');
		} catch {
			end(res, 400);
			return;
		}
		/** @type {string} */
		let pathname;
		try {
			pathname = decodeURIComponent(url.pathname);
		} catch {
			end(res, 400);
			return;
		}
		const isInteractionAction = pathname === DRESS_UP_INTERACTION_ACTION;
		if (method !== 'GET' && method !== 'HEAD' && !(isInteractionAction && method === 'POST')) {
			end(res, 405, isInteractionAction ? { allow: 'POST' } : { allow: 'GET, HEAD' });
			return;
		}
		if (pathname === DRESS_UP_PATH) {
			end(res, 301, { location: DRESS_UP_ENTRY });
			return;
		}
		if (pathname === DRESS_UP_CLIENT_CONFIG) {
			const body = Buffer.from(JSON.stringify({
				version: DRESS_UP_CONFIG_VERSION,
				interaction: {
					enabled: interactionEnabled,
					stateUrl: DRESS_UP_INTERACTION_STATE,
					actionUrl: DRESS_UP_INTERACTION_ACTION,
				},
				// v3.0.1：版本化资产清单（宿主侧后台 prefetch 用；version=null 时客户端跳过）
				assets: assetPrefetch,
			}), 'utf8');
			res.writeHead(200, {
				'content-type': MIME['.json'],
				'content-length': String(body.byteLength),
				'cache-control': 'no-store',
			});
			res.end(method === 'HEAD' ? undefined : body);
			return;
		}
		if (pathname === DRESS_UP_INTERACTION_STATE) {
			if (!interactionEnabled) {
				end(res, 404);
				return;
			}
			const payload = { ok: true, version: 1, .../** @type {any} */ (interaction).summary(now()) };
			sendJsonNoStore(res, 200, payload, method === 'HEAD');
			return;
		}
		if (isInteractionAction) {
			if (method !== 'POST') {
				end(res, 405, { allow: 'POST' });
				return;
			}
			if (!interactionEnabled) {
				end(res, 404);
				return;
			}
			if (req.headers['x-feiyu-interaction'] !== '1') {
				sendJsonNoStore(res, 403, { ok: false, code: 'forbidden', message: '缺少互动请求头' });
				return;
			}
			if (!isSameOrigin(req)) {
				sendJsonNoStore(res, 403, { ok: false, code: 'forbidden', message: '只接受同源请求' });
				return;
			}
			const contentType = String(req.headers['content-type'] || '').toLowerCase();
			if (!contentType.startsWith('application/json')) {
				sendJsonNoStore(res, 415, { ok: false, code: 'invalid_content_type', message: '需要 application/json' });
				return;
			}
			let body;
			try {
				body = await readJsonBody(req, INTERACTION_MAX_BODY_BYTES);
			} catch (error) {
				const status = /** @type {any} */ (error).status === 413 ? 413 : 400;
				sendJsonNoStore(res, status, { ok: false, code: status === 413 ? 'body_too_large' : 'invalid_json' });
				return;
			}
			const kind = /** @type {any} */ (body).kind;
			if (kind !== 'pat' && kind !== 'feed' && kind !== 'greet') {
				sendJsonNoStore(res, 400, { ok: false, code: 'bad-kind', message: '未知互动类型' });
				return;
			}
			const tier = /** @type {any} */ (body).tier === 'big' ? 'big' : 'small';
			const at = now();
			if (!bucket.take(at)) {
				sendJsonNoStore(res, 429, { ok: false, code: 'rate-limited', retryInMs: bucket.retryInMs(at) });
				return;
			}
			const result = /** @type {any} */ (interaction).act(kind, { tier }, at);
			if (!result || !result.ok) {
				sendJsonNoStore(res, 409, {
					ok: false,
					code: (result && result.reason) || 'rejected',
					retryInMs: (result && result.retryInMs) || 0,
				});
				return;
			}
			sendJsonNoStore(res, 200, { ok: true, state: result.state });
			return;
		}
		const relative = relativeAssetPath(pathname);
		if (relative === null) {
			end(res, 404);
			return;
		}
		const target = resolve(join(root, normalize(relative)));
		if (target !== root && !target.startsWith(root + sep)) {
			end(res, 403);
			return;
		}
		let body;
		let fileStat;
		try {
			[body, fileStat] = await Promise.all([readFile(target), stat(target)]);
		} catch (error) {
			if (error && typeof error === 'object' && MISSING.has(error.code)) {
				end(res, 404);
				return;
			}
			throw error;
		}
		const extension = extname(target).toLowerCase();
		const contentType = MIME[extension] ?? 'application/octet-stream';
		// v3.0.1：带 ?v= 的版本化静态资源长缓存 immutable；入口/未版本化资源保持短缓存
		const cacheControl = staticCacheControl(url.searchParams.has('v'));
		const acceptEncoding = String(req.headers && req.headers['accept-encoding'] || '');
		const acceptsBrotli = /\bbr\b/i.test(acceptEncoding);
		const acceptsGzip = /\bgzip\b/i.test(acceptEncoding);
		const compressible = COMPRESSIBLE.has(extension) && body.byteLength >= COMPRESS_MIN_BYTES;
		// v3.2.0：br 优先（构建期预压缩 `.br` 产物直接用；否则 q5 动态压缩 + 进程内缓存）
		if (compressible && acceptsBrotli) {
			const precompressed = await readPrecompressedBrotli(target, fileStat);
			const br = precompressed || await dynamicBrotli(target, body, fileStat, brCache);
			if (br) {
				res.writeHead(200, {
					'content-type': contentType,
					'content-length': String(br.byteLength),
					'content-encoding': 'br',
					'vary': 'accept-encoding',
					'cache-control': cacheControl,
				});
				res.end(method === 'HEAD' ? undefined : br);
				return;
			}
		}
		if (compressible && acceptsGzip) {
			const gzip = dynamicGzip(target, body, fileStat, gzipCache);
			res.writeHead(200, {
				'content-type': contentType,
				'content-length': String(gzip.byteLength),
				'content-encoding': 'gzip',
				'vary': 'accept-encoding',
				'cache-control': cacheControl,
			});
			res.end(method === 'HEAD' ? undefined : gzip);
			return;
		}
		res.writeHead(200, {
			'content-type': contentType,
			'content-length': String(body.byteLength),
			'cache-control': cacheControl,
		});
		res.end(method === 'HEAD' ? undefined : body);
	};
}

/**
 * 在宿主 context 上挂载换装间静态路由（webServer 存在时才挂）。
 * @param {any} ctx cordis 插件 context
 * @param {{
 *   rootDir?: string,
 *   interaction?: {
 *     enabled?: boolean,
 *     summary?: (now?: number) => object,
 *     act?: (kind: string, payload: object, now?: number) => { ok: boolean, reason?: string, retryInMs?: number, state?: object },
 *   },
 *   now?: () => number,
 * }} [options]
 */
export function mountDressUpRoutes(ctx, options = {}) {
	const rootDir = options.rootDir ?? dressUpRoot();
	const handler = createDressUpHandler(rootDir, {
		interaction: options.interaction,
		now: options.now,
	});
	ctx.inject(['webServer'], (/** @type {any} */ webCtx) => {
		webCtx.effect(
			() =>
				webCtx.webServer.register({
					kind: 'prefix',
					path: DRESS_UP_PATH,
					handler,
				}),
			'feiyu-wardrobe: dress-up static route',
		);
	});
	return handler;
}
