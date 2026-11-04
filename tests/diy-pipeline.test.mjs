/**
 * DIY S2 宿主流水线测试：plan/预算/守卫/全流程（真实 Python split+bind，fake provider）/QA 回退/
 * registry 幂等/remove/CLI 单行 JSON/`/diy` 命令。
 *
 * 依赖：node ≥22（内置 test）、python3 + Pillow（split/bind 冒烟；缺失时 skip 并注明）。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { validateConfig } from '../lib/config.js';
import { executeDiyCommand } from '../lib/commands.js';
import { DiyPipelineError, createDiyPipeline, defaultPipelineConfig } from '../lib/diy-pipeline.js';

const ROOT = resolve(import.meta.dirname, '..');
const PYTHON = process.env.DSH_FEIYU_PYTHON || 'python3';

function pythonAvailable() {
	const result = spawnSync(PYTHON, ['-c', 'import PIL, numpy; print("ok")'], { encoding: 'utf8' });
	return result.status === 0 && String(result.stdout).trim() === 'ok';
}

/** 生成 look/flatout 合成 fixture（白底 + 深色矩形衣服 / 平涂灰矩形），返回 {look, flatout}。 */
function makeFixture(dir) {
	mkdirSync(dir, { recursive: true });
	const look = join(dir, 'look.png');
	const flatout = join(dir, 'flatout.png');
	const script = [
		'from PIL import Image, ImageDraw',
		'import sys',
		'W,H=1152,2048',
		'def bg():',
		'    im=Image.new("RGB",(W,H),(255,255,255)); d=ImageDraw.Draw(im)',
		'    d.ellipse((430,300,730,700),fill=(230,200,170))',
		'    d.rectangle((420,640,735,1500),fill=(240,240,240))',
		'    return im,d',
		'im,d=bg(); d.rectangle((440,860,720,1300),fill=(40,70,160)); im.save(sys.argv[1])',
		'im,d=bg(); d.rectangle((440,860,720,1300),fill=(128,128,128)); im.save(sys.argv[2])',
	].join('\n');
	const result = spawnSync(PYTHON, ['-c', script, look, flatout], { encoding: 'utf8' });
	if (result.status !== 0) return null;
	return { look, flatout };
}

function makePipeline(options = {}) {
	const tmp = mkdtempSync(join(tmpdir(), 'feiyu-diy-'));
	const statePath = join(tmp, 'state.json');
	const config = validateConfig({ statePath, ...(options.config || {}) });
	const pipeline = createDiyPipeline({
		config,
		home: join(tmp, 'diy'),
		now: () => 1_760_000_000_000,
		...options,
	});
	return { tmp, pipeline, config, statePath };
}

function fakeProvider(lookBuffer, flatBuffer) {
	let calls = 0;
	return {
		configured: true,
		model: 'fake-model',
		size: '1152x2048',
		async generate() {
			const image = calls === 0 ? lookBuffer : flatBuffer;
			calls += 1;
			return { image, mime: 'image/png', usage: {}, latencyMs: 1, attempts: 1, model: 'fake-model', size: '1152x2048' };
		},
	};
}

