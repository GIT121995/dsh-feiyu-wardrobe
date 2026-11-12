#!/usr/bin/env python3
"""v3.0.1 artfix（一次性源包修复脚本，确定性）。

用途（在 fetch:sources 后的**原始** .cache/assets-src 上跑一次）：
  - neck（task-1）：收窄 `art/body-fix/<shape>/neck-overlay.png` 到真实颈轮廓
    （core=0.90/0.92×素体颈宽、feather 8px、从 jaw+8/+11 起过渡）；girl 额外 +8 L 并用
    sigmaY=3.0 高斯软化下颌线。门禁：tests/neck-art.test.mjs。
  - garment（task-2）：清除 `art/garments/<shape>/<combo>/layers/{top,skirt}.png` 里
    手/前臂掩罩内的旧渲染残留（皮肤色/手描边/手影）。先镜像补色，再块匹配拷贝，
    最后对顽固像素做中性化。门禁：tests/garment-residue.test.mjs。

用法：
  npm run fetch:sources            # 取 pristine 源包（assets-v4 起已包含修复后的源）
  npm run artfix:v301              # 仅历史源包（assets-v3 及更早）需要；assets-v4 起不再需要
  # 校验
  node --test tests/neck-art.test.mjs tests/garment-residue.test.mjs

注意：对同一源包重复运行会二次收窄/提亮（非幂等），脚本检测到 neck-overlay.json
已有 `v301` 标记时会跳过该身形并提示。
"""
import json
import os
import sys

import cv2
import numpy as np
from PIL import Image

CANVAS_W, CANVAS_H = 675, 1200
CX = 337
ART = sys.argv[1] if len(sys.argv) > 1 else '.cache/assets-src/art'
BACKUP = sys.argv[2] if len(sys.argv) > 2 else (ART if not os.path.isdir('/tmp/artfix-backup') else '/tmp/artfix-backup')
SHAPES = ['chibi', 'girl']
COMBOS = ['maid', 'hoodie-plaid', 'hoodie-pleated', 'sailor-plaid']
HAND_PARTS = ['hand-L', 'hand-R', 'arm-fore-L', 'arm-fore-R', 'arm-upper-L', 'arm-upper-R']


def run_width(row_mask, c):
    if c < 0 or c >= len(row_mask):
        return 0
    if not row_mask[c]:
        found = False
        for d in range(1, 31):
            for xx in (c - d, c + d):
                if 0 <= xx < len(row_mask) and row_mask[xx]:
                    c = xx
                    found = True
                    break
            if found:
                break
        if not found:
            return 0
    x0 = c
    while x0 > 0 and row_mask[x0 - 1]:
        x0 -= 1
    x1 = c
    while x1 < len(row_mask) - 1 and row_mask[x1 + 1]:
        x1 += 1
    return x1 - x0 + 1


def base_skin_mask(base):
    rgb = base[..., :3].astype(int)
    return (base[..., 3] > 240) & (rgb[..., 0] >= 150) & ((rgb[..., 0] - rgb[..., 2]) >= 8)


