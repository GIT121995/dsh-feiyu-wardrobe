/**
 * 4.0 槽位底座 Phase 0 契约测试（slot registry 结构 + 真实 rig 骨骼存在性 + 现行实现兼容性）。
 *
 * 单一真相：docs/dress-up/slot-registry.json（format=feiyu-slot-registry，version=1）。
 * 契约全文见 docs/dress-up/SLOT-REGISTRY.md，决策见 docs/dress-up/ADR-4.0-SLOTS.md。
 *
 * 范围（Phase 0 = 契约定稿，运行期/构建期代码仍是 v3.2.1 行为）：
 *  - registry 自身结构合法：slot 唯一、kind/group 合法、z 数值唯一、pageGroup 声明完整；
 *  - 配饰 socket / 服装 seat 引用的骨骼在真实 chibi/girl rig.json（65 骨）中真实存在；
 *  - 当前官方 rig（5 页）与 registry 页命名空间/pageGroup 规则一致，且逐 drawable 归属不变；
 *  - 现行代码上限与 registry 的**阶段性兼容**：v3.2.1 的 MAX_ATLASES=6 / MAX_PAGES=6，
 *    要求「≥ 当前官方页数」且「≤ registry maxPages(12)」。
 *    ⚠️ 3.3.0 会把 runtime MAX_ATLASES / build_2d5 MAX_PAGES 提到 12（= registry maxPages），
 *    届时本文件的兼容断言升级为**相等校验**（`cap === registry.maxPages`）；在此之前不要提前改代码。
 *  - 页选择：用真实 rig + 当前默认造型（maid）验证 collectLookAtlasIndices 仍是
 *    「base 页 + 当前 outfit 页」（3.3.0 泛化后该行为必须保持不变）。
 *
 * 运行：node --test tests/slot-registry.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { collectLookAtlasIndices } from '../docs/dress-up/runtime-2d5-core.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY_PATH = path.join(ROOT, 'docs/dress-up/slot-registry.json');
const RUNTIME_CORE_PATH = path.join(ROOT, 'docs/dress-up/runtime-2d5-core.js');
const BUILD_2D5_PATH = path.join(ROOT, 'tools/art/build_2d5.py');
const SHAPES = ['chibi', 'girl'];

const registry = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'));
const rigs = Object.fromEntries(
	SHAPES.map((shape) => [
		shape,
		JSON.parse(readFileSync(path.join(ROOT, `docs/dress-up/art/2d5/${shape}/rig.json`), 'utf8')),
	]),
);

const OUTIFIT_LINEAGE_IDS = ['topUnder', 'bottom', 'topBody', 'sleeve', 'sleeveUpper', 'sleeveFore', 'collar'];
const ACCESSORY_IDS = ['shoes', 'socks', 'necklace', 'earring', 'headwear', 'handheld'];
const VALID_KINDS = new Set(['outfit', 'accessory', 'legacy']);
const slotById = new Map(registry.slots.map((slot) => [slot.id, slot]));
const pageGroupById = new Map(registry.pageGroups.map((group) => [group.id, group]));
const boneIds = Object.fromEntries(
	SHAPES.map((shape) => [shape, new Set(rigs[shape].skeleton.bones.map((bone) => bone.id))]),
);

/** 把 rig.atlas id 解析成 drawable.atlasIndex（运行时 toRuntimeRig 的等价归一，测试用）。 */
function normalizeRig(rig) {
	const atlasIndexById = new Map(rig.atlases.map((atlas, index) => [atlas.id, index]));
	return {
		...rig,
		drawables: rig.drawables.map((drawable) => ({ ...drawable, atlasIndex: atlasIndexById.get(drawable.atlas) })),
	};
}

/** 拆分 "a/b" 形式的多骨骼引用。 */
function splitBones(value) {
	return String(value).split('/').map((part) => part.trim()).filter(Boolean);
}

test('registry 元信息：format/version/status 合法且声明为 Phase 0 契约', () => {
	assert.equal(registry.format, 'feiyu-slot-registry');
	assert.equal(registry.version, 1);
	assert.equal(registry.status, 'phase0-contract');
	assert.ok(registry.scope && typeof registry.scope === 'string' && registry.scope.length > 0);
});

