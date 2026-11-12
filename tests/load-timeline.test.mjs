/**
 * v3.0.1 · 首屏加载体验门禁判定逻辑测试（QA task-4 门禁 ③ 的确定性部分）
 *
 * 分工：
 *   - 真机/headless 时间线采集 = `scripts/qa-load-timeline.mjs`（单 Chrome、CDP 节流、截图证据）；
 *   - 本测试 = 用**实测/合成时间线数据**验证该脚本的判定函数 `evaluateRun` 与阈值
 *     `THRESHOLDS`：修复前的 v3.0.0 数据必须 FAIL，修复后目标数据必须 PASS，
 *     且每条断言都能按原因给出可读失败信息。这样 CI/`npm test` 不需要 Chrome 也能守住判定口径。
 *
 * 数据：
 *   - `tests/fixtures/load-timeline-v300-chibi-dpr2-hi.json`：v3.0.0 未修复实测
 *     （2026-11-12 qa：chibi DPR2 hi override 正常网络 stub host，无加载提示、首帧 3994ms/ready 4019ms）；
 *   - 合成「修复后」数据：加载提示 ready 前可见、lo 首帧提前、hi 升级完成（符合 runtimefix v3.0.1 契约）。
 *
 * 真实 E2E 复跑（task-5）：`node scripts/qa-load-timeline.mjs --shape both --dpr 2 --tier hi --assert`；
 * 结果写 `.visual-qa/load-timeline/`（不入 git）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { THRESHOLDS, evaluateRun } from '../scripts/qa-load-timeline.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const FIXTURE_V300 = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'load-timeline-v300-chibi-dpr2-hi.json'), 'utf8'));
const OPTIONS = { shape: 'chibi', dpr: 2, tier: 'hi', throttle: 'none' };

/** 合成一条「修复后达标」的 run（runtimefix v3.0.1 契约字段齐全、两路时间一致）。 */
function fixedRun() {
	return {
		tag: 'chibi_dpr2_tier-hi_net-none_fixed',
		shape: 'chibi',
		options: { dpr: 2, tier: 'hi', throttle: 'none' },
		fatal: null,
		pageErrors: [],
		tier: { tier: 'hi', reason: 'override:url', override: { tier: 'hi', source: 'url' } },
		// 契约 API：firstFrame=lo 先出图，ready=流程结束；override=hi 直接按 hi 加载（无升档）
		runtimeTimeline: {
			bootStartAt: 120, loadingShownAt: 150, firstFrameAt: 1350, readyAt: 3200,
			loadingHiddenAt: 3300, tierAtFirstFrame: 'hi', targetTier: 'hi',
			tierReadyAt: 3200, upgrade: { status: 'not-needed', startedAt: null, doneAt: null },
		},
		loading: { selector: '#figureLoading', text: '正在加载角色…', visibleAt: 150, lastVisibleAt: 3200, hiddenAt: 3300, visibleBeforeReady: true, visibleMs: 3050, sampleCount: 300, visibleSamples: 200 },
		marks: { navigationStart: 0, domContentLoaded: 120, canvasInDom: 300, firstDraw: 1350, ready: 3200, loadEvent: 400, loadingVisible: 150, loadingHidden: 3300 },
		canvasRect: { x: 62, y: 22, width: 295, height: 525 },
		firstDrawOk: true,
		readyOk: true,
		requests: {
			count: 40,
			hiArt: ['art/2d5/chibi-hi/rig.json?v=22', 'art/2d5/chibi-hi/atlas.webp?v=22', 'art/2d5/chibi-hi/atlas-2.webp?v=22'],
			loArt: ['art/2d5/chibi/rig.json?v=22', 'art/2d5/chibi/atlas.webp?v=22'],
		},
		resourcesSummary: { count: 8, transferSize: 900000, decodedBodySize: 1200000 },
		pixels: { shots: { pending: { pendingDarkRatio: 0.30, figStd: 30 }, firstframe: { changedRatio: 0.42 } } },
	};
}

test('load-timeline · v3.0.0 未修复实测数据必须 FAIL（用户反馈 #3 能被门禁抓住）', () => {
	const gate = evaluateRun(FIXTURE_V300, OPTIONS);
	assert.equal(gate.pass, false, 'v3.0.0 数据（无加载提示、首帧 4s）不应被判为通过');
	const text = gate.failures.join('\n');
	assert.match(text, /加载提示不存在/, `应包含「加载提示不存在」失败：\n${text}`);
	// v3.0.0 结构性问题：没有加载提示 + 首帧是 hi-first（fixture 为 tier=hi override）
	assert.equal(gate.pass, false);
	assert.equal(gate.metrics.firstFrameMs, 3994, '失败信息应带实测首帧数字');
	// 墙钟阈值已按 SwANGLE 环境复标（normal 6000ms）；3994ms 本身不再触发「过晚」，由加载提示断言抓住回归。
	assert.doesNotMatch(text, /加载提示不存在[\s\S]*加载提示不存在/, '不应重复报同一条');
});

test('load-timeline · ready 前 figure 区纯暗空白且无加载提示 → FAIL（用户看到「人物没加载出来」）', () => {
	// 该场景是 v3.0.0 在真机移动网络/首次访问（背景图也未加载）时的形态：合成数据验证判定分支。
	const run = JSON.parse(JSON.stringify(FIXTURE_V300));
	run.pixels = { shots: { pending: { pendingDarkRatio: 0.995, figStd: 4 }, firstframe: { changedRatio: 0.30 } } };
	const gate = evaluateRun(run, OPTIONS);
	assert.equal(gate.pass, false);
	assert.ok(gate.failures.some((f) => /纯暗像素且无加载提示/.test(f)), gate.failures.join('\n'));
});

