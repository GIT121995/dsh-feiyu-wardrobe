import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
	ARK_API_URL,
	DEFAULT_DIY_MODEL,
	DEFAULT_DIY_SIZE,
	DiyProviderError,
	createSeedreamClient,
	imageToDataUrl,
	loadArkKey,
	referenceToDataUrl,
	sanitizeProviderError,
} from '../lib/diy-provider.js';

const KEY = 'sk-test-secret-key-123';

/** 最小合法 PNG 头 + 填充（满足 ≥1000 字节校验）。 */
function pngBytes(size = 2000) {
	const buffer = Buffer.alloc(Math.max(24, size));
	Buffer.from('89504e470d0a1a0a', 'hex').copy(buffer, 0);
	return buffer;
}

function pngResponse(buffer = pngBytes()) {
	return {
		status: 200,
		ok: true,
		async json() {
			return {};
		},
		async text() {
			return '';
		},
		async arrayBuffer() {
			return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
		},
	};
}

function jsonResponse(payload, status = 200) {
	return {
		status,
		ok: status >= 200 && status < 300,
		async json() {
			return payload;
		},
		async text() {
			return JSON.stringify(payload);
		},
		async arrayBuffer() {
			return new ArrayBuffer(0);
		},
	};
}

function errorResponse(status, text = '') {
	return {
		status,
		ok: false,
		async json() {
			throw new Error('not json');
		},
		async text() {
			return text;
		},
		async arrayBuffer() {
			return new ArrayBuffer(0);
		},
	};
}

function createHarness(handler, options = {}) {
	const calls = [];
	const sleeps = [];
	const client = createSeedreamClient({
		apiKey: options.apiKey === undefined ? KEY : options.apiKey,
		model: DEFAULT_DIY_MODEL,
		size: DEFAULT_DIY_SIZE,
		retries: options.retries ?? 2,
		fetchImpl: async (url, init) => {
			calls.push({ url, init });
			return handler(url, init, calls.length);
		},
		sleep: async (ms) => {
			sleeps.push(ms);
		},
	});
	return { client, calls, sleeps };
}

const REQUEST = {
	prompt: '参考图1是这个角色的素体。请给她穿上参考图2的衣服。',
	references: ['data:image/png;base64,AAAA'],
};

/* ---------------- 凭证与脱敏 ---------------- */

test('loadArkKey：环境变量优先，其次宿主 env 文件，找不到返回空串', () => {
	assert.equal(loadArkKey({ env: { ARK_API_KEY: 'sk-env' } }), 'sk-env');
	const dir = mkdtempSync(join(tmpdir(), 'feiyu-diy-key-'));
	const file = join(dir, 'env');
	writeFileSync(file, '# comment\nARK_API_KEY="sk-file"\nOTHER=1\n');
	assert.equal(loadArkKey({ env: {}, envFile: file }), 'sk-file');
	assert.equal(loadArkKey({ env: {}, envFile: join(dir, 'missing') }), '');
});

test('sanitizeProviderError：key/Bearer/签名参数全部脱敏且截断', () => {
	const text = `Authorization: Bearer ${KEY} failed; ARK_API_KEY=${KEY}; url=.png?X-Tos-Signature=abc&signature=xyz`;
	const clean = sanitizeProviderError(text, KEY);
	assert.ok(!clean.includes(KEY), clean);
	assert.ok(!clean.includes('abc'), clean);
	assert.ok(clean.includes('***'));
	assert.ok(sanitizeProviderError('x'.repeat(2000)).length <= 501);
});

test('referenceToDataUrl / imageToDataUrl：data URL 透传、文件转 base64', () => {
	assert.equal(referenceToDataUrl('data:image/png;base64,AAAA'), 'data:image/png;base64,AAAA');
	assert.throws(() => referenceToDataUrl(''), DiyProviderError);
	const dir = mkdtempSync(join(tmpdir(), 'feiyu-diy-ref-'));
	const file = join(dir, 'a.png');
	writeFileSync(file, pngBytes());
	assert.match(referenceToDataUrl(file), /^data:image\/png;base64,/);
	assert.match(imageToDataUrl(pngBytes(), 'image/webp'), /^data:image\/webp;base64,/);
});

/* ---------------- 客户端行为 ---------------- */

test('未配置 key：configured=false，generate 抛 missing_api_key', async () => {
	const { client } = createHarness(() => jsonResponse({}), { apiKey: '' });
	assert.equal(client.configured, false);
	await assert.rejects(() => client.generate(REQUEST), (error) => {
		assert.equal(error.code, 'missing_api_key');
		return true;
	});
});

