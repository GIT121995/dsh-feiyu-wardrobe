/**
 * v2 页面源码不变量：2.5D-only（无 DOM 人物渲染 / 无渲染开关 / 无兜底图 / 无 WebGL2 只提示）。
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { dressUpRoot } from '../lib/webserver.js';

const ROOT = dressUpRoot();
const read = (file) => readFileSync(join(ROOT, file), 'utf8');
const APP = read('app.js');
const INDEX = read('index.html');
const CSS = read('style.css');
const CORE = read('runtime-2d5-core.js');
const RUNTIME = read('runtime-2d5.js');
const WARDROBE = read('wardrobe-core.js');

/** 页面源码文件（排除历史文档与 DIY 子模块）。 */
function pageFiles() {
	return readdirSync(ROOT).filter((file) => /\.(js|html|css)$/.test(file));
}

test('index.html：删除 DOM 人物容器/脸部层/渲染开关，保留舞台与衣柜/HUD', () => {
	assert.equal(INDEX.includes('id="figure"'), false, '不应再有 DOM #figure 人形容器');
	assert.equal(INDEX.includes('figure-layer'), false, '不应再有 .figure-layer');
	assert.equal(INDEX.includes('face-layer'), false, '不应再有 B1-lite .face-layer');
	assert.equal(INDEX.includes('id="renderBtn"'), false, '不应再有渲染方式切换按钮');
	// 保留舞台/背景/特效/气泡/HUD/衣柜/图鉴
	for (const id of ['stage', 'scene', 'figureWrap', 'fx', 'bubble', 'shapeToggle', 'tabs', 'shelf', 'randomBtn', 'saveBtn', 'collectBtn', 'diyBtn', 'interactionHud', 'exportCanvas']) {
		assert.ok(INDEX.includes(`id="${id}"`), `index.html 缺少 #${id}`);
	}
	// 无 WebGL2：纯文本提示 + 重试（无任何图片兜底）
	assert.ok(INDEX.includes('id="fallbackNotice"'), '应有 WebGL2 文本提示层');
	assert.ok(INDEX.includes('id="retryBtn"'), '应有重试按钮');
	assert.match(INDEX, /不支持 WebGL2/, '提示文案应说明不支持 WebGL2');
	assert.match(INDEX, /升级浏览器/, '提示文案应给出可操作建议');
	assert.match(INDEX, /开启硬件加速/, '提示文案应建议开启硬件加速');
	assert.ok(INDEX.includes('id="diyNote"'), '应有 DIY 静态贴片提示');
	assert.match(INDEX, /不支持骨骼动画/, 'DIY 提示应说明不支持骨骼动画');
	// 版本号（v3.1.1 页面模块升 v27；资产升 v24）
	assert.match(INDEX, /app\.js\?v=28/);
	assert.match(INDEX, /style\.css\?v=28/);
	assert.ok(INDEX.includes('type="module"'));
});

test('app.js：唯一渲染路径是 2.5D runtime，DOM 渲染/双模式代码全部移除', () => {
	// 必须保留：runtime 懒加载（boot 即唯一路径）+ 资产版本 + 文本提示 + DIY 静态
	assert.ok(APP.includes("const RUNTIME_2D5_MODULE = './runtime-2d5.js?v=28'"));
	assert.ok(APP.includes('import(RUNTIME_2D5_MODULE)'), '应动态 import 2.5D runtime');
	assert.ok(APP.includes('bootRuntime()'), 'boot 应启动 2.5D runtime（唯一路径）');
	assert.ok(APP.includes('RUNTIME_2D5_ASSET_VERSION'), 'rig/atlas 应带资产版本');
	assert.ok(APP.includes("RUNTIME_2D5_ASSET_VERSION = '25'"), 'v3.2.0 资产版本应为 25（rig.bin/5 页图集 ?v=25；lazy outfit page + rig 二进化）');
	assert.ok(APP.includes('client-config.json'), '页面应读宿主 client-config（仅互动）');
	assert.ok(APP.includes('diyLayerUrls'), 'DIY 应改 canvas 静态贴片');
	assert.ok(APP.includes('不支持骨骼动画'), 'DIY 静态提示文案');
	// v2.0.1 回归：DIY 贴片前必须先切 bare，避免「基础造型衣服 + DIY 贴片」两层衣服
	assert.ok(APP.includes('runtime.setLook({ bare: true })'), 'DIY 静态模式应先切 bare（隐藏基础服装层）');
	const enterDiy = APP.slice(APP.indexOf('async function enterDiyStatic('), APP.indexOf('/** 退出 DIY 静态模式'));
	assert.ok(enterDiy.includes('bare: true'), 'enterDiyStatic 内应设置 bare');
	assert.ok(enterDiy.indexOf('bare: true') < enterDiy.indexOf('overlay.classList.add'), '应先隐藏基础服装层再叠 DIY 贴片');
	assert.match(APP, /不支持 WebGL2|不支持 WebGL2。/, '无 WebGL2 时文本提示');
	// 必须删除：DOM 图层/脸部补丁/渲染模式开关/渲染配置/兜底图
	for (const forbidden of [
		'buildFigureLayers', 'renderFigure', 'figure-layer', 'face-layer',
		'FACE_PATCH', 'facePatchesOf', 'resolveLayers', 'syncFaceShape',
		'renderMode', 'applyRenderMode', 'resolveRenderMode', 'parseRenderMode',
		'render2d5Fallback', 'render-config.json', "params.get('render')",
		'static-fallback', 'staticFallback', 'fallbackImg',
	]) {
		assert.equal(APP.includes(forbidden), false, `app.js 不应再包含：${forbidden}`);
	}
});

