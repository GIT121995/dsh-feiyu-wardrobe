/**
 * 大肥鱼衣橱 · DIY 云端生成（火山方舟 / Seedream）宿主侧客户端
 *
 * 安全边界（task-7 D1 硬要求）：
 *   - API key **只**从宿主环境读取（`ARK_API_KEY` 或 `~/.config/seedream/env` / 配置指定的文件），
 *     不来自浏览器、不写日志、不进错误响应/成本日志；错误信息经 `sanitizeProviderError` 脱敏。
 *   - 浏览器只与本机宿主路由通信；云端返回的图片 URL 下载后立即丢弃，不返回浏览器。
 *   - 重试 ≤2 次（总计 ≤3 次）；4xx（除 429）不重试。
 *
 * 该模块只做「一张图」的生成/下载，预算/缓存/内容守卫在 lib/diy.js。
 *
 * @module dsh-feiyu-wardrobe/diy-provider
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, join } from 'node:path';

/** 火山方舟图像生成接口（M0 实测可用）。 */
export const ARK_API_URL = 'https://ark.cn-beijing.volces.com/api/v3/images/generations';

/** 本仓库实测可用的模型（pro 未开通；可用配置覆盖）。 */
export const DEFAULT_DIY_MODEL = 'doubao-seedream-5-0-flash-260915';

/** 与既有 675×1200 分层素材同构的生成尺寸。 */
export const DEFAULT_DIY_SIZE = '1152x2048';

/** 单张下载图最大字节数（防止异常响应把内存/磁盘打爆）。 */
export const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

/** 默认凭证文件（与既有 `seedream_image_api.py` 一致）。 */
export const DEFAULT_ENV_FILES = () => [join(homedir(), '.config', 'seedream', 'env')];

/**
 * 宿主侧 Seedream 错误（code 供路由/日志分类，message 已脱敏）。
 */
export class DiyProviderError extends Error {
	/**
	 * @param {string} code
	 * @param {string} message
	 * @param {{ attempts?: number, status?: number }} [meta]
	 */
	constructor(code, message, meta = {}) {
		super(message);
		this.name = 'DiyProviderError';
		this.code = code;
		this.attempts = meta.attempts ?? 0;
		this.status = meta.status ?? 0;
	}
}

/**
 * 读取 `KEY=VALUE` 形式的环境文件（忽略注释/空行；值去掉引号）。
 * @param {string} path
 * @returns {Record<string, string>}
 */
function readEnvFile(path) {
	/** @type {Record<string, string>} */
	const values = {};
	if (!path || !existsSync(path)) return values;
	let text = '';
	try {
		text = readFileSync(path, 'utf8');
	} catch {
		return values;
	}
	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
		const index = trimmed.indexOf('=');
		let value = trimmed.slice(index + 1).trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		values[trimmed.slice(0, index).trim()] = value;
	}
	return values;
}

/**
 * 从宿主环境解析 Ark API key（只读宿主；绝不记录 key 本身）。
 * 优先级：`process.env.ARK_API_KEY` → 配置指定 env 文件 → 默认 `~/.config/seedream/env`。
 * @param {{ env?: NodeJS.ProcessEnv, envFile?: string }} [options]
 * @returns {string} 找不到时返回空字符串（调用方据此报 `missing_api_key`）
 */
export function loadArkKey(options = {}) {
	const env = options.env || process.env;
	const direct = typeof env.ARK_API_KEY === 'string' ? env.ARK_API_KEY.trim() : '';
	if (direct) return direct;
	const files = options.envFile ? [options.envFile] : DEFAULT_ENV_FILES();
	for (const file of files) {
		const value = readEnvFile(file).ARK_API_KEY;
		if (value) return value;
	}
	return '';
}

/**
 * 脱敏：把 key、Bearer token、疑似签名 URL 参数替换掉（错误响应/日志用）。
 * @param {string} text
 * @param {string} [key]
 * @returns {string}
 */
export function sanitizeProviderError(text, key = '') {
	let out = String(text ?? '');
	if (key) out = out.split(key).join('***');
	out = out
		.replace(/Bearer\s+[A-Za-z0-9._\-+/=]+/gi, 'Bearer ***')
		.replace(/([?&](?:X-Tos-|X-Amz-)[^=&\s]+)=[^&\s]+/gi, '$1=***')
		.replace(/([?&]signature=)[^&\s]+/gi, '$1***')
		.replace(/\b(ARK_API_KEY|api[_-]?key)\s*[=:]\s*[^\s,}]+/gi, '$1=***');
	return out.length > 500 ? `${out.slice(0, 500)}…` : out;
}