test('成功路径（url → 下载）：返回图片 Buffer / mime / attempts=1，且请求体不含明文以外的 key 头', async () => {
	const downloaded = pngBytes(3000);
	const { client, calls } = createHarness((url, init) => {
		if (url === ARK_API_URL) {
			const payload = JSON.parse(init.body);
			assert.equal(payload.model, DEFAULT_DIY_MODEL);
			assert.equal(payload.size, DEFAULT_DIY_SIZE);
			assert.equal(payload.response_format, 'url');
			assert.equal(payload.watermark, false);
			assert.equal(init.headers.authorization, `Bearer ${KEY}`);
			assert.ok(Array.isArray(payload.image) || typeof payload.image === 'string');
			return jsonResponse({ data: [{ url: 'https://cdn.example/x.png' }], usage: { generated: 1 } });
		}
		return pngResponse(downloaded);
	});
	const result = await client.generate({ ...REQUEST, seed: 42 });
	assert.equal(result.attempts, 1);
	assert.equal(result.mime, 'image/png');
	assert.equal(result.image.length, downloaded.length);
	assert.deepEqual(result.usage, { generated: 1 });
	assert.equal(calls.length, 2);
});

test('b64_json 响应：不二次下载', async () => {
	const { client, calls } = createHarness(() =>
		jsonResponse({ data: [{ b64_json: pngBytes().toString('base64') }] }),
	);
	const result = await client.generate(REQUEST);
	assert.equal(result.image.length, 2000);
	assert.equal(calls.length, 1);
});

test('5xx 重试 ≤2：第二次成功，attempts=2 且 sleep 过一次', async () => {
	const { client, calls, sleeps } = createHarness((url, init, call) => {
		if (url === ARK_API_URL && call === 1) return errorResponse(503, 'busy');
		if (url === ARK_API_URL) return jsonResponse({ data: [{ url: 'https://cdn.example/x.png' }] });
		return pngResponse();
	});
	const result = await client.generate(REQUEST);
	assert.equal(result.attempts, 2);
	assert.equal(sleeps.length, 1);
	assert.equal(calls.length, 3); // 2 POST + 1 下载
});

test('连续 5xx：重试 2 次后抛 api_retry_exhausted（总尝试 3 次）', async () => {
	const { client, calls } = createHarness(() => errorResponse(502, 'bad gateway'));
	await assert.rejects(
		() => client.generate(REQUEST),
		(error) => {
			assert.equal(error.code, 'api_retry_exhausted');
			assert.equal(error.attempts, 3);
			return true;
		},
	);
	assert.equal(calls.length, 3);
});

test('4xx 不重试：api_rejected，错误信息脱敏（不含 key）', async () => {
	const { client, calls } = createHarness((url, init, call) =>
		call === 1 ? errorResponse(400, `bad prompt Authorization: Bearer ${KEY}`) : pngResponse(),
	);
	await assert.rejects(
		() => client.generate(REQUEST),
		(error) => {
			assert.equal(error.code, 'api_rejected');
			assert.ok(!error.message.includes(KEY), error.message);
			assert.match(error.message, /\*\*\*/);
			return true;
		},
	);
	assert.equal(calls.length, 1);
});

test('网络错误重试后失败：network_failed，消息脱敏', async () => {
	const { client, calls } = createHarness(() => {
		throw new Error(`socket hang up ${KEY}`);
	});
	await assert.rejects(
		() => client.generate(REQUEST),
		(error) => {
			assert.equal(error.code, 'network_failed');
			assert.ok(!error.message.includes(KEY), error.message);
			return true;
		},
	);
	assert.equal(calls.length, 3);
});

test('非法响应/下载失败/超大图/非法 prompt 都归类到明确错误码', async () => {
	const badJson = createHarness(() => ({
		status: 200,
		ok: true,
		async json() {
			throw new Error('nope');
		},
		async text() {
			return '';
		},
		async arrayBuffer() {
			return new ArrayBuffer(0);
		},
	}));
	await assert.rejects(() => badJson.client.generate(REQUEST), (error) => error.code === 'bad_response');

	const noImage = createHarness(() => jsonResponse({ data: [] }));
	await assert.rejects(() => noImage.client.generate(REQUEST), (error) => error.code === 'bad_response');

	const downloadFail = createHarness((url) => (url === ARK_API_URL ? jsonResponse({ data: [{ url: 'https://x/y.png' }] }) : errorResponse(404)));
	await assert.rejects(() => downloadFail.client.generate(REQUEST), (error) => error.code === 'download_failed');

	const tooLarge = createHarness(() => jsonResponse({ data: [{ b64_json: Buffer.alloc(13 * 1024 * 1024).toString('base64') }] }));
	await assert.rejects(() => tooLarge.client.generate(REQUEST), (error) => error.code === 'image_too_large');

	const { client } = createHarness(() => jsonResponse({ data: [{ b64_json: pngBytes().toString('base64') }] }));
	await assert.rejects(() => client.generate({ ...REQUEST, prompt: '短' }), (error) => error.code === 'bad_prompt');
	await assert.rejects(() => client.generate({ ...REQUEST, references: [] }), (error) => error.code === 'bad_reference');
	await assert.rejects(() => client.generate({ ...REQUEST, references: ['a', 'b', 'c', 'd'] }), (error) => error.code === 'bad_reference');
});