test('plan：校验图片/品类/形状/守卫，创建 job 并给出预算与预估', () => {
	const available = pythonAvailable();
	if (!available) return;
	const { tmp, pipeline } = makePipeline({ enabledOverride: true });
	try {
		const fixture = makeFixture(join(tmp, 'fixtures'));
		assert.ok(fixture, 'fixture 生成失败');
		const result = pipeline.plan({ image: fixture.look, name: '测试衬衫', category: 'top' });
		assert.equal(result.ok, true);
		assert.ok(result.job.startsWith('diy-'));
		assert.equal(result.estimate.images, 2);
		assert.equal(result.estimate.costYuan, 0.6);
		assert.equal(result.guard.pass, true);
		assert.equal(result.budget.ok, true);
		assert.ok(existsSync(join(tmp, 'diy', 'jobs', result.job, 'job.json')));

		assert.throws(() => pipeline.plan({ image: join(tmp, 'missing.png') }), (error) => error.code === 'image_missing');
		assert.throws(() => pipeline.plan({ image: fixture.look, category: 'swimwear' }), (error) => error.code === 'unsupported_category');
		assert.throws(() => pipeline.plan({ image: fixture.look, shape: 'girl' }), (error) => error.code === 'unsupported_shape');
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

test('plan：内容守卫硬拦截（不建 job）', () => {
	const { tmp, pipeline } = makePipeline({ enabledOverride: true });
	try {
		const image = join(tmp, 'garment.png');
		writeFileSync(image, readFileSync(join(ROOT, 'docs/dress-up/art/diy/base-chibi.png')));
		assert.throws(
			() => pipeline.plan({ image, description: '低胸露背泳装内衣', category: 'top' }),
			(error) => error instanceof DiyPipelineError && error.code === 'guard_rejected',
		);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

test('run：默认关闭时拒绝；预算不足时 generate 失败且不产生费用', async () => {
	const { tmp, pipeline } = makePipeline();
	const image = join(tmp, 'input.png');
	writeFileSync(image, readFileSync(join(ROOT, 'docs/dress-up/art/diy/base-chibi.png')));
	try {
		const job = pipeline.plan({ image, category: 'top' });
		const disabled = await pipeline.run({ job: job.job });
		assert.equal(disabled.ok, false);
		assert.equal(disabled.code, 'diy_disabled');

		const ledger = {
			canSpend: () => ({ ok: false, code: 'daily_image_limit', message: '今日额度已用完', snapshot: { images: 40 } }),
			record: () => ({}),
			snapshot: () => ({ images: 40 }),
		};
		const limited = makePipeline({ enabledOverride: true, ledger });
		const job2 = limited.pipeline.plan({ image, category: 'top' });
		assert.equal(job2.budget.ok, false);
		const result = await limited.pipeline.run({ job: job2.job, stage: 'generate' });
		assert.equal(result.ok, false);
		assert.equal(result.code, 'daily_image_limit');
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

test('全流程（fake provider + 真实 Python split/bind）：generate→split→bind→qa→install 并幂等', async () => {
	if (!pythonAvailable()) {
		console.log('skip: python3 + Pillow/numpy 不可用');
		return;
	}
	const { tmp } = makePipeline();
	const fixture = makeFixture(join(tmp, 'fixtures'));
	assert.ok(fixture);
	const lookBuffer = readFileSync(fixture.look);
	const flatBuffer = readFileSync(fixture.flatout);
	const { pipeline } = makePipeline({ enabledOverride: true, provider: fakeProvider(lookBuffer, flatBuffer), home: join(tmp, 'diy') });
	try {
		const plan = pipeline.plan({ image: fixture.look, name: '合成衬衫', category: 'top' });
		const result = await pipeline.run({ job: plan.job });
		assert.equal(result.ok, true, JSON.stringify(result));
		assert.equal(result.stages.split, 'success');
		assert.equal(result.stages.bind, 'success');
		assert.equal(result.stages.qa, 'success');
		assert.equal(result.qa.pass, true);
		assert.equal(result.qa.fallback, 'none');
		assert.equal(result.install.animated, true);
		const packDir = join(tmp, 'diy', 'packs', plan.itemId);
		assert.ok(existsSync(join(packDir, 'diy-pack.json')));
		assert.ok(existsSync(join(packDir, 'tex')));
		const pack = JSON.parse(readFileSync(join(packDir, 'diy-pack.json'), 'utf8'));
		assert.equal(pack.format, 'feiyu-diy-pack');
		assert.equal(pack.formatVersion, 1);
		assert.equal(pack.base.skeletonBones, 59);
		assert.ok(pack.drawables.length >= 1);
		assert.equal(pack.drawables[0].texture, `tex/${plan.itemId}-body.webp`);

		// registry 幂等：再安装一次不重复
		const again = pipeline.install(plan.job, { dryRun: false });
		assert.equal(again.itemId, plan.itemId);
		const list = pipeline.list();
		assert.equal(list.count, 1);
		assert.equal(list.items[0].id, plan.itemId);
		assert.equal(list.items[0].animated, true);
		// remove
		const removed = pipeline.remove({ id: plan.itemId });
		assert.equal(removed.removed, true);
		assert.equal(pipeline.list().count, 0);
		assert.equal(existsSync(packDir), false);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

test('qa：纹理缺失/覆盖率不足 → pass=false、fallback=static（安装后 animated=false）', () => {
	const { tmp, pipeline } = makePipeline({ enabledOverride: true });
	try {
		const jobId = 'diy-broken-20260101000000';
		const jobDir = join(tmp, 'diy', 'jobs', jobId);
		mkdirSync(join(jobDir, 'layers'), { recursive: true });
		mkdirSync(join(jobDir, 'pack', 'tex'), { recursive: true });
		writeFileSync(join(jobDir, 'layers', 'split.json'), JSON.stringify({ ok: true, grade: 'pass', qa: {}, defects: [] }));
		writeFileSync(join(jobDir, 'layers', 'body.png'), Buffer.from('fake-png'));
		writeFileSync(join(jobDir, 'pack', 'bind-report.json'), JSON.stringify({
			coverage: { coverageIoU: 0.5, alphaCovered: 0.5, meshOvershoot: 0.9, alphaAreaFrac: 0.05 },
			alphaClean: { body: { removedComponents: 0 } }, drawables: [], sleeve: false,
		}));
		writeFileSync(join(jobDir, 'pack', 'diy-pack.json'), JSON.stringify({
			format: 'feiyu-diy-pack', formatVersion: 1, item: jobId, shape: 'chibi', category: 'top',
			base: { skeletonBones: 59 }, drawables: [{
				id: `${jobId}-body`, slot: 'topBody', z: 40, texture: `tex/${jobId}-body.webp`,
				rect: [0, 0, 10, 10], texSize: [10, 10],
				mesh: { positions: [[0, 0], [10, 0], [10, 10]], uvs: [[0, 0], [1, 0], [1, 1]],
					bones: [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]],
					weights: [[1, 0, 0, 0], [1, 0, 0, 0], [1, 0, 0, 0]], deform: [[0, 0], [0, 0], [0, 0]],
					indices: [0, 1, 2] },
			}], outfits: { [jobId]: { name: 'broken', topBody: [`${jobId}-body`], sleeve: [], bottom: [] } },
		}));
		writeFileSync(join(jobDir, 'job.json'), JSON.stringify({
			version: 1, id: jobId, itemId: jobId, status: 'running',
			input: { name: 'broken', category: 'top', shape: 'chibi', description: '测试' },
			createdAt: new Date().toISOString(), stages: {},
		}));
		const qa = pipeline.stages.qa({ id: jobId, itemId: jobId, input: { name: 'broken', category: 'top', shape: 'chibi' }, createdAt: new Date().toISOString(), stages: {} });
		assert.equal(qa.pass, false);
		assert.equal(qa.fallback, 'static');
		const install = pipeline.install(jobId, { dryRun: false });
		assert.equal(install.animated, false);
		assert.equal(install.fallback, 'static');
		assert.equal(install.static.body, 'static/body.png');
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

test('CLI：plan/list/未知命令输出单行 JSON', () => {
	const tmp = mkdtempSync(join(tmpdir(), 'feiyu-diy-cli-'));
	try {
		const image = join(ROOT, 'docs/dress-up/art/diy/base-chibi.png');
		const run = (args) => {
			const result = spawnSync(process.execPath, [join(ROOT, 'bin', 'dsh-feiyu-diy.mjs'), ...args], {
				encoding: 'utf8',
				cwd: ROOT,
			});
			const lines = String(result.stdout).trim().split(/\n/).filter(Boolean);
			assert.equal(lines.length, 1, `stdout 必须恰好一行 JSON：${result.stdout}`);
			return { code: result.status, json: JSON.parse(lines[0]) };
		};
		const planned = run(['plan', '--image', image, '--name', 'CLI 测试', '--category', 'top', '--home', tmp]);
		assert.equal(planned.code, 0);
		assert.equal(planned.json.ok, true);
		assert.ok(planned.json.job);
		const listed = run(['list', '--home', tmp]);
		assert.equal(listed.json.count, 0);
		const bad = run(['nope', '--home', tmp]);
		assert.equal(bad.code, 2);
		assert.equal(bad.json.code, 'bad_argument');
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

test('executeDiyCommand：/diy plan 返回 JSON 文本块，错误码可解析', async () => {
	const { tmp, pipeline } = makePipeline({ enabledOverride: true });
	try {
		const image = join(ROOT, 'docs/dress-up/art/diy/base-chibi.png');
		const ok = await executeDiyCommand(pipeline, `plan --image ${image} --name 命令测试 --category top`);
		assert.equal(ok.kind, 'success');
		const match = ok.text.match(/```json\n(.+)\n```/s);
		assert.ok(match, ok.text);
		const data = JSON.parse(match[1]);
		assert.equal(data.ok, true);
		assert.ok(data.job);
		const failed = await executeDiyCommand(pipeline, 'run --job nope');
		assert.equal(failed.kind, 'error');
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

test('split_layers.py 冒烟：合成图 → 层 + split.json', () => {
	if (!pythonAvailable()) {
		console.log('skip: python3 + Pillow/numpy 不可用');
		return;
	}
	const tmp = mkdtempSync(join(tmpdir(), 'feiyu-diy-split-'));
	try {
		const fixture = makeFixture(join(tmp, 'fixtures'));
		assert.ok(fixture);
		const out = join(tmp, 'layers');
		const result = spawnSync(PYTHON, [
			join(ROOT, 'tools', 'diy', 'split_layers.py'),
			'--look', fixture.look, '--flatout', fixture.flatout,
			'--hair', join(ROOT, 'docs/dress-up/art/diy/masks/chibi/hair.webp'),
			'--arms', join(ROOT, 'docs/dress-up/art/diy/masks/chibi/arms.webp'),
			'--category', 'top', '--out', out,
		], { encoding: 'utf8' });
		assert.equal(result.status, 0, result.stderr);
		const payload = JSON.parse(String(result.stdout).trim().split(/\n/).pop());
		assert.equal(payload.ok, true);
		assert.ok(existsSync(join(out, 'body.png')));
		assert.ok(existsSync(join(out, 'split.json')));
		const split = JSON.parse(readFileSync(join(out, 'split.json'), 'utf8'));
		assert.ok(split.qa.alphaAreaFrac > 0);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});