test('style.css：DOM 人物/脸部/渲染按钮样式删除，保留 2.5D canvas + 文本提示/DIY 贴片样式', () => {
	for (const forbidden of ['.figure-layer', '.face-layer', '.render-btn', '.figure-dim', '.figure {', 'feiyu-hop']) {
		assert.equal(CSS.includes(forbidden), false, `style.css 不应再包含：${forbidden}`);
	}
	assert.ok(CSS.includes('.figure-2d5'));
	assert.ok(CSS.includes('.fallback-notice'));
	assert.ok(CSS.includes('.fallback-notice[hidden]'), '文本提示必须能被 hidden 隐藏');
	assert.ok(CSS.includes('.diy-overlay'));
	assert.ok(CSS.includes('.diy-static-note'));
});

test('wardrobe-core / runtime core：不再提供 DOM 渲染或渲染模式决策 API', () => {
	for (const forbidden of ['resolveLayers', 'FACE_PATCHES', 'FACE_TIMING', 'facePatchesOf', 'facePatchStyle', 'randomBetween']) {
		assert.equal(WARDROBE.includes(forbidden), false, `wardrobe-core 不应再包含：${forbidden}`);
	}
	for (const forbidden of ['parseRenderMode', 'resolveRenderMode', 'resolveAutoMode', 'renderModeLabel', 'RENDER_MODES']) {
		assert.equal(CORE.includes(forbidden), false, `runtime-2d5-core 不应再包含：${forbidden}`);
	}
	assert.ok(CORE.includes('export function resolveLook'));
	assert.ok(CORE.includes('export function visibleDrawables'));
	assert.ok(RUNTIME.includes("from './runtime-2d5-core.js?v=28'"), 'runtime 模块应按 v28 复用 core');
	assert.ok(RUNTIME.includes('assetVersion'), 'runtime 应支持资产版本查询串');
	// v2.6.1 资产 tier（2x 高 DPI）：页面/运行时都必须接线 URL/localStorage 覆盖与回退
	assert.ok(APP.includes('resolveTierOverride'), 'app.js 应解析 ?feiyuTier / localStorage tier 覆盖');
	assert.ok(APP.includes('tierOverride'), 'app.js 应把 tier 覆盖传给 runtime');
	assert.ok(APP.includes('devicePixelRatio'), 'app.js 应把设备 DPR 传给 runtime（tier 决策用）');
	assert.ok(RUNTIME.includes('resolveAssetTier'), 'runtime 应使用 core 的 tier 决策');
	assert.ok(RUNTIME.includes('assetDirForTier'), 'runtime 应按 tier 选择 {shape} / {shape}-hi 目录');
	assert.ok(RUNTIME.includes('tierInfo.fallback'), 'runtime 应记录 hi 加载失败回退 lo 的原因');
	assert.ok(RUNTIME.includes('getTier()'), 'runtime 应暴露 getTier()');
	assert.ok(CORE.includes('export function resolveAssetTier'), 'core 应导出纯函数 tier 决策');
	assert.ok(CORE.includes('export function assetDirForTier'), 'core 应导出 tier 目录映射');
});