test('maxPages=12 且 pageFiles 恰好 12 项、命名按 atlas.webp / atlas-{n}.webp 递增', () => {
	assert.equal(registry.maxPages, 12);
	assert.equal(registry.pageFiles.length, registry.maxPages);
	assert.equal(new Set(registry.pageFiles).size, registry.pageFiles.length, 'pageFiles 不得重复');
	registry.pageFiles.forEach((file, index) => {
		const expected = index === 0 ? 'atlas.webp' : `atlas-${index + 1}.webp`;
		assert.equal(file, expected, `pageFiles[${index}] 命名不符合契约`);
	});
});

test('slots 结构合法：唯一 id、合法 kind/group、唯一数值 z、mirror/required/maxPerSlot 类型正确', () => {
	assert.ok(Array.isArray(registry.slots));
	assert.equal(new Set(registry.slots.map((slot) => slot.id)).size, registry.slots.length, 'slot id 必须唯一');
	const zValues = registry.slots.map((slot) => slot.z);
	for (const z of zValues) assert.ok(Number.isFinite(z), `slot z 必须是有限数值：${z}`);
	assert.equal(new Set(zValues).size, zValues.length, 'slot z 必须唯一（z 表排序契约）');
	for (const slot of registry.slots) {
		assert.ok(VALID_KINDS.has(slot.kind), `slot ${slot.id} kind 非法：${slot.kind}`);
		assert.ok(typeof slot.group === 'string' && slot.group.length > 0, `slot ${slot.id} group 必须非空字符串`);
		assert.ok(pageGroupById.has(slot.pageGroup), `slot ${slot.id} pageGroup 未在 pageGroups 声明：${slot.pageGroup}`);
		assert.equal(typeof slot.mirror, 'boolean', `slot ${slot.id} mirror 必须是布尔`);
		assert.equal(typeof slot.required, 'boolean', `slot ${slot.id} required 必须是布尔`);
		assert.equal(slot.maxPerSlot, registry.rules.maxPerSlot, `slot ${slot.id} maxPerSlot 必须与 rules 一致`);
		assert.equal(slot.maxPerSlot, 1);
		if (slot.kind === 'accessory') {
			assert.ok(typeof slot.socket === 'string' && slot.socket.length > 0, `配饰 ${slot.id} 必须声明 socket`);
			assert.equal(slot.seat, undefined, `配饰 ${slot.id} 不应声明 seat`);
		} else {
			assert.ok(typeof slot.seat === 'string' && slot.seat.length > 0, `服装/legacy 槽 ${slot.id} 必须声明 seat`);
			assert.equal(slot.socket, undefined, `服装/legacy 槽 ${slot.id} 不应声明 socket`);
		}
		if (slot.physics !== undefined) assert.ok(['skirt', 'hair', 'tail'].includes(slot.physics), `slot ${slot.id} physics 非法`);
	}
});

test('槽位集合与 4.0 已批准边界一致：7 服装槽（2 活跃 outfit + 5 legacy）+ 6 配饰槽（裤装后置）', () => {
	assert.equal(registry.slots.length, 13);
	assert.deepEqual(registry.slots.filter((slot) => slot.kind !== 'accessory').map((slot) => slot.id), OUTIFIT_LINEAGE_IDS);
	assert.deepEqual(registry.slots.filter((slot) => slot.kind === 'accessory').map((slot) => slot.id), ACCESSORY_IDS);
	assert.deepEqual(
		registry.slots.filter((slot) => slot.kind === 'outfit').map((slot) => slot.id),
		['bottom', 'topBody'],
		'4.0 活跃服装槽只有整层 paper-doll 的 bottom/topBody',
	);
	for (const id of ACCESSORY_IDS) assert.equal(slotById.get(id).kind, 'accessory');
	// 用户 2026-11-27 决策 ④：裤装后置（4.1+ 候选），registry 不得有 pants 槽。
	assert.equal(slotById.has('pants'), false);
});

