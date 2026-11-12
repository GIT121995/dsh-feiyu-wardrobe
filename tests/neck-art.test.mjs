/**
 * v3.0.1 · 素体颈部/下巴美术门禁（QA task-4 门禁 ②；用户反馈「下巴跟脸连不上」）
 *
 * 背景（v3.0.0 线上缺陷）：
 *   v3.0.0 用 W8 AI 局部重绘 + G3-2 细线做了 `body-fix/<shape>/neck-overlay.png`（alpha=羽化权重，
 *   RGB=目标肤色，675×1200；builder 按 out=base·(1−w)+overlayRGB·w 烘进 body-head 贴图）。
 *   该 overlay 把**下巴下缘到颈部的整个宽区域**（halfW=112 → 约 224px 宽）刷成一片平白偏冷的
 *   肤色带，且 G3-2 细线（Ldrop35/α0.75）在带的上缘形成横贯下颌的硬切线；叠加 sailor 白色内领后
 *   读作「下巴被切下来、接不上脸」。
 *
 * 本门禁（内容级、不依赖浏览器；从源包合成 body-head 纹理 == dist 里烘后的 body-head 贴图）：
 *   base = `art/base/<shape>/parts/body-head.png`，overlay = `art/body-fix/<shape>/neck-overlay.png`，
 *   composite = base·(1−w)+overlayRGB·w（w=overlay alpha/255，只对 base alpha>240 生效，与
 *   tools/art/build_prod.py::apply_neck_overlay 完全一致）。
 *   断言（v3.0.1 验收口径，对应 task-1）：
 *     A. 颈部宽度收窄到真实颈部轮廓内：overlay 有效宽度（alpha≥128）/ base 素体颈部宽度 ≤ 1.15；
 *     B. 颈部与脸颊 LAB 连续：|L_neck − L_cheek| ≤ 12、Δa/Δb ≤ 8（task-1 验收 face_L−12..face_L+1）；
 *     C. 无横贯下颌硬切线：下颌区（jaw−15..jaw+11）逐列 max|ΔL| 的 p90 ≤ 45（8bit LAB L）；
 *     D. 颈部不出现「平白宽带」：neck 区色度（max−min）相对脸颊色度 ≥ 0.80（报告指标，超限失败）。
 *
 * 双验证要求：
 *   - 当前未修复 v3.0.0 源包必须 FAIL（实测：chibi 宽度比 1.35、girl 1.19；girl |ΔL|=16；
 *     girl 下颌梯度 p90=63）；
 *   - task-1（artfix）修复后的 overlay 必须 PASS；
 *   - 无 `.cache/assets-src` 时 skip，不阻塞干净 clone / CI。
 *
 * 备注：阈值在候选 N1/N2/N3 定稿后如需按美术判断微调，必须同时记录「修复前 FAIL / 修复后 PASS」
 * 的双向实测数据（task-5 回归报告），不得单方面放宽。
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

/** v3.0.1 验收阈值（见文件头注释；修复前实测值在失败信息里输出）。 */
const THRESHOLDS = {
	neckWidthRatioMax: 1.15,
	cheekNeckDeltaLMax: 12,
	cheekNeckDeltaABMax: 8,
	chinLineGradientP90Max: 45,
	neckChromaRatioMin: 0.80,
};

function pythonOk() {
	const r = spawnSync(PYTHON, ['-c', 'import numpy, cv2, PIL'], { encoding: 'utf8' });
	return r.status === 0;
}
const hasPython = pythonOk();
const hasSources = existsSync(join(SRC, 'base')) && existsSync(join(SRC, 'body-fix'));