test('全站产品代码（页面 + lib）不再引用 render-config 端点或 DOM 渲染代码', () => {
	const libDir = join(ROOT, '..', '..', 'lib');
	const libFiles = readdirSync(libDir).filter((file) => file.endsWith('.js'));
	for (const file of libFiles) {
		const text = readFileSync(join(libDir, file), 'utf8');
		assert.equal(text.includes('render-config.json'), false, `lib/${file} 不应再引用 render-config.json`);
	}
	// client.js 的互动 UI 标签读 v2 client-config
	const client = readFileSync(join(libDir, 'client.js'), 'utf8');
	assert.ok(client.includes('client-config.json'), 'client.js 应读 client-config.json');
});

test('页面源码不再出现 ?render= 渲染开关或 render-config 端点', () => {
	for (const file of pageFiles()) {
		const text = read(file);
		assert.equal(text.includes('?render='), false, `${file} 不应再有 ?render= 开关`);
		assert.equal(text.includes('render-config.json'), false, `${file} 不应再引用 render-config.json`);
	}
});

test('无 WebGL2 提示不含任何人物图片/兜底图引用', () => {
	const match = INDEX.match(/<div class="fallback-notice"[\s\S]*?<\/div>\s*<div class="diy-static-note"/);
	assert.ok(match, '应能定位 fallbackNotice 结构');
	assert.equal(/<img|background-image|\.webp/.test(match[0]), false, '文本提示层不得包含图片兜底');
});

/* ---------------- v3.0.1 首屏加载体验不变量 ---------------- */

/** 页面内联 head 脚本（v3.0.1：启动计时/FCP + 版本化资产 preload）。 */
function inlineHeadBootstrap() {
	const match = INDEX.match(/<script>\s*\/\* v3\.0\.1 首屏[\s\S]*?<\/script>/);
	assert.ok(match, 'index.html 应有 v3.0.1 首屏内联 bootstrap（FCP 计时 + 资产 preload）');
	return match[0];
}

test('v3.0.1 首屏：加载态静态标记（script 执行前可见）+ 文案/进度/aria', () => {
	for (const id of ['figureLoading', 'figureLoadingText', 'figureLoadingFill', 'figureLoadingPct']) {
		assert.ok(INDEX.includes(`id="${id}"`), `index.html 缺少加载态节点 #${id}`);
	}
	const loadingTag = INDEX.match(/<div class="figure-loading"[\s\S]*?<\/div>\s*$/m);
	assert.ok(INDEX.includes('data-feiyu-loading'), '加载态应有稳定 DOM hook data-feiyu-loading');
	assert.match(INDEX, /role="status"[\s\S]{0,200}aria-live="polite"/, '加载态应可被读屏播报');
	assert.match(INDEX, /正在加载/, '加载态文案应含「加载」');
	// 加载态必须在 stage 内、figure-wrap 兄弟层（figureWrap 尺寸由 JS 计算，不能作为其子层）
	const stageStart = INDEX.indexOf('id="stage"');
	const loadingAt = INDEX.indexOf('data-feiyu-loading');
	assert.ok(stageStart > 0 && loadingAt > stageStart, '加载态应位于 stage 内（进入页面即可见）');
	assert.ok(!/id="figureLoading"[^>]*pointer-events/.test(INDEX), 'pointer-events 由 CSS 控制，不挡点击');
});

