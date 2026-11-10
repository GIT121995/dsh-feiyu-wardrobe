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
	// 版本号（v2.7.0 页面模块升 v24；资产升 v21）
	assert.match(INDEX, /app\.js\?v=24/);
	assert.match(INDEX, /style\.css\?v=24/);
	assert.ok(INDEX.includes('type="module"'));
});

test('app.js：唯一渲染路径是 2.5D runtime，DOM 渲染/双模式代码全部移除', () => {
	// 必须保留：runtime 懒加载（boot 即唯一路径）+ 资产版本 + 文本提示 + DIY 静态
	assert.ok(APP.includes("const RUNTIME_2D5_MODULE = './runtime-2d5.js?v=24'"));
	assert.ok(APP.includes('import(RUNTIME_2D5_MODULE)'), '应动态 import 2.5D runtime');
	assert.ok(APP.includes('bootRuntime()'), 'boot 应启动 2.5D runtime（唯一路径）');
	assert.ok(APP.includes('RUNTIME_2D5_ASSET_VERSION'), 'rig/atlas 应带资产版本');
	assert.ok(APP.includes("RUNTIME_2D5_ASSET_VERSION = '21'"), 'v2.7.0 资产版本应为 21（rig/atlas ?v=21；毛衣下架后 dist 变更递增）');
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
	assert.ok(RUNTIME.includes("from './runtime-2d5-core.js?v=24'"), 'runtime 模块应按 v24 复用 core');
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
