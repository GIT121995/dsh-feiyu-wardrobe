import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { validateConfig } from '../lib/config.js';
import {
	DIY_PATH,
	DiyError,
	buildFlatoutPrompt,
	buildLookPrompt,
	buildPromptPack,
	conservativePromptSuffix,
	createDiyHandler,
	createDiyService,
	decodeUploadImage,
	estimateDiyCost,
	mountDiyRoutes,
} from '../lib/diy.js';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const BASE_REF = join(REPO, 'docs', 'dress-up', 'art', 'diy', 'base-chibi.png');
const HIDDEN_KEY = 'sk-host-secret-should-never-leak';

function pngBytes(size = 2000, marker = 'a') {
	const buffer = Buffer.alloc(Math.max(1024, size), marker);
	Buffer.from('89504e470d0a1a0a', 'hex').copy(buffer, 0);
	return buffer;
}

function uploadDataUrl(marker = 'a') {
	return `data:image/jpeg;base64,${pngBytes(2000, marker).toString('base64')}`;
}

function makeConfig(overrides = {}) {
	const dir = mkdtempSync(join(tmpdir(), 'feiyu-diy-svc-'));
	const config = validateConfig({
		diy: {
			enabled: true,
			statePath: join(dir, 'ledger.json'),
			costLogPath: join(dir, 'costs.jsonl'),
			cacheDir: join(dir, 'cache'),
			baseRefPath: BASE_REF,
			dailyImageLimit: 6,
			dailyBudgetYuan: 3,
			pricePerImageYuan: 0.3,
			...overrides,
		},
	});
	return { config, dir };
}

function makeProvider(options = {}) {
	const calls = [];
	const provider = {
		configured: options.configured !== false,
		model: 'fake-model',
		size: '1152x2048',
		async generate(request) {
			calls.push(request);
			if (options.failAtCall && calls.length === options.failAtCall) {
				const error = new Error(options.failMessage || 'upstream boom');
				error.code = options.failCode || 'api_retry_exhausted';
				throw error;
			}
			return {
				image: pngBytes(2500, String.fromCharCode(97 + (calls.length % 20))),
				mime: 'image/png',
				usage: { generated: 1 },
				latencyMs: 2,
				attempts: 1,
				model: 'fake-model',
				size: '1152x2048',
			};
		},
	};
	return { provider, calls };
}

function makeService(overrides = {}, providerOptions = {}) {
	const { config, dir } = makeConfig(overrides);
	const { provider, calls } = makeProvider(providerOptions);
	let clock = 1_760_000_000_000;
	const service = createDiyService({ config, provider, now: () => clock });
	return {
		config,
		dir,
		provider,
		calls,
		service,
		advance(ms) {
			clock += ms;
		},
		logLines() {
			const path = config.diy.costLogPath;
			if (!existsSync(path)) return [];
			return readFileSync(path, 'utf8')
				.split('\n')
				.filter(Boolean)
				.map((line) => JSON.parse(line));
		},
		ledger() {
			return JSON.parse(readFileSync(config.diy.statePath, 'utf8'));
		},
	};
}

function baseRequest(extra = {}) {
	return {
		category: 'top',
		description: '白色长袖纯棉衬衫（尖领、前襟纽扣）',
		imageDataUrl: uploadDataUrl(),
		consent: true,
		confirmCost: true,
		...extra,
	};
}

/* ---------------- prompt 包 ---------------- */