test('pageGroups 声明完整、有序，且覆盖全部 13 个 slot', () => {
	const groups = registry.pageGroups;
	assert.equal(groups.length, 8, 'base + outfit + 6 个配饰页组');
	groups.forEach((group, index) => {
		assert.equal(group.order, index, `pageGroups[${index}] order 必须连续递增`);
	});
	assert.equal(groups[0].id, 'base');
	assert.equal(groups[0].kind, 'base');
	assert.equal(groups[0].selection, 'always');
	assert.equal(groups[1].id, 'outfit');
	assert.equal(groups[1].kind, 'outfit');
	assert.equal(groups[1].selection, 'by-outfit-combo');
	assert.equal(groups[1].crossCombinationPages, false, '不生成上衣×下装交叉组合页');
	assert.ok(typeof groups[1].rule === 'string' && groups[1].rule.includes('pre-composed'));
	assert.ok(groups[1].rule.includes('并集'), '交叉混搭必须写明运行期「页并集」实现');
	const accessoryGroups = groups.filter((group) => group.kind === 'accessory');
	assert.equal(accessoryGroups.length, ACCESSORY_IDS.length);
	// 配饰页顺序 = 首屏补齐优先级（鞋/袜先行，避免裸脚帧）。
	assert.deepEqual(accessoryGroups.map((group) => group.id), registry.rules.pageSelection.accessoryPriority);
	for (const group of groups) {
		assert.ok(Array.isArray(group.slots), `pageGroup ${group.id} slots 必须是数组`);
		for (const slotId of group.slots) {
			assert.ok(slotById.has(slotId), `pageGroup ${group.id} 引用了未声明 slot：${slotId}`);
			assert.equal(slotById.get(slotId).pageGroup, group.id, `slot ${slotId} 的 pageGroup 与所在组不一致`);
		}
	}
	const declaredSlotIds = groups.flatMap((group) => group.slots).sort();
	assert.deepEqual(declaredSlotIds, registry.slots.map((slot) => slot.id).sort(), '每个 slot 必须恰好归属一个 pageGroup');
	for (const group of accessoryGroups) {
		assert.equal(group.slots.length, 1, `配饰页组 ${group.id} 必须 1 slot = 1 页`);
		assert.equal(group.pageId, group.id, `配饰页 id 约定 = pageGroup id`);
	}
});

test('页容量守恒：base(1) + combo 页预算(≤5) + 配饰页组(≤6) = maxPages(12)，4.0 用满无空闲页', () => {
	// Lead 2026-11-27 裁决：combo 页预算 = 5（现有 4 套 pre-composed + 4.0 新增日常通勤 1 套）；
	// 不生成上衣×下装交叉组合页；4.0 容量 1+5+6 = 12 用满 maxPages，无 reserve 页；
	// 4.1 批量穿搭/更多组合需扩 maxPages（另立 ADR）。
	assert.equal(registry.outfitPageBudget, 5, 'combo 页预算 5 = 现有 4 套 + 新增日常通勤 1 套 pre-composed combo');
	assert.ok(
		typeof registry.outfitPageBudgetNote === 'string' && registry.outfitPageBudgetNote.length > 0,
		'必须用 outfitPageBudgetNote 写明预算来源/不生成交叉组合页/4.1 扩页口径',
	);
	assert.ok(
		registry.outfitPageBudgetNote.includes('交叉组合') && registry.outfitPageBudgetNote.includes('4.1'),
		'outfitPageBudgetNote 必须写明「不生成交叉组合页」与「4.1 需扩 maxPages」',
	);
	assert.deepEqual(registry.reservedPages, [], '4.0 无空闲页，reservedPages 必须为空');
	assert.ok(
		typeof registry.reservedPagesNote === 'string' && registry.reservedPagesNote.includes('4.1'),
		'reservedPagesNote 必须说明 4.1 扩页另立 ADR',
	);
	const outfitGroup = registry.pageGroups.find((group) => group.id === 'outfit');
	assert.equal(outfitGroup.crossCombinationPages, false, 'outfit 页组不得生成交叉组合页');
	const accessoryPageCount = registry.pageGroups.filter((group) => group.kind === 'accessory').length;
	assert.equal(accessoryPageCount, 6);
	assert.equal(1 + registry.outfitPageBudget + accessoryPageCount + registry.reservedPages.length, registry.maxPages);
	// 当前官方 rig 的 combo 页数（4）必须落在 4.0 combo 预算（5）内。
	for (const shape of SHAPES) {
		const comboPages = rigs[shape].atlases.length - 1;
		assert.ok(comboPages <= registry.outfitPageBudget, `${shape} combo 页数 ${comboPages} 不得超过预算 ${registry.outfitPageBudget}`);
	}
});

