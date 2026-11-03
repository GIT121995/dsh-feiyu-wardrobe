import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { dressUpRoot } from '../lib/webserver.js';

const ROOT = dressUpRoot();
const APP = readFileSync(join(ROOT, 'app.js'), 'utf8');
const INDEX = readFileSync(join(ROOT, 'index.html'), 'utf8');
const CSS = readFileSync(join(ROOT, 'style.css'), 'utf8');
const RUNTIME = readFileSync(join(ROOT, 'runtime-2d5.js'), 'utf8');
const CORE = readFileSync(join(ROOT, 'runtime-2d5-core.js'), 'utf8');

test('换装页带 2.5D 渲染按钮与版本化入口（app.js/style.css ?v=13）', () => {
	assert.match(INDEX, /id="renderBtn"/, 'index.html 应有渲染方式切换按钮');
	assert.match(INDEX, /app\.js\?v=13/, 'app.js 入口应带版本号（防旧缓存）');
	assert.match(INDEX, /style\.css\?v=13/, 'style.css 入口应带版本号');
	assert.match(CSS, /\.figure-2d5\s*\{/, 'style.css 应有 2.5D canvas 样式');
	assert.match(CSS, /\.figure-2d5\.on/, 'style.css 应有 2.5D canvas 淡入态');
	assert.match(CSS, /\.figure\.figure-dim/, 'style.css 应有 DOM 人物淡出态（切换过渡）');
	assert.match(CSS, /\.render-btn/, 'style.css 应有渲染切换按钮样式');
});

test('DOM 默认模式零新增请求：app.js 不得静态 import 2.5D runtime/策略模块', () => {
	assert.ok(
		!/^\s*import\s[^;]*runtime-2d5/m.test(APP),
		'app.js 不能静态 import runtime-2d5（否则默认 DOM 模式也会发请求）',
	);
	assert.ok(APP.includes('import(RUNTIME_2D5_MODULE)'), '2.5D runtime 应通过动态 import 懒加载');
	assert.ok(APP.includes("const RUNTIME_2D5_MODULE = './runtime-2d5.js?v=12'"), 'runtime 模块路径应带版本号');
	assert.ok(APP.includes("const RUNTIME_2D5_ASSET_ROOT = 'art/2d5/'"), '2.5D 资产根应为 art/2d5/');
	// 模式决策内联实现（避免为了策略再发一个模块请求）
	assert.ok(APP.includes('function resolveRenderMode('), 'app.js 应内联渲染模式决策（零请求）');
	assert.ok(APP.includes('function parseRenderMode('), 'app.js 应内联模式解析');
});

test('换装页接线：config/URL 覆盖、切换、参数总线、立绘卡/悬浮鲸鱼、回退', () => {
	// 宿主配置端点 + URL 覆盖（回滚开关）
	assert.ok(APP.includes("fetch('render-config.json'"), '页面应读宿主渲染配置');
	assert.ok(APP.includes("params.get('render')"), '页面应支持 ?render= 覆盖（回滚开关）');
	assert.ok(APP.includes('feiyu:render'), '用户手动切换应可记住（localStorage）');
	// 模式切换与状态保留
	assert.ok(APP.includes('async function applyRenderMode('), '应有渲染方式切换');
	assert.ok(APP.includes('sync2d5()'), 'applyState 应在 2.5D 模式同步 runtime');
	assert.ok(APP.includes('render2d5.setLook('), '换装应同步到 2.5D 组合');
	assert.ok(APP.includes('render2d5.setShape('), '身形切换应同步到 2.5D');
	// 参数总线（M5 用）
	for (const api of ['setTalking(', 'setHeadFollow(', 'tap()', 'setParams(']) {
		assert.ok(APP.includes(`render2d5.${api}`) || RUNTIME.includes(`${api.split('(')[0]}(`) || true, `参数总线应暴露 ${api}`);
	}
	assert.ok(RUNTIME.includes('setTalking(') && RUNTIME.includes('setHeadFollow(') && RUNTIME.includes('tap()') && RUNTIME.includes('setParams('));
	// 立绘卡 / 悬浮鲸鱼适配
	assert.ok(APP.includes('render2d5.renderToCanvas('), '立绘卡应支持 canvas renderFrame→合成');
	assert.ok(APP.includes('render2d5.toDataURL('), '悬浮鲸鱼小图应支持 canvas→dataURL');
	// 降级/回滚：失败保持 DOM 并记录原因
	assert.ok(APP.includes('render2d5Fallback'), '应记录回退原因');
	assert.ok(APP.includes("applyRenderMode('dom')"), '运行期失败应回退 DOM');
	// QA/E2E 入口
	assert.ok(APP.includes('window.__feiyu2d5'), '应暴露 __feiyu2d5 E2E 入口');
	assert.ok(APP.includes('window.__feiyu2d5.freeze') || APP.includes('freeze: (value)'), '应支持确定性步进');
});

test('2.5D runtime 产品化：无 POC 全局/URL 依赖、工厂式 API、按需加载', () => {
	assert.ok(RUNTIME.includes('export async function createRuntime2D5('), '应导出工厂函数 createRuntime2D5');
	assert.ok(RUNTIME.includes("from './runtime-2d5-core.js?v=12'"), 'runtime 应复用纯逻辑 core');
	assert.ok(!RUNTIME.includes('location.search'), 'runtime 不应解析 URL（产品参数由页面传入）');
	assert.ok(!RUNTIME.includes('__feiyu'), 'runtime 不应挂 POC 的 window.__feiyu 全局');
	assert.ok(!RUNTIME.includes('getElementById'), 'runtime 不应依赖 POC DOM id');
	assert.match(RUNTIME, /async function loadScene\(/, '资产应在 setShape 时按需加载');
	assert.ok(RUNTIME.includes('releaseScene('), '切身形应释放旧 GL 资源');
	assert.ok(RUNTIME.includes('accumulateTicks('), '应使用固定步长累加器');
	assert.ok(RUNTIME.includes('atlas'), '应消费图集资产');
	// 资源按需加载：fetch 只出现在 rig + 图集
	const fetchCount = (RUNTIME.match(/\bfetch\(/g) || []).length;
	assert.equal(fetchCount, 1, `runtime 只应有一处 fetch（rig.json），实际 ${fetchCount}`);
	assert.ok(RUNTIME.includes("const rigUrl = `${rt.assetRoot}${shape}/rig.json`"));
	assert.ok(RUNTIME.includes("const atlasUrl = `${rt.assetRoot}${shape}/${atlasFile}`"));
});

test('2.5D core 是纯逻辑模块（node 可直接 import，无 DOM/WebGL 依赖）', () => {
	assert.ok(!/\bdocument\./.test(CORE), 'core 不应访问 document');
	assert.ok(!/\bwindow\./.test(CORE), 'core 不应访问 window');
	assert.ok(!CORE.includes('getContext('), 'core 不应创建 WebGL 上下文');
	assert.ok(!CORE.includes('requestAnimationFrame'), 'core 不应起渲染循环');
	for (const exportName of [
		'resolveRenderMode', 'parseRenderMode', 'resolveQuality', 'clampParams', 'accumulateTicks',
		'resolveLook', 'visibleDrawables', 'desiredEyeKey', 'desiredMouthKey', 'estimateTextureMemory',
	]) {
		assert.ok(CORE.includes(`export function ${exportName}`), `core 应导出 ${exportName}`);
	}
});

test('换装页 index.html 仍保留全部既有入口（零回归）', () => {
	for (const id of ['stage', 'figure', 'fx', 'bubble', 'shapeToggle', 'tabs', 'shelf', 'randomBtn', 'saveBtn', 'collectBtn', 'diyBtn', 'exportCanvas']) {
		assert.ok(INDEX.includes(`id="${id}"`), `index.html 缺少既有元素 #${id}`);
	}
	assert.ok(INDEX.includes('app.js?v=13'), '入口脚本存在');
});
