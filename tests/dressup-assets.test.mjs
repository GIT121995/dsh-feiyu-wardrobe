import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { dressUpRoot } from '../lib/webserver.js';

const ROOT = dressUpRoot();
const MANIFEST = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));

/** v6 契约：drawOrder 的 7 个深度槽位（LAYER-MODEL.md §1）。 */
const DRAW_ORDER = ['body', 'topUnder', 'bottom', 'topBody', 'arms', 'sleeve', 'hair'];
/** 身形自带的身体部件层。 */
const SHAPE_LAYER_SLOTS = ['body', 'arms', 'hair'];
/** 身形层之外、由单品占用的槽位（下装 bottom / 上衣 topUnder+topBody+sleeve / 套装 topBody+sleeve）。 */
const ITEM_LAYER_SLOTS = ['topUnder', 'bottom', 'topBody', 'sleeve'];
const CLOTHING_CATEGORIES = ['outfits', 'tops', 'bottoms'];

/** 2.5D runtime 资产：每身形 rig.json 引用的图集 + 构建报告（由 tools/build_2d5.py 产出）。 */
function collect2d5RuntimeFiles() {
	/** @type {Set<string>} */
	const referenced = new Set();
	for (const shape of ['chibi', 'girl']) {
		const rigRel = `art/2d5/${shape}/rig.json`;
		referenced.add(rigRel);
		referenced.add(`art/2d5/${shape}/build-report.json`);
		const rig = JSON.parse(readFileSync(join(ROOT, rigRel), 'utf8'));
		const atlas = (rig.atlas && rig.atlas.file) || 'atlas.webp';
		referenced.add(`art/2d5/${shape}/${atlas}`);
	}
	return referenced;
}

/** 断言相对路径存在、是 WebP 且体积像真图。 */
function assertWebp(rel, label) {
	const file = join(ROOT, rel);
	assert.ok(existsSync(file), `${label}: missing ${rel}`);
	const bytes = readFileSync(file);
	assert.ok(bytes.byteLength > 1024, `${label}: too small ${rel}`);
	assert.equal(bytes.subarray(0, 4).toString('latin1'), 'RIFF', `${label}: not RIFF ${rel}`);
	assert.equal(bytes.subarray(8, 12).toString('latin1'), 'WEBP', `${label}: not WEBP ${rel}`);
}

/** 递归列出目录下所有文件（相对 ROOT 的 posix 路径）。 */
function walk(relDir) {
	/** @type {string[]} */
	const out = [];
	const dir = join(ROOT, relDir);
	if (!existsSync(dir)) return out;
	const base = ROOT.endsWith('/') ? ROOT : `${ROOT}/`;
	for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
		if (entry.isFile()) {
			const full = join(entry.parentPath || entry.path, entry.name);
			out.push(full.slice(base.length).split('\\').join('/'));
		}
	}
	return out;
}

/** 递归收集 manifest 里所有字符串（带 JSON 键路径，便于报错定位）。 */
function collectManifestStrings(value, path = 'manifest') {
	/** @type {Array<[string, string]>} */
	const out = [];
	if (typeof value === 'string') out.push([path, value]);
	else if (value && typeof value === 'object') {
		for (const [key, child] of Object.entries(value)) out.push(...collectManifestStrings(child, `${path}.${key}`));
	}
	return out;
}

/** v5 的整套立绘裸文件（art/<shape>/(dress|combo)-*.webp）。 */
function isLegacyWholeLook(rel) {
	return /^art\/(?:chibi|girl)\/(?:dress|combo)-[^/]+\.webp$/.test(rel);
}

/** v5 的素体 / 头发叠层文件。 */
function isLegacyShapeFile(rel) {
	return /^art\/(?:chibi|girl)\/(?:base|overlay)\.webp$/.test(rel);
}

