/**
 * v3.0.1 · 服装层手心残留门禁（QA task-4 门禁 ①；用户反馈「box2 左臂/裙：穿模」）
 *
 * 背景（v3.0.0 线上缺陷）：
 *   v3 整层服装资产是从旧版全身渲染图确定性提取生成的。旧图里手/前臂画在裙子前面，
 *   提取进 `garments/<shape>/<combo>/layers/{top,skirt}.png` 后，在**手/前臂与服装重叠区**
 *   留下了原画的手部像素：皮肤色块、手部黑/紫描边碎片、半透明手影描边。
 *   静止时大部分被真实手层（z=65）盖住，但动画/姿态变化时从手边露出一条「第二只手/皮肤带」
 *   ——即用户截图里的「穿模」观感。该残留不是骨骼/层级问题，是**服装层贴图像素**问题。
 *
 * 本门禁（内容级、不依赖浏览器）：
 *   读源包 `.cache/assets-src/art/garments/<shape>/<combo>/layers/{top,skirt}.png`，
 *   用源包素体部件（`art/base/<shape>/parts/{hand-L,hand-R,arm-fore-L/R,arm-upper-L/R}.png`）
 *   的 alpha 建「手/臂掩罩」，在掩罩内检测三类残留像素：
 *     D1 皮肤暖色：HSV 色相 ≤60°、饱和 ≥0.18、明度 ≥0.35 —— 蓝白/黑白的服装面料不可能出现；
 *     D2w 深暖手描边（所有层）：明度 <0.45、饱和 ≥0.15、色相 ≤45°、r−b ≥12、r≥g
 *        ——原画手部深红/暗棕轮廓与手影（源包实测典型值 [68,35,31]/[76,32,25]；白/蓝面料无此色）；
 *     D2p 深紫手描边（仅 skirt 层）：明度 <0.32、饱和 ≥0.20、色相 235–340° 且 r≥g、0≤b−r≤25
 *        （与蓝布暗纹 b−r 很大、纯黑描边 r≈g≈b 区分）——原画手部紫黑轮廓（典型 [31,28,42]/[36,30,44]）；
 *     D3 灰紫手影（仅 skirt 层）：明度 0.45–0.72、低饱和 0.02–0.10、色相 240–340°、r−g≥5
 *        ——原画手影半透明描边（典型值 [153,144,154]、[158,146,154]）。
 *   阈值 = 0 像素（每层）。top 层查 D1+D2w（白卫衣/水手服面料无暖色，D2w 安全）；
 *   D2p/D3 只用于 skirt 层（裙层是蓝白格纹/黑裙，紫/灰紫色相在面料中不存在；top 的白布阴影
 *   有低饱和灰紫，D3 会误伤，故 top 不启用）。
 *
 * 双验证要求（v3.0.1 交付纪律）：
 *   - 在**当前未修复 v3.0.0 源包**上本测试必须 FAIL（实测残留：chibi sailor-plaid skirt 829px、
 *     hoodie-plaid 431px、hoodie-pleated 222px；girl 对应 36/101/80px 等，见带下界断言）；
 *   - 修复后（task-2 产出新的 layers png）必须 PASS（每层 0px）；
 *   - 无 `.cache/assets-src`（干净 clone / CI）时 skip，不阻塞主分支。
 *
 * 写作用域说明：本文件归 qa；修复动作在 task-2（artfix），本测试只做门禁不改资产。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';

const ROOT = resolve(import.meta.dirname, '..');
const PYTHON = process.env.DSH_FEIYU_PYTHON || 'python3';
const SRC = join(ROOT, '.cache', 'assets-src', 'art');
const SHAPES = ['chibi', 'girl'];
const COMBOS = ['maid', 'hoodie-plaid', 'hoodie-pleated', 'sailor-plaid'];
const LAYERS = ['top', 'skirt'];
const HAND_PARTS = ['hand-L', 'hand-R', 'arm-fore-L', 'arm-fore-R', 'arm-upper-L', 'arm-upper-R'];

/** 每层残留像素上限：严格 0（门禁口径）。 */
const RESIDUE_MAX_PX = 0;
/** 掩罩与服装层有效重叠下界：低于此值说明该组合手/臂根本没碰到这层（如 maid 黑裙），无检测意义。 */
const MIN_MASK_OVERLAP_PX = 200;
/** 修复前（v3.0.0）实测残留下界——防止门禁被阈值/掩罩静默改弱：未修复资产必须超限。 */
const V300_BASELINE_MIN_RESIDUE = {
	chibi: { 'maid/top': 50, 'hoodie-plaid/skirt': 300, 'hoodie-pleated/skirt': 150, 'sailor-plaid/skirt': 600 },
	girl: { 'maid/top': 400, 'hoodie-plaid/skirt': 25, 'hoodie-pleated/skirt': 70, 'sailor-plaid/skirt': 50 },
};

