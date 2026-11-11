/**
 * v3.0 paper-doll · 服装层卫生断言（Phase 3 门禁之一）
 *
 * 校验已提交的官方 dist（docs/dress-up/art/2d5）：
 *   1) v3 整层 outfit 结构：每个 combo 只有 topBody/bottom 两个 drawable
 *      （slot/z：topBody=64 / bottom=30），网格非空；
 *   2) 服装层纹理里**没有任何烘焙皮肤**（严格口径：邻域支撑+面积过滤，与
 *      .scratch/p8/v3-paperdoll/art/scripts/assemble.py 的 baked_skin_mask 一致）；
 *   3) 纹理每层 alpha 闭合（无 >4px 成片孔洞；**功能性开口不计**：领口露颈、
 *      手从袖口伸出。开口位置由骨架 neck/handL/handR 骨 base 判定——落在开口区域内
 *      的透明洞合法，落在服装面内的才是贴图缺陷）。
 *
 * 说明：dist 尚未迁移到 v3 时（旧 v2.7 分件资产）本测试 skip，不阻塞主分支；
 *      v3 dist 合并后自动生效。Python/PIL 缺失时 skip（与 asset-build.test.mjs 同策略）。
 *
 * 环境变量：DSH_FEIYU_PYTHON（默认 python3）。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';

const ROOT = resolve(import.meta.dirname, '..');
const PYTHON = process.env.DSH_FEIYU_PYTHON || 'python3';
const DIST = join(ROOT, 'docs', 'dress-up', 'art', '2d5');
const SHAPES = ['chibi', 'girl'];
const COMBOS = ['maid', 'hoodie-plaid', 'hoodie-pleated', 'sailor-plaid'];

function pythonOk() {
	const r = spawnSync(PYTHON, ['-c', 'import numpy, cv2, PIL'], { encoding: 'utf8' });
	return r.status === 0;
}

function readRig(shape) {
	const p = join(DIST, shape, 'rig.json');
	if (!existsSync(p)) return null;
	return JSON.parse(readFileSync(p, 'utf8'));
}

function isV3Rig(rig) {
	if (!rig || !rig.outfits) return false;
	return COMBOS.some((combo) => {
		const outfit = rig.outfits[combo];
		if (!outfit) return false;
		const top = outfit.topBody || [];
		const bottom = outfit.bottom || [];
		return top.some((id) => id.endsWith('-top')) && bottom.some((id) => id.endsWith('-skirt'));
	});
}

/**
 * v3 整层服装的「功能性开口」区域（canvas 坐标）：
 *   - 领口：neck 骨 base 附近（露颈）；
 *   - 袖口/手：handL/handR 骨 base 周围（手从袖子伸出，服装层在该处透明、由 body hand z=65 覆盖）。
 * 这些位置的透明洞是合法开口；其它位置的成片透明洞是贴图缺陷（会露出身体/背景）。
 * @param {any} rig
 * @returns {{ canvas: { width: number, height: number }, boxes: Array<{x0:number,y0:number,x1:number,y1:number}>, circles: Array<{cx:number,cy:number,r:number}> }}
 */
function functionalOpenings(rig) {
	const bones = new Map(((rig.skeleton && rig.skeleton.bones) || []).map((bone) => [bone.id, bone]));
	const base = (id) => {
		const bone = bones.get(id);
		return bone && Array.isArray(bone.base) ? bone.base : null;
	};
	const canvas = rig.canvas && Number(rig.canvas.width) > 0
		? { width: Number(rig.canvas.width), height: Number(rig.canvas.height) }
		: { width: 675, height: 1200 };
	// 领口：neck 骨上下留出「领圈在锁骨」的解剖范围（chibi neck.y≈575 / girl≈430）
	const neck = base('neck') || [canvas.width / 2, canvas.height * 0.47];
	const boxes = [{
		x0: neck[0] - 125, x1: neck[0] + 125,
		y0: neck[1] - 80, y1: neck[1] + 60,
	}];
	// 袖口/手：半径按两肩手骨间距比例取（chibi≈83px / girl≈80px），覆盖袖口内手部轮廓
	const handL = base('handL');
	const handR = base('handR');
	const reach = handL && handR ? Math.abs(handR[0] - handL[0]) : canvas.width * 0.35;
	const r = Math.max(55, Math.min(96, reach * 0.34));
	const circles = [];
	for (const hand of [handL, handR]) {
		if (hand) circles.push({ cx: hand[0], cy: hand[1], r });
	}
	return { canvas, boxes, circles };
}