test('rules 合法：conflict/slotAliases/hideBase/pageSelection（200ms/220ms 口径为已批准值）', () => {
	const rules = registry.rules;
	assert.equal(rules.maxPerSlot, 1);
	assert.ok(Array.isArray(rules.hideBase));
	const knownSlotIds = new Set([...registry.slots.map((slot) => slot.id), ...(registry.futureSlots || [])]);
	for (const pair of rules.conflict) {
		assert.ok(Array.isArray(pair) && pair.length === 2, 'conflict 项必须是二元组');
		assert.notEqual(pair[0], pair[1]);
		for (const id of pair) assert.ok(knownSlotIds.has(id), `conflict 引用了未声明/未预留 slot：${id}`);
	}
	for (const [alias, target] of Object.entries(rules.slotAliases)) {
		assert.ok(slotById.has(target), `slotAlias ${alias} 指向未声明 slot：${target}`);
	}
	const selection = rules.pageSelection;
	assert.equal(selection.accessoryDelayMs, 200, '用户已批准：配饰首帧后 200ms 补齐');
	assert.equal(selection.accessoryFadeInMs, 200);
	assert.equal(selection.prefetchDelayMs, 220, '沿用 v3.2.0 首帧后 220ms 空闲预取');
	assert.deepEqual(selection.accessoryPriority, ACCESSORY_IDS);
	assert.ok(selection.noBareFirstFrame && selection.noBareFirstFrame.length > 0);
	// 用户已批准首屏预算口径：lo ≤1.2MB = 1,200,000B（十进制硬门禁；不得按 1.2MiB 放宽）。
	assert.ok(selection.firstFrame.includes('1.2MB') && selection.firstFrame.includes('1,200,000B'), 'firstFrame 必须写死 1.2MB=1,200,000B 硬门禁口径');
});

test('socket→骨骼 / seat→骨骼：引用的骨在真实 chibi 与 girl rig（65 骨）中均存在', () => {
	for (const slot of registry.slots) {
		const ref = slot.kind === 'accessory' ? slot.socket : slot.seat;
		const bones = splitBones(ref);
		assert.ok(bones.length > 0, `slot ${slot.id} 骨骼引用不得为空`);
		for (const shape of SHAPES) {
			for (const bone of bones) {
				assert.ok(boneIds[shape].has(bone), `slot ${slot.id} 引用的骨 ${bone} 在 ${shape} rig 中不存在`);
			}
		}
	}
	// 锚定语义补充断言：mirror 配饰要么 2 个成对 socket（pair），要么 1 个对称 socket（symmetry）。
	for (const slot of registry.slots.filter((entry) => entry.kind === 'accessory')) {
		const sockets = splitBones(slot.socket);
		if (slot.mirror) assert.ok(sockets.length === 1 || sockets.length === 2, `mirror 配饰 ${slot.id} socket 数量非法`);
		else assert.equal(sockets.length, 1, `非 mirror 配饰 ${slot.id} 必须单 socket`);
	}
	assert.equal(splitBones(slotById.get('socks').socket).length, 2);
	assert.equal(splitBones(slotById.get('shoes').socket).length, 2);
	assert.equal(splitBones(slotById.get('earring').socket).length, 1);
});