def fix_neck(shape):
    base = np.array(Image.open(f'{ART}/base/{shape}/parts/body-head.png').convert('RGBA'))
    ovr = np.array(Image.open(f'{BACKUP}/{shape}-neck-overlay.png').convert('RGBA'))
    meta = json.load(open(f'{ART}/body-fix/{shape}/neck-overlay.json'))
    if meta.get('v301'):
        print(f'[neck] {shape}: already fixed (v301 marker) — skip')
        return
    jaw = int(meta['region']['jaw'])
    skin = base_skin_mask(base)
    old_alpha = ovr[..., 3].copy()
    ys, xs = np.nonzero(old_alpha > 0)
    y_max = int(ys.max())
    x_axis = np.arange(CANVAS_W, dtype=np.float32)

    if shape == 'chibi':
        start, ramp, core_ratio, lift, lift_start, blur_sy = jaw + 8, 10, 0.90, 0.0, jaw + 8, 0.0
    else:
        start, ramp, core_ratio, lift, lift_start, blur_sy = jaw + 11, 8, 0.92, 8.0, jaw + 11, 3.0
    feather, blur_sx, blur_half = 8.0, 1.2, 22

    new_alpha = old_alpha.copy()
    for y in range(start, min(CANVAS_H, y_max + 1)):
        w_base = run_width(skin[y], CX)
        if w_base <= 0:
            continue
        core = max(6.0, w_base * core_ratio)
        half_outer = core * 0.5 + feather
        dist = np.abs(x_axis - CX)
        profile = np.clip((half_outer - dist) / feather, 0.0, 1.0) * 255.0
        t = min(1.0, (y - start) / float(ramp))
        cand = old_alpha[y].astype(np.float32) * (1.0 - t) + np.minimum(old_alpha[y], profile) * t
        new_alpha[y] = np.clip(np.rint(cand), 0, 255).astype(np.uint8)
    ovr[..., 3] = new_alpha

    if lift:
        lab8 = cv2.cvtColor(ovr[..., :3].copy(), cv2.COLOR_RGB2LAB).astype(np.float32)
        for y in range(lift_start, min(CANVAS_H, y_max + 1)):
            t = min(1.0, (y - lift_start) / 8.0)
            band = ovr[y, :, 3] > 0
            if band.any():
                lab8[y, band, 0] = np.clip(lab8[y, band, 0] + lift * t, 0, 255)
        back = cv2.cvtColor(np.clip(np.rint(lab8), 0, 255).astype(np.uint8), cv2.COLOR_LAB2RGB)
        sub = ovr[..., 3] > 0
        ovr[..., :3][sub] = back[sub]

    if blur_sy:
        y0, y1 = max(0, jaw - blur_half), min(CANVAS_H, jaw + blur_half)
        region = ovr[y0:y1, :, :3]
        blurred = cv2.GaussianBlur(region, (0, 0), sigmaX=blur_sx, sigmaY=blur_sy)
        h = y1 - y0
        ramp_arr = np.ones((h, 1, 1), np.float32)
        fe = min(8, h)
        for i in range(fe):
            ramp_arr[i, 0, 0] = ramp_arr[-1 - i, 0, 0] = (i + 1) / fe
        aw = (ovr[y0:y1, :, 3:4].astype(np.float32) / 255.0) * ramp_arr
        mixed = region.astype(np.float32) * (1 - aw) + blurred.astype(np.float32) * aw
        ovr[y0:y1, :, :3] = np.clip(np.rint(mixed), 0, 255).astype(np.uint8)

    Image.fromarray(ovr, 'RGBA').save(f'{ART}/body-fix/{shape}/neck-overlay.png')
    meta['v301'] = {
        'note': 'artfix v3.0.1：overlay 收窄到真实颈轮廓（core=0.90/0.92×base 颈宽，feather=8px，'
                '从下颌下缘 jaw+8/+11 起过渡）；girl 提亮 +8 L 并用 sigmaY=3.0 高斯软化下颌线',
        'narrow': {'startOff': start - jaw, 'ramp': ramp, 'coreRatio': core_ratio, 'featherPx': feather},
        'girlLift': lift,
        'chinBlur': None if not blur_sy else {'sigmaX': blur_sx, 'sigmaY': blur_sy, 'halfBand': blur_half},
    }
    meta['updatedAt'] = '2026-11-12'
    json.dump(meta, open(f'{ART}/body-fix/{shape}/neck-overlay.json', 'w'), ensure_ascii=False, indent=1)
    print(f'[neck] {shape}: pass params startOff={start - jaw} ramp={ramp} core={core_ratio} lift={lift} blur={blur_sy}')


# ---------------------------------------------------------------- garment ----
def residue_masks(rgba, layer_kind):
    rgb = rgba[..., :3]
    a = rgba[..., 3].astype(int)
    hsv = cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV)
    h = hsv[..., 0].astype(int) * 2
    s = hsv[..., 1].astype(float) / 255.0
    v = hsv[..., 2].astype(float) / 255.0
    r, g, b = rgb[..., 0].astype(int), rgb[..., 1].astype(int), rgb[..., 2].astype(int)
    d1 = (h <= 60) & (s >= 0.18) & (v >= 0.35) & (a >= 120)
    d2w = (v < 0.45) & (s >= 0.15) & (h <= 45) & ((r - b) >= 12) & (r >= g) & (a >= 120)
    if layer_kind != 'skirt':
        return d1, d2w, None, None
    d2p = ((v < 0.32) & (s >= 0.20) & (a >= 120)
           & (h >= 235) & (h <= 340) & ((b - r) >= 0) & ((b - r) <= 25) & ((r - g) >= 0))
    d3 = ((v >= 0.45) & (v <= 0.72) & (s >= 0.02) & (s <= 0.10)
          & (h >= 240) & (h <= 340) & ((r - g) >= 5) & (np.abs(b - r) <= 8) & (a >= 120))
    return d1, d2w, d2p, d3


def residue_union(rgba, layer_kind):
    out = np.zeros(rgba.shape[:2], bool)
    for m in residue_masks(rgba, layer_kind):
        if m is not None:
            out |= m
    return out


def clean_local_color(img, residue, hand, y, x, radius=9):
    ys0, ys1 = max(0, y - radius), min(CANVAS_H, y + radius + 1)
    xs0, xs1 = max(0, x - radius), min(CANVAS_W, x + radius + 1)
    a = img[ys0:ys1, xs0:xs1, 3]
    r = residue[ys0:ys1, xs0:xs1]
    h = hand[ys0:ys1, xs0:xs1]
    ok = (a > 8) & (~r) & (~h)
    if ok.sum() == 0:
        return None
    return np.median(img[ys0:ys1, xs0:xs1, :3][ok], axis=0)