/**
 * 本地参考图/结果图 → data URL（兼容 data URL 透传）。
 * @param {string} source 文件路径或 data URL
 * @returns {string}
 */
export function referenceToDataUrl(source) {
	if (typeof source !== 'string' || !source) throw new DiyProviderError('bad_reference', '参考图无效');
	if (source.startsWith('data:image/')) return source;
	if (!existsSync(source)) throw new DiyProviderError('bad_reference', '参考图文件不存在');
	const lower = extname(source).toLowerCase();
	const mime =
		lower === '.jpg' || lower === '.jpeg'
			? 'image/jpeg'
			: lower === '.webp'
				? 'image/webp'
				: 'image/png';
	const buffer = readFileSync(source);
	return `data:${mime};base64,${buffer.toString('base64')}`;
}

/**
 * 二进制图片 → data URL。
 * @param {Buffer} buffer
 * @param {string} [mime]
 * @returns {string}
 */
export function imageToDataUrl(buffer, mime = 'image/png') {
	return `data:${mime};base64,${buffer.toString('base64')}`;
}

/** @returns {Promise<void>} */
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 从响应体里判断图片 MIME（PNG/JPEG/WebP magic）。
 * @param {Buffer} buffer
 * @returns {string}
 */
function sniffMime(buffer) {
	if (buffer.length >= 8 && buffer.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') return 'image/png';
	if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
	if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
		return 'image/webp';
	}
	return '';
}

/**
 * 创建 Seedream 客户端（可注入 fetch/sleep，便于单测与 QA 脚本复用）。
 *
 * @param {{
 *   apiKey?: string,
 *   model?: string,
 *   size?: string,
 *   retries?: number,
 *   timeoutMs?: number,
 *   fetchImpl?: typeof fetch,
 *   sleep?: (ms: number) => Promise<void>,
 * }} [options]
 * @returns {{
 *   configured: boolean,
 *   model: string,
 *   size: string,
 *   generate: (request: { prompt: string, references: string[], seed?: number, size?: string, model?: string }) => Promise<{ image: Buffer, mime: string, usage: unknown, latencyMs: number, attempts: number, model: string, size: string }>,
 * }}
 */