function pythonOk() {
	const r = spawnSync(PYTHON, ['-c', 'import numpy, cv2, PIL'], { encoding: 'utf8' });
	return r.status === 0;
}
const hasPython = pythonOk();
const hasSources = existsSync(join(SRC, 'garments')) && existsSync(join(SRC, 'base'));

/**
 * 对所有 shape × combo × layer 做残留检测，返回 { [key]: {D1,D2,D3,total,maskOverlap} }。
 * @param {string[]} shapes
 */
function analyze(shapes) {
	const py = String.raw`
import json, os, sys
import numpy as np
from PIL import Image
import cv2

payload = json.loads(sys.argv[1])
art = payload['art']
shapes = payload['shapes']
combos = payload['combos']
layers = payload['layers']
hand_parts = payload['handParts']

# 残留颜色分类（阈值与注释见 tests/garment-residue.test.mjs 文件头）
def residue_masks(rgba, layer_kind):
    rgb = rgba[..., :3]
    a = rgba[..., 3].astype(int)
    hsv = cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV)
    h = hsv[..., 0].astype(int) * 2          # OpenCV H: 0..179 -> 0..358 度
    s = hsv[..., 1].astype(float) / 255.0
    v = hsv[..., 2].astype(float) / 255.0
    r, g, b = rgb[..., 0].astype(int), rgb[..., 1].astype(int), rgb[..., 2].astype(int)
    # D1 皮肤暖色（所有层）
    d1 = (h <= 60) & (s >= 0.18) & (v >= 0.35) & (a >= 120)
    # D2w 深暖手描边/手影（所有层；白/蓝面料无 r-b>=12 的暖色）
    d2w = (v < 0.45) & (s >= 0.15) & (h <= 45) & ((r - b) >= 12) & (r >= g) & (a >= 120)
    if layer_kind != 'skirt':
        return d1, d2w, None, None
    # D2p 深紫手描边（skirt）：暗紫，b 略大于 r 但远小于蓝布
    d2p = ((v < 0.32) & (s >= 0.20) & (a >= 120)
           & (h >= 235) & (h <= 340) & ((b - r) >= 0) & ((b - r) <= 25) & ((r - g) >= 0))
    # D3 灰紫手影（skirt）
    d3 = ((v >= 0.45) & (v <= 0.72) & (s >= 0.02) & (s <= 0.10)
          & (h >= 240) & (h <= 340) & ((r - g) >= 5) & (np.abs(b - r) <= 8) & (a >= 120))
    return d1, d2w, d2p, d3

out = {}
for shape in shapes:
    # 手/臂掩罩：源包素体部件 alpha 并集（675×1200 canvas 对齐）
    mask = np.zeros((1200, 675), bool)
    missing = []
    for pid in hand_parts:
        p = os.path.join(art, 'base', shape, 'parts', pid + '.png')
        if not os.path.exists(p):
            missing.append(pid)
            continue
        alpha = np.asarray(Image.open(p).convert('RGBA'))[..., 3]
        mask |= alpha > 16
    for combo in combos:
        for layer in layers:
            p = os.path.join(art, 'garments', shape, combo, 'layers', layer + '.png')
            if not os.path.exists(p):
                out[f'{shape}/{combo}/{layer}'] = {'missing': True, 'maskPartsMissing': missing}
                continue
            rgba = np.asarray(Image.open(p).convert('RGBA'))
            if rgba.shape[:2] != (1200, 675):
                out[f'{shape}/{combo}/{layer}'] = {'badSize': list(rgba.shape[:2]), 'maskPartsMissing': missing}
                continue
            fabric = rgba[..., 3] > 8
            overlap = fabric & mask
            masks = residue_masks(rgba, layer)
            d1, d2w, second, third = masks
            entry = {
                'maskOverlap': int(overlap.sum()),
                'maskPartsMissing': missing,
                'D1': int((d1 & overlap).sum()),
                'D2w': int((d2w & overlap).sum()),
                'D2p': int((second & overlap).sum()) if layer == 'skirt' else None,
                'D3': int((third & overlap).sum()) if layer == 'skirt' and third is not None else None,
            }
            entry['total'] = entry['D1'] + entry['D2w'] + (entry['D2p'] or 0) + (entry['D3'] or 0)
            out[f'{shape}/{combo}/{layer}'] = entry
print(json.dumps(out))
`;
	const r = spawnSync(PYTHON, ['-c', py, JSON.stringify({ art: SRC, shapes, combos: COMBOS, layers: LAYERS, handParts: HAND_PARTS })], {
		encoding: 'utf8',
		timeout: 120000,
	});
	assert.equal(r.status, 0, `python 残留分析失败: ${(r.stderr || '').slice(0, 800)}`);
	return JSON.parse(r.stdout.trim());
}

