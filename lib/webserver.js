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
/** 换装间宿主配置端点（页面 boot 时读取渲染模式默认值；静态托管时 404 → 回退 dom）。 */
export const DRESS_UP_RENDER_CONFIG = `${DRESS_UP_ENTRY}render-config.json`;
/** 换装间配置端点版本（页面据此判断接口兼容）。 */
export const DRESS_UP_CONFIG_VERSION = 1;

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
 * 创建一个能直接挂到 ctx.webServer.register 的 handler。
 *
 * 额外能力（M3）：
 * - `render-config.json`：返回换装间渲染模式默认值（`config.dressUp.render`），
 *   `no-store` 保证宿主改配置后页面刷新即生效；
 * - 文本资产按 `Accept-Encoding: gzip` 压缩（带 mtime+size 失效的进程内缓存），
 *   2.5D rig JSON 首屏传输从 1.6MB 降到 ~270KB。
 *
 * @param {string} rootDir 素材根目录（docs/dress-up 的绝对路径）
 * @param {{ render?: 'dom'|'2d5'|'auto' }} [options] 换装间配置（默认 render='dom'）
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function createDressUpHandler(rootDir, options = {}) {
	const root = resolve(rootDir);
	const render = options.render === '2d5' || options.render === 'auto' ? options.render : 'dom';
	/** @type {Map<string, { gzip: Buffer, size: number, mtimeMs: number }>} */
	const gzipCache = new Map();

	/** @param {import('node:http').ServerResponse} res @param {number} status */
	const end = (res, status, headers) => {
		res.writeHead(status, headers);
		res.end();
	};

	return async function dressUpHandler(req, res) {
		const method = req.method || 'GET';
		if (method !== 'GET' && method !== 'HEAD') {
			end(res, 405, { allow: 'GET, HEAD' });
			return;
		}
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
		if (pathname === DRESS_UP_PATH) {
			end(res, 301, { location: DRESS_UP_ENTRY });
			return;
		}
		if (pathname === DRESS_UP_RENDER_CONFIG) {
			const body = Buffer.from(JSON.stringify({ version: DRESS_UP_CONFIG_VERSION, render }), 'utf8');
			res.writeHead(200, {
				'content-type': MIME['.json'],
				'content-length': String(body.byteLength),
				'cache-control': 'no-store',
			});
			res.end(method === 'HEAD' ? undefined : body);
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
 * @param {{ rootDir?: string, render?: 'dom'|'2d5'|'auto' }} [options]
 */
export function mountDressUpRoutes(ctx, options = {}) {
	const rootDir = options.rootDir ?? dressUpRoot();
	const handler = createDressUpHandler(rootDir, { render: options.render });
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