/** B1-lite 脸部动画补丁：运行时特效层，由 wardrobe-core.FACE_PATCHES 引用，不进 manifest。 */
function isFacePatch(rel) {
	return /^art\/(?:chibi|girl)\/face\/(?:eye_blink|eye_smile|mouth_mid|mouth_open)\.webp$/.test(rel);
}

/** v5 保守范围里「无槽位后缀」的旧上衣 / 套装图层（新文件名带 -topBody/-topUnder/-sleeve 等槽位后缀）。 */
function isLegacyBareLayer(rel) {
	return /^art\/(?:chibi|girl)\/layers\/(?:dress-maid|top-sweater|top-hoodie|top-sailor)\.webp$/.test(rel);
}

/** 单个身形下某件单品的槽位映射。 */
function itemSlots(item, shapeId) {
	return (item.layers && item.layers[shapeId]) || null;
}

/* ---------------- manifest v6：整体契约 ---------------- */

test('manifest v7：drawOrder / 两种身形 / 5 个分类（v6 数据语义不变）', () => {
	assert.equal(MANIFEST.version, 7, 'manifest 版本应为 7（新增 DIY 扩展声明，v6 字段不变）');
	assert.deepEqual(MANIFEST.drawOrder, DRAW_ORDER, 'drawOrder 必须与 LAYER-MODEL.md §1 一致');
	assert.deepEqual(MANIFEST.shapes.map((shape) => shape.id), ['chibi', 'girl']);
	assert.deepEqual(
		MANIFEST.categories.map((category) => category.id),
		['outfits', 'tops', 'bottoms', 'backgrounds', 'effects'],
	);
	assert.ok(typeof MANIFEST.credits === 'string' && MANIFEST.credits.length > 10);
	assert.ok(typeof MANIFEST.title === 'string' && MANIFEST.title.length > 0);
	assert.equal(MANIFEST.bounds, undefined, 'v6 没有顶层 bounds（改到 shapes[].bounds）');
	assert.equal(MANIFEST.diy && typeof MANIFEST.diy, 'object', 'v7 必须带 DIY 扩展声明');
	assert.equal(MANIFEST.diy.enabled, false, 'DIY 默认关闭');
	assert.equal(MANIFEST.diy.storage, 'indexeddb');
});

test('每个身形有 body/arms/hair 三层（WebP），且只引用 drawOrder 里的槽位', () => {
	for (const shape of MANIFEST.shapes) {
		assert.ok(shape.layers && typeof shape.layers === 'object', `${shape.id} 需要 layers 映射`);
		assert.equal(shape.base, undefined, `${shape.id} 不应再有 v5 的 base 字段`);
		assert.equal(shape.overlay, undefined, `${shape.id} 不应再有 v5 的 overlay 字段`);
		for (const slot of SHAPE_LAYER_SLOTS) {
			const rel = shape.layers[slot];
			assert.ok(rel, `${shape.id} 缺少 ${slot} 层`);
			assert.equal(rel, `art/${shape.id}/${slot}.webp`, `${shape.id} 的 ${slot} 层路径应为 art/${shape.id}/${slot}.webp`);
			assertWebp(rel, `${shape.id}/${slot}`);
		}
		for (const slot of Object.keys(shape.layers)) {
			assert.ok(MANIFEST.drawOrder.includes(slot), `${shape.id} 的槽位 ${slot} 不在 drawOrder 里`);
		}
		const { top, bottom } = shape.bounds || {};
		assert.ok(typeof top === 'number' && top >= 0 && top < 0.5, `${shape.id} bounds.top 不合理：${top}`);
		assert.ok(typeof bottom === 'number' && bottom > 0.6 && bottom <= 1, `${shape.id} bounds.bottom 不合理：${bottom}`);
		assert.ok(bottom > top, `${shape.id} bounds.bottom 应大于 top`);
	}
});

/* ---------------- 保守范围：1 套装 + 3 上衣 + 2 下装 ---------------- */