const report = hasSources && hasPython ? analyze(SHAPES) : {};

for (const shape of SHAPES) {
	test(`garment-residue · ${shape}：手/前臂掩罩内无 baked 皮肤/手描边/手影残留`, (t) => {
		if (!hasSources) return t.skip('缺少源包 .cache/assets-src（npm run fetch:sources 后生效）');
		if (!hasPython) return t.skip('python3 + numpy/cv2/PIL 不可用');
		const failures = [];
		let checkedLayers = 0;
		for (const combo of COMBOS) {
			for (const layer of LAYERS) {
				const key = `${shape}/${combo}/${layer}`;
				const entry = report[key];
				if (!entry) { failures.push(`${key}: 分析结果缺失`); continue; }
				if (entry.missing) { failures.push(`${key}: 源包缺少 layers/${layer}.png`); continue; }
				if (entry.badSize) { failures.push(`${key}: 层尺寸异常 ${entry.badSize.join('×')}`); continue; }
				if (entry.maskPartsMissing && entry.maskPartsMissing.length > 0) {
					failures.push(`${key}: 素体手/臂部件缺失（掩罩不完整）：${entry.maskPartsMissing.join(',')}`);
					continue;
				}
				if (entry.maskOverlap < MIN_MASK_OVERLAP_PX) {
					t.diagnostic(`${key}: 手/臂掩罩与服装层重叠 ${entry.maskOverlap}px < ${MIN_MASK_OVERLAP_PX}，跳过（该层无手/臂接触面）`);
					continue;
				}
				checkedLayers += 1;
				if (entry.total > RESIDUE_MAX_PX) {
					failures.push(`${key}: 残留 ${entry.total}px（阈值 ${RESIDUE_MAX_PX}）`
						+ ` —— 皮肤 D1=${entry.D1}px、深暖描边 D2w=${entry.D2w}px`
						+ `、深紫描边 D2p=${entry.D2p == null ? 'n/a(top)' : `${entry.D2p}px`}`
						+ `、灰紫手影 D3=${entry.D3 == null ? 'n/a(top)' : `${entry.D3}px`}`
						+ `；用户反馈「手心残留/穿模」即此类像素（修复：task-2 artfix 用布料纹理干净填补）`);
				}
			}
		}
		assert.ok(checkedLayers > 0, `${shape}: 没有任何层进入残留检测（源包结构异常）`);
		assert.deepEqual(failures, [], `${shape}: 服装层手心残留门禁失败：\n  - ${failures.join('\n  - ')}`);
		t.diagnostic(`${shape}: ${checkedLayers} 层通过手/臂掩罩残留检测（0px）`);
	});

	test(`garment-residue · ${shape}：未修复基线复核（防止门禁用例被静默改弱）`, (t) => {
		// 该断言只对「v3.0.0 未修复资产」有意义：修复后这些 key 的 total 会变 0。
		// 做法：若仍在未修复状态（源包 layers mtime/内容仍是 v3.0.0），必须至少有一层超限；
		// 若已修复（全部 0），则跳过——由前一个测试保证 PASS。
		if (!hasSources) return t.skip('缺少源包');
		if (!hasPython) return t.skip('python3 不可用');
		const baseline = V300_BASELINE_MIN_RESIDUE[shape] || {};
		const totals = {};
		let anyResidue = false;
		for (const combo of COMBOS) {
			for (const layer of LAYERS) {
				const entry = report[`${shape}/${combo}/${layer}`];
				if (!entry || entry.missing || entry.badSize) continue;
				totals[`${combo}/${layer}`] = entry.total;
				if (entry.total > 0) anyResidue = true;
			}
		}
		if (!anyResidue) return t.skip('服装层已无残留（修复后状态）——本复核仅用于未修复基线');
		for (const [key, minPx] of Object.entries(baseline)) {
			const total = totals[key];
			assert.ok(total != null, `${shape}/${key}: 缺少分析结果`);
			assert.ok(total >= minPx,
				`${shape}/${key}: 残留 ${total}px 低于 v3.0.0 基线下界 ${minPx}px——门禁阈值/掩罩可能被静默改弱，请复核`);
		}
		t.diagnostic(`${shape}: 未修复基线复核通过（残留层：${Object.entries(totals).filter(([, v]) => v > 0).map(([k, v]) => `${k}=${v}px`).join('、')}）`);
	});
}
