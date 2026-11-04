/**
 * 换装间本地静态路由：把 docs/dress-up 里的游戏页、图层素材从宿主本地发出去，
 * 换装间因此离线可用，不再依赖 GitHub Pages。
 *
 * 路由：`/feiyu/dress-up/*`（prefix）。只应答 GET/HEAD；拒绝目录穿越；
 * 未知路径 404；非 GET/HEAD 405。素材是公开静态文件，不做鉴权。
 *
 * @module dsh-feiyu-wardrobe/webserver
 */

import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

/** 换装间路由前缀（客户端半区 iframe 也用它）。 */
export const DRESS_UP_PATH = '/feiyu/dress-up';
/** 换装间入口（带尾斜杠，相对路径才能解析）。 */
export const DRESS_UP_ENTRY = `${DRESS_UP_PATH}/`;
/** 换装间客户端配置端点（v2：只含互动端点发现；静态托管时 404 → local-only）。 */
export const DRESS_UP_CLIENT_CONFIG = `${DRESS_UP_ENTRY}client-config.json`;
/** 换装间客户端配置端点版本（v2：去渲染模式，仅 interaction 段）。 */
export const DRESS_UP_CONFIG_VERSION = 2;
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
const MISSING = new Set(['ENOENT', 'EISDIR', 'ENOTDIR', 'ENAMETOOLONG']);

/** 可 gzip 的文本类型（2.5D rig JSON 1.6MB → gzip 后 ~270KB，首屏 payload 关键项）。 */
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.json', '.svg', '.txt', '.map', '.mjs']);
/** gzip 缓存上限（条；每条形如 { gzip: Buffer, size, mtimeMs }）。 */
const GZIP_CACHE_LIMIT = 12;
/** 小于该字节数不 gzip（头部开销不值得）。 */
const GZIP_MIN_BYTES = 1024;

/**
 * 解析包内换装间素材目录（docs/dress-up）。
 * @param {string} [baseUrl] 覆盖牌 module url（测试用）
 * @returns {string}
 */
export function dressUpRoot(baseUrl = import.meta.url) {
	return fileURLToPath(new URL('../docs/dress-up/', baseUrl));
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
 * 额外能力（v2）：
 * - `client-config.json`：换装间客户端配置（仅互动端点发现；2.5D 为唯一渲染路径，无渲染开关），
 *   `no-store` 保证宿主改配置后页面刷新即生效；
 * - 文本资产按 `Accept-Encoding: gzip` 压缩（带 mtime+size 失效的进程内缓存），
 *   2.5D rig JSON 首屏传输从 1.6MB 降到 ~270KB。
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
	/** @type {Map<string, { gzip: Buffer, size: number, mtimeMs: number }>} */
	const gzipCache = new Map();

	/** @param {import('node:http').ServerResponse} res @param {number} status */
	const end = (res, status, headers) => {
		res.writeHead(status, headers);
		res.end();
	};

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
		const acceptsGzip = /\bgzip\b/i.test(String(req.headers && req.headers['accept-encoding'] || ''));
		if (acceptsGzip && COMPRESSIBLE.has(extension) && body.byteLength >= GZIP_MIN_BYTES) {
			const cached = gzipCache.get(target);
			let gzip;
			if (cached && cached.size === body.byteLength && cached.mtimeMs === fileStat.mtimeMs) {
				gzip = cached.gzip;
			} else {
				gzip = gzipSync(body, { level: 9 });
				gzipCache.set(target, { gzip, size: body.byteLength, mtimeMs: fileStat.mtimeMs });
				if (gzipCache.size > GZIP_CACHE_LIMIT) {
					const oldest = gzipCache.keys().next().value;
					if (oldest !== undefined) gzipCache.delete(oldest);
				}
			}
			res.writeHead(200, {
				'content-type': contentType,
				'content-length': String(gzip.byteLength),
				'content-encoding': 'gzip',
				'vary': 'accept-encoding',
				'cache-control': CACHE_CONTROL,
			});
			res.end(method === 'HEAD' ? undefined : gzip);
			return;
		}
		res.writeHead(200, {
			'content-type': contentType,
			'content-length': String(body.byteLength),
			'cache-control': CACHE_CONTROL,
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
