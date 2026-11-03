import assert from 'node:assert/strict';
import test from 'node:test';

import {
	BANNED_TERMS,
	CONSERVATIVE_CONSTRAINTS,
	DIY_CATEGORIES,
	DIY_GUARD_VERSION,
	MAX_DESCRIPTION_LENGTH,
	NEGATIVE_TERMS,
	categorySlot,
	checkGarmentDescription,
	contentPolicyTag,
	downgradeDescription,
	isDiyCategory,
	normalizeDescription,
	scanBannedTerms,
} from '../docs/dress-up/diy-guard.js';

/* ---------------- 基础契约 ---------------- */

test('守卫版本与品类表是导出常量（浏览器/宿主/分享格式共用）', () => {
	assert.match(DIY_GUARD_VERSION, /^diy-guard-\d+$/);
	assert.deepEqual(DIY_CATEGORIES, ['top', 'bottom', 'dress', 'coat', 'outfit']);
	assert.equal(isDiyCategory('top'), true);
	assert.equal(isDiyCategory('hat'), false);
	assert.equal(isDiyCategory(null), false);
	assert.deepEqual(categorySlot('bottom'), { slot: 'bottom', sleeve: false });
	assert.deepEqual(categorySlot('top'), { slot: 'topBody', sleeve: true });
	assert.equal(categorySlot('nope'), null);
});

test('保守约束与负向词覆盖内容基调（长袖/及膝/不暴露）', () => {
	assert.match(CONSERVATIVE_CONSTRAINTS, /长袖|及膝/);
	assert.match(CONSERVATIVE_CONSTRAINTS, /不暴露|不透明/);
	for (const word of ['暴露', '性感', '比基尼', '超短', '露脐', '未成年']) {
		assert.ok(NEGATIVE_TERMS.includes(word), `负向词应包含 ${word}`);
	}
});

/* ---------------- 合规输入：pass / downgrade ---------------- */

test('合规描述通过（M0 测试集同款）', () => {
	for (const desc of [
		'白色长袖纯棉衬衫（尖领、前襟纽扣、左胸口袋）',
		'米色亚麻长袖套头衬衫',
		'蓝紫格纹及膝半裙',
		'深色玫瑰印花中长连衣裙',
		'棕色泰迪绒长外套',
	]) {
		const result = checkGarmentDescription(desc);
		assert.equal(result.action, 'pass', desc);
		assert.equal(result.description, desc);
		assert.deepEqual(result.hits, []);
		assert.equal(result.guardVersion, DIY_GUARD_VERSION);
	}
});

test('偏短/贴身日常描述降级为保守版型（不拒绝，但必须展示改写）', () => {
	const result = checkGarmentDescription('白色短袖T恤配短裙，版型紧身');
	assert.equal(result.action, 'downgrade');
	assert.ok(result.hits.length >= 3);
	assert.match(result.description, /长袖/);
	assert.match(result.description, /及膝/);
	assert.match(result.description, /宽松/);
	assert.doesNotMatch(result.description, /短袖|短裙|紧身/);
	assert.equal(result.original, '白色短袖T恤配短裙，版型紧身');
});

test('downgradeDescription 只改版型词、不动颜色/材质', () => {
	const out = downgradeDescription('黑色短袖针织衫，短发的人穿');
	assert.match(out, /长袖/);
	assert.match(out, /黑色/);
	// 「短发」不是「短袖」，不应被误改写
	assert.match(out, /短发/);
});

/* ---------------- 不合规输入：≥3 个必须 reject 且不产生可用描述 ---------------- */

test('不合规输入 A：暴露款 reject（M0 实测 API 不拦截的那类）', () => {
	const result = checkGarmentDescription('黑色蕾丝比基尼（低胸、露脐、露背）');
	assert.equal(result.action, 'reject');
	assert.ok(result.hits.length > 0);
	assert.equal(result.description, '');
});

test('不合规输入 B：超短热裤 reject', () => {
	const result = checkGarmentDescription('超短热裤 + 露脐短上衣');
	assert.equal(result.action, 'reject');
	assert.equal(result.description, '');
});

test('不合规输入 C：透明/情趣向 reject', () => {
	const result = checkGarmentDescription('透明蕾丝情趣内衣');
	assert.equal(result.action, 'reject');
});

test('不合规输入 D：涉未成年人一票否决', () => {
	for (const desc of ['萝莉风小学生制服', '幼女款连衣裙', 'loli 短裙']) {
		const result = checkGarmentDescription(desc);
		assert.equal(result.action, 'reject', desc);
		assert.equal(result.description, '', desc);
	}
});

test('归一化绕过被拦：全角/空格/零宽/大小写', () => {
	for (const desc of ['比　基　尼', '比\u200b基\u200b尼', 'ＢＩＫＩＮＩ', 'Bikini 泳装', '露 脐 装']) {
		const result = checkGarmentDescription(desc);
		assert.equal(result.action, 'reject', JSON.stringify(desc));
	}
});

test('scanBannedTerms 是宿主侧二次校验的同一词表实现', () => {
	assert.ok(scanBannedTerms('暴露比基尼').includes('比基尼'));
	assert.deepEqual(scanBannedTerms('白色长袖衬衫'), []);
	// 词表非空且不含空字符串（避免 includes("") 恒真）
	assert.ok(BANNED_TERMS.length >= 40);
	assert.ok(BANNED_TERMS.every((term) => typeof term === 'string' && term.trim().length > 0));
});

/* ---------------- 输入卫生 ---------------- */

test('空/非文本/纯空白描述被拒绝', () => {
	for (const raw of ['', '   ', null, undefined, 42, {}, []]) {
		const result = checkGarmentDescription(raw);
		assert.equal(result.action, 'reject', JSON.stringify(raw));
	}
});

test('超长描述截断并标记（控制字符被清理）', () => {
	const raw = `白色长袖衬衫\u0000\u0007 ${'很长'.repeat(MAX_DESCRIPTION_LENGTH)}`;
	const result = checkGarmentDescription(raw);
	assert.equal(result.action, 'pass');
	assert.equal(result.truncated, true);
	assert.ok(result.description.length <= MAX_DESCRIPTION_LENGTH);
	assert.doesNotMatch(result.description, /[\u0000-\u001f]/);
	const norm = normalizeDescription(raw);
	assert.equal(norm.text.length, MAX_DESCRIPTION_LENGTH);
});

test('内容策略标签：pass/downgrade 可区分（写进记录/分享包）', () => {
	assert.equal(contentPolicyTag('pass'), 'conservative-v1');
	assert.equal(contentPolicyTag('downgrade'), 'conservative-downgraded-v1');
});