test('z 表关系不变量：袜<鞋<裙；服装层次有序；配饰压在服装/头发之上（不遮眼）', () => {
	const z = Object.fromEntries(registry.slots.map((slot) => [slot.id, slot.z]));
	assert.ok(z.socks < z.shoes && z.shoes < z.bottom, '袜<鞋<裙（裙摆可盖鞋口）');
	assert.ok(z.topUnder < z.bottom && z.bottom < z.sleeve, '内搭<裙<袖');
	assert.ok(z.sleeve < z.collar && z.collar < z.sleeveUpper && z.sleeveUpper < z.sleeveFore && z.sleeveFore < z.topBody);
	assert.ok(z.topBody < z.necklace && z.necklace < z.handheld && z.handheld < z.earring && z.earring < z.headwear);
	// 手持在 hand(z65) 之上；项链在 topBody 之上；头饰在刘海（真实 rig hairFront z70）之上。
	for (const shape of SHAPES) {
		const byId = new Map(rigs[shape].drawables.map((drawable) => [drawable.id, drawable]));
		assert.equal(byId.get('hand-R').z, 65);
		assert.ok(z.handheld > byId.get('hand-R').z, 'handheld 必须画在手之上');
		const baseMaxZ = Math.max(...rigs[shape].drawables.filter((drawable) => drawable.atlas === 'base').map((drawable) => drawable.z));
		assert.equal(baseMaxZ, 70, 'base 页最高层是 hairFront（刘海）');
		assert.ok(z.headwear > baseMaxZ, `headwear 必须在 ${shape} 刘海之上（不遮眼）`);
	}
});

test('z 表数值冻结：配饰 z 为已批准口径，legacy z 对齐历史/文档口径（旧 rig 以 drawable.z 为准）', () => {
	const z = Object.fromEntries(registry.slots.map((slot) => [slot.id, slot.z]));
	// 用户 2026-11-27 已批准 4.0 配饰槽 z（不得改口径）。
	assert.deepEqual(
		{ socks: z.socks, shoes: z.shoes, necklace: z.necklace, handheld: z.handheld, earring: z.earring, headwear: z.headwear },
		{ socks: 18, shoes: 20, necklace: 64.5, handheld: 66, earring: 68, headwear: 72 },
	);
	// 服装/legacy：与 docs/dress-up/2.5D-RUNTIME.md §6.5 历史值对齐（bottom/collar/sleeveUpper/sleeveFore），
	// topBody 取 v3 整层 production 实值 64；topUnder 历史 20 与 4.0 shoes=20 冲突 → canonical 20.5；
	// sleeve 历史无独立 z → canonical 50。legacy z 只作文档/新资产契约，不改旧资产渲染（旧 rig 读 drawable.z）。
	assert.equal(z.bottom, 30);
	assert.equal(z.collar, 56);
	assert.equal(z.sleeveUpper, 60);
	assert.equal(z.sleeveFore, 62);
	assert.equal(z.topBody, 64);
	assert.equal(z.topUnder, 20.5);
	assert.equal(z.sleeve, 50);
	assert.ok(typeof registry.zTableNote === 'string' && registry.zTableNote.includes('drawable.z'), 'zTableNote 必须说明旧 rig 以 drawable.z 为准');
});

test('当前官方 rig（chibi/girl）与 registry 页命名空间/pageGroup 规则一致，逐 drawable 归属不变', () => {
	for (const shape of SHAPES) {
		const rig = rigs[shape];
		const pages = rig.atlases;
		assert.ok(pages.length >= 1 && pages.length <= registry.maxPages, `${shape} 页数必须 ≤ maxPages`);
		assert.equal(pages[0].id, registry.basePage.id);
		assert.equal(pages[0].file, registry.basePage.file);
		pages.forEach((page, index) => {
			assert.equal(page.file, registry.pageFiles[index], `${shape} 第 ${index} 页文件名必须落在 registry pageFiles 命名空间`);
		});
		for (const page of pages.slice(1)) {
			assert.ok(rig.outfits[page.id], `${shape} 页 id ${page.id} 必须是 rig.outfits 的 outfit combo`);
			const refs = Object.values(rig.outfits[page.id]).filter(Array.isArray).flat();
			assert.ok(refs.length > 0, `${shape} outfit ${page.id} 页不得为空`);
		}
		const declaredDrawableSlots = new Set([...registry.basePage.slots, ...registry.slots.map((slot) => slot.id)]);
		const atlasIndexById = new Map(pages.map((page, index) => [page.id, index]));
		for (const drawable of rig.drawables) {
			assert.ok(
				declaredDrawableSlots.has(drawable.slot),
				`${shape} drawable ${drawable.id} 的 slot=${drawable.slot} 未在 registry 声明（构建期校验同口径）`,
			);
			assert.ok(atlasIndexById.has(drawable.atlas), `${shape} drawable ${drawable.id} atlas=${drawable.atlas} 不是已声明页`);
			const isBaseSlot = registry.basePage.slots.includes(drawable.slot);
			assert.equal(
				drawable.atlas === registry.basePage.id,
				isBaseSlot,
				`${shape} drawable ${drawable.id}（slot=${drawable.slot}）归属页与 basePage 规则不一致`,
			);
		}
	}
});

