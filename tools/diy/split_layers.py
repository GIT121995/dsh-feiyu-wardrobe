#!/usr/bin/env python3
"""DIY 宿主侧自动成层（split）：把 M1 浏览器算法（docs/dress-up/diy-layers.js）移植到纯 Python。

宿主无浏览器依赖：输入 look / flatout（Seedream 2 张，同姿势）+ 身形参考掩膜 hair/arms，
输出 675×1200 的「衣身层 / 袖子层」（PNG，RGB 取自 look、alpha 为成层结果）+ QA JSON。

算法与浏览器版同口径（diff 自适应阈值 40→9、fill-under-hair 行级反投影、拆袖（arms∩alpha−手部）、
羽化、拓扑半分辨率加速、自动 QA）。纯 Pillow + numpy，无 cv2/浏览器。

用法：
  python3 tools/diy/split_layers.py --look gen/look.png --flatout gen/flatout.png \
      --hair docs/dress-up/art/diy/masks/chibi/hair.webp \
      --arms docs/dress-up/art/diy/masks/chibi/arms.webp \
      --category top --out layers/
输出：layers/body.png、layers/sleeve.png（可能不存在）、layers/split.json（QA）。
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np
from PIL import Image

W, H = 675, 1200
CANVAS_AREA = W * H
SUPPORTED = ('top', 'bottom', 'dress', 'coat', 'outfit')
SLEEVE_CATEGORIES = {'top', 'dress', 'coat', 'outfit'}
DIFF_THRESHOLDS = [40, 30, 22, 16, 12, 9]
ALPHA_AREA_RANGE = (0.004, 0.32)
SLEEVE_MIN_FRAC = 0.002
WHITE_FRINGE_MAX = 0.05
MAX_POSE_SHIFT_PX = 2.0
DEFAULT_OPTIONS = {
    'headFraction': 0.36,
    'diffThreshold': 0,
    'closeRadius': 7,
    'lookFgThreshold': 245,
    'featherRadius': 1,
    'armsDilate': 6,
}


# ------------------------------------------------------------------ helpers ---
def load_rgba(path: Path, resize=True) -> np.ndarray:
    img = Image.open(path).convert('RGBA')
    if resize and img.size != (W, H):
        img = img.resize((W, H), Image.LANCZOS)
    return np.asarray(img, dtype=np.uint8)


def _windows(mask: np.ndarray, radius: int, axis: int) -> np.ndarray:
    """可分离窗口计数（dilate: >0；erode: ==window 大小）；输出与输入同 shape。"""
    if radius <= 0:
        return mask.astype(np.int32)
    n = mask.shape[axis]
    pad = [(0, 0), (0, 0)]
    pad[axis] = (radius, radius)
    padded = np.pad(mask.astype(np.int32), pad, mode='constant')
    c = np.cumsum(padded, axis=axis)
    zshape = list(c.shape)
    zshape[axis] = 1
    c = np.concatenate([np.zeros(zshape, np.int32), c], axis=axis)
    hi = [slice(None), slice(None)]
    lo = [slice(None), slice(None)]
    hi[axis] = slice(2 * radius + 1, 2 * radius + 1 + n)
    lo[axis] = slice(0, n)
    return c[tuple(hi)] - c[tuple(lo)]


def dilate(mask: np.ndarray, radius: int) -> np.ndarray:
    if radius <= 0:
        return mask.astype(np.uint8).copy()
    h = _windows(mask, radius, 1)
    v = _windows(h > 0, radius, 0)
    return (v > 0).astype(np.uint8)


def erode(mask: np.ndarray, radius: int) -> np.ndarray:
    if radius <= 0:
        return mask.astype(np.uint8).copy()
    h = _windows(mask, radius, 1) == 2 * radius + 1
    v = _windows(h, radius, 0) == 2 * radius + 1
    return v.astype(np.uint8)


def close_mask(mask: np.ndarray, radius: int) -> np.ndarray:
    return erode(dilate(mask, radius), radius)


def fill_holes(mask: np.ndarray) -> np.ndarray:
    """填充不接触画布边界的 0 区域（扫描线 flood fill，移植自 diy-layers.js 的 fillHolesMask）。"""
    h, w = mask.shape
    m = mask.astype(np.uint8)
    outside = np.zeros((h, w), dtype=np.uint8)
    stack = []

    def push_span(x: int, y: int) -> None:
        if y < 0 or y >= h or m[y, x] or outside[y, x]:
            return
        x1 = x
        while x1 > 0 and not m[y, x1 - 1] and not outside[y, x1 - 1]:
            x1 -= 1
        x2 = x
        while x2 < w - 1 and not m[y, x2 + 1] and not outside[y, x2 + 1]:
            x2 += 1
        outside[y, x1:x2 + 1] = 1
        stack.append((x1, x2, y))

    for x in range(w):
        if not m[0, x]:
            push_span(x, 0)
        if not m[h - 1, x]:
            push_span(x, h - 1)
    for y in range(h):
        push_span(0, y)
        push_span(w - 1, y)
    while stack:
        x1, x2, y = stack.pop()
        for ny in (y - 1, y + 1):
            if ny < 0 or ny >= h:
                continue
            row = outside[ny]
            for x in range(x1, x2 + 1):
                if not m[ny, x] and not row[x]:
                    push_span(x, ny)
    return (m | (1 - outside)).astype(np.uint8)


def keep_large_components(mask: np.ndarray, min_area: int) -> np.ndarray:
    """保留面积 ≥ min_area 的 8 连通块（BFS）。"""
    h, w = mask.shape
    m = mask.astype(np.uint8)
    labels = np.zeros((h, w), dtype=np.int32)
    out = np.zeros((h, w), dtype=np.uint8)
    label = 0
    for y0 in range(h):
        for x0 in range(w):
            if not m[y0, x0] or labels[y0, x0]:
                continue
            label += 1
            stack = [(y0, x0)]
            labels[y0, x0] = label
            cells = []
            while stack:
                y, x = stack.pop()
                cells.append((y, x))
                for dy in (-1, 0, 1):
                    for dx in (-1, 0, 1):
                        ny, nx = y + dy, x + dx
                        if dy == 0 and dx == 0:
                            continue
                        if ny < 0 or ny >= h or nx < 0 or nx >= w:
                            continue
                        if m[ny, nx] and not labels[ny, nx]:
                            labels[ny, nx] = label
                            stack.append((ny, nx))
            if len(cells) >= min_area:
                ys = np.array([c[0] for c in cells])
                xs = np.array([c[1] for c in cells])
                out[ys, xs] = 1
    return out


def blur_box(alpha: np.ndarray, radius: int) -> np.ndarray:
    """0–255 alpha 的可分离盒式模糊（与 JS blurAlpha 同口径）。"""
    a = alpha.astype(np.float32)
    if radius <= 0:
        return alpha.astype(np.uint8).copy()
    r = int(radius)
    # 水平
    pad = np.pad(a, ((0, 0), (r, r)), mode='edge')
    c = np.cumsum(pad, axis=1)
    width = np.minimum(np.arange(a.shape[1]) + r, a.shape[1] + r - 1) - np.maximum(np.arange(a.shape[1]) - r, 0) + 1
    hsum = c[:, 2 * r:2 * r + a.shape[1]] - np.concatenate([np.zeros((a.shape[0], 1), np.float32), c[:, :-2 * r - 1]], axis=1)
    tmp = hsum / width[None, :]
    pad2 = np.pad(tmp, ((r, r), (0, 0)), mode='edge')
    c2 = np.cumsum(pad2, axis=0)
    height = np.minimum(np.arange(a.shape[0]) + r, a.shape[0] + r - 1) - np.maximum(np.arange(a.shape[0]) - r, 0) + 1
    vsum = c2[2 * r:2 * r + a.shape[0], :] - np.concatenate([np.zeros((1, a.shape[1]), np.float32), c2[:-2 * r - 1, :]], axis=0)
    return vsum / height[:, None]


def feather_alpha(alpha: np.ndarray, radius: int) -> np.ndarray:
    blurred = blur_box(alpha, max(1, radius))
    out = blurred * 1.05 - 6
    return np.clip(out, 0, 255).astype(np.uint8)


def alpha_to_mask(alpha: np.ndarray) -> np.ndarray:
    return (alpha > 127).astype(np.uint8)


def diff_map(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    return np.abs(a[:, :, :3].astype(np.int16) - b[:, :, :3].astype(np.int16)).max(axis=2).astype(np.uint8)


def foreground_mask(rgba: np.ndarray, threshold: int = 245) -> np.ndarray:
    rgb = rgba[:, :, :3].astype(np.uint8)
    raw = (rgb.min(axis=2) < threshold).astype(np.uint8)
    return fill_holes(raw)


def mask_bounds(mask: np.ndarray):
    ys, xs = np.where(mask)
    if len(xs) == 0:
        return None
    return {'x0': int(xs.min()), 'y0': int(ys.min()), 'x1': int(xs.max()) + 1, 'y1': int(ys.max()) + 1,
            'width': int(xs.max() - xs.min() + 1), 'height': int(ys.max() - ys.min() + 1), 'count': int(len(xs))}


def pose_registration(look_fg: np.ndarray, flat_fg: np.ndarray) -> dict:
    ys, xs = np.where(look_fg)
    fy, fx = np.where(flat_fg)
    if len(xs) == 0 or len(fx) == 0:
        return {'shiftPx': 0, 'dx': 0, 'dy': 0, 'iou': 0, 'ok': False}
    dx = float(fx.mean() - xs.mean())
    dy = float(fy.mean() - ys.mean())
    inter = int((look_fg & flat_fg).sum())
    union = int((look_fg | flat_fg).sum())
    return {'shiftPx': round(float(np.hypot(dx, dy)), 2), 'dx': round(dx, 2), 'dy': round(dy, 2),
            'iou': round(inter / union, 4) if union else 0, 'ok': True}


def downsample_mask(mask: np.ndarray) -> np.ndarray:
    h, w = mask.shape
    hw, hh = max(1, w >> 1), max(1, h >> 1)
    m = mask[: hh * 2, : hw * 2].reshape(hh, 2, hw, 2)
    return (m.sum(axis=(1, 3)) >= 2).astype(np.uint8)


def downsample_diff(diff: np.ndarray) -> np.ndarray:
    h, w = diff.shape
    hw, hh = max(1, w >> 1), max(1, h >> 1)
    m = diff[: hh * 2, : hw * 2].reshape(hh, 2, hw, 2)
    return m.max(axis=(1, 3)).astype(np.uint8)


def upsample_alpha(alpha_half: np.ndarray, hw: int, hh: int) -> np.ndarray:
    """双线性上采样 half→675×1200（与 JS upsampleAlpha 的像素中心口径一致）。"""
    y = np.arange(H, dtype=np.float32)
    x = np.arange(W, dtype=np.float32)
    sy = (y + 0.5) * (hh / H) - 0.5
    sx = (x + 0.5) * (hw / W) - 0.5
    sy = np.clip(sy, 0, hh - 1)
    sx = np.clip(sx, 0, hw - 1)
    y0 = np.floor(sy).astype(np.int32)
    x0 = np.floor(sx).astype(np.int32)
    y1 = np.minimum(hh - 1, y0 + 1)
    x1 = np.minimum(hw - 1, x0 + 1)
    fy = (sy - y0)[:, None]
    fx = (sx - x0)[None, :]
    a = alpha_half.astype(np.float32)
    top = a[y0][:, x0] * (1 - fx) + a[y0][:, x1] * fx
    bottom = a[y1][:, x0] * (1 - fx) + a[y1][:, x1] * fx
    return top * (1 - fy) + bottom * fy


def edge_band(mask: np.ndarray) -> np.ndarray:
    band = np.zeros_like(mask, dtype=np.uint8)
    dx = mask[:, :-1] != mask[:, 1:]
    dy = mask[:-1, :] != mask[1:, :]
    band[:, :-1] |= dx
    band[:, 1:] |= dx
    band[:-1, :] |= dy
    band[1:, :] |= dy
    return band


def skin_mask(look: np.ndarray) -> np.ndarray:
    r = look[:, :, 0].astype(np.int16)
    g = look[:, :, 1].astype(np.int16)
    b = look[:, :, 2].astype(np.int16)
    lum = (r + g + b) / 3.0
    return ((r - g > 6) & (g - b > -8) & (r > 200) & (lum > 165)).astype(np.uint8)


def hand_region_mask(look: np.ndarray, arms: np.ndarray, dilate_radius: int = 5) -> np.ndarray:
    bounds = mask_bounds(arms)
    geom = np.zeros_like(arms, dtype=np.uint8)
    if bounds is None:
        return geom
    cut_y = bounds['y0'] + int(bounds['height'] * 0.78)
    low_y = bounds['y0'] + int(bounds['height'] * 0.55)
    skin = skin_mask(look)
    raw = np.zeros_like(arms, dtype=np.uint8)
    raw[cut_y:bounds['y1'], bounds['x0']:bounds['x1']] = arms[cut_y:bounds['y1'], bounds['x0']:bounds['x1']]
    band = (arms & skin)[low_y:bounds['y1'], bounds['x0']:bounds['x1']]
    raw[low_y:bounds['y1'], bounds['x0']:bounds['x1']] = np.maximum(
        raw[low_y:bounds['y1'], bounds['x0']:bounds['x1']], band)
    grown = dilate(raw, dilate_radius)
    return (grown & arms).astype(np.uint8)


def fill_under_hair_rows(alpha: np.ndarray, hair: np.ndarray, keep: np.ndarray | None) -> tuple[np.ndarray, int]:
    h, w = alpha.shape
    out = alpha.copy()
    filled = 0
    for y in range(h):
        row_alpha = alpha[y]
        left = int(np.argmax(row_alpha > 0)) if row_alpha.any() else -1
        if left < 0:
            continue
        right = int(w - 1 - np.argmax(row_alpha[::-1] > 0))
        if right <= left:
            continue
        for x in range(left + 1, right):
            if not hair[y, x] or out[y, x]:
                continue
            if keep is not None and not keep[y, x]:
                continue
            out[y, x] = 1
            filled += 1
    return out, filled


def split_sleeve_alpha(look, alpha_mask, arms, body_alpha, arms_dilate=6):
    grown = dilate(arms, arms_dilate)
    hand = hand_region_mask(look, arms, 0)
    sleeve = np.zeros((H, W), dtype=np.uint8)
    mask = grown.astype(bool) & ~hand.astype(bool)
    sleeve[mask] = body_alpha[mask]
    covered = int((sleeve > 20).sum())
    frac = covered / CANVAS_AREA
    if frac < SLEEVE_MIN_FRAC:
        return None
    return blur_box(sleeve, 1).astype(np.uint8), frac


def choose_threshold(diff_half: np.ndarray, region: dict) -> dict:
    # 与 JS 同口径：分数以「降采样后画布面积」为分母（diy-layers.js chooseThreshold 的 width*height）
    half_area = diff_half.shape[0] * diff_half.shape[1]
    fallback = {'threshold': 9, 'frac': 0.0}
    for threshold in DIFF_THRESHOLDS:
        count = int((diff_half[region['y0']:region['y1'], region['x0']:region['x1']] > threshold).sum())
        frac = count / half_area
        if threshold == 9:
            fallback = {'threshold': threshold, 'frac': frac}
        if 0.03 <= frac <= 0.25:
            return {'threshold': threshold, 'frac': frac}
    return fallback


def classify_garment_color(look: np.ndarray, mask: np.ndarray) -> dict:
    sel = mask.astype(bool)
    count = int(sel.sum())
    if count == 0:
        return {'white': False, 'meanRgb': [0, 0, 0], 'nearWhiteFrac': 0}
    rgb = look[:, :, :3][sel]
    near = ((rgb.min(axis=1) > 215) & ((rgb.max(axis=1) - rgb.min(axis=1)) < 35)).sum()
    return {'white': bool(near / count > 0.5),
            'meanRgb': [int(round(v)) for v in rgb.mean(axis=0)],
            'nearWhiteFrac': round(float(near / count), 3)}


# -------------------------------------------------------------------- main ---
def extract(look: np.ndarray, flatout: np.ndarray, hair: np.ndarray, arms: np.ndarray,
            category: str, options: dict | None = None) -> dict:
    t0 = time.time()
    opts = dict(DEFAULT_OPTIONS)
    if options:
        opts.update(options)
    if category not in SUPPORTED:
        return {'ok': False, 'reason': 'category_unsupported', 'category': category}
    hair_mask = alpha_to_mask(hair[:, :, 3])
    arms_mask = alpha_to_mask(arms[:, :, 3])

    look_fg = foreground_mask(look, opts['lookFgThreshold'])
    flat_fg = foreground_mask(flatout, opts['lookFgThreshold'])
    pose = pose_registration(look_fg, flat_fg)

    diff = diff_map(look, flatout)
    diff_half = downsample_diff(diff)
    hh, hw = diff_half.shape

    hair_half = downsample_mask(hair_mask)
    arms_half = downsample_mask(arms_mask)
    look_fg_half = downsample_mask(look_fg)
    hair_half_d = dilate(hair_half, 3)
    hair_half_d2 = dilate(hair_half, 2)
    look_fg_half_grown = dilate(look_fg_half, 3)

    margin = max(4, int(round(hw * 0.02)))
    hb = mask_bounds(look_fg_half)
    region = {
        'x0': max(0, hb['x0'] - margin) if hb else 0,
        'y0': int(round(hh * opts['headFraction'])),
        'x1': min(hw, hb['x1'] + margin) if hb else hw,
        'y1': min(hh, int(round(hh * 0.99))),
    }
    chosen = {'threshold': opts['diffThreshold'], 'frac': 0.0} if opts['diffThreshold'] > 0 else choose_threshold(diff_half, region)
    threshold = chosen['threshold']
    raw = np.zeros((hh, hw), dtype=np.uint8)
    sub = (diff_half[region['y0']:region['y1'], region['x0']:region['x1']] > threshold) & \
          ~hair_half_d[region['y0']:region['y1'], region['x0']:region['x1']].astype(bool)
    raw[region['y0']:region['y1'], region['x0']:region['x1']] = sub.astype(np.uint8)
    raw_count = int(raw.sum())
    if raw_count / (hw * hh) < 0.002:
        return {'ok': False, 'reason': 'garment_not_found', 'category': category}

    filled = fill_holes(raw)
    mask = close_mask(filled, max(2, int(round(opts['closeRadius'] / 2))))
    mask = fill_holes(mask)
    mask = keep_large_components(mask, 125)
    mask = (mask & look_fg_half_grown).astype(np.uint8)
    mask = fill_holes(mask)
    mask_before_fill = mask.copy()
    mask_area = int(mask.sum())
    if (mask_area * 4) / CANVAS_AREA > ALPHA_AREA_RANGE[1]:
        return {'ok': False, 'reason': 'too_large', 'category': category}

    under_hair, filled_under_hair = fill_under_hair_rows(mask, hair_half_d, look_fg_half)
    alpha_half = fill_holes(under_hair)
    alpha_area = int(alpha_half.sum())
    if (alpha_area * 4) / CANVAS_AREA < ALPHA_AREA_RANGE[0]:
        return {'ok': False, 'reason': 'garment_not_found', 'category': category}

    upsampled = upsample_alpha(alpha_half.astype(np.float32) * 255.0, hw, hh)
    upsampled_bin = (upsampled > 127).astype(np.uint8)
    band = edge_band(upsampled_bin)
    gate_lo = threshold * 0.5
    gate_span = max(1.0, threshold * 0.6)
    gate = np.clip((diff.astype(np.float32) - gate_lo) / gate_span, 0, 1)
    upsampled = np.where(band.astype(bool), np.minimum(upsampled, 255.0 * gate), upsampled)
    body_alpha = feather_alpha(np.clip(upsampled, 0, 255).astype(np.uint8), opts['featherRadius'])

    sleeve_alpha = None
    sleeve_frac = 0.0
    if category in SLEEVE_CATEGORIES:
        sleeve = split_sleeve_alpha(look, alpha_to_mask(upsampled.astype(np.uint8)), arms_mask, body_alpha, opts['armsDilate'])
        if sleeve:
            sleeve_alpha, sleeve_frac = sleeve

    # QA（与浏览器版同口径）
    alpha_bin = alpha_to_mask(body_alpha)
    hole_filled = fill_holes(alpha_half)
    alpha_hole_half = int(((hole_filled == 1) & (alpha_half == 0) & (hair_half_d2 == 0)).sum())
    alpha_hole_px = alpha_hole_half * 4
    white = 0
    band_inside = 0
    for y, x in zip(*np.where((body_alpha >= 200) & band.astype(bool))):
        band_inside += 1
        r, g, b = look[y, x, 0], look[y, x, 1], look[y, x, 2]
        if r > 238 and g > 238 and b > 238:
            white += 1
    white_fringe_frac = (white / band_inside) if band_inside else 0.0
    bg_residue_half = int(((alpha_half == 1) & (look_fg_half_grown == 0)).sum())
    arms_half_d = dilate(arms_half, 2)
    missing_half = int(((mask_before_fill == 1) & (hair_half_d == 0) & (arms_half_d == 0) & (alpha_half == 0)).sum())
    garment_color = classify_garment_color(look, alpha_bin)
    qa = {
        'alphaMode': 'flatout_diff',
        'threshold': threshold,
        'alphaAreaFrac': round((alpha_area * 4) / CANVAS_AREA, 4),
        'alphaHolePx': int(alpha_hole_px),
        'missingGarmentPx': int(missing_half * 4),
        'bgResiduePx': int(bg_residue_half * 4),
        'whiteFringeFrac': round(float(white_fringe_frac), 4),
        'poseShiftPx': pose['shiftPx'],
        'poseIou': pose['iou'],
        'sleevePresent': sleeve_alpha is not None,
        'sleeveAreaFrac': round(float(sleeve_frac), 4),
        'garmentColor': garment_color,
        'fillUnderHairPx': int(filled_under_hair * 4),
        'timingMs': int(round((time.time() - t0) * 1000)),
    }
    defects = []
    if qa['alphaHolePx'] > 50:
        defects.append(f"alpha 洞 {qa['alphaHolePx']}px > 50")
    if qa['missingGarmentPx'] > 50:
        defects.append(f"缺衣/露底 {qa['missingGarmentPx']}px > 50")
    if qa['bgResiduePx'] > 200:
        defects.append(f"背景残留 {qa['bgResiduePx']}px > 200")
    if not garment_color['white'] and qa['whiteFringeFrac'] > WHITE_FRINGE_MAX:
        defects.append(f"白边/洗白 {qa['whiteFringeFrac'] * 100:.0f}% > 5%")
    if pose['shiftPx'] > MAX_POSE_SHIFT_PX:
        defects.append(f"同姿势配准 {pose['shiftPx']}px > 2px")
    if not (ALPHA_AREA_RANGE[0] <= qa['alphaAreaFrac'] <= ALPHA_AREA_RANGE[1]):
        defects.append(f"alpha 面积 {qa['alphaAreaFrac'] * 100:.1f}% 超出范围")
    hard_fail = qa['alphaHolePx'] > 4000 or qa['missingGarmentPx'] > 8000 or qa['alphaAreaFrac'] > ALPHA_AREA_RANGE[1]
    grade = 'fail' if hard_fail else ('needs-fix' if defects else 'pass')
    return {'ok': True, 'category': category, 'bodyAlpha': body_alpha, 'sleeveAlpha': sleeve_alpha,
            'qa': qa, 'grade': grade, 'defects': defects, 'pose': pose}


def write_layer(path: Path, look: np.ndarray, alpha: np.ndarray) -> None:
    out = np.dstack([look[:, :, :3], alpha.astype(np.uint8)])
    Image.fromarray(out, 'RGBA').save(path)


def main() -> int:
    ap = argparse.ArgumentParser(description='DIY 宿主侧自动成层（Python 移植 M1 split 算法）')
    ap.add_argument('--look', required=True)
    ap.add_argument('--flatout', required=True)
    ap.add_argument('--hair', required=True)
    ap.add_argument('--arms', required=True)
    ap.add_argument('--category', required=True, choices=SUPPORTED)
    ap.add_argument('--out', required=True)
    ap.add_argument('--diff-threshold', type=int, default=0)
    args = ap.parse_args()
    try:
        look = load_rgba(Path(args.look))
        flatout = load_rgba(Path(args.flatout))
        hair = load_rgba(Path(args.hair))
        arms = load_rgba(Path(args.arms))
    except FileNotFoundError as exc:
        print(json.dumps({'ok': False, 'reason': 'input_missing', 'message': str(exc)}, ensure_ascii=False))
        return 2
    result = extract(look, flatout, hair, arms, args.category, {'diffThreshold': args.diff_threshold})
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    payload = {'ok': result['ok'], 'category': args.category}
    if not result['ok']:
        payload['reason'] = result.get('reason', 'split_failed')
        payload['grade'] = 'fail'
        (out / 'split.json').write_text(json.dumps(payload, ensure_ascii=False, indent=1) + '\n')
        print(json.dumps(payload, ensure_ascii=False))
        return 1
    write_layer(out / 'body.png', look, result['bodyAlpha'])
    if result['sleeveAlpha'] is not None:
        write_layer(out / 'sleeve.png', look, result['sleeveAlpha'])
    else:
        (out / 'sleeve.png').unlink(missing_ok=True)
    payload.update({'grade': result['grade'], 'defects': result['defects'], 'qa': result['qa'],
                    'pose': result['pose'], 'hasSleeve': result['sleeveAlpha'] is not None})
    (out / 'split.json').write_text(json.dumps(payload, ensure_ascii=False, indent=1) + '\n')
    print(json.dumps(payload, ensure_ascii=False))
    return 0 if result['grade'] != 'fail' else 1


if __name__ == '__main__':
    sys.exit(main())