test('load-timeline · v3.0.1 修复后达标数据必须 PASS', () => {
	const gate = evaluateRun(fixedRun(), OPTIONS);
	assert.equal(gate.pass, true, `修复后达标数据应通过，实际失败：\n${gate.failures.join('\n')}`);
	assert.equal(gate.metrics.firstFrameMs, 1350);
	assert.equal(gate.metrics.readyAt, 3200);
	assert.equal(gate.metrics.loadingVisibleAt, 150);
	assert.equal(gate.contract.finalTier, 'hi');
	assert.equal(gate.contract.targetTier, 'hi');
});

test('load-timeline · 逐条断言可独立抓住回归（各自只触发一条失败）', () => {
	// 1) 加载提示出现太晚（> loadingVisibleMaxMs）
	{
		const run = fixedRun();
		run.loading.visibleAt = THRESHOLDS.loadingVisibleMaxMs + 300;
		run.marks.loadingVisible = run.loading.visibleAt;
		run.runtimeTimeline.loadingShownAt = run.loading.visibleAt;
		const gate = evaluateRun(run, OPTIONS);
		assert.equal(gate.pass, false);
		assert.ok(gate.failures.some((f) => /出现太晚/.test(f)), gate.failures.join('\n'));
	}
	// 2) 加载提示 ready 后未隐藏
	{
		const run = fixedRun();
		run.loading.hiddenAt = null;
		run.marks.loadingHidden = null;
		run.runtimeTimeline.loadingHiddenAt = null;
		const gate = evaluateRun(run, OPTIONS);
		assert.equal(gate.pass, false);
		assert.ok(gate.failures.some((f) => /ready 后未隐藏/.test(f)), gate.failures.join('\n'));
	}
	// 3) 首帧过晚（lo 先出图严重失效 / 白屏卡死；墙钟 sanity 阈值 = normal 6000ms）
	{
		const run = fixedRun();
		run.marks.firstDraw = THRESHOLDS.firstFrameMaxMs.normal + 100;
		run.runtimeTimeline.firstFrameAt = run.marks.firstDraw;
		const gate = evaluateRun(run, OPTIONS);
		assert.equal(gate.pass, false);
		assert.ok(gate.failures.some((f) => /首帧人物出现过晚/.test(f)), gate.failures.join('\n'));
	}
	// 4) tier override 静默降级（hi → lo）
	{
		const run = fixedRun();
		run.tier.tier = 'lo';
		const gate = evaluateRun(run, OPTIONS);
		assert.equal(gate.pass, false);
		assert.ok(gate.failures.some((f) => /静默降级|override=hi/.test(f)), gate.failures.join('\n'));
	}
	// 5) 加载提示存在但文案不含「加载」（用户不知道在干嘛）
	{
		const run = fixedRun();
		run.loading.text = '请稍候';
		const gate = evaluateRun(run, OPTIONS);
		// 文案只做 diagnostic，不判死；但必须出现在 diagnostics 里
		assert.ok((gate.diagnostics || []).some((d) => /文案不含「加载」/.test(d)), JSON.stringify(gate.diagnostics));
	}
	// 6) 首帧截图空白（ready 了但画面没人物）
	{
		const run = fixedRun();
		run.pixels.shots.firstframe.changedRatio = 0.01;
		const gate = evaluateRun(run, OPTIONS);
		assert.equal(gate.pass, false);
		assert.ok(gate.failures.some((f) => /首帧截图像素异常/.test(f)), gate.failures.join('\n'));
	}
});

test('load-timeline · tier 静态确定性断言（override 固定最终 tier、不启动 lo→hi 升级）', () => {
	// hi override 但 timeline 报告首帧 tier=lo / 存在进行中的升级 → 失败（QA 基线确定性要求）
	{
		const run = fixedRun();
		run.runtimeTimeline.tierAtFirstFrame = 'lo';
		run.runtimeTimeline.upgrade = { status: 'running', startedAt: 1500, doneAt: null };
		const gate = evaluateRun(run, OPTIONS);
		assert.equal(gate.pass, false);
		assert.ok(gate.failures.some((f) => /progressive upgrade|首帧 tier=lo/.test(f)), gate.failures.join('\n'));
	}
	// lo override：不得请求 hi 资产、最终 tier 固定 lo
	{
		const run = fixedRun();
		run.options = { dpr: 1, tier: 'lo', throttle: 'none' };
		run.tier = { tier: 'lo', reason: 'override:url', override: { tier: 'lo', source: 'url' } };
		run.runtimeTimeline = null;
		run.requests.hiArt = [];
		const gate = evaluateRun(run, { shape: 'chibi', dpr: 1, tier: 'lo', throttle: 'none' });
		assert.equal(gate.pass, true, gate.failures.join('\n'));
		run.requests.hiArt = ['art/2d5/chibi-hi/rig.json?v=22'];
		const gate2 = evaluateRun(run, { shape: 'chibi', dpr: 1, tier: 'lo', throttle: 'none' });
		assert.equal(gate2.pass, false);
		assert.ok(gate2.failures.some((f) => /却请求了 hi tier 资产/.test(f)), gate2.failures.join('\n'));
	}
});