test('v0.9 保守范围：套装只留「经典女仆装」，上衣 3 件、下装 2 件', () => {
	assert.deepEqual(
		MANIFEST.items.outfits.map((item) => item.id),
		['none', 'maid'],
		'套装应只剩 none + maid',
	);
	assert.deepEqual(
		MANIFEST.items.tops.map((item) => item.id).sort(),
		['hoodie', 'sailor', 'sweater'],
		'上衣应保留 sweater / hoodie / sailor',
	);
	assert.deepEqual(
		MANIFEST.items.bottoms.map((item) => item.id).sort(),
		['plaid', 'pleated'],
		'下装应保留 plaid / pleated',
	);
});

/* ---------------- 单品图层：每身形齐全、槽位合法、文件存在 ---------------- */

test('每件单品都有 v6 layers 映射，每身形图层齐全、槽位合法且是 WebP', () => {
	/** @type {Map<string, number>} 每个身形的衣服图层文件数 */
	const perShapeCount = new Map(MANIFEST.shapes.map((shape) => [shape.id, 0]));
	let itemCount = 0;

	for (const categoryId of CLOTHING_CATEGORIES) {
		for (const item of MANIFEST.items[categoryId] || []) {
			if (item.id === 'none') continue;
			itemCount += 1;
			assert.ok(item.icon, `${categoryId}/${item.id} 需要只有衣服的 icon`);
			assertWebp(item.icon, `${categoryId}/${item.id} icon`);
			assert.equal(item.layer, undefined, `${categoryId}/${item.id} 不应再有 v5 的 layer 字段`);
			assert.equal(item.z, undefined, `${categoryId}/${item.id} 不应再有 v5 的 z 字段`);
			assert.ok(item.layers && typeof item.layers === 'object', `${categoryId}/${item.id} 需要 layers 映射`);

			for (const shape of MANIFEST.shapes) {
				const slots = itemSlots(item, shape.id);
				assert.ok(slots && typeof slots === 'object', `${categoryId}/${item.id} 缺少 ${shape.id} 的图层映射`);
				const slotNames = Object.keys(slots).filter((slot) => slots[slot]);
				assert.ok(slotNames.length >= 1, `${categoryId}/${item.id}/${shape.id} 至少要有一层`);
				for (const slot of slotNames) {
					assert.ok(MANIFEST.drawOrder.includes(slot), `${categoryId}/${item.id}/${shape.id} 槽位 ${slot} 非法`);
					assert.ok(
						!SHAPE_LAYER_SLOTS.includes(slot),
						`${categoryId}/${item.id}/${shape.id} 不应占用身形层槽位 ${slot}`,
					);
					assertWebp(slots[slot], `${categoryId}/${item.id}/${shape.id}/${slot}`);
					perShapeCount.set(shape.id, perShapeCount.get(shape.id) + 1);
				}
			}
		}
	}

	assert.equal(itemCount, 6, '保守范围应是 1 套装 + 3 上衣 + 2 下装 = 6 件单品');
	for (const shape of MANIFEST.shapes) {
		const count = perShapeCount.get(shape.id);
		// 每件单品 1–2 层（主体 + 可选袖子/下摆），6 件单品 → 6–12 个图层文件
		assert.ok(count >= 6 && count <= 12, `${shape.id} 衣服图层数不合理：${count}（应在 6–12）`);
	}
});