/** 分析某身形的 composite 颈部指标。返回原始指标 JSON。 */
function analyze(shape) {
	const py = String.raw`
import json, os, sys
import numpy as np
from PIL import Image
import cv2

payload = json.loads(sys.argv[1])
art = payload['art']; shape = payload['shape']
base_path = os.path.join(art, 'base', shape, 'parts', 'body-head.png')
ovr_path = os.path.join(art, 'body-fix', shape, 'neck-overlay.png')
meta_path = os.path.join(art, 'body-fix', shape, 'neck-overlay.json')
for p in (base_path, ovr_path):
    if not os.path.exists(p):
        print(json.dumps({'skip': f'缺少源包文件 {p}'})); sys.exit(0)
base = np.asarray(Image.open(base_path).convert('RGBA'))
ovr = np.asarray(Image.open(ovr_path).convert('RGBA'))
if base.shape[:2] != (1200, 675) or ovr.shape[:2] != (1200, 675):
    print(json.dumps({'skip': f'尺寸异常 base={base.shape[:2]} overlay={ovr.shape[:2]}'})); sys.exit(0)
meta = {}
if os.path.exists(meta_path):
    try: meta = json.load(open(meta_path))
    except Exception: meta = {}
region = meta.get('region') or {}
jaw = int(region.get('jaw') or 0)
cx = int(region.get('cx') or 0)
# 回退：从 overlay alpha bbox 推 cx/jaw（json 缺失时仍可测）
ys, xs = np.nonzero(ovr[..., 3] > 0)
if not xs.size:
    print(json.dumps({'skip': 'neck-overlay alpha 为空'})); sys.exit(0)
if not cx: cx = int(round((xs.min() + xs.max()) / 2))
if not jaw: jaw = int(ys.min())

# ---- 合成（与 build_prod.py::apply_neck_overlay 一致） ----
w = (ovr[..., 3].astype(np.float32) / 255.0) * (base[..., 3] > 240)
rgb = base[..., :3].astype(np.float32) * (1 - w[..., None]) + ovr[..., :3].astype(np.float32) * w[..., None]
comp = np.dstack([np.clip(np.rint(rgb), 0, 255).astype(np.uint8), base[..., 3]])
LAB = cv2.cvtColor(comp[..., :3], cv2.COLOR_RGB2LAB).astype(np.float32)
opaque = comp[..., 3] > 240

# ---- A. 颈部宽度：overlay 有效宽度 / base 素体真实颈部宽度 ----
brgb = base[..., :3].astype(int)
base_skin = (base[..., 3] > 240) & (brgb[..., 0] >= 150) & ((brgb[..., 0] - brgb[..., 2]) >= 8)
def run_width(mrow, c):
    if not mrow[c]:
        found = False
        for d in range(1, 31):
            for xx in (c - d, c + d):
                if 0 <= xx < len(mrow) and mrow[xx]:
                    c = xx; found = True; break
            if found: break
        if not found: return 0
    x0 = c
    while x0 > 0 and mrow[x0 - 1]: x0 -= 1
    x1 = c
    while x1 < len(mrow) - 1 and mrow[x1 + 1]: x1 += 1
    return x1 - x0 + 1
rows = range(jaw + 10, jaw + 36)
base_is = [v for v in (run_width(base_skin[y], cx) for y in rows) if v > 0]
overlay_is = [v for v in (run_width(ovr[y, :, 3] >= 128, cx) for y in rows) if v > 0]
if not base_is or not overlay_is:
    print(json.dumps({'skip': '颈部行带内取不到 base 颈部/overlay 宽度（几何异常）'})); sys.exit(0)
base_neck_width = float(np.median(base_is))
overlay_neck_width = float(np.median(overlay_is))
neck_width_ratio = overlay_neck_width / max(1.0, base_neck_width)

# ---- B. 脸颊 vs 颈部 LAB 连续性 ----
def med_lab(y0, y1, x0, x1):
    seg = LAB[y0:y1, x0:x1]; m = comp[y0:y1, x0:x1, 3] > 240
    if m.sum() < 20: return None
    return [float(np.median(seg[..., i][m])) for i in range(3)]
cheek_l = med_lab(jaw - 55, jaw - 25, cx - 70, cx - 28)
cheek_r = med_lab(jaw - 55, jaw - 25, cx + 28, cx + 70)
neck_lab = med_lab(jaw + 14, jaw + 38, cx - 18, cx + 18)
if not neck_lab or not (cheek_l and cheek_r):
    print(json.dumps({'skip': '脸颊/颈部采样区无效'})); sys.exit(0)
delta_l = max(abs(neck_lab[0] - cheek_l[0]), abs(neck_lab[0] - cheek_r[0]))
delta_ab = max(max(abs(neck_lab[1] - cheek_l[1]), abs(neck_lab[2] - cheek_l[2])),
               max(abs(neck_lab[1] - cheek_r[1]), abs(neck_lab[2] - cheek_r[2])))

# ---- C. 下颌硬切线：逐列 max|ΔL|（只统计 face/neck 皮肤类像素列） ----
crgb = comp[..., :3].astype(int)
skinlike = opaque & (crgb[..., 0] >= 150) & (crgb[..., 0] >= crgb[..., 1] - 2) & ((crgb[..., 0] - crgb[..., 2]) >= 6)
grads = []
for x in range(cx - 40, cx + 41):
    rows_ok = [y for y in range(jaw - 15, jaw + 11) if skinlike[y, x]]
    if len(rows_ok) < 10: continue
    vals = LAB[rows_ok, x, 0]
    grads.append(float(np.max(np.abs(np.diff(vals)))))
grad_p90 = float(np.percentile(grads, 90)) if grads else 0.0

# ---- D. 颈部色度相对脸颊（平白→低色度） ----
def chroma_ratio():
    seg = comp[..., :3].astype(int)
    def chroma(y0, y1, x0, x1):
        m = comp[y0:y1, x0:x1, 3] > 240
        if m.sum() < 20: return None
        p = seg[y0:y1, x0:x1][m]
        return float((p.max(axis=1) - p.min(axis=1)).mean())
    c = chroma(jaw - 55, jaw - 25, cx - 70, cx + 70)
    n = chroma(jaw + 14, jaw + 38, cx - 18, cx + 18)
    if not c or not n or c <= 0: return None
    return n / c
neck_chroma_ratio = chroma_ratio()

print(json.dumps({
    'shape': shape,
    'geometry': {'cx': cx, 'jaw': jaw, 'neckBase': int(region.get('neckBase') or 0), 'halfW': region.get('halfW')},
    'overlay': {'alphaPx': int((ovr[..., 3] > 0).sum()), 'fullPx': int((ovr[..., 3] == 255).sum())},
    'metrics': {
        'baseNeckWidth': base_neck_width,
        'overlayNeckWidth': overlay_neck_width,
        'neckWidthRatio': round(neck_width_ratio, 3),
        'cheekLabL': round(cheek_l[0], 1),
        'cheekLabR': round(cheek_r[0], 1),
        'neckLab': [round(v, 1) for v in neck_lab],
        'cheekNeckDeltaL': round(delta_l, 1),
        'cheekNeckDeltaAB': round(delta_ab, 1),
        'chinLineGradientP90': round(grad_p90, 1),
        'neckChromaRatio': None if neck_chroma_ratio is None else round(neck_chroma_ratio, 3),
    },
}))
`;
	const r = spawnSync(PYTHON, ['-c', py, JSON.stringify({ art: SRC, shape })], { encoding: 'utf8', timeout: 120000 });
	assert.equal(r.status, 0, `python 颈部分析失败: ${(r.stderr || '').slice(0, 800)}`);
	return JSON.parse(r.stdout.trim());
}