test('prompt 包：look/flatout 模板含品类穿着说明、保守约束、负向词与确定性 seed', () => {
	const look = buildLookPrompt({ category: 'top', description: '白色长袖衬衫' });
	assert.match(look, /白色长袖衬衫/);
	assert.match(look, /不穿裙子、不穿裤子/);
	assert.match(look, /禁止出现/);
	assert.match(look, /鲸鱼尾巴/);
	assert.ok(look.includes(conservativePromptSuffix()));
	const flatout = buildFlatoutPrompt({ category: 'top', description: '白色长袖衬衫' });
	assert.match(flatout, /#808080/);
	assert.match(flatout, /不要移动、不要缩放、不要重新居中/);
	const pack = buildPromptPack({ category: 'dress', description: '蓝色连衣裙', imageDigest: 'abcdef0123456789' });
	assert.equal(pack.promptVersion, 'diy-m1-v1');
	assert.equal(pack.slot, 'topBody');
	const rerolled = buildPromptPack({ category: 'dress', description: '蓝色连衣裙', imageDigest: 'abcdef0123456789', reroll: 1 });
	assert.notEqual(pack.seed, rerolled.seed);
	assert.throws(() => buildPromptPack({ category: 'hat', description: 'x', imageDigest: 'ff' }), DiyError);
	assert.deepEqual(estimateDiyCost({ images: 2, pricePerImageYuan: 0.3 }).costRangeYuan, [0.42, 0.6]);
});

/* ---------------- 默认关闭 / 凭证 / 同意 ---------------- */

test('默认关闭：status.enabled=false 且 generate 直接拒绝、不调用 provider', async () => {
	const { config } = makeConfig();
	assert.equal(validateConfig({}).diy.enabled, false);
	assert.equal(config.diy.enabled, true);
	const { dir } = makeConfig({ enabled: false });
	const disabled = validateConfig({ diy: { enabled: false, statePath: join(dir, 'l.json') } });
	const provider = makeProvider();
	const service = createDiyService({ config: disabled, provider: provider.provider });
	assert.equal(service.status().enabled, false);
	await assert.rejects(
		() => service.generate(baseRequest()),
		(error) => error instanceof DiyError && error.code === 'diy_disabled' && error.status === 403,
	);
	assert.equal(provider.calls.length, 0);
});

test('缺少宿主 key：missing_api_key（无网络调用）', async () => {
	const { service } = makeService({}, { configured: false });
	assert.equal(service.status().hasApiKey, false);
	await assert.rejects(
		() => service.generate(baseRequest()),
		(error) => error.code === 'missing_api_key' && error.status === 503,
	);
});

test('显式同意：consent 非 true 时 403 consent_required', async () => {
	const { service, calls } = makeService();
	await assert.rejects(
		() => service.generate(baseRequest({ consent: false })),
		(error) => error.code === 'consent_required' && error.status === 403,
	);
	assert.equal(calls.length, 0);
});

test('费用预估确认：confirmCost 非 true 时拒绝并要求确认', async () => {
	const { service, calls } = makeService();
	await assert.rejects(
		() => service.generate(baseRequest({ confirmCost: false })),
		(error) => error.code === 'cost_confirmation_required' && error.status === 400 && typeof error.details.estimate === 'object',
	);
	assert.equal(calls.length, 0);
});

test('非法品类 / 非法上传图：明确错误码且不调用 provider', async () => {
	const { service, calls } = makeService();
	await assert.rejects(() => service.generate(baseRequest({ category: 'hat' })), (e) => e.code === 'invalid_category');
	await assert.rejects(() => service.generate(baseRequest({ imageDataUrl: 'http://evil/x.png' })), (e) => e.code === 'invalid_image');
	await assert.rejects(() => service.generate(baseRequest({ imageDataUrl: 'data:image/gif;base64,AAAA' })), (e) => e.code === 'invalid_image');
	assert.equal(calls.length, 0);
});

test('upload 解码：PNG/JPEG/WebP 通过，返回 digest 与字节数', () => {
	const decoded = decodeUploadImage(uploadDataUrl());
	assert.equal(decoded.mime, 'image/jpeg');
	assert.equal(decoded.bytes, 2000);
	assert.match(decoded.digest, /^[0-9a-f]{64}$/);
	assert.throws(() => decodeUploadImage('data:image/png;base64,AAAA'), (e) => e.code === 'invalid_image');
});

/* ---------------- 内容守卫（端到端：≥3 个不合规输入被拒且不送 API） ---------------- */

test('内容守卫端到端：≥3 类不合规输入 422 content_rejected、0 次 API 调用、审计落盘', async () => {
	const { service, calls, logLines } = makeService();
	const badInputs = [
		'黑色蕾丝比基尼（低胸、露脐、露背）',
		'超短热裤 + 露脐短上衣',
		'透明蕾丝情趣内衣',
		'萝莉风小学生制服',
	];
	for (const description of badInputs) {
		await assert.rejects(
			() => service.generate(baseRequest({ description })),
			(error) =>
				error.code === 'content_rejected' && error.status === 422 && Array.isArray(error.details.guard.hits) && error.details.guard.action === 'reject',
		);
	}
	assert.equal(calls.length, 0, '守卫拒绝后不得调用云端 API');
	const audit = logLines().filter((entry) => entry.event === 'guard_reject');
	assert.equal(audit.length, badInputs.length);
	for (const entry of audit) {
		assert.equal(entry.images, 0);
		assert.equal(entry.costYuan, 0);
		assert.match(String(entry.descriptionSha256), /^[0-9a-f]{16}$/, '审计只保留描述 sha256 摘要');
		assert.ok(!JSON.stringify(entry).includes('黑色蕾丝比基尼（低胸、露脐、露背）'), '审计日志不保存原始描述');
		assert.ok(JSON.stringify(entry).includes('guardHits'), '审计日志保留命中词便于复盘');
	}
});

test('降级：偏短/贴身描述自动改写为保守版型但仍可生成', async () => {
	const { service, calls } = makeService();
	const result = await service.generate(baseRequest({ description: '白色短袖T恤配短裙，版型紧身' }));
	assert.equal(result.meta.guard.action, 'downgrade');
	assert.match(result.meta.guard.description, /长袖/);
	assert.match(result.meta.guard.description, /及膝/);
	assert.match(calls[0].prompt, /长袖/);
	assert.doesNotMatch(calls[0].prompt, /短袖/);
});

/* ---------------- 生成成功 / 缓存 / 预算 ---------------- */

test('生成成功：2 张图（look + flatout #808080）、回 data URL、元数据/台账/成本日志完整且无 key', async () => {
	const { service, calls, ledger, logLines } = makeService();
	const result = await service.generate(baseRequest());
	assert.equal(result.ok, true);
	assert.equal(calls.length, 2);
	assert.match(calls[0].prompt, /白色长袖纯棉衬衫/);
	assert.match(calls[0].references[0], /^data:image\/png;base64,/, 'look 参考图1 = 宿主素体');
	assert.match(calls[0].references[1], /^data:image\/jpeg;base64,/, 'look 参考图2 = 用户上传图');
	assert.match(calls[1].prompt, /#808080/);
	assert.match(calls[1].references[0], /^data:image\/png;base64,/, 'flatout 参考图 = look');
	assert.match(result.look.dataUrl, /^data:image\/png;base64,/);
	assert.match(result.flatout.dataUrl, /^data:image\/png;base64,/);
	assert.equal(result.meta.shape, 'chibi');
	assert.equal(result.meta.slot, 'topBody');
	assert.equal(result.meta.cacheHit, false);
	assert.equal(result.meta.cost.images, 2);
	assert.equal(result.meta.cost.costYuan, 0.6);
	const state = ledger();
	assert.equal(state.totals.images, 2);
	assert.equal(Number(state.totals.costYuan.toFixed(2)), 0.6);
	const generateEntries = logLines().filter((entry) => entry.event === 'generate');
	assert.equal(generateEntries.length, 1);
	const serialized = JSON.stringify(generateEntries[0]);
	assert.ok(!serialized.includes('ARK_API_KEY'), '成本日志不得出现 key 名');
	assert.ok(!serialized.includes(HIDDEN_KEY), '成本日志不得出现 key 值');
	assert.ok(!serialized.includes('白色长袖纯棉衬衫'), '成本日志不保存原始描述');
	assert.match(String(generateEntries[0].cacheKey), /^[0-9a-f]{16}$/);
});

test('hash 去重缓存：同图同描述第二次命中缓存（0 次新 API、0 费用）', async () => {
	const { service, calls, logLines } = makeService();
	const first = await service.generate(baseRequest());
	assert.equal(first.meta.cacheHit, false);
	const second = await service.generate(baseRequest());
	assert.equal(second.meta.cacheHit, true);
	assert.equal(calls.length, 2, '第二次不得再调用 API');
	assert.equal(second.meta.cost.images, 0);
	assert.equal(second.meta.cost.costYuan, 0);
	assert.equal(second.look.dataUrl, first.look.dataUrl);
	const hits = logLines().filter((entry) => entry.event === 'cache_hit');
	assert.equal(hits.length, 1);
	// 换一张上传图 → 缓存 key 变化 → 重新调用
	await service.generate(baseRequest({ imageDataUrl: uploadDataUrl('b') }));
	assert.equal(calls.length, 4);
});

test('预算护栏（图片数）：超过每日上限 → 429 daily_image_limit，且不再调用 API', async () => {
	const { service, calls } = makeService({ dailyImageLimit: 2 });
	await service.generate(baseRequest());
	await assert.rejects(
		() => service.generate(baseRequest({ imageDataUrl: uploadDataUrl('b') })),
		(error) => error.code === 'daily_image_limit' && error.status === 429 && error.details.daily.images === 2,
	);
	assert.equal(calls.length, 2);
});

test('预算护栏（金额）：每日预算不足 → 429 daily_budget_exceeded', async () => {
	const { service, calls } = makeService({ dailyBudgetYuan: 0.5 });
	await assert.rejects(
		() => service.generate(baseRequest()),
		(error) => error.code === 'daily_budget_exceeded' && error.status === 429,
	);
	assert.equal(calls.length, 0);
});

test('上游失败分类：look 成功/flatout 失败 → 502 generation_failed，只计 1 张成本', async () => {
	const { service, ledger, logLines } = makeService({}, { failAtCall: 2 });
	await assert.rejects(
		() => service.generate(baseRequest()),
		(error) =>
			error.code === 'generation_failed' &&
			error.status === 502 &&
			error.details.spentImages === 1 &&
			String(error.details.causeCode).length > 0,
	);
	const state = ledger();
	assert.equal(state.totals.images, 1);
	assert.equal(Number(state.totals.costYuan.toFixed(2)), 0.3);
	const failed = logLines().filter((entry) => entry.event === 'generate_failed');
	assert.equal(failed.length, 1);
});

test('上游错误脱敏：错误文本里的 key 不进响应/成本日志', async () => {
	const { service, logLines } = makeService({}, { failAtCall: 1, failMessage: `Authorization: Bearer ${HIDDEN_KEY}` });
	let message = '';
	await assert.rejects(
		() => service.generate(baseRequest()),
		(error) => {
			message = error.message;
			return true;
		},
	);
	assert.ok(!message.includes(HIDDEN_KEY), message);
	const serialized = JSON.stringify(logLines());
	assert.ok(!serialized.includes(HIDDEN_KEY), '成本日志不得出现 key');
});

/* ---------------- status / 路由 ---------------- */

test('status：默认关闭也能读，字段覆盖开关/预算/守卫/缓存/存储（无 key）', async () => {
	const { service } = makeService();
	const status = service.status();
	assert.equal(status.ok, true);
	assert.equal(status.service, 'feiyu-diy');
	assert.equal(status.enabled, true);
	assert.equal(status.shape, 'chibi');
	assert.equal(status.model, 'doubao-seedream-5-0-flash-260915');
	assert.equal(status.consentRequired, true);
	assert.deepEqual(status.guard.categories, ['top', 'bottom', 'dress', 'coat', 'outfit']);
	assert.equal(status.storage.backend, 'indexeddb');
	assert.equal(status.storage.format, '.dshskin');
	assert.equal(status.daily.limits.dailyImageLimit, 6);
	assert.equal(status.estimate.images, 2);
	assert.equal(status.hasApiKey, true);
	const serialized = JSON.stringify(status);
	assert.ok(!serialized.includes(HIDDEN_KEY));
	assert.equal('apiKey' in status, false, 'status 不应返回 key 字段');
	assert.equal(typeof status.hasApiKey, 'boolean');
});

function makeReq(method, url, options = {}) {
	const headers = options.headers || {};
	/** @type {any} */
	const req = { method, url, headers };
	req[Symbol.asyncIterator] = async function* iterator() {
		if (options.body !== undefined) {
			yield Buffer.isBuffer(options.body) ? options.body : Buffer.from(String(options.body));
		}
	};
	return req;
}

function makeRes() {
	return {
		statusCode: 0,
		headers: {},
		body: '',
		writeHead(status, headers) {
			this.statusCode = status;
			Object.assign(this.headers, headers || {});
			return this;
		},
		end(body) {
			if (body !== undefined) this.body = Buffer.isBuffer(body) ? body.toString('utf8') : String(body);
		},
	};
}

async function hit(handler, req) {
	const res = makeRes();
	await handler(req, res);
	return { status: res.statusCode, headers: res.headers, json: res.body ? JSON.parse(res.body) : null };
}

function makeHandler(service) {
	return createDiyHandler(service, { maxBodyBytes: 64 * 1024, logger: { warn() {}, error() {} } });
}

const JSON_HEADERS = { 'content-type': 'application/json', 'x-feiyu-diy': '1', origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080' };

test('路由：GET /feiyu/diy/status 与 HEAD', async () => {
	const { service } = makeService();
	const handler = makeHandler(service);
	const status = await hit(handler, makeReq('GET', `${DIY_PATH}/status`));
	assert.equal(status.status, 200);
	assert.equal(status.json.ok, true);
	assert.equal(status.headers['cache-control'], 'no-store');
	const head = await hit(handler, makeReq('HEAD', `${DIY_PATH}/status`));
	assert.equal(head.status, 200);
	assert.equal(head.json, null);
});

test('路由：POST generate 成功（同源 + 自定义头 + JSON）', async () => {
	const { service } = makeService();
	const handler = makeHandler(service);
	const res = await hit(
		handler,
		makeReq('POST', `${DIY_PATH}/generate`, {
			headers: JSON_HEADERS,
			body: JSON.stringify(baseRequest()),
		}),
	);
	assert.equal(res.status, 200, JSON.stringify(res.json));
	assert.equal(res.json.ok, true);
	assert.match(res.json.look.dataUrl, /^data:image\/png;base64,/);
});

test('路由：CSRF/内容类型/请求体防护', async () => {
	const { service } = makeService();
	const handler = makeHandler(service);
	const noHeader = await hit(
		handler,
		makeReq('POST', `${DIY_PATH}/generate`, {
			headers: { ...JSON_HEADERS, 'x-feiyu-diy': undefined },
			body: JSON.stringify(baseRequest()),
		}),
	);
	assert.equal(noHeader.status, 403);
	const crossOrigin = await hit(
		handler,
		makeReq('POST', `${DIY_PATH}/generate`, {
			headers: { ...JSON_HEADERS, origin: 'https://evil.example' },
			body: JSON.stringify(baseRequest()),
		}),
	);
	assert.equal(crossOrigin.status, 403);
	const badContentType = await hit(
		handler,
		makeReq('POST', `${DIY_PATH}/generate`, {
			headers: { ...JSON_HEADERS, 'content-type': 'text/plain' },
			body: JSON.stringify(baseRequest()),
		}),
	);
	assert.equal(badContentType.status, 415);
	const badJson = await hit(
		handler,
		makeReq('POST', `${DIY_PATH}/generate`, { headers: JSON_HEADERS, body: '{oops' }),
	);
	assert.equal(badJson.status, 400);
	assert.equal(badJson.json.code, 'invalid_json');
	const tooLarge = await hit(
		handler,
		makeReq('POST', `${DIY_PATH}/generate`, { headers: JSON_HEADERS, body: 'x'.repeat(70 * 1024) }),
	);
	assert.equal(tooLarge.status, 413);
	assert.equal(tooLarge.json.code, 'body_too_large');
});

test('路由：守卫拒绝 → 422 content_rejected（不调 provider）；未知路径/方法 → 404/405', async () => {
	const { service, calls } = makeService();
	const handler = makeHandler(service);
	const rejected = await hit(
		handler,
		makeReq('POST', `${DIY_PATH}/generate`, {
			headers: JSON_HEADERS,
			body: JSON.stringify(baseRequest({ description: '黑色蕾丝比基尼' })),
		}),
	);
	assert.equal(rejected.status, 422);
	assert.equal(rejected.json.code, 'content_rejected');
	assert.ok(Array.isArray(rejected.json.guard.hits));
	assert.equal(calls.length, 0);
	const missing = await hit(handler, makeReq('GET', `${DIY_PATH}/nope`));
	assert.equal(missing.status, 404);
	const wrongMethod = await hit(handler, makeReq('GET', `${DIY_PATH}/generate`));
	assert.equal(wrongMethod.status, 405);
	assert.equal(wrongMethod.headers.allow, 'POST');
	const wrongStatusMethod = await hit(handler, makeReq('POST', `${DIY_PATH}/status`));
	assert.equal(wrongStatusMethod.headers.allow, 'GET, HEAD');
});

test('路由：上游失败返回脱敏 502（不泄露 key / 上游原文）', async () => {
	const { service } = makeService({}, { failAtCall: 1, failMessage: `Bearer ${HIDDEN_KEY} upstream stack` });
	const handler = makeHandler(service);
	const res = await hit(
		handler,
		makeReq('POST', `${DIY_PATH}/generate`, { headers: JSON_HEADERS, body: JSON.stringify(baseRequest()) }),
	);
	assert.equal(res.status, 502);
	assert.equal(res.json.code, 'generation_failed');
	assert.ok(!JSON.stringify(res.json).includes(HIDDEN_KEY));
});

test('mountDiyRoutes 注册一个 prefix 路由并返回 service', () => {
	const { config } = makeConfig();
	const { provider } = makeProvider();
	const routes = [];
	let effects = 0;
	const ctx = {
		inject(deps, callback) {
			assert.deepEqual(deps, ['webServer']);
			callback({
				effect(fn) {
					effects += 1;
					return fn();
				},
				webServer: {
					register(route) {
						routes.push(route);
						return () => {};
					},
				},
			});
		},
	};
	const service = mountDiyRoutes(ctx, { config, service: createDiyService({ config, provider }) });
	assert.equal(effects, 1);
	assert.equal(routes.length, 1);
	assert.equal(routes[0].kind, 'prefix');
	assert.equal(routes[0].path, DIY_PATH);
	assert.equal(typeof routes[0].handler, 'function');
	assert.equal(typeof service.status, 'function');
});