test('上衣主体槽位语义：水手服 topUnder，毛衣/卫衣 topBody；topUnder 与 topBody 互斥', () => {
	for (const shape of MANIFEST.shapes) {
		const sailor = MANIFEST.items.tops.find((item) => item.id === 'sailor');
		const sailorSlots = Object.keys(itemSlots(sailor, shape.id));
		assert.ok(sailorSlots.includes('topUnder'), `${shape.id} 水手服主体应放 topUnder（下摆塞进裙子）`);
		assert.ok(!sailorSlots.includes('bottom'), `${shape.id} 上衣不应自带下装`);

		for (const id of ['sweater', 'hoodie']) {
			const top = MANIFEST.items.tops.find((item) => item.id === id);
			const slots = Object.keys(itemSlots(top, shape.id));
			assert.ok(slots.includes('topBody'), `${shape.id} ${id} 主体应放 topBody（下摆盖在裙子外）`);
			assert.ok(!slots.includes('topUnder'), `${shape.id} ${id} 不应同时占 topUnder`);
		}

		for (const top of MANIFEST.items.tops) {
			const slots = Object.keys(itemSlots(top, shape.id));
			assert.ok(
				slots.includes('topUnder') !== slots.includes('topBody'),
				`${shape.id}/${top.id} 主体槽位 topUnder / topBody 必须二选一`,
			);
			if (slots.includes('sleeve')) {
				assert.ok(
					slots.includes('topUnder') || slots.includes('topBody'),
					`${shape.id}/${top.id} 有袖子层就必须有主体层`,
				);
			}
		}
	}
});

test('下装只有 bottom 一个槽位（每身形一张）', () => {
	for (const item of MANIFEST.items.bottoms) {
		if (item.id === 'none') continue;
		for (const shape of MANIFEST.shapes) {
			const slots = itemSlots(item, shape.id);
			assert.ok(slots, `${item.id} 缺少 ${shape.id} 图层`);
			assert.deepEqual(Object.keys(slots).filter((slot) => slots[slot]), ['bottom'], `${shape.id}/${item.id} 应只有 bottom 层`);
			assertWebp(slots.bottom, `${shape.id}/${item.id}/bottom`);
		}
	}
});

test('套装与上衣/下装互斥：套装只占 topBody + 可选 sleeve', () => {
	for (const item of MANIFEST.items.outfits) {
		if (item.id === 'none') continue;
		for (const shape of MANIFEST.shapes) {
			const slots = Object.keys(itemSlots(item, shape.id)).filter((slot) => itemSlots(item, shape.id)[slot]);
			assert.ok(slots.includes('topBody'), `${shape.id}/${item.id} 套装主体应放 topBody`);
			assert.ok(!slots.includes('bottom'), `${shape.id}/${item.id} 套装不应再带 bottom 层`);
			assert.ok(!slots.includes('topUnder'), `${shape.id}/${item.id} 套装不应占 topUnder`);
			for (const slot of slots) assert.ok(['topBody', 'sleeve'].includes(slot), `${shape.id}/${item.id} 非法套装槽位 ${slot}`);
		}
	}
});

/* ---------------- 旧 v5 素材清理 ---------------- */