test('v3.0.1 首屏：app.js 接线加载态/timeline/渐进 tier（QA/E2E 契约）', () => {
	assert.ok(APP.includes('showLoadingState'), 'app.js 应显示加载态');
	assert.ok(APP.includes('hideLoadingState'), 'app.js 应平滑移除加载态');
	assert.ok(APP.includes('scheduleHideLoadingState'), '首帧后再移除加载态');
	assert.ok(APP.includes('waitForFirstPaint'), '长任务（GL 初始化）前应等加载态真正上屏');
	assert.ok(APP.includes('loadingTimelineSnapshot'), 'app.js 应提供 timeline() 快照');
	assert.ok(APP.includes('timeline: () => loadingTimelineSnapshot()'), 'window.__feiyu2d5 应暴露 timeline()');
	assert.ok(APP.includes('waitForTierUpgrade'), 'window.__feiyu2d5 应暴露 waitForTierUpgrade()');
	assert.ok(APP.includes('setProgressiveUpgrade'), 'window.__feiyu2d5 应暴露 setProgressiveUpgrade()');
	assert.ok(APP.includes('progressiveTier: true'), 'app.js 应把渐进 tier 传给 runtime');
	assert.ok(APP.includes('onLoadProgress'), 'app.js 应消费 runtime 加载进度');
	// 失败路径必须隐藏加载态并复用现有 WebGL2 可重试提示
	const unavailable = APP.slice(APP.indexOf('function showRuntimeUnavailable('), APP.indexOf('function hideRuntimeUnavailable('));
	assert.ok(unavailable.includes('hideLoadingState(true)'), '失败时应先隐藏加载态（避免一直转圈）');
	assert.ok(unavailable.includes('els.fallbackNotice.hidden = false'), '失败时仍显示现有 WebGL2 提示');
});

test('v3.0.1 首屏：index.html head 尽早 preload 当前 shape 的 lo rig+atlas（版本取自 meta 单一配置）', () => {
	const bootstrap = inlineHeadBootstrap();
	assert.match(INDEX, /<meta name="feiyu-asset-version" content="\d+"/, '应有资产版本 meta（供 head preload）');
	assert.ok(bootstrap.includes("params.get('shape')"), 'preload 的 shape 应优先取 URL ?shape=');
	assert.ok(bootstrap.includes("localStorage.getItem('feiyu:outfit')"), 'preload 的 shape 应回退到 localStorage 上次穿搭（与 app.js STORAGE_KEY 一致）');
	assert.ok(bootstrap.includes('feiyu:tier'), 'preload 应尊重 localStorage tier 覆盖');
	assert.ok(bootstrap.includes('searchParams.set'), 'preload URL 应用 searchParams 拼版本参数');
	assert.equal(/\?v=\d+/.test(bootstrap), false, 'head 内联脚本不得出现字面量 ?v=<page 版本>（避免页面版本门禁混淆）');
	assert.ok(bootstrap.includes("link.rel = 'preload'"), '应注入 preload link');
	assert.ok(/rel="preload"/.test(INDEX) === false, 'preload 由脚本按 shape 注入（不能写死单一 shape）');
	// meta 资产版本必须与 app.js 常量一致（避免 preload 无效浪费）
	const appVersion = APP.match(/RUNTIME_2D5_ASSET_VERSION\s*=\s*'(\d+)'/)[1];
	const metaVersion = INDEX.match(/<meta name="feiyu-asset-version" content="(\d+)"/)[1];
	assert.equal(metaVersion, appVersion, 'meta 资产版本应与 app.js RUNTIME_2D5_ASSET_VERSION 一致');
});

test('v3.0.1 首屏：runtime 落 lo→hi 渐进升级状态机 + 静态模式固定 tier', () => {
	assert.ok(RUNTIME.includes('resolveTierPlan'), 'runtime 应使用 core 的 tier 渐进计划');
	assert.ok(RUNTIME.includes('scheduleTierUpgrade'), 'setShape 后应安排后台 hi 升级');
	assert.ok(RUNTIME.includes('hotSwapTier'), 'hi 就绪后应热切换（保留物理链/DIY/不闪回）');
	assert.ok(RUNTIME.includes('waitForTierUpgrade'), 'runtime 应暴露 waitForTierUpgrade()');
	assert.ok(RUNTIME.includes('setProgressiveUpgrade'), 'runtime 应暴露 setProgressiveUpgrade()');
	assert.ok(RUNTIME.includes('getTimeline'), 'runtime 应暴露 getTimeline()');
	assert.ok(RUNTIME.includes('cancelPendingUpgrade'), 'setStatic 应取消未完成后台升级');
	assert.ok(CORE.includes('export function resolveTierPlan'), 'core 应导出 resolveTierPlan');
	assert.ok(CORE.includes('export function tierLoadPlan'), 'core 应导出 tierLoadPlan（进度阶段）');
	assert.ok(CORE.includes('export function carryDiyPacks'), 'core 应导出 carryDiyPacks（lo→hi 迁移 DIY）');
	assert.ok(CORE.includes('export function tierUpgradeSettled'), 'core 应导出 tierUpgradeSettled');
});