/** 用 Python+PIL 读 dist 图集，统计 v3 服装层的严格皮肤像素与 alpha 孔洞。 */
function analyzeTextures(shape, jobs, openings) {
	const py = `
import json, sys
import numpy as np
from PIL import Image

payload = json.loads(sys.argv[1])
atlas = np.array(Image.open(payload['atlas']).convert('RGBA'))
H, W = atlas.shape[:2]
canvas_w = int(payload['canvas']['width'])
canvas_h = int(payload['canvas']['height'])
import cv2

# 功能性开口 mask（canvas 坐标）：领口 box + 手/袖口 circle（位置来自骨架 base）
allow = np.zeros((canvas_h, canvas_w), bool)
for box in payload['openings']['boxes']:
    x0 = max(0, int(round(box['x0']))); x1 = min(canvas_w, int(round(box['x1'])))
    y0 = max(0, int(round(box['y0']))); y1 = min(canvas_h, int(round(box['y1'])))
    allow[y0:y1, x0:x1] = True
if payload['openings']['circles']:
    yy, xx = np.ogrid[0:canvas_h, 0:canvas_w]
    for circle in payload['openings']['circles']:
        r = float(circle['r'])
        allow |= ((xx - float(circle['cx'])) ** 2 + (yy - float(circle['cy'])) ** 2) <= r * r

def skin_mask(tile):
    rgb = tile[..., :3].astype(np.int32)
    a = tile[..., 3]
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    rg, gb = r - g, g - b
    m = (a >= 1) & (r >= 190) & (g >= 135) & (rg >= 6) & (rg <= 65) & (gb >= 2) & (gb <= 25)
    support = cv2.filter2D(m.astype(np.uint8), -1, np.ones((3, 3), np.uint8))
    m = m & (support >= 5)
    m = cv2.morphologyEx(m.astype(np.uint8), cv2.MORPH_OPEN, np.ones((2, 2), np.uint8)).astype(bool)
    n, lab, stats, _ = cv2.connectedComponentsWithStats(m.astype(np.uint8), 8)
    keep = np.zeros_like(m)
    for i in range(1, n):
        if stats[i, cv2.CC_STAT_AREA] >= 24:
            keep |= (lab == i)
    return keep

def alpha_analysis(tile, job):
    a = (tile[..., 3] > 0).astype(np.uint8)
    h, w = a.shape
    flood = a.copy()
    ff = np.zeros((h + 2, w + 2), np.uint8)
    if flood[0, 0] == 0:
        cv2.floodFill(flood, ff, (0, 0), 2)
    holes = (flood == 0) & (a == 0)
    n, lab, stats, _ = cv2.connectedComponentsWithStats(holes.astype(np.uint8), 8)
    # 把 hole 像素映射回 canvas 坐标（v3 层 rect=alpha bbox；图集 tile 两侧各留 padding）
    rx0, ry0, rx1, ry1 = job['rect']
    content_w = max(1, rx1 - rx0)
    content_h = max(1, ry1 - ry0)
    inset_x = (w - content_w) / 2.0
    inset_y = (h - content_h) / 2.0
    holes_gt4 = 0
    holes_px = 0
    defect = 0
    legal = 0
    for i in range(1, n):
        area = int(stats[i, cv2.CC_STAT_AREA])
        if area <= 0:
            continue
        holes_px += area
        if area <= 4:
            continue
        holes_gt4 += 1
        ys, xs = np.nonzero(lab == i)
        cx = np.clip(np.round(rx0 + xs - inset_x).astype(np.int32), 0, canvas_w - 1)
        cy = np.clip(np.round(ry0 + ys - inset_y).astype(np.int32), 0, canvas_h - 1)
        coverage = float(allow[cy, cx].mean()) if len(cx) else 1.0
        if coverage >= 0.95:
            legal += 1
        else:
            defect += 1
    return {
        'alphaHolesGt4': holes_gt4,
        'alphaHolesPx': holes_px,
        'defectHolesGt4': defect,
        'legalHolesGt4': legal,
    }

out = {}
for job in payload['jobs']:
    x, y, w, h = job['atlasRect']
    tile = atlas[y:y + h, x:x + w]
    info = alpha_analysis(tile, job)
    info['skinPx'] = int(skin_mask(tile).sum())
    info['opaquePx'] = int((tile[..., 3] > 8).sum())
    out[job['id']] = info
print(json.dumps(out))
`;
	const r = spawnSync(PYTHON, ['-c', py, JSON.stringify({
		atlas: join(DIST, shape, 'atlas.webp'),
		canvas: openings.canvas,
		openings: { boxes: openings.boxes, circles: openings.circles },
		jobs,
	})], {
		encoding: 'utf8',
		timeout: 120000,
	});
	assert.equal(r.status, 0, `python 纹理分析失败: ${r.stderr}`);
	return JSON.parse(r.stdout.trim());
}
const hasPython = pythonOk();