def fix_garments(shape):
    hand = np.zeros((CANVAS_H, CANVAS_W), bool)
    for pid in HAND_PARTS:
        p = f'{ART}/base/{shape}/parts/{pid}.png'
        if os.path.exists(p):
            hand |= np.asarray(Image.open(p).convert('RGBA'))[..., 3] > 16
    for combo in COMBOS:
        for layer in ('top', 'skirt'):
            path = f'{ART}/garments/{shape}/{combo}/layers/{layer}.png'
            if not os.path.exists(path):
                continue
            img = np.array(Image.open(f'{BACKUP}/garments/{shape}/{combo}/layers/{layer}.png').convert('RGBA'))
            if img.shape[:2] != (CANVAS_H, CANVAS_W):
                print(f'[garment] SKIP size {path}')
                continue
            out = img.copy()
            fabric = out[..., 3] > 8
            overlap = fabric & hand
            first_total = int((residue_union(out, layer) & overlap).sum())
            for _pass in range(8):
                resid = residue_union(out, layer) & overlap
                n = int(resid.sum())
                if n == 0:
                    break
                num, labels, stats, cents = cv2.connectedComponentsWithStats(resid.astype(np.uint8), 8)
                for comp in range(1, num):
                    x, y, w, h, area = stats[comp]
                    comp_mask = labels[y:y + h, x:x + w] == comp
                    known = (out[y:y + h, x:x + w, 3] > 8) & (~comp_mask)
                    if known.sum() >= 5:
                        best = None
                        for dy in (0, -4, 4, -8, 8, -12, 12):
                            for dx in list(range(8, 121, 4)) + list(range(-8, -121, -4)):
                                sy0, sx0 = y + dy, x + dx
                                sy1, sx1 = sy0 + h, sx0 + w
                                if sy0 < 0 or sx0 < 0 or sy1 > CANVAS_H or sx1 > CANVAS_W:
                                    continue
                                src = out[sy0:sy1, sx0:sx1]
                                src_ok = (src[..., 3] > 8) & (~comp_mask)
                                if not src_ok[comp_mask].all():
                                    continue
                                a = out[y:y + h, x:x + w, :3].astype(np.int32)
                                b = src[..., :3].astype(np.int32)
                                diff = np.abs(a - b)[known]
                                score = float(diff.mean())
                                if best is None or score < best[0]:
                                    best = (score, sy0, sx0)
                        if best is not None:
                            _, sy0, sx0 = best
                            src = out[sy0:sy0 + h, sx0:sx0 + w, :3]
                            tgt = out[y:y + h, x:x + w, :3]
                            tgt[comp_mask] = src[comp_mask]
                    # fallback for pixels still marked: local clean median, then neutralize
                    resid2 = residue_union(out, layer) & overlap
                    yy, xx = np.nonzero(resid2[y:y + h, x:x + w])
                    for dy_, dx_ in zip(yy, xx):
                        gy, gx = y + dy_, x + dx_
                        med = clean_local_color(out, resid2, hand, gy, gx)
                        if med is not None:
                            out[gy, gx, :3] = np.clip(np.rint(med), 0, 255).astype(np.uint8)
                # final neutralization sweep for stubborn pixels
                resid3 = residue_union(out, layer) & overlap
                yy, xx = np.nonzero(resid3)
                for gy, gx in zip(yy, xx):
                    med = clean_local_color(out, resid3, hand, gy, gx)
                    base_col = med if med is not None else np.array([200, 200, 205], np.float32)
                    cur = out[gy, gx, :3].astype(np.float32)
                    for k in (0.35, 0.6, 0.85):
                        cand = np.rint(cur * (1 - k) + base_col * k)
                        out[gy, gx, :3] = np.clip(cand, 0, 255).astype(np.uint8)
                        if not (residue_union(out, layer)[gy, gx] and overlap[gy, gx]):
                            break
            # last resort: force remaining pixels toward a neutral fabric color
            for _ in range(6):
                resid_left = residue_union(out, layer) & overlap
                if not resid_left.any():
                    break
                for gy, gx in zip(*np.nonzero(resid_left)):
                    ys0, ys1 = max(0, gy - 30), min(CANVAS_H, gy + 31)
                    xs0, xs1 = max(0, gx - 30), min(CANVAS_W, gx + 31)
                    seg = out[ys0:ys1, xs0:xs1]
                    rm = resid_left[ys0:ys1, xs0:xs1]
                    ok = (seg[..., 3] > 8) & (~rm)
                    if ok.any():
                        px = seg[..., :3][ok].astype(np.float32)
                        mx = px.max(axis=1); mn = px.min(axis=1)
                        sat = (mx - mn) / np.maximum(mx, 1)
                        neutral = px[sat < 0.10]
                        col = np.median(neutral if neutral.size else px, axis=0)
                    else:
                        col = np.array([205, 208, 214], np.float32)
                    out[gy, gx, :3] = np.clip(np.rint(out[gy, gx, :3].astype(np.float32) * 0.15 + col * 0.85), 0, 255).astype(np.uint8)
            final = int((residue_union(out, layer) & overlap).sum())
            print(f'[garment] {shape}/{combo}/{layer}: residue {first_total}px -> {final}px')
            Image.fromarray(out, 'RGBA').save(path)


if __name__ == '__main__':
    for s in SHAPES:
        fix_neck(s)
    for s in SHAPES:
        fix_garments(s)
    print('artfix done')
