/**
 * 大肥鱼衣橱 · DIY 上传内容守卫（纯函数，浏览器与宿主/单元测试共用）
 *
 * 背景（M0 实测，见 `.scratch/m0-diy/REPORT.md` §1/§10）：
 * Seedream API 对「暴露/超短」类输入 **2/2 未拦截**，因此内容安全必须在客户端
 * 与宿主两侧都硬拦截——本模块就是唯一的词表/判定实现：
 *   - 浏览器：上传描述先过 `checkGarmentDescription`，reject 不送 API；
 *   - 宿主：`/feiyu/diy/generate` 再判一次（防御绕过 UI 的请求）；
 *   - 保守 prompt 模板里再拼 `NEGATIVE_TERMS`（见 lib/diy.js），三重兜底。
 *
 * 内容基调（HANDOFF §0）：衣服保守——有领/长袖/及膝/宽松；不得出现暴露、
 * 超短、性感向或涉及未成年人的内容。守卫只做**文本层**拦截，图像分类器是
 * 后续项（如实标注，不宣称完全防护）。
 *
 * @module dsh-feiyu-wardrobe/diy-guard
 */

/** 守卫版本：词表/判定规则变更时递增，写进 consent / `.dshskin` / 日志。 */
export const DIY_GUARD_VERSION = 'diy-guard-1';

/** 用户描述最大长度（字符）；超长截断并标记。 */
export const MAX_DESCRIPTION_LENGTH = 160;

/** 支持 DIY 上传的衣服品类。 */
export const DIY_CATEGORIES = ['top', 'bottom', 'dress', 'coat', 'outfit'];

/** 品类中文名（prompt 与 UI 共用）。 */
export const DIY_CATEGORY_LABELS = {
	top: '上衣',
	bottom: '下装',
	dress: '连衣裙',
	coat: '外套',
	outfit: '整套穿搭',
};

/** 品类 → manifest 槽位 / 是否拆袖（与 wardrobe-core DIY_LAYER_MODEL 对齐）。 */
export const DIY_CATEGORY_SLOTS = {
	top: { slot: 'topBody', sleeve: true },
	bottom: { slot: 'bottom', sleeve: false },
	dress: { slot: 'topBody', sleeve: true },
	coat: { slot: 'topBody', sleeve: true },
	outfit: { slot: 'topBody', sleeve: true },
};

/**
 * 硬拦截词（命中即 reject，不送 API）。
 * 覆盖：暴露（泳装/内衣/低胸/露肤）、超短、性感向、透明/情趣、涉未成年人。
 * 中英混合；匹配前统一小写、全角转半角。
 */
export const BANNED_TERMS = [
	// 暴露 / 泳装 / 内衣
	'比基尼', 'bikini', '泳装', '泳衣', '泳裤', '内衣', '内裤', '胸罩', 'bra', '情趣',
	'蕾丝内衣', '透视', '透明衣', '低胸', '深v', '露乳', '露胸', '露脐', '露腰', '露背',
	'露肩', '露点', '抹胸', '吊带', '比坚尼', '三点式', '半裸', '全裸', '裸体',
	// 超短 / 紧身暴露
	'超短', '热裤', '丁字裤', '超mini', 'micro', '越短越好', 'crop top', '露大腿',
	'丝袜高跟', '渔网', '捆绑', '开裆',
	// 性感向泛词
	'性感', '诱惑', '情色', '色情', '情趣', '挑逗', '擦边',
	// 涉未成年人（一票否决）
	'未成年', '萝莉', 'loli', '幼女', '幼齿', '幼童', '儿童', '小学生',
];

/**
 * 降级词表：偏短/贴身的**日常**描述自动替换成保守版型（仍会真正生成，
 * 但 prompt 已改写，且 UI 必须显式展示改写结果）。reject 词不在此表。
 */
export const DOWNGRADE_RULES = [
	{ pattern: /超短(?:裙|裤)/g, replacement: '及膝长度', label: '超短下装 → 及膝' },
	{ pattern: /短裙/g, replacement: '及膝裙', label: '短裙 → 及膝裙' },
	{ pattern: /短裤/g, replacement: '及膝长裤', label: '短裤 → 及膝长裤' },
	{ pattern: /短袖/g, replacement: '长袖', label: '短袖 → 长袖' },
	{ pattern: /无袖/g, replacement: '有袖', label: '无袖 → 有袖' },
	{ pattern: /紧身/g, replacement: '宽松版型', label: '紧身 → 宽松' },
	{ pattern: /贴身/g, replacement: '宽松版型', label: '贴身 → 宽松' },
	{ pattern: /露腿/g, replacement: '及膝长度', label: '露腿 → 及膝' },
	{ pattern: /露脐装/g, replacement: '常规长度上衣', label: '露脐 → 常规长度' },
	{ pattern: /高跟/g, replacement: '平底', label: '高跟 → 平底' },
];

/** 保守 prompt 的负向词（拼进 Seedream prompt；与 BANNED_TERMS 同源）。 */
export const NEGATIVE_TERMS = [
	'暴露', '性感', '比基尼', '泳装', '内衣', '超短', '热裤', '露脐', '露背', '露肩',
	'低胸', '透视', '透明', '紧身', '渔网', '情趣', '色情', '文字', 'logo', '水印',
	'未成年', '儿童', '萝莉',
];

/** 保守 prompt 的通用约束（衣服保守：有领/长袖/及膝/宽松）。 */
export const CONSERVATIVE_CONSTRAINTS =
	'日常保守服装：有领或常规领口、长袖或常规袖、下摆及膝或常规长度、版型宽松合身；' +
	'不暴露、不透明、不紧身，不改变角色的面部、发型、表情、年龄感与既有角色设定；禁止文字、logo、水印。';

