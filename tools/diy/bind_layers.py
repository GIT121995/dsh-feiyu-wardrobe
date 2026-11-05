#!/usr/bin/env python3
"""DIY 宿主侧自动绑定（bind）：DIY 分层 PNG → **增量 DIY outfit pack**（S3 运行时合并用）。

输入：
  --layers <dir>      split_layers.py 输出：body.png（必需）、sleeve.png（可选）
  --base-rig <path>   production 2.5D rig（docs/dress-up/art/2d5/<shape>/rig.json）
  --item-id <id>      形如 diy-g1-shirt-20261104
  --category top|bottom|dress|coat|outfit
  --out <dir>         输出 pack 目录（diy-pack.json + tex/*.webp + bind-report.json）

输出增量 pack（不复制 base rig）：
  diy-pack.json = { format:'feiyu-diy-pack', formatVersion:1, item, name, shape, category,
                    base:{rigFormat,shape,skeletonBones,rigVersion},
                    drawables:[{id,slot,z,role,texture,texSize,rect,mesh{positions,uvs,bones,weights,deform,indices}}],
                    outfits:{diy-<item>:{name,topBody:[],sleeve:[],bottom:[]}, ...},
                    pairing:{...} }
  tex/<id>-body.webp / tex/<id>-sleeve.webp（lossless，裁到 alpha bbox+2px）
  bind-report.json（覆盖率/顶点数/alpha 清理/耗时；qa 阶段读这个）

算法与 S1 spike 一致（与官方 rig_chibi_v2 同口径）：alpha 清理 → bbox 网格/UV → core/arm/skirt
位置权重场（≤4 骨/顶点）→ 复用 base rig 既有 skirtP/skirtM 物理链（不新增骨骼，59 骨同构）→
槽位/z/outfit 组合。纯 Pillow + numpy。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import time
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

W, H = 675, 1200
CX = 337.5
MIN_COMPONENT_PX = 180
FILL_HOLE_PX = 80
CELL = {'topBody': 10.0, 'sleeve': 8.0, 'bottom': 9.0, 'topUnder': 10.0}
CATEGORY_ROLES = {
    'top': {'body': ('topBody', 40.0, CELL['topBody'], 'skirted'), 'sleeve': True},
    'coat': {'body': ('topBody', 45.0, CELL['topBody'], 'skirted'), 'sleeve': True},
    'dress': {'body': ('topBody', 40.0, CELL['topBody'], 'skirted'), 'sleeve': True},
    'outfit': {'body': ('topBody', 40.0, CELL['topBody'], 'skirted'), 'sleeve': True},
    'bottom': {'body': ('bottom', 30.0, CELL['bottom'], 'skirted'), 'sleeve': False},
}
PAIRING = {
    'top': {'topBody': [], 'sleeve': [], 'bottom': ['bottom-plaid'], 'topUnder': []},
    'coat': {'topBody': [], 'sleeve': [], 'bottom': ['bottom-plaid'], 'topUnder': []},
    'bottom': {'topBody': ['sweater-body'], 'sleeve': ['sweater-sleeve'], 'bottom': [], 'topUnder': []},
    'dress': {'topBody': [], 'sleeve': [], 'bottom': [], 'topUnder': []},
    'outfit': {'topBody': [], 'sleeve': [], 'bottom': [], 'topUnder': []},
}

# outfit 槽位（v2.2 cutout：topBody/bottom/sleeve 之外新增 collar/sleeveUpper/sleeveFore；legacy sleeve 保留）
PAIR_SLOTS = ('topBody', 'sleeve', 'bottom', 'topUnder', 'collar', 'sleeveUpper', 'sleeveFore')
# 用哪套 base 组合做配对（v2.2 有 sweater-plaid 上下装配件；旧 rig 回退 PAIRING 常量）
PAIR_REFERENCE_OUTFITS = ('sweater-plaid', 'sweater-pleated', 'maid', 'sailor-plaid')


def derive_pairing(base_rig: dict, category: str) -> tuple[dict, dict]:
    """从 base rig 的可用组合套装里取配对部件（v2.2 cutout），不再写死 v2.1 id。

    - top/coat/dress/outfit：配对下装（避免 DIY 上衣/裙装光腿）；不配 base 上衣（DIY 自己提供）。
    - bottom：配对 base 上衣/领/袖部件（避免 DIY 下装裸上身）。
    - 目标部件必须真实存在于 base rig drawables；否则放弃并返回 warning（QA 可发现）。
    - 保留 legacy `sleeve` 槽位：若 base rig 组合里有 sleeve 部件则一并作为配对。
    """
    outfits = base_rig.get('outfits') or {}
    drawable_slot = {d.get('id'): d.get('slot') for d in base_rig.get('drawables') or []}
    candidates = [oid for oid in PAIR_REFERENCE_OUTFITS if oid in outfits]
    candidates += [oid for oid in outfits if oid not in candidates]
    warnings: list[str] = []
    for outfit_id in candidates:
        outfit = outfits.get(outfit_id) or {}
        slots = {}
        for slot in PAIR_SLOTS:
            slots[slot] = [did for did in (outfit.get(slot) or []) if did in drawable_slot]
        if category in ('top', 'coat', 'dress', 'outfit'):
            if slots.get('bottom'):
                pairing = {slot: [] for slot in PAIR_SLOTS}
                pairing['bottom'] = slots['bottom'][:]
                return pairing, {'source': f'base-rig:{outfit_id}', 'warnings': warnings}
        else:  # bottom
            if slots.get('topBody'):
                pairing = {slot: [] for slot in PAIR_SLOTS}
                for slot in ('topBody', 'collar', 'sleeveUpper', 'sleeveFore', 'sleeve', 'topUnder'):
                    pairing[slot] = slots.get(slot, [])[:]
                return pairing, {'source': f'base-rig:{outfit_id}', 'warnings': warnings}
    warnings.append('no_base_pair_outfit')
    return json.loads(json.dumps(PAIRING[category])), {'source': 'legacy-static', 'warnings': warnings}
FORMAT = 'feiyu-diy-pack'
FORMAT_VERSION = 1
GENERATOR = 'dsh-feiyu-diy/2.1.0'


# ------------------------------------------------------------------ weights --
def clamp(v, a, b):
    return a if v < a else b if v > b else v


def smoothstep(a, b, x):
    t = clamp((x - a) / (b - a) if b != a else 0.0, 0.0, 1.0)
    return t * t * (3 - 2 * t)


def lerp(a, b, t):
    return a + (b - a) * t


def core_weights(x, y):
    head = 1.0 - smoothstep(550, 600, y)
    neck = (1.0 - head) * (1.0 - smoothstep(575, 620, y))
    chest = (1.0 - head - neck) * (1.0 - smoothstep(640, 700, y))
    spine = (1.0 - head - neck - chest) * (1.0 - smoothstep(730, 800, y))
    hips = max(0.0, 1.0 - head - neck - chest - spine)
    w = {'head': head, 'neck': neck, 'chest': chest, 'spine': spine, 'hips': hips}
    w = {k: v for k, v in w.items() if v > 1e-4}
    hw = w.pop('head', 0.0)
    if hw:
        w['neck'] = w.get('neck', 0.0) + hw * 0.45
        w['chest'] = w.get('chest', 0.0) + hw * 0.55
    return w


def arm_weights(x, y):
    side = 'L' if x < CX else 'R'
    ua, fa, hd = f'upperArm{side}', f'forearm{side}', f'hand{side}'
    if y < 615:
        f = smoothstep(560, 625, y)
        return {ua: 0.5 + 0.5 * f, 'chest': 0.5 * (1 - f)}
    if y < 725:
        f = smoothstep(680, 745, y)
        return {ua: 1 - 0.5 * f, fa: 0.5 * f}
    if y < 845:
        f = smoothstep(805, 860, y)
        return {fa: 1 - 0.5 * f, hd: 0.5 * f}
    return {hd: 1.0}


class ChainMeta:
    def __init__(self, rig):
        self.chains = {}
        for p in rig.get('physics', []):
            self.chains[p['id']] = {'ids': p['chain'], 'nodes': p['nodes'], 'parent': p['parent']}

    def chain_param(self, points, x, y):
        best = (1e9, 0.0)
        total = 0.0
        segs = []
        for i in range(len(points) - 1):
            x0, y0 = points[i]
            x1, y1 = points[i + 1]
            ln = math.hypot(x1 - x0, y1 - y0)
            segs.append((x0, y0, x1, y1, ln, total))
            total += ln
        for x0, y0, x1, y1, ln, acc in segs:
            dx, dy = x1 - x0, y1 - y0
            L2 = dx * dx + dy * dy or 1e-9
            t = clamp(((x - x0) * dx + (y - y0) * dy) / L2, 0.0, 1.0)
            px, py = x0 + dx * t, y0 + dy * t
            d = math.hypot(x - px, y - py)
            if d < best[0]:
                best = (d, (acc + ln * t) / (total or 1))
        return best[1], best[0]

    def bone_weights(self, cname, t):
        ids = self.chains[cname]['ids']
        centers = [(i + 0.5) / len(ids) for i in range(len(ids))]
        ws = {}
        for bid, c in zip(ids, centers):
            g = math.exp(-((t - c) ** 2) / (2 * 0.17 ** 2))
            if g > 0.02:
                ws[bid] = g
        s = sum(ws.values()) or 1
        return {k: v / s for k, v in ws.items()}

    def skirt_weights(self, x, y, cfg):
        wy, hy = cfg['waist_y'], cfg['hem_y']
        prefix = cfg['prefix']
        t = clamp((y - wy) / (hy - wy), 0.0, 1.0)
        attach = smoothstep(0.02, 0.28, t)
        halfw = lerp(cfg['waist_x1'] - cfg['waist_x0'], cfg['hem_x1'] - cfg['hem_x0'], t) / 2
        u = clamp((x - CX) / max(halfw, 20), -1.15, 1.15)
        f = clamp((u + 1) / 2 * 5, 0.0, 5.0)
        i0 = int(math.floor(f))
        i1 = min(5, i0 + 1)
        fr = f - i0
        w = {'hips': 1 - attach * 0.94}
        for idx, share in ((i0, 1 - fr), (i1, fr)):
            if share < 0.02:
                continue
            for bid, bw in self.bone_weights(f'{prefix}{idx}', t).items():
                w[bid] = w.get(bid, 0.0) + attach * 0.94 * share * bw
        return w


# ------------------------------------------------------------------- layers --
def load_layer(path: Path) -> np.ndarray:
    return np.asarray(Image.open(path).convert('RGBA'), dtype=np.uint8)


def clean_alpha(alpha: np.ndarray) -> tuple[np.ndarray, dict]:
    """去 diff 残留小块 + 回填小洞（与 S1/官方 QA 同口径的保守清理）。"""
    import cv2  # 仅在宿主构建期使用；测试环境无 cv2 时优雅退化

    mask = (alpha > 8).astype(np.uint8)
    n, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    if n <= 1:
        raise RuntimeError('empty garment alpha')
    areas = stats[1:, cv2.CC_STAT_AREA]
    keep = [i + 1 for i, area in enumerate(areas) if area >= MIN_COMPONENT_PX]
    keep.sort(key=lambda i: -stats[i, cv2.CC_STAT_AREA])
    if keep:
        largest = stats[keep[0], cv2.CC_STAT_AREA]
        keep = [i for i in keep if stats[i, cv2.CC_STAT_AREA] >= max(MIN_COMPONENT_PX, 0.02 * largest)]
    out = np.zeros_like(mask)
    for i in keep:
        out[labels == i] = 1
    holes = cv2.morphologyEx(out, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    holes = (holes > 0) & (out == 0)
    nh, hl, hs, _ = cv2.connectedComponentsWithStats(holes.astype(np.uint8), connectivity=8)
    filled = 0
    for i in range(1, nh):
        if hs[i, cv2.CC_STAT_AREA] <= FILL_HOLE_PX:
            out[hl == i] = 1
            filled += int(hs[i, cv2.CC_STAT_AREA])
    cleaned = (out.astype(np.float32) * (alpha / 255.0)).astype(np.float32)
    return cleaned, {'components': len(keep), 'removedComponents': int(n - 1 - len(keep)),
                     'removedPx': int(((alpha > 8) & (out == 0)).sum()), 'filledHolePx': filled}


def derive_skirt_cfg(alpha: np.ndarray, long_form: bool) -> dict:
    ys, xs = np.where(alpha > 0.08)
    y0, y1 = int(ys.min()), int(ys.max())
    waist_y = int(clamp(y0 + 6, 600, 760)) if not long_form else int(
        clamp(655 if y0 < 655 else y0 + 4, 600, 760))
    hem_y = max(waist_y + 80, y1 - 2)

    def band(ya, yb):
        m = (ys >= ya) & (ys <= yb)
        if m.sum() < 20:
            return int(xs.min()), int(xs.max())
        return int(np.percentile(xs[m], 5)), int(np.percentile(xs[m], 95))

    waist_x0, waist_x1 = band(y0, y0 + max(10, int((y1 - y0) * 0.12)))
    hem_x0, hem_x1 = band(y1 - max(10, int((y1 - y0) * 0.12)), y1)
    return {'waist_y': waist_y, 'hem_y': hem_y, 'waist_x0': waist_x0, 'waist_x1': waist_x1,
            'hem_x0': hem_x0, 'hem_x1': hem_x1, 'prefix': 'skirtP'}


def build_mesh(alpha: np.ndarray, cell: float, weight_fn) -> tuple[list, list, list]:
    ys_all, xs_all = np.where(alpha > 0.05)
    if len(xs_all) == 0:
        raise RuntimeError('empty layer alpha')
    x0, x1 = max(0, int(xs_all.min()) - 2), min(W, int(xs_all.max()) + 3)
    y0, y1 = max(0, int(ys_all.min()) - 2), min(H, int(ys_all.max()) + 3)
    gx = max(1, int(round((x1 - x0) / cell)))
    gy = max(1, int(round((y1 - y0) / cell)))
    xs = [x0 + (x1 - x0) * i / gx for i in range(gx + 1)]
    ys = [y0 + (y1 - y0) * j / gy for j in range(gy + 1)]
    cells = []
    for j in range(gy):
        for i in range(gx):
            keep = False
            for sy in (0.2, 0.5, 0.8):
                for sx in (0.2, 0.5, 0.8):
                    px = int(xs[i] + (xs[i + 1] - xs[i]) * sx)
                    py = int(ys[j] + (ys[j + 1] - ys[j]) * sy)
                    if 0 <= px < W and 0 <= py < H and alpha[py, px] > 24 / 255:
                        keep = True
                        break
                if keep:
                    break
            if keep:
                cells.append((i, j))
    if not cells:
        raise RuntimeError('no mesh cells')
    positions, uvs, indices = [], [], []
    vmap = {}

    def vid(i, j):
        if (i, j) not in vmap:
            vmap[(i, j)] = len(positions)
            positions.append([xs[i], ys[j]])
            uvs.append([xs[i] / W, ys[j] / H])
        return vmap[(i, j)]

    for i, j in cells:
        a, b, c, d = vid(i, j), vid(i + 1, j), vid(i + 1, j + 1), vid(i, j + 1)
        indices += [a, b, c, a, c, d]
    return positions, uvs, indices, cells


def bind_drawable(meta: ChainMeta, bone_index: dict, alpha: np.ndarray, cell: float, weight_fn) -> dict:
    positions, uvs, indices, cells = build_mesh(alpha, cell, weight_fn)
    vert_bones, vert_weights, deform = [], [], []
    for (x, y) in positions:
        w = weight_fn(x, y)
        items = sorted(w.items(), key=lambda kv: -kv[1])[:4]
        s = sum(v for _, v in items) or 1
        items = [(k, v / s) for k, v in items if v / s > 1e-4]
        s = sum(v for _, v in items) or 1
        items = [(k, v / s) for k, v in items]
        vert_bones.append([bone_index[k] for k, _ in items] + [0] * (4 - len(items)))
        vert_weights.append([round(v, 4) for _, v in items] + [0.0] * (4 - len(items)))
        hw = sum(v for k, v in items if k == 'head')
        cw = sum(v for k, v in items if k in ('chest', 'spine'))
        deform.append([round(min(1.0, hw), 4), round(min(1.0, cw * 0.9), 4)])
    mesh = {
        'positions': [[round(p[0], 2), round(p[1], 2)] for p in positions],
        'uvs': [[round(u[0], 5), round(u[1], 5)] for u in uvs],
        'bones': vert_bones, 'weights': vert_weights, 'deform': deform,
        'indices': indices, 'cell': cell,
    }
    return {'mesh': mesh, 'verts': len(positions), 'tris': len(indices) // 3, 'cells': cells}


def crop_texture(alpha: np.ndarray, rgba: np.ndarray, mesh: dict, out_path: Path) -> dict:
    ys, xs = np.where(alpha > 0.05)
    x0, y0 = max(0, int(xs.min()) - 2), max(0, int(ys.min()) - 2)
    x1, y1 = min(W, int(xs.max()) + 3), min(H, int(ys.max()) + 3)
    crop = rgba[y0:y1, x0:x1].copy()
    tw, th = x1 - x0, y1 - y0
    Image.fromarray(crop, 'RGBA').save(out_path, format='WEBP', lossless=True, quality=100, method=6, exact=True)
    for i, (x, y) in enumerate(mesh['positions']):
        mesh['uvs'][i] = [round((x - x0) / tw, 5), round((y - y0) / th, 5)]
    return {'rect': [x0, y0, x1, y1], 'texSize': [tw, th]}


def raster_coverage(mesh: dict, alpha: np.ndarray) -> dict:
    img = Image.new('L', (W, H), 0)
    draw = ImageDraw.Draw(img)
    pos = mesh['positions']
    idx = mesh['indices']
    for k in range(0, len(idx), 3):
        tri = [tuple(pos[idx[k]]), tuple(pos[idx[k + 1]]), tuple(pos[idx[k + 2]])]
        draw.polygon(tri, fill=255)
    mesh_mask = np.asarray(img) > 127
    alpha_mask = alpha > 0.5
    inter = int((mesh_mask & alpha_mask).sum())
    union = int((mesh_mask | alpha_mask).sum()) or 1
    alpha_area = int(alpha_mask.sum())
    mesh_area = int(mesh_mask.sum())
    return {'coverageIoU': round(inter / union, 4),
            'alphaCovered': round(inter / alpha_area, 4) if alpha_area else 0.0,
            'meshOvershoot': round((mesh_area - inter) / mesh_area, 4) if mesh_area else 1.0,
            'meshAreaPx': mesh_area, 'alphaAreaPx': alpha_area,
            'alphaAreaFrac': round(float(alpha_mask.mean()), 4)}


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()[:16]


def bind(layers_dir: Path, base_rig_path: Path, item_id: str, category: str, name: str,
         out_dir: Path) -> dict:
    t0 = time.time()
    if category not in CATEGORY_ROLES:
        raise RuntimeError(f'unsupported_category:{category}')
    role_cfg = CATEGORY_ROLES[category]
    base_rig = json.loads(base_rig_path.read_text())
    bones = base_rig['skeleton']['bones']
    bone_index = {b['id']: i for i, b in enumerate(bones)}
    meta = ChainMeta(base_rig)

    body_rgba = load_layer(layers_dir / 'body.png')
    body_alpha, clean_stats = clean_alpha(body_rgba[:, :, 3])
    sleeve_path = layers_dir / 'sleeve.png'
    sleeve = None
    if role_cfg['sleeve'] and sleeve_path.exists():
        sleeve_rgba = load_layer(sleeve_path)
        sleeve_alpha, sleeve_stats = clean_alpha(sleeve_rgba[:, :, 3])
        if np.any(sleeve_alpha > 0.05):
            sleeve = (sleeve_rgba, sleeve_alpha, sleeve_stats)

    body_role, body_z, body_cell, _ = role_cfg['body']
    ys = np.where(body_alpha > 0.08)[0]
    needs_skirt = bool(len(ys) and ys.max() > 690) or category in ('dress', 'outfit', 'bottom')
    skirt_cfg = derive_skirt_cfg(body_alpha, long_form=category in ('bottom', 'dress', 'outfit')) if needs_skirt else None
    weight_body = (lambda x, y: meta.skirt_weights(x, y, skirt_cfg)
                   if skirt_cfg and y > skirt_cfg['waist_y'] else core_weights(x, y))

    out_dir.mkdir(parents=True, exist_ok=True)
    tex_dir = out_dir / 'tex'
    tex_dir.mkdir(exist_ok=True)
    drawables = []
    body_id = f'{item_id}-body'
    body_bind = bind_drawable(meta, bone_index, body_alpha, body_cell, weight_body)
    body_map = crop_texture(body_alpha, body_rgba, body_bind['mesh'], tex_dir / f'{body_id}.webp')
    drawables.append({'id': body_id, 'slot': body_role, 'z': body_z, 'role': body_role,
                      'texture': f'tex/{body_id}.webp', 'mesh': body_bind['mesh'], **body_map})
    sleeve_id = None
    sleeve_verts = 0
    if sleeve is not None:
        sleeve_rgba, sleeve_alpha, sleeve_stats = sleeve
        sleeve_mesh = bind_drawable(meta, bone_index, sleeve_alpha, CELL['sleeve'], arm_weights)
        sleeve_id = f'{item_id}-sleeve'
        sz = 61.0 if category == 'coat' else 60.0
        sleeve_map = crop_texture(sleeve_alpha, sleeve_rgba, sleeve_mesh['mesh'], tex_dir / f'{sleeve_id}.webp')
        drawables.append({'id': sleeve_id, 'slot': 'sleeve', 'z': sz, 'role': 'sleeve',
                          'texture': f'tex/{sleeve_id}.webp', 'mesh': sleeve_mesh['mesh'], **sleeve_map})
        sleeve_verts = sleeve_mesh['verts']

    pairing, pairing_meta = derive_pairing(base_rig, category)
    outfit = {slot: pairing.get(slot, [])[:] for slot in PAIR_SLOTS}
    outfit['name'] = name
    # body_role 即 topBody/bottom/topUnder；DIY 主体放在该槽位最前
    outfit[body_role].insert(0, body_id)
    if sleeve_id:
        outfit['sleeve'].append(sleeve_id)

    coverage = raster_coverage(body_bind['mesh'], body_alpha)
    pack = {
        'format': FORMAT, 'formatVersion': FORMAT_VERSION, 'generator': GENERATOR,
        'item': item_id, 'name': name, 'shape': 'chibi', 'category': category,
        'base': {'rigFormat': base_rig.get('format', '2d5-rig'), 'shape': base_rig.get('shape', 'chibi'),
                 'skeletonBones': len(bones), 'boneNames': [b['id'] for b in bones],
                 'skeletonVersion': base_rig.get('version'), 'rigVersion': base_rig.get('version'),
                 'ref': f'docs/dress-up/art/2d5/{base_rig.get("shape", "chibi")}/rig.json'},
        'drawables': drawables,
        'outfits': {item_id: outfit},
        'pairing': pairing,
        'pairingSource': pairing_meta.get('source'),
        'createdAt': None,
    }
    report = {
        'ok': True, 'item': item_id, 'category': category, 'shape': 'chibi',
        'drawables': [{'id': d['id'], 'slot': d['slot'], 'z': d['z'], 'texSize': d['texSize'],
                       'rect': d['rect'], 'verts': len(d['mesh']['positions']),
                       'tris': len(d['mesh']['indices']) // 3,
                       'textureBytes': (out_dir / d['texture']).stat().st_size} for d in drawables],
        'sleeve': bool(sleeve_id), 'sleeveVerts': sleeve_verts,
        'skirtCfg': skirt_cfg, 'coverage': coverage,
        'alphaClean': {'body': clean_stats, 'sleeve': sleeve[2] if sleeve else None},
        'pairing': pairing,
        'pairingSource': pairing_meta.get('source'),
        'pairingWarnings': pairing_meta.get('warnings') or [],
        'bindMs': None,
    }
    pack['bind'] = report
    bind_ms = int(round((time.time() - t0) * 1000))
    report['bindMs'] = bind_ms
    (out_dir / 'diy-pack.json').write_text(json.dumps(pack, ensure_ascii=False, separators=(',', ':')) + '\n')
    (out_dir / 'bind-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=1) + '\n')
    return report


def validate(pack_dir: Path) -> list[str]:
    """宿主侧结构校验；返回错误列表（空 = 通过）。"""
    errors = []
    try:
        pack = json.loads((pack_dir / 'diy-pack.json').read_text())
    except FileNotFoundError:
        return ['pack_missing']
    if pack.get('format') != FORMAT or pack.get('formatVersion') != FORMAT_VERSION:
        errors.append('bad_format')
    bones = int(pack.get('base', {}).get('skeletonBones', 0))
    if bones <= 0:
        errors.append('bad_skeleton_bones')
    seen = set()
    for d in pack.get('drawables', []):
        for key in ('id', 'slot', 'z', 'mesh', 'texture', 'rect', 'texSize'):
            if key not in d:
                errors.append(f'drawable_missing:{d.get("id", "?")}:{key}')
        if d.get('id') in seen:
            errors.append(f'drawable_duplicate:{d.get("id")}')
        seen.add(d.get('id'))
        tex = pack_dir / d.get('texture', '')
        if not tex.is_file():
            errors.append(f'texture_missing:{d.get("id")}')
        mesh = d.get('mesh', {})
        n = len(mesh.get('positions', []))
        if n == 0:
            errors.append(f'mesh_empty:{d.get("id")}')
            continue
        if len(mesh.get('uvs', [])) != n or len(mesh.get('bones', [])) != n or len(mesh.get('weights', [])) != n:
            errors.append(f'mesh_attr_length:{d.get("id")}')
        if len(mesh.get('indices', [])) % 3 != 0:
            errors.append(f'mesh_indices:{d.get("id")}')
        for u, v in mesh.get('uvs', [])[:100000]:
            if not (0.0 <= u <= 1.0 and 0.0 <= v <= 1.0):
                errors.append(f'uv_out_of_range:{d.get("id")}')
                break
        for idx in mesh.get('indices', []):
            if not (0 <= idx < n):
                errors.append(f'index_out_of_range:{d.get("id")}')
                break
        for bones_row, weights_row in zip(mesh.get('bones', []), mesh.get('weights', [])):
            if len(bones_row) != 4 or len(weights_row) != 4:
                errors.append(f'four_influence:{d.get("id")}')
                break
            if any(b < 0 or b >= bones for b in bones_row):
                errors.append(f'bone_out_of_range:{d.get("id")}')
                break
            if abs(sum(weights_row) - 1.0) > 0.01:
                errors.append(f'weights_not_normalized:{d.get("id")}')
                break
        tw, th = d.get('texSize', [0, 0])
        img = Image.open(tex)
        if list(img.size) != [tw, th]:
            errors.append(f'texsize_mismatch:{d.get("id")}')
    outfits = pack.get('outfits', {})
    if not outfits:
        errors.append('outfit_missing')
    for name, outfit in outfits.items():
        if not any(outfit.get(slot) for slot in ('topBody', 'bottom', 'topUnder')):
            errors.append(f'outfit_empty:{name}')
        if not name.startswith('diy-'):
            errors.append(f'outfit_bad_name:{name}')
    return errors


def main() -> int:
    ap = argparse.ArgumentParser(description='DIY 宿主侧自动绑定（增量 outfit pack）')
    ap.add_argument('--layers', required=True)
    ap.add_argument('--base-rig', required=True)
    ap.add_argument('--item-id', required=True)
    ap.add_argument('--category', required=True, choices=sorted(CATEGORY_ROLES))
    ap.add_argument('--name', default='')
    ap.add_argument('--out', required=True)
    args = ap.parse_args()
    try:
        report = bind(Path(args.layers), Path(args.base_rig), args.item_id, args.category,
                      args.name or args.item_id, Path(args.out))
    except Exception as exc:  # noqa: BLE001 - CLI 边界统一转 JSON
        print(json.dumps({'ok': False, 'reason': 'bind_failed', 'message': str(exc)}, ensure_ascii=False))
        return 1
    errors = validate(Path(args.out))
    if errors:
        print(json.dumps({'ok': False, 'reason': 'bind_validate_failed', 'errors': errors}, ensure_ascii=False))
        return 1
    print(json.dumps({'ok': True, 'item': report['item'], 'category': report['category'],
                      'verts': sum(d['verts'] for d in report['drawables']),
                      'tris': sum(d['tris'] for d in report['drawables']),
                      'coverage': report['coverage'], 'bindMs': report['bindMs']}, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