for (const shape of SHAPES) {
	test(`neck-art · ${shape}：颈部宽度/LAB 连续性/无硬切线（W8 overlay 替换验收）`, (t) => {
		if (!hasSources) return t.skip('缺少源包 .cache/assets-src（npm run fetch:sources 后生效）');
		if (!hasPython) return t.skip('python3 + numpy/cv2/PIL 不可用');
		const report = analyze(shape);
		if (report.skip) return t.skip(report.skip);
		const m = report.metrics;
		t.diagnostic(`${shape} 指标：${JSON.stringify(m)}`);
		const failures = [];
		// A. 颈部宽度
		if (!(m.neckWidthRatio <= THRESHOLDS.neckWidthRatioMax)) {
			failures.push(`颈部宽度比 ${m.neckWidthRatio} > ${THRESHOLDS.neckWidthRatioMax}`
				+ `（overlay 有效宽 ${m.overlayNeckWidth}px / 素体真实颈宽 ${m.baseNeckWidth}px）`
				+ ' —— W8 平白宽带把颈部刷宽；验收：收窄到真实颈部轮廓内（task-1 artfix）');
		}
		// B. LAB 连续性
		if (!(m.cheekNeckDeltaL <= THRESHOLDS.cheekNeckDeltaLMax)) {
			failures.push(`颈/脸 ΔL=${m.cheekNeckDeltaL} > ${THRESHOLDS.cheekNeckDeltaLMax}（neck L=${m.neckLab[0]}，脸颊 L=${m.cheekLabL}/${m.cheekLabR}）`);
		}
		if (!(m.cheekNeckDeltaAB <= THRESHOLDS.cheekNeckDeltaABMax)) {
			failures.push(`颈/脸 Δa/Δb=${m.cheekNeckDeltaAB} > ${THRESHOLDS.cheekNeckDeltaABMax}（色相不连续）`);
		}
		// C. 下颌硬切线
		if (!(m.chinLineGradientP90 <= THRESHOLDS.chinLineGradientP90Max)) {
			failures.push(`下颌逐列 max|ΔL| p90=${m.chinLineGradientP90} > ${THRESHOLDS.chinLineGradientP90Max}`
				+ ' —— 横贯下颌的硬切线（G3-2 细线/overlay 上缘）；验收：极柔和过渡或沿真实下巴轮廓的淡影');
		}
		// D. 颈部色度（平白宽带 → 色度显著低于脸颊）
		if (m.neckChromaRatio != null && !(m.neckChromaRatio >= THRESHOLDS.neckChromaRatioMin)) {
			failures.push(`颈部色度/脸颊色度=${m.neckChromaRatio} < ${THRESHOLDS.neckChromaRatioMin}（颈部被刷成平白低色度带）`);
		}
		assert.deepEqual(failures, [], `${shape}: 颈部/下巴美术门禁失败：\n  - ${failures.join('\n  - ')}`);
	});
}