/**
 * 把多种全角/异体字符归一化后小写，便于词表匹配。
 * @param {string} text
 * @returns {string}
 */
function foldText(text) {
	return String(text)
		.normalize('NFKC')
		.replace(/[\u200b-\u200f\u2028\u2029\ufeff]/g, '')
		.replace(/\s+/g, '')
		.toLowerCase();
}

/**
 * 规范化用户描述：去控制字符、合并空白、截断到最大长度。
 * @param {unknown} raw
 * @returns {{ ok: boolean, text: string, truncated: boolean, error: string }}
 */
export function normalizeDescription(raw) {
	if (typeof raw !== 'string') {
		return { ok: false, text: '', truncated: false, error: '描述必须是文本' };
	}
	let text = raw
		.replace(/[\u0000-\u001f\u007f]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	const truncated = text.length > MAX_DESCRIPTION_LENGTH;
	if (truncated) text = text.slice(0, MAX_DESCRIPTION_LENGTH).trim();
	if (!text) return { ok: false, text: '', truncated, error: '描述不能为空' };
	return { ok: true, text, truncated, error: '' };
}

/**
 * 扫描一段文本命中的硬拦截词（宿主侧二次校验 / 测试用）。
 * @param {string} text
 * @returns {string[]}
 */
export function scanBannedTerms(text) {
	const folded = foldText(text);
	/** @type {string[]} */
	const hits = [];
	for (const term of BANNED_TERMS) {
		if (folded.includes(foldText(term))) hits.push(term);
	}
	return hits;
}

/**
 * 扫描一段文本命中的降级词。
 * @param {string} text
 * @returns {string[]}
 */
export function scanDowngradeTerms(text) {
	const folded = foldText(text);
	/** @type {string[]} */
	const hits = [];
	for (const rule of DOWNGRADE_RULES) {
		// 逐条用归一化后的文本重新匹配，避免全角/大小写绕过
		const re = new RegExp(rule.pattern.source, rule.pattern.flags);
		if (re.test(folded)) hits.push(rule.label);
	}
	return hits;
}

/**
 * 把描述里的偏短/贴身词替换成保守版型。
 * @param {string} text
 * @returns {string}
 */
export function downgradeDescription(text) {
	let out = String(text);
	for (const rule of DOWNGRADE_RULES) {
		out = out.replace(rule.pattern, rule.replacement);
	}
	return out;
}

/**
 * DIY 上传描述的内容判定（客户端与宿主共用）。
 *
 * 决策：
 *   - `reject`：命中硬拦截词 → 不送 API、不落盘、只记 hash；
 *   - `downgrade`：命中偏短/贴身日常词 → 改写成保守版型后**仍可生成**，但 UI 必须
 *     显式展示改写结果并要求用户确认；
 *   - `pass`：直接通过，prompt 仍会拼保守约束与负向词。
 *
 * @param {unknown} raw 用户上传描述
 * @returns {{ action: 'pass' | 'downgrade' | 'reject', hits: string[], reasons: string[], description: string, original: string, truncated: boolean, guardVersion: string }}
 */
export function checkGarmentDescription(raw) {
	const normalized = normalizeDescription(raw);
	const original = typeof raw === 'string' ? raw : '';
	if (!normalized.ok) {
		return {
			action: 'reject',
			hits: [],
			reasons: [normalized.error],
			description: '',
			original,
			truncated: normalized.truncated,
			guardVersion: DIY_GUARD_VERSION,
		};
	}
	const hard = scanBannedTerms(normalized.text);
	if (hard.length > 0) {
		return {
			action: 'reject',
			hits: hard,
			reasons: ['命中暴露/超短/性感/涉未成年人词表：' + hard.join('、')],
			description: '',
			original,
			truncated: normalized.truncated,
			guardVersion: DIY_GUARD_VERSION,
		};
	}
	const soft = scanDowngradeTerms(normalized.text);
	if (soft.length > 0) {
		return {
			action: 'downgrade',
			hits: soft,
			reasons: ['偏短/贴身描述 → 已改写为保守版型：' + soft.join('、')],
			description: downgradeDescription(normalized.text),
			original,
			truncated: normalized.truncated,
			guardVersion: DIY_GUARD_VERSION,
		};
	}
	return {
		action: 'pass',
		hits: [],
		reasons: [],
		description: normalized.text,
		original,
		truncated: normalized.truncated,
		guardVersion: DIY_GUARD_VERSION,
	};
}

/**
 * 是否为合法 DIY 品类。
 * @param {unknown} category
 * @returns {boolean}
 */
export function isDiyCategory(category) {
	return typeof category === 'string' && DIY_CATEGORIES.includes(category);
}

/**
 * 品类 → 槽位/拆袖配置；未知品类返回 null。
 * @param {string} category
 * @returns {{ slot: string, sleeve: boolean } | null}
 */
export function categorySlot(category) {
	const entry = DIY_CATEGORY_SLOTS[/** @type {keyof typeof DIY_CATEGORY_SLOTS} */ (category)];
	return entry ? { ...entry } : null;
}

/**
 * 内容策略标签（写进 IndexedDB 记录 / `.dshskin`，导入时用来校验）。
 * @param {'pass' | 'downgrade'} decision
 * @returns {string}
 */
export function contentPolicyTag(decision) {
	return decision === 'downgrade' ? 'conservative-downgraded-v1' : 'conservative-v1';
}
