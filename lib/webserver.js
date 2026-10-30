/**
 * 换装间本地静态路由：把 docs/dress-up 里的游戏页、图层素材从宿主本地发出去，
 * 换装间因此离线可用，不再依赖 GitHub Pages。
 *
 * 路由：`/feiyu/dress-up/*`（prefix）。只应答 GET/HEAD；拒绝目录穿越；
 * 未知路径 404；非 GET/HEAD 405。素材是公开静态文件，不做鉴权。
 *
 * @module dsh-feiyu-wardrobe/webserver
 */

import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 换装间路由前缀（客户端半区 iframe 也用它）。 */
export const DRESS_UP_PATH = '/feiyu/dress-up';
/** 换装间入口（带尾斜杠，相对路径才能解析）。 */
export const DRESS_UP_ENTRY = `${DRESS_UP_PATH}/`;

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
 * @param {string} rootDir 素材根目录（docs/dress-up 的绝对路径）
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function createDressUpHandler(rootDir) {
	const root = resolve(rootDir);

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
		try {
			body = await readFile(target);
		} catch (error) {
			if (error && typeof error === 'object' && MISSING.has(error.code)) {
				end(res, 404);
				return;
			}
			throw error;
		}
		res.writeHead(200, {
			'content-type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
			'content-length': String(body.byteLength),
			'cache-control': CACHE_CONTROL,
		});
		res.end(method === 'HEAD' ? undefined : body);
	};
}

/**
 * 在宿主 context 上挂载换装间静态路由（webServer 存在时才挂）。
 * @param {any} ctx cordis 插件 context
 * @param {{ rootDir?: string }} [options]
 */
export function mountDressUpRoutes(ctx, options = {}) {
	const rootDir = options.rootDir ?? dressUpRoot();
	const handler = createDressUpHandler(rootDir);
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
