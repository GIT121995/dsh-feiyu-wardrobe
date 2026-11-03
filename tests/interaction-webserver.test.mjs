/** M5 互动端点：GET 状态 / POST 动作；安全校验矩阵、限流、零变更、no-store、v2 配置。 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
	DRESS_UP_CONFIG_VERSION,
	DRESS_UP_ENTRY,
	DRESS_UP_INTERACTION_ACTION,
	DRESS_UP_INTERACTION_STATE,
	DRESS_UP_RENDER_CONFIG,
	createDressUpHandler,
	dressUpRoot,
} from '../lib/webserver.js';

const ROOT = dressUpRoot();
const NOW = Date.parse('2026-11-03T04:00:00Z');

function createRes() {
	return {
		statusCode: 0,
		headers: {},
		body: undefined,
		writeHead(status, headers) {
			this.statusCode = status;
			this.headers = { ...this.headers, ...(headers || {}) };
			return this;
		},
		end(body) {
			this.body = body;
		},
	};
}

function createReq({ method = 'GET', url = '/', headers = {}, body = null } = {}) {
	const chunks = body == null ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))];
	return {
		method,
		url,
		headers,
		async *[Symbol.asyncIterator]() {
			for (const chunk of chunks) yield chunk;
		},
	};
}

async function hit(handler, request) {
	const res = createRes();
	await handler(request, res);
	return res;
}

function fakeSummary() {
	return {
		enabled: true,
		coins: 120,
		mood: { score: 60, key: 'fine', label: '悠哉', emoji: '🐳', face: 'calm' },
		intimacy: { score: 20, title: '点头之交', emoji: '🐳', nextTitle: '饭搭子', nextAt: 35 },
		today: { meals: 0, pats: 0, feeds: 0, greets: 0, coinsSpent: 0 },
		allowed: { pat: true, feedSmall: true, feedBig: true, greet: true },
		retryIn: { pat: 0, feed: 0 },
		costs: { small: 3, big: 8 },
	};
}

function makeHandler({ enabled = true, act = null, now = () => NOW } = {}) {
	const calls = [];
	const handler = createDressUpHandler(ROOT, {
		render: '2d5',
		now,
		interaction: {
			enabled,
			summary: () => fakeSummary(),
			act: (kind, payload, at) => {
				calls.push({ kind, payload, at });
				if (act) return act(kind, payload, at);
				return { ok: true, state: { ...fakeSummary(), coins: 117, allowed: { pat: false, feedSmall: false, feedBig: false, greet: true } } };
			},
		},
	});
	return { handler, calls };
}

const POST_HEADERS = {
	'content-type': 'application/json',
	'x-feiyu-interaction': '1',
	host: '127.0.0.1:3080',
	origin: 'http://127.0.0.1:3080',
	'sec-fetch-site': 'same-origin',
};

test('GET interaction-state.json：200 + no-store + 聚合；HEAD 无 body', async () => {
	const { handler } = makeHandler();
	const res = await hit(handler, createReq({ url: DRESS_UP_INTERACTION_STATE }));
	assert.equal(res.statusCode, 200);
	assert.equal(res.headers['cache-control'], 'no-store');
	const body = JSON.parse(String(res.body));
	assert.equal(body.ok, true);
	assert.equal(body.version, 1);
	assert.equal(body.coins, 120);
	assert.ok(body.mood.label);
	const head = await hit(handler, createReq({ method: 'HEAD', url: DRESS_UP_INTERACTION_STATE }));
	assert.equal(head.statusCode, 200);
	assert.equal(head.body, undefined);
});

test('disabled（未注入或 enabled=false）→ 两个端点 404；页面按 local-only 降级', async () => {
	for (const options of [undefined, { enabled: false }]) {
		const handler = options
			? makeHandler(options).handler
			: createDressUpHandler(ROOT, { now: () => NOW });
		const stateRes = await hit(handler, createReq({ url: DRESS_UP_INTERACTION_STATE }));
		assert.equal(stateRes.statusCode, 404);
		const actRes = await hit(handler, createReq({
			method: 'POST', url: DRESS_UP_INTERACTION_ACTION, headers: POST_HEADERS, body: { kind: 'pat' },
		}));
		assert.equal(actRes.statusCode, 404);
	}
});

test('POST 成功：返回最新 state；GET on action → 405', async () => {
	const { handler, calls } = makeHandler();
	const res = await hit(handler, createReq({
		method: 'POST', url: DRESS_UP_INTERACTION_ACTION, headers: POST_HEADERS, body: { kind: 'feed', tier: 'big' },
	}));
	assert.equal(res.statusCode, 200);
	assert.equal(res.headers['cache-control'], 'no-store');
	const body = JSON.parse(String(res.body));
	assert.equal(body.ok, true);
	assert.equal(body.state.coins, 117);
	assert.deepEqual(calls, [{ kind: 'feed', payload: { tier: 'big' }, at: NOW }]);
	const wrongMethod = await hit(handler, createReq({ method: 'GET', url: DRESS_UP_INTERACTION_ACTION }));
	assert.equal(wrongMethod.statusCode, 405);
	assert.equal(wrongMethod.headers.allow, 'POST');
});

test('POST 校验矩阵：缺头 403 / 跨源 403 / content-type 415 / 超长 413 / 坏 JSON 400 / 非法 kind 400', async () => {
	const { handler, calls } = makeHandler();
	const cases = [
		[{ ...POST_HEADERS, 'x-feiyu-interaction': undefined }, 403],
		[{ ...POST_HEADERS, origin: 'http://evil.example' }, 403],
		[{ ...POST_HEADERS, 'content-type': 'text/plain' }, 415],
		[POST_HEADERS, 413, `{"kind":"pat","pad":"${'x'.repeat(3000)}"}`],
		[POST_HEADERS, 400, 'not-json'],
		[POST_HEADERS, 400, { kind: 'hug' }],
	];
	for (const [headers, expected, body = { kind: 'pat' }] of cases) {
		const res = await hit(handler, createReq({ method: 'POST', url: DRESS_UP_INTERACTION_ACTION, headers, body }));
		assert.equal(res.statusCode, expected, `case ${JSON.stringify(headers)}`);
		const code = res.body ? JSON.parse(String(res.body)).code : undefined;
		assert.ok(code, '失败响应应含 code');
	}
	assert.equal(calls.length, 0, '所有校验失败都应零调用于 act（零状态变更）');
});

test('POST 业务拒绝（cooldown/no-coins）→ 409 + code + retryInMs；再次调用零变更', async () => {
	const { handler } = makeHandler({
		act: () => ({ ok: false, reason: 'cooldown', retryInMs: 18000 }),
	});
	const res = await hit(handler, createReq({
		method: 'POST', url: DRESS_UP_INTERACTION_ACTION, headers: POST_HEADERS, body: { kind: 'pat' },
	}));
	assert.equal(res.statusCode, 409);
	const body = JSON.parse(String(res.body));
	assert.equal(body.ok, false);
	assert.equal(body.code, 'cooldown');
	assert.equal(body.retryInMs, 18000);
});

test('令牌桶：突发 5 次后 429；2s 后恢复（固定 now）', async () => {
	let clock = NOW;
	const { handler } = makeHandler({ now: () => clock });
	const post = () => hit(handler, createReq({
		method: 'POST', url: DRESS_UP_INTERACTION_ACTION, headers: POST_HEADERS, body: { kind: 'pat' },
	}));
	for (let i = 0; i < 5; i++) {
		const res = await post();
		assert.equal(res.statusCode, 200, `第 ${i + 1} 次应通过`);
	}
	const limited = await post();
	assert.equal(limited.statusCode, 429);
	const info = JSON.parse(String(limited.body));
	assert.equal(info.code, 'rate-limited');
	assert.ok(info.retryInMs > 0);
	clock += 2000;
	assert.equal((await post()).statusCode, 200);
});

test('render-config v2：interaction 段含 enabled/stateUrl/actionUrl', async () => {
	const { handler } = makeHandler();
	const res = await hit(handler, createReq({ url: DRESS_UP_RENDER_CONFIG }));
	assert.equal(res.statusCode, 200);
	const body = JSON.parse(String(res.body));
	assert.equal(body.version, DRESS_UP_CONFIG_VERSION);
	assert.equal(body.version, 2);
	assert.deepEqual(body.interaction, {
		enabled: true,
		stateUrl: DRESS_UP_INTERACTION_STATE,
		actionUrl: DRESS_UP_INTERACTION_ACTION,
	});
	assert.equal(DRESS_UP_INTERACTION_STATE, `${DRESS_UP_ENTRY}interaction-state.json`);
	assert.equal(DRESS_UP_INTERACTION_ACTION, `${DRESS_UP_ENTRY}interaction`);
});

test('静态资产路径不受影响（GET 正常资产仍 200）', async () => {
	const { handler } = makeHandler();
	const res = await hit(handler, createReq({ url: `${DRESS_UP_ENTRY}app.js` }));
	assert.equal(res.statusCode, 200);
	assert.match(res.headers['content-type'], /javascript/);
});