export function createSeedreamClient(options = {}) {
	const apiKey = options.apiKey ?? loadArkKey();
	const model = options.model || DEFAULT_DIY_MODEL;
	const size = options.size || DEFAULT_DIY_SIZE;
	const retries = Math.max(0, Math.min(2, Math.floor(options.retries ?? 2)));
	const timeoutMs = Math.max(10_000, Math.floor(options.timeoutMs ?? 180_000));
	const fetchImpl = options.fetchImpl || globalThis.fetch;
	const sleep = options.sleep || defaultSleep;
	if (typeof fetchImpl !== 'function') {
		throw new DiyProviderError('fetch_unavailable', '宿主运行时不支持 fetch');
	}

	/**
	 * @param {string} url
	 * @param {RequestInit} init
	 * @returns {Promise<Response>}
	 */
	const runFetch = async (url, init) => {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			return await fetchImpl(url, { ...init, signal: controller.signal });
		} finally {
			clearTimeout(timer);
		}
	};

	/**
	 * 生成一张图。
	 * @param {{ prompt: string, references: string[], seed?: number, size?: string, model?: string }} request
	 */
	const generate = async (request) => {
		if (!apiKey) throw new DiyProviderError('missing_api_key', '宿主未配置 ARK_API_KEY');
		if (typeof request.prompt !== 'string' || request.prompt.length < 8 || request.prompt.length > 4000) {
			throw new DiyProviderError('bad_prompt', 'prompt 长度非法');
		}
		if (!Array.isArray(request.references) || request.references.length === 0 || request.references.length > 3) {
			throw new DiyProviderError('bad_reference', '参考图数量必须为 1–3');
		}
		const references = request.references.map((reference) => referenceToDataUrl(reference));
		const payload = {
			model: request.model || model,
			prompt: request.prompt,
			size: request.size || size,
			response_format: 'url',
			watermark: false,
			image: references.length === 1 ? references[0] : references,
		};
		if (Number.isFinite(request.seed)) payload.seed = Math.floor(Number(request.seed));
		const startedAt = Date.now();
		/** @type {unknown[]} */
		const errors = [];
		for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
			try {
				const response = await runFetch(ARK_API_URL, {
					method: 'POST',
					headers: {
						authorization: `Bearer ${apiKey}`,
						'content-type': 'application/json',
					},
					body: JSON.stringify(payload),
				});
				const status = Number(response && response.status) || 0;
				if (status === 429 || status >= 500) {
					const text = typeof response.text === 'function' ? await response.text() : '';
					errors.push(`HTTP ${status}: ${sanitizeProviderError(text, apiKey)}`);
					if (attempt <= retries) {
						await sleep(3000 * attempt);
						continue;
					}
					throw new DiyProviderError('api_retry_exhausted', `图像 API 连续 ${attemptsText(errors.length)} 次失败`, {
						attempts: errors.length,
						status,
					});
				}
				if (status < 200 || status >= 300) {
					const text = typeof response.text === 'function' ? await response.text() : '';
					throw new DiyProviderError(
						'api_rejected',
						`图像 API 拒绝（HTTP ${status}）：${sanitizeProviderError(text, apiKey)}`,
						{ attempts: attempt, status },
					);
				}
				/** @type {any} */
				let body;
				try {
					body = await response.json();
				} catch {
					throw new DiyProviderError('bad_response', '图像 API 响应不是 JSON', { attempts: attempt, status });
				}
				const item = (body && Array.isArray(body.data) && body.data[0]) || null;
				if (!item) {
					throw new DiyProviderError('bad_response', '图像 API 响应缺少图片', { attempts: attempt, status });
				}
				/** @type {Buffer} */
				let image;
				if (typeof item.b64_json === 'string' && item.b64_json) {
					image = Buffer.from(item.b64_json, 'base64');
				} else if (typeof item.url === 'string' && item.url) {
					const download = await runFetch(item.url, { method: 'GET' });
					if (!download || download.status !== 200) {
						throw new DiyProviderError('download_failed', `生成图下载失败（HTTP ${download ? download.status : 0}）`, {
							attempts: attempt,
							status: download ? download.status : 0,
						});
					}
					const arrayBuffer = await download.arrayBuffer();
					image = Buffer.from(arrayBuffer);
				} else {
					throw new DiyProviderError('bad_response', '图像 API 响应既无 b64_json 也无 url', {
						attempts: attempt,
						status,
					});
				}
				if (image.length < 1000) {
					throw new DiyProviderError('bad_response', '生成图字节数异常', { attempts: attempt, status });
				}
				if (image.length > MAX_IMAGE_BYTES) {
					throw new DiyProviderError('image_too_large', '生成图超过大小上限', { attempts: attempt, status });
				}
				const mime = sniffMime(image) || 'image/png';
				return {
					image,
					mime,
					usage: (body && body.usage) || {},
					latencyMs: Date.now() - startedAt,
					attempts: attempt,
					model: payload.model,
					size: payload.size,
				};
			} catch (error) {
				/** 不重试的终态错误（避免重复计费/无意义重试）。 */
				const terminal = new Set([
					'api_rejected',
					'missing_api_key',
					'api_retry_exhausted',
					'image_too_large',
					'bad_prompt',
					'bad_reference',
				]);
				if (error instanceof DiyProviderError) {
					if (terminal.has(error.code)) throw error;
					errors.push(`${error.code}: ${error.message}`);
				} else {
					errors.push(`network: ${sanitizeProviderError(error instanceof Error ? error.message : String(error), apiKey)}`);
				}
				if (attempt <= retries) {
					await sleep(3000 * attempt);
					continue;
				}
				if (error instanceof DiyProviderError) throw error;
				throw new DiyProviderError('network_failed', `图像 API 请求失败：${errors[errors.length - 1] || '未知错误'}`, {
					attempts: attempt,
				});
			}
		}
		throw new DiyProviderError('network_failed', '图像 API 请求失败', { attempts: errors.length });
	};

	return { configured: Boolean(apiKey), model, size, generate };
}

/**
 * @param {number} count
 * @returns {string}
 */
function attemptsText(count) {
	return `${count}`;
}