test('代码上限与 registry 阶段性兼容：官网页数 ≤ 现行 cap ≤ maxPages（3.3.0 升级为 === maxPages）', () => {
	const runtimeSource = readFileSync(RUNTIME_CORE_PATH, 'utf8');
	const buildSource = readFileSync(BUILD_2D5_PATH, 'utf8');
	const runtimeMatch = runtimeSource.match(/export\s+const\s+MAX_ATLASES\s*=\s*(\d+)\s*;/);
	const buildMatch = buildSource.match(/^MAX_PAGES\s*=\s*(\d+)/m);
	assert.ok(runtimeMatch, 'runtime-2d5-core.js 未找到 export const MAX_ATLASES = <n>');
	assert.ok(buildMatch, 'build_2d5.py 未找到 MAX_PAGES = <n>');
	const runtimeCap = Number(runtimeMatch[1]);
	const buildCap = Number(buildMatch[1]);
	assert.ok(Number.isInteger(runtimeCap) && Number.isInteger(buildCap));
	for (const [label, cap] of [['MAX_ATLASES', runtimeCap], ['MAX_PAGES', buildCap]]) {
		assert.ok(cap <= registry.maxPages, `${label}=${cap} 不得超过 registry maxPages=${registry.maxPages}`);
		for (const shape of SHAPES) {
			const officialPages = rigs[shape].atlases.length;
			assert.ok(cap >= officialPages, `${label}=${cap} 不得小于当前官方页数 ${officialPages}（${shape}）`);
		}
	}
	// 注释契约：3.3.0 实施后 MAX_ATLASES / MAX_PAGES 必须 = registry.maxPages（12）。
	// 届时把上面「范围断言」升级为 `assert.equal(cap, registry.maxPages)`（本测试保持向前兼容，不需要改结构）。
});

test('页选择行为不变：真实 rig + 默认 maid 造型 = base 页 + 当前 outfit 页（3.3.0 泛化后必须保持）', () => {
	for (const shape of SHAPES) {
		const rig = normalizeRig(rigs[shape]);
		const combo = rig.defaults.outfit;
		const outfit = rig.outfits[combo];
		assert.ok(outfit, `${shape} 默认 outfit ${combo} 必须存在`);
		const expectedAtlasIndex = rig.atlases.findIndex((page) => page.id === combo);
		const look = {
			slots: {
				topBody: outfit.topBody || [],
				bottom: outfit.bottom || [],
			},
		};
		assert.deepEqual(collectLookAtlasIndices(rig, look), [0, expectedAtlasIndex], `${shape} 默认造型页选择`);
		assert.deepEqual(collectLookAtlasIndices(rig, { slots: {} }), [0], `${shape} 空 look 只选 base 页`);
	}
});

test('文档交付物落盘：SLOT-REGISTRY.md / ADR-4.0-SLOTS.md 存在且引用 registry 单一真相', () => {
	for (const relativePath of ['docs/dress-up/SLOT-REGISTRY.md', 'docs/dress-up/ADR-4.0-SLOTS.md']) {
		const fullPath = path.join(ROOT, relativePath);
		assert.ok(existsSync(fullPath), `${relativePath} 必须存在`);
		const content = readFileSync(fullPath, 'utf8');
		assert.ok(content.includes('slot-registry.json'), `${relativePath} 必须引用 docs/dress-up/slot-registry.json`);
		assert.ok(content.length > 2000, `${relativePath} 内容过短，契约/决策文档不完整`);
	}
});