for (const shape of SHAPES) {
	test(`garment-hygiene · ${shape}：v3 整层 outfit 结构+纹理卫生`, (t) => {
		const rig = readRig(shape);
		if (!rig) return t.skip(`缺少 dist rig：${shape}`);
		if (!isV3Rig(rig)) return t.skip(`dist 尚未迁移到 v3 整层资产（${shape}）`);
		if (!hasPython) return t.skip('python3 + numpy/cv2/PIL 不可用');

		const drawableById = new Map(rig.drawables.map((d) => [d.id, d]));
		const openings = functionalOpenings(rig);
		const jobs = [];
		for (const combo of COMBOS) {
			const outfit = rig.outfits[combo];
			assert.ok(outfit, `${shape}: rig.outfits 缺少 ${combo}`);
			const topIds = outfit.topBody || [];
			const bottomIds = outfit.bottom || [];
			assert.equal(topIds.length, 1, `${shape}/${combo}: topBody 应有 1 个整层 drawable，实际 ${topIds.length}`);
			assert.equal(bottomIds.length, 1, `${shape}/${combo}: bottom 应有 1 个整层 drawable，实际 ${bottomIds.length}`);
			assert.equal(topIds[0], `${combo}-top`, `${shape}/${combo}: top drawable id 应为 ${combo}-top`);
			assert.equal(bottomIds[0], `${combo}-skirt`, `${shape}/${combo}: skirt drawable id 应为 ${combo}-skirt`);

			// v3：不再有 collar/sleeve 等分件
			for (const slot of ['collar', 'sleeve', 'sleeveUpper', 'sleeveFore']) {
				const ids = outfit[slot] || [];
				assert.equal(ids.length, 0, `${shape}/${combo}: v3 不应再有 ${slot} 分件`);
			}

			const top = drawableById.get(`${combo}-top`);
			const skirt = drawableById.get(`${combo}-skirt`);
			assert.ok(top && skirt, `${shape}/${combo}: rig.drawables 缺少 top/skirt`);
			assert.equal(top.slot, 'topBody', `${shape}/${combo}: top slot 应为 topBody`);
			assert.equal(top.z, 64, `${shape}/${combo}: top z 应为 64（高于 body 手臂 45/48、低于手 65）`);
			assert.equal(skirt.slot, 'bottom', `${shape}/${combo}: skirt slot 应为 bottom`);
			assert.equal(skirt.z, 30, `${shape}/${combo}: skirt z 应为 30`);
			for (const d of [top, skirt]) {
				assert.ok(d.mesh && Array.isArray(d.mesh.indices) && d.mesh.indices.length > 0,
					`${shape}/${combo}: ${d.id} 网格为空`);
				assert.ok(Array.isArray(d.atlasRect) && d.atlasRect.length === 4,
					`${shape}/${combo}: ${d.id} 缺少 atlasRect`);
				assert.ok(Array.isArray(d.rect) && d.rect.length === 4,
					`${shape}/${combo}: ${d.id} 缺少 canvas rect（alpha bbox，孔洞定位用）`);
				jobs.push({ id: d.id, atlasRect: d.atlasRect, rect: d.rect, layer: d.slot });
			}
		}

		const report = analyzeTextures(shape, jobs, openings);
		for (const job of jobs) {
			const r = report[job.id];
			assert.equal(r.skinPx, 0, `${shape}: ${job.id} 服装层含烘焙皮肤 ${r.skinPx}px（应为 0）`);
			// 功能性开口（领口露颈 / 手从袖口伸出，位置由骨架判定）合法；其余成片孔洞是缺陷
			assert.equal(r.defectHolesGt4, 0,
				`${shape}: ${job.id} 有 ${r.defectHolesGt4} 处非功能性开口的 >4px alpha 孔洞（功能性开口 ${r.legalHolesGt4} 处）`);
			assert.ok(r.opaquePx > 500, `${shape}: ${job.id} 不透明像素过少（${r.opaquePx}），纹理可能为空`);
			if (r.legalHolesGt4 > 0) {
				t.diagnostic(`${shape}/${job.id}: 功能性开口 alpha 洞 ${r.legalHolesGt4} 处（合法，位于领口/袖口）`);
			}
		}
	});
}