test('旧 v5 字段不再被引用，旧素材文件已清理', () => {
	// 1) manifest 里不应再引用任何 v5 旧文件
	for (const [key, value] of collectManifestStrings(MANIFEST)) {
		if (!/^art\//.test(value)) continue;
		assert.ok(!isLegacyWholeLook(value), `${key} 仍引用旧整套立绘：${value}`);
		assert.ok(!isLegacyShapeFile(value), `${key} 仍引用 v5 base/overlay：${value}`);
		assert.ok(!isLegacyBareLayer(value), `${key} 仍引用无槽位后缀的旧图层：${value}`);
	}

	// 2) 旧文件不应还留在 art/ 里
	const files = walk('art');
	assert.deepEqual(files.filter(isLegacyWholeLook), [], '旧整套立绘文件应删除');
	assert.deepEqual(files.filter(isLegacyShapeFile), [], 'v5 base/overlay 文件应删除');
	assert.deepEqual(files.filter(isLegacyBareLayer), [], '无槽位后缀的旧图层应删除');

	// 3) 已知旧文件名逐个断言（双保险）
	const legacyFiles = [];
	for (const shape of ['chibi', 'girl']) {
		legacyFiles.push(
			`art/${shape}/base.webp`,
			`art/${shape}/overlay.webp`,
			`art/${shape}/layers/dress-maid.webp`,
			`art/${shape}/layers/top-sweater.webp`,
			`art/${shape}/layers/top-hoodie.webp`,
			`art/${shape}/layers/top-sailor.webp`,
		);
	}
	for (const rel of legacyFiles) assert.ok(!existsSync(join(ROOT, rel)), `旧 v5 文件不应再存在：${rel}`);

	// 4) art/ 里不应有 manifest / 宿主 fallback 都没引用的孤儿文件（兜住任何改名遗漏的旧素材）
	const referenced = new Set(
		collectManifestStrings(MANIFEST)
			.map(([, value]) => value)
			.filter((value) => /^art\//.test(value)),
	);
	referenced.add('art/pet-default.webp'); // 悬浮鲸鱼兜底图由 lib/client.js 引用，不在 manifest 里
	// 2.5D runtime 资产（rig.json/图集/构建报告）由 runtime-2d5.js 按需加载，不进 manifest
	for (const rel of collect2d5RuntimeFiles()) referenced.add(rel);
	// 脸部动画补丁由 wardrobe-core.FACE_PATCHES 运行时引用（不进 manifest），不算孤儿
	const orphans = files.filter((rel) => !referenced.has(rel) && !isFacePatch(rel));
	assert.deepEqual(orphans, [], `art/ 里不应有未被引用的文件：${orphans.join(', ')}`);
});

/* ---------------- 悬浮小鲸鱼 / 背景 / 图标 ---------------- */

test('悬浮小鲸鱼默认穿搭小图存在（readOutfit 的 fallback）', () => {
	assertWebp('art/pet-default.webp', 'pet-default');
});

test('背景图 + 缩略图 + 地面线齐全，衣柜只放「衣服本身」的图标', () => {
	for (const item of MANIFEST.items.backgrounds) {
		assertWebp(item.file, `background ${item.id}`);
		assertWebp(item.thumb, `background thumb ${item.id}`);
		assert.ok(
			typeof item.floor === 'number' && item.floor > 0.5 && item.floor < 1,
			`background ${item.id} floor 应为 0.5–1 之间`,
		);
	}
	assert.ok(MANIFEST.items.effects.length >= 3);
	for (const categoryId of CLOTHING_CATEGORIES) {
		for (const item of MANIFEST.items[categoryId]) {
			if (item.id === 'none') continue;
			assert.ok(item.icon, `${categoryId}/${item.id} 需要只有衣服的 icon`);
			assertWebp(item.icon, `${categoryId}/${item.id} icon`);
			assert.ok(!item.thumb, `${categoryId}/${item.id} 不应再用「穿好衣服的人」缩略图`);
		}
	}
});

test('宿主半区 readOutfit 接受 data URL / art 路径，并 fallback 到 pet-default', () => {
	const client = readFileSync(join(ROOT, '..', '..', 'lib', 'client.js'), 'utf8');
	assert.ok(client.includes("startsWith('data:image/')"), 'readOutfit 应接受合成小图 data URL');
	assert.ok(client.includes("startsWith('art/')"), 'readOutfit 应兼容 art/ 相对路径');
	assert.ok(client.includes("'art/pet-default.webp'"), 'readOutfit 的 fallback 应为 art/pet-default.webp');
	assert.ok(!client.includes("'art/chibi/base.webp'"), 'fallback 不应指向 v5 的 base 素体');
	assert.ok(client.includes("outfit.image.startsWith('data:')"), '悬浮小鲸鱼渲染时 data URL 不能拼 GAME_BASE 前缀');
});

/* ---------------- 页面 / 渲染器 v6 ---------------- */

test('index.html v7：不写死图层 img，cache-bust 升到 v12', () => {
	const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
	assert.match(html, /style\.css\?v=12/, 'style.css 应 cache-bust 到 v12');
	assert.match(html, /app\.js\?v=12/, 'app.js 应 cache-bust 到 v12');
	assert.ok(!/\?v=(?!12)\d+/.test(html), 'index.html 里不应残留旧版本号');
	assert.ok(html.includes('type="module"'));
	assert.ok(html.includes('id="figure"'), 'index.html 应保留 .figure 容器');
	assert.ok(!/data-layer=/.test(html), 'v6 不再在 index.html 写死图层槽位 <img>');
	assert.ok(!html.includes('id="figureImg"'), '不再用单张立绘 <img>');
	assert.ok(!html.includes('github.io'), 'game page should not hardcode GitHub Pages');
	assert.ok(!html.includes('裙底'), 'index.html 不应包含不保守文案');
});

test('app.js v7：按 manifest.drawOrder 动态建槽位，三处叠图都走 resolveLayers', () => {
	const app = readFileSync(join(ROOT, 'app.js'), 'utf8');
	assert.match(app, /from '\.\/wardrobe-core\.js\?v=11'/, 'app.js 应按 v11 复用 wardrobe-core');
	assert.ok(app.includes('manifest.drawOrder'), 'app.js 应读 manifest.drawOrder 决定槽位');
	assert.ok(!/LAYER_SLOTS\s*=\s*\[/.test(app), 'app.js 不应再写死 5 个槽位常量');
	assert.ok(app.includes('buildFigureLayers'), 'app.js 应动态创建 .figure-layer');
	assert.ok(app.includes('data-layer') || app.includes('dataset.layer'), '动态图层应带 data-layer=槽位');
	assert.ok(app.includes('createElement(\'img\')'), '动态图层应是 <img>');
	assert.ok(app.includes('resolveLayers'), 'app.js 应按 resolveLayers 叠图层');
	assert.ok(
		(app.match(/resolveLayers\(/g) || []).length >= 3,
		'renderFigure / 立绘卡 / 悬浮小图三处都应按 resolveLayers 顺序合成',
	);
	assert.ok(!app.includes('resolveImage'), 'app.js 不应再用 v4 的 resolveImage');
	assert.ok(!app.includes('.kind'), 'app.js 不应再用 v5 的 layer.kind 字段');
	assert.ok(app.includes('feiyu:outfit'), 'app.js 必须把当前穿搭写进 localStorage 给悬浮鲸鱼用');
	// v0.8 性能优化保留
	assert.ok(app.includes('renderSeq'), '应保留 renderSeq 防竞态');
	assert.ok(app.includes('toBlob'), '小图合成应走异步 canvas.toBlob');
	assert.ok(app.includes('requestIdleCallback'), '小图合成应放到浏览器空闲时执行');
	assert.ok(!app.includes('composePetImageNow'), '不应在点击路径里同步合成小图');
	assert.ok(app.includes('persistTimer'), 'persist 应有 debounce 定时器');

	// v0.8 保守文案：去掉性感/身体评价/撒娇过头的台词
	const banned = ['转一圈', '裙底', '性感', '身材', '偷看', '亲亲', '抱抱'];
	for (const word of banned) assert.ok(!app.includes(word), `app.js 不应包含不保守文案「${word}」`);
	assert.ok(!app.includes('github.io'), 'app.js should not hardcode GitHub Pages');
});

test('style.css：.figure-layer 仍绝对定位铺满画布', () => {
	const css = readFileSync(join(ROOT, 'style.css'), 'utf8');
	const rule = css.match(/\.figure-layer\s*\{([^}]*)\}/);
	assert.ok(rule, 'style.css 应有 .figure-layer 规则');
	const body = rule[1];
	assert.match(body, /position:\s*absolute/, '.figure-layer 应绝对定位');
	assert.match(body, /inset:\s*0/, '.figure-layer 应铺满容器');
	assert.match(body, /width:\s*100%/, '.figure-layer 宽度应铺满');
	assert.match(body, /height:\s*100%/, '.figure-layer 高度应铺满');
	assert.match(body, /object-fit:\s*contain/, '.figure-layer 应用 object-fit: contain');
	assert.ok(!/data-layer="(?:base|bottom|top|outfit|overlay)"/.test(css), 'style.css 不应残留 v5 写死槽位');
});
