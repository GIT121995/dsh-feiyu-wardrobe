#!/usr/bin/env python3
"""换装 3.0 素材构建：v0.7 分层换装（素体 + 衣服图层 + 头发叠层）。

输入目录（默认 .scratch/feiyu-gen/raw12）里按命名约定存放：
  base-bandeau-<shape>.png           素体（白色无肩带连体衣，1152×2048，纯白背景）
  <shape>-only-<cat>-<id>.png        单件穿着 look（同一素体上生成，构图一致）
  <shape>-whiteout-<cat>-<id>.png    白底单件图（取衣服调色板用）

处理：
  1. 素体：白底→透明，premultiplied 缩放到 675×1200 WebP；
  2. 头发/尾巴叠层：从素体做 CV 颜色分割（蓝发 + 深色描边），单独一层（z=100，画在最上面）；
  3. 衣服图层：直接从「单件穿着 look」抠图（位置/合身度 100% 正确）：
       - 浅色衣服：线稿灌水（多 seed）+ 平涂色块区域生长（补领口/袖口/罗纹）
       - 彩色衣服：look 与素体的像素差主连通块 + 填洞
       - 再做大核闭运算补掉「头发在衣服上划出的细通道」，保证衣服完整
       - 保留头发处的小洞/缺口：由最上层头发叠层补回（头发永远在衣服前）
  4. 统一 premultiplied 缩放到 675×1200，写 WebP；
  5. 重建 manifest.json（v5）+ 悬浮鲸鱼兜底图 art/pet-default.webp；
  6. 生成 QA 拼图到 --qa-dir（默认 ../../.scratch/feiyu-art/）。

依赖：pillow + numpy + opencv-python（仅构建用，运行时不依赖）。

用法:
  python3 tools/build_wardrobe.py --src /home/ubuntu/dsh/.scratch/feiyu-gen/raw12 --out docs/dress-up
  python3 tools/build_wardrobe.py --shape chibi      # 只构建一个身形（调试）
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
TARGET = (675, 1200)
GLOBAL = TARGET[0] / 1152.0

SHAPES = [('chibi', 'Q版', '大头小身子的可爱版本'), ('girl', '少女版', '六头身的少女比例')]

# 内容基调：养女儿向 / 保守——套装只保留最保守的经典女仆装（长袖长裙 + 围裙）
# 其余礼服类（抹胸/蕾丝/大裙摆）已从 v0.8.0 移除
DRESSES = [
    ('maid', '经典女仆装', '她本来的样子。'),
]
TOPS = [
    ('sweater', '白色高领毛衣', '软乎乎的，像一条围巾。'),
    ('hoodie', '白色连帽卫衣', '宽宽松松，把自己藏进去。'),
    ('sailor', '水手服上衣', '海风味的日常。'),
]
BOTTOMS = [
    ('plaid', '格纹百褶裙', '校园里最普通也最好看的那条。'),
    ('pleated', '深蓝百褶裙', '转一圈，裙摆会开成花。'),
]

# 每件单品的抠图策略：
#   flood = 线稿灌水 + 平涂色块区域生长（浅色衣服）
#   diff  = 与素体像素差主块 + 填洞（彩色衣服）
#   thr   = diff 阈值（浅色礼服可调低）
LAYER_PLAN = {
    # 上装：单独生成时 AI 会把上衣画大/画长，且 look 里的白色素体会被 diff 灌水带进来；
    # 统一走「白底单件图 + 形状 IoU 配准」——图层只含衣服本体，位置/大小由配准决定。
    ('top', 'sweater'): {'mode': 'whiteout', 'target_frac': {'chibi': 0.57, 'girl': 0.46}},
    ('top', 'hoodie'): {'mode': 'whiteout', 'target_frac': {'chibi': 0.57, 'girl': 0.46}},
    # 水手服：AI 抠图时把深色水手领/蝴蝶结画得比衬衫主体大，直接用整体 alpha 配准会被拉小，
    # 改成只拿「衬衫的浅色主体」做形状配准（probe），再套用到整件衣服。
    ('top', 'sailor'): {'mode': 'whiteout', 'target_frac': {'chibi': 0.57, 'girl': 0.46},
                        'align_probe': 'light', 'extra_scale': {'chibi': 1.0, 'girl': 0.95}},
    # 下装：同样走 whiteout 配准；单独生成时裙子偏短，按「衣服顶部中点」锚定放大，
    # 保证上衣下摆之下还能露出明显裙摆（组合模式好看）。
    ('bottom', 'plaid'): {'mode': 'whiteout', 'extra_scale': {'chibi': 1.72, 'girl': 1.40}},
    ('bottom', 'pleated'): {'mode': 'whiteout', 'extra_scale': {'chibi': 1.72, 'girl': 1.40}},
    # 连衣裙：直接对 look 做 diff 主块 matte（v1/v2 两轮 QA 已确认位置/大小正确）
    ('dress', 'maid'): {'mode': 'diff', 'thr': 30},
}
# 图层 z 序：下装在下、上装在上（毛衣/卫衣下摆盖住裙腰）
Z_ORDER = {'bottom': 20, 'top': 30, 'dress': 30}

BACKGROUNDS = [
    ('bg-snow', '冬夜街道', '暖黄色的路灯，和一直下的雪。', 0.86),
    ('bg-sakura', '樱花庭院', '走过小桥，花瓣落了一路。', 0.88),
    ('bg-starry', '银河原野', '抬头是整条银河。', 0.9),
    ('bg-forest', '晨光森林', '雾还没散，花已经开了。', 0.88),
    ('bg-cyber', '霓虹街区', '雨后的路面，倒映着一整条街的灯。', 0.86),
    ('bg-cafe', '雪日咖啡馆', '窗外在下雪，热可可刚好。', 0.92),
]
ICON_SOURCES = {
    'maid': 'maid-dress.png',
    'sweater': 'top-sweater.png',
    'hoodie': 'top-hoodie.png',
    'sailor': 'top-sailor.png',
    'plaid': 'bottom-plaid.png',
    'pleated': 'bottom-pleated.png',
}
EFFECTS = [
    ('none', '无', '安安静静。', '🌙'),
    ('snow', '飘雪', '一直一直下雪。', '❄️'),
    ('petals', '花瓣', '风一吹，花瓣就落下来。', '🌸'),
    ('stars', '星光', '四周浮着小小的光。', '✨'),
]
BUBBLES = [
    '今天也要好好吃饭呀。',
    '换好衣服啦，可以出门玩了吗？',
    '这件裙子转起来，像一朵小花。',
    '你回来啦！我等你好久了。',
    '这个背景好漂亮，像画一样。',
    '一起在窗边坐一会儿吧。',
    '鱼粮我都收好啦，没有乱花。',
    '拍立绘卡的时候，记得把我拍得可爱一点。',
    '今天的天气，适合出去走走。',
    '要是每天都能和你一起玩就好了。',
]
CREDITS = ('立绘 / 服装：本项目用 Seedream 5.0（火山方舟）基于自建素体生成 · '
           '角色参考：大肥鱼社区二创（仅作风格参考，未直接使用原画）· 非官方，禁止商用')


# ---------------------------------------------------------------- 通用图像工具

def load_rgb(path: Path) -> np.ndarray:
    return np.asarray(Image.open(path).convert('RGB')).astype(np.int16)


def remove_white_alpha(rgb: np.ndarray, thresh: int = 26) -> np.ndarray:
    """纯白背景 → 透明（从四角 floodfill，固定阈值）。返回 alpha 0-255。"""
    im = np.clip(rgb, 0, 255).astype(np.uint8)
    h, w = im.shape[:2]
    probe = im.copy()
    for corner in [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)]:
        if int(probe[corner[1], corner[0]].sum()) < 700:
            continue
        cv2.floodFill(probe, None, corner, (255, 0, 255), (thresh,) * 3, (thresh,) * 3,
                      cv2.FLOODFILL_FIXED_RANGE)
    bg = np.all(probe == np.array([255, 0, 255], np.uint8), axis=2)
    return ((~bg).astype(np.uint8)) * 255


def fill_holes(mask: np.ndarray) -> np.ndarray:
    inv = (1 - mask).astype(np.uint8)
    ff = inv.copy()
    fm = np.zeros((inv.shape[0] + 2, inv.shape[1] + 2), np.uint8)
    cv2.floodFill(ff, fm, (0, 0), 2)
    holes = ((inv == 1) & (ff != 2)).astype(np.uint8)
    return cv2.bitwise_or(mask, holes)


def keep_largest(mask: np.ndarray) -> np.ndarray:
    """只保留最大连通块（去掉头发抖动等零碎噪声）。"""
    m = (mask > 0).astype(np.uint8)
    n, lab, stats, _ = cv2.connectedComponentsWithStats(m, 8)
    if n <= 1:
        return mask
    main = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    return (lab == main).astype(np.uint8) * 255


def resize_rgba(rgb: np.ndarray, alpha: np.ndarray, size=TARGET) -> tuple[np.ndarray, np.ndarray]:
    """premultiplied 缩放：避免「白色背景色被插值进半透明边缘」形成灰边。"""
    a = alpha.astype(np.float32) / 255.0
    rgbp = np.clip(rgb, 0, 255).astype(np.float32) * a[..., None]
    rgb2 = cv2.resize(rgbp, size, interpolation=cv2.INTER_AREA)
    a2 = np.clip(cv2.resize(a, size, interpolation=cv2.INTER_AREA), 0, 1)
    safe = np.maximum(a2, 1e-4)[..., None]
    out = np.where(a2[..., None] > 0.004, rgb2 / safe, 0.0)
    return np.clip(out, 0, 255), (a2 * 255)


def save_webp(rgb: np.ndarray, alpha: np.ndarray, path: Path, quality: int = 88) -> None:
    """原子写（先写 .tmp 再 os.replace），避免游戏页在构建过程中读到半截图。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    rgba = np.dstack([np.clip(rgb, 0, 255).astype(np.uint8), np.clip(alpha, 0, 255).astype(np.uint8)])
    tmp = path.with_name(path.name + '.tmp')
    Image.fromarray(rgba).save(tmp, 'WEBP', quality=quality, method=6)
    os.replace(tmp, path)


def save_thumb(src_rgb: np.ndarray, src_alpha: np.ndarray, path: Path, size: int = 200) -> None:
    """衣服图标：清晰裁切 + 居中。"""
    ys, xs = np.nonzero(src_alpha > 40)
    if len(ys) == 0:
        return
    rgb = src_rgb[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
    a = src_alpha[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
    ratio = min((size - 18) / a.shape[1], (size - 18) / a.shape[0])
    nw, nh = max(1, round(a.shape[1] * ratio)), max(1, round(a.shape[0] * ratio))
    rgb = cv2.resize(np.clip(rgb, 0, 255).astype(np.uint8), (nw, nh), interpolation=cv2.INTER_AREA)
    a = cv2.resize(a, (nw, nh), interpolation=cv2.INTER_AREA)
    canvas = np.zeros((size, size, 4), np.uint8)
    x0, y0 = (size - nw) // 2, (size - nh) // 2
    canvas[y0:y0 + nh, x0:x0 + nw, :3] = rgb
    canvas[y0:y0 + nh, x0:x0 + nw, 3] = a
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(canvas).save(path, 'WEBP', quality=88, method=6)


# ---------------------------------------------------------------- 头发 / 尾巴叠层

def hair_front_mask(base: np.ndarray) -> np.ndarray:
    """素体「前面的头发」alpha：蓝色发丝/耳鳍/呆毛 + 它们的深色描边。

    只保留与头部相连的蓝色连通块（按 bbox 顶部位置判断），**不含鲸鱼尾巴**——
    尾巴在身体后面，应该被衣服盖住，不能画到最上层。
    """
    r, g, b = base[:, :, 0], base[:, :, 1], base[:, :, 2]
    lum = base.mean(axis=2)
    blue = ((b - r > 18) & (b - g > 6) & (b > 40)).astype(np.uint8)
    body = (np.abs(base - 255).max(axis=2) > 25)
    ys, xs = np.nonzero(body)
    by0, by1 = float(ys.min()), float(ys.max())
    n, lab, stats, _ = cv2.connectedComponentsWithStats(blue, 8)
    kept = np.zeros_like(blue)
    for i in range(1, n):
        if stats[i, cv2.CC_STAT_AREA] < 150:
            continue
        top_frac = (stats[i, cv2.CC_STAT_TOP] - by0) / max(by1 - by0, 1)
        if top_frac > 0.45:  # 只保留头部/上身连着的头发（排除尾巴、下摆碎块）
            continue
        kept[lab == i] = 1
    near_blue = cv2.dilate(kept, np.ones((5, 5), np.uint8)) > 0
    overlay = (kept > 0) | ((lum < 100) & near_blue)
    ov = overlay.astype(np.uint8)
    n, lab, stats, _ = cv2.connectedComponentsWithStats(ov, 8)
    out = np.zeros_like(ov)
    for i in range(1, n):
        if stats[i, cv2.CC_STAT_AREA] >= 200:
            out[lab == i] = 1
    box = np.zeros_like(body)
    box[ys.min():ys.max() + 1, xs.min():xs.max() + 1] = True
    return (out.astype(bool) & box).astype(np.uint8) * 255


def extract_overlay(base: np.ndarray) -> np.ndarray:
    """兼容旧名字：头发叠层 == hair_front_mask。"""
    return hair_front_mask(base)


# ---------------------------------------------------------------- 衣服抠图（matte）

def flat_regions(look: np.ndarray, line_thr: int = 112):
    lum = look.mean(axis=2)
    line = cv2.dilate((lum < line_thr).astype(np.uint8), np.ones((2, 2), np.uint8))
    n, lab, stats, cent = cv2.connectedComponentsWithStats((1 - line), 4)
    regions = []
    for i in range(1, n):
        area = int(stats[i, cv2.CC_STAT_AREA])
        if area < 30:
            continue
        m = lab == i
        regions.append({'id': i, 'area': area, 'mean': np.clip(look[m].mean(axis=0), 0, 255),
                        'centroid': cent[i],
                        'bbox': (stats[i, cv2.CC_STAT_LEFT], stats[i, cv2.CC_STAT_TOP],
                                 stats[i, cv2.CC_STAT_WIDTH], stats[i, cv2.CC_STAT_HEIGHT])})
    return lab, regions


def flood_regions(look: np.ndarray, band: tuple[float, float]) -> list[np.ndarray]:
    """多 seed 线稿灌水，返回候选区域（已填洞，按面积降序，最多 3 个）。"""
    lum = look.mean(axis=2)
    line = cv2.dilate((lum < 112).astype(np.uint8), np.ones((2, 2), np.uint8))
    free = (1 - line).astype(np.uint8)
    h, w = free.shape
    cands: list[tuple[int, np.ndarray]] = []
    for fy in np.arange(0.30, 0.86, 0.04):
        for fx in (0.42, 0.46, 0.50, 0.54, 0.58):
            sx, sy = int(w * fx), int(h * fy)
            if not free[sy, sx]:
                continue
            ff = free.copy()
            m = np.zeros((h + 2, w + 2), np.uint8)
            cv2.floodFill(ff, m, (sx, sy), 2)
            reg = (ff == 2).astype(np.uint8)
            area = int(reg.sum())
            if area < 4000 or area > 0.32 * w * h:
                continue
            ys, xs = np.nonzero(reg)
            if xs.min() <= 2 or ys.min() <= 2 or xs.max() >= w - 3 or ys.max() >= h - 3:
                continue
            if not (band[0] <= (ys.min() + ys.max()) / 2 / h <= band[1]):
                continue
            reg = fill_holes(reg)
            if any(np.logical_and(reg, o).sum() / max(np.logical_or(reg, o).sum(), 1) > 0.85 for _, o in cands):
                continue
            cands.append((area, reg))
    cands.sort(key=lambda t: t[0], reverse=True)
    return [r for _, r in cands[:3]]


def diff_comps(look: np.ndarray, base: np.ndarray, thr: int = 30, min_area: int = 1200):
    strong = (np.abs(look - base).max(axis=2) > thr).astype(np.uint8)
    strong = cv2.morphologyEx(strong, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
    n, lab, stats, cent = cv2.connectedComponentsWithStats(strong, 8)
    comps = []
    for i in range(1, n):
        area = int(stats[i, cv2.CC_STAT_AREA])
        if area < min_area:
            continue
        comps.append({'id': i, 'area': area, 'mask': (lab == i).astype(np.uint8),
                      'centroid': cent[i],
                      'mean': np.clip(look[lab == i].mean(axis=0), 0, 255),
                      'bbox': (stats[i, cv2.CC_STAT_LEFT], stats[i, cv2.CC_STAT_TOP],
                               stats[i, cv2.CC_STAT_WIDTH], stats[i, cv2.CC_STAT_HEIGHT])})
    comps.sort(key=lambda c: c['area'], reverse=True)
    return comps


def _bbox_overlap(a, b, pad: int = 15) -> bool:
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    return not (ax + aw < bx - pad or ax > bx + bw + pad or ay + ah < by - pad or ay > by + bh + pad)


def close_fill(mask: np.ndarray, kernel_size: int = 31, max_grow: int = 14) -> np.ndarray:
    """填洞 + 大核闭运算（补掉头发在衣服上划出的细通道）+ 限制外扩。"""
    f = fill_holes(mask)
    if f.sum() == 0:
        return f
    closed = cv2.morphologyEx(f.astype(np.uint8), cv2.MORPH_CLOSE, np.ones((kernel_size, kernel_size), np.uint8))
    filled = fill_holes(closed)
    limit = cv2.dilate(f.astype(np.uint8), np.ones((max_grow * 2 + 1, max_grow * 2 + 1), np.uint8))
    return fill_holes((filled & (limit > 0)).astype(np.uint8))



# ---------------------------------------------------------------- 白底单件图（whiteout）配准

def whiteout_alpha(im: np.ndarray, thresh: int = 26) -> np.ndarray:
    """白底单件图 → 前景 alpha（只保留最大块及邻近块 + 填内部小洞）。"""
    rgb = np.clip(im, 0, 255).astype(np.uint8)
    h, w = rgb.shape[:2]
    probe = rgb.copy()
    for corner in [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)]:
        if int(probe[corner[1], corner[0]].sum()) < 700:
            continue
        cv2.floodFill(probe, None, corner, (255, 0, 255), (thresh,) * 3, (thresh,) * 3,
                      cv2.FLOODFILL_FIXED_RANGE)
    bg = np.all(probe == np.array([255, 0, 255], np.uint8), axis=2)
    alpha = ((~bg).astype(np.uint8)) * 255
    n, lab, stats, cent = cv2.connectedComponentsWithStats(alpha, 8)
    if n <= 1:
        return alpha
    areas = stats[1:, cv2.CC_STAT_AREA]
    main = 1 + int(np.argmax(areas))
    x0, y0, ww, hh = (stats[main, cv2.CC_STAT_LEFT], stats[main, cv2.CC_STAT_TOP],
                      stats[main, cv2.CC_STAT_WIDTH], stats[main, cv2.CC_STAT_HEIGHT])
    out = np.zeros_like(alpha)
    for i in range(1, n):
        if stats[i, cv2.CC_STAT_AREA] < 200:
            continue
        xa, ya = stats[i, cv2.CC_STAT_LEFT], stats[i, cv2.CC_STAT_TOP]
        xb, yb = xa + stats[i, cv2.CC_STAT_WIDTH], ya + stats[i, cv2.CC_STAT_HEIGHT]
        if xb < x0 - 30 or xa > x0 + ww + 30 or yb < y0 - 30 or ya > y0 + hh + 30:
            continue
        out[lab == i] = 255
    return fill_holes((out > 0).astype(np.uint8)).astype(np.uint8) * 255


def palette_of(wo: np.ndarray, wa: np.ndarray, k: int = 6, sample: int = 20000) -> np.ndarray:
    gp = np.clip(wo, 0, 255).astype(np.uint8)[wa > 127].reshape(-1, 3)
    gp = gp[(np.abs(gp.astype(np.int16) - 255).max(axis=1) > 18)]
    if len(gp) < 300:
        return np.array([[250, 248, 245]], np.float32)
    step = max(1, len(gp) // sample)
    s = gp[::step].astype(np.float32)
    crit = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 20, 1.0)
    _, labels, centers = cv2.kmeans(s, k, None, crit, 3, cv2.KMEANS_PP_CENTERS)
    counts = np.bincount(labels.reshape(-1), minlength=k)
    return centers[counts > len(s) * 0.02]


def color_dist(img: np.ndarray, palette: np.ndarray) -> np.ndarray:
    f = np.clip(img, 0, 255).astype(np.float32)
    d = np.full(img.shape[:2], 1e9, np.float32)
    for c in palette:
        d = np.minimum(d, np.linalg.norm(f - c[None, None, :], axis=2))
    return d


def flood_target(look: np.ndarray, band: tuple[float, float], want_frac: float) -> np.ndarray | None:
    """从多个线稿灌水候选里挑「中心高度最接近期望」的那个（衣服该在的位置）。"""
    cands = flood_regions(look, band)
    best = None
    h = look.shape[0]
    for reg in cands:
        ys, _ = np.nonzero(reg)
        frac = float((ys.min() + ys.max()) / 2.0 / h)
        score = abs(frac - want_frac)
        if best is None or score < best[0]:
            best = (score, reg)
    return None if best is None else (best[1] * 255).astype(np.uint8)


def whiteout_target(look: np.ndarray, base: np.ndarray, wo: np.ndarray, wa: np.ndarray) -> np.ndarray | None:
    """在 look 里找出「这件衣服」的位置：whiteout 调色板 ∩ 与素体的差异。"""
    pal = palette_of(wo, wa)
    m = ((color_dist(look, pal) < 38) & (np.abs(look - base).max(axis=2) > 12)).astype(np.uint8)
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    n, lab, stats, cent = cv2.connectedComponentsWithStats(m, 8)
    if n <= 1:
        return None
    areas = stats[1:, cv2.CC_STAT_AREA]
    main = 1 + int(np.argmax(areas))
    keep = fill_holes((lab == main).astype(np.uint8))
    return cv2.morphologyEx(keep, cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8)) * 255


def register_shape(alpha: np.ndarray, target: np.ndarray) -> tuple[float, float, float, float]:
    """形状 IoU 配准（FFT 互相关做全图平移搜索 + 缩放扫描）。"""
    ys, xs = np.nonzero(alpha > 127)
    if len(ys) == 0:
        return 1.0, 0.0, 0.0, 0.0
    ay0, ay1, ax0, ax1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
    a = (alpha[ay0:ay1, ax0:ax1] > 127).astype(np.float32)
    tgt = (target > 127).astype(np.float32)
    th, tw = tgt.shape
    ii = cv2.integral(tgt)
    best = (1.0, 0.0, 0.0, -1.0)
    for s in np.arange(0.30, 1.55, 0.03):
        nh, nw = max(8, int(round(a.shape[0] * s))), max(8, int(round(a.shape[1] * s)))
        if nh >= th or nw >= tw:
            continue
        t = cv2.resize(a, (nw, nh), interpolation=cv2.INTER_AREA)
        inter = cv2.matchTemplate(tgt, t, cv2.TM_CCORR)
        win = ii[nh:, nw:] - ii[:-nh, nw:] - ii[nh:, :-nw] + ii[:-nh, :-nw]
        iou = inter / np.maximum(float(t.sum()) + win - inter, 1e-6)
        idx = int(np.argmax(iou))
        val = float(iou.flat[idx])
        if val > best[3]:
            py, px = np.unravel_index(idx, iou.shape)
            best = (float(s), float(px) - ax0 * s, float(py) - ay0 * s, val)
    return best


def layer_from_whiteout(wo: np.ndarray, wa: np.ndarray, target: np.ndarray,
                        extra_scale: float = 1.0,
                        align_probe: str | None = None) -> tuple[np.ndarray, np.ndarray, float]:
    """白底单件图按形状配准回 look 坐标 → (rgb, alpha, iou)。

    extra_scale > 1 时以「衣服顶部中点」为锚点整体放大（下摆向下同时变宽），
    用来补偿 AI 单独画裙子时偏短的问题，保证叠在上衣下面还能露出裙摆。
    """
    probe = wa
    if align_probe == 'light':
        # 只拿浅色像素（衬衫主体）做形状配准，深色领子/蝴蝶结不参与
        light = np.clip(wo, 0, 255).astype(np.uint8).mean(axis=2) > 150
        probe = ((wa > 127) & light).astype(np.uint8) * 255
    s, dx, dy, iou = register_shape(probe, target)
    if extra_scale != 1.0:
        ys, xs = np.nonzero(wa > 127)
        top_y, cx = float(ys.min()), float((xs.min() + xs.max()) / 2)
        waist_y, center_x = s * top_y + dy, s * cx + dx
        s2 = s * extra_scale
        dx = center_x - s2 * cx
        dy = waist_y - s2 * top_y
        s = s2
    h, w = wo.shape[:2]
    M = np.float32([[s, 0, dx], [0, s, dy]])
    rgb = cv2.warpAffine(np.clip(wo, 0, 255).astype(np.uint8), M, (w, h), flags=cv2.INTER_LINEAR)
    a = cv2.warpAffine(wa, M, (w, h), flags=cv2.INTER_LINEAR)
    return rgb, a, iou


def matte(look: np.ndarray, base: np.ndarray, cfg: dict) -> np.ndarray | None:
    mode = cfg['mode']
    if mode == 'diff_low':
        # 下装专用：只在「下半身带」里找最大的横向色块（排除上衣 look 里被 AI 画上去的背心/头发噪声）
        comps = diff_comps(look, base, thr=cfg.get('thr', 26))
        body = (np.abs(base - 255).max(axis=2) > 25)
        ys, xs = np.nonzero(body)
        by0, by1 = float(ys.min()), float(ys.max())
        bw = float(xs.max() - xs.min())
        band = (0.52, 0.92)
        best = None
        for c in comps:
            x, y, w, h = c['bbox']
            frac = (c['centroid'][1] - by0) / max(by1 - by0, 1)
            if not (band[0] <= frac <= band[1]):
                continue
            if w / max(h, 1) < 0.7 or w < 0.2 * bw:
                continue
            if best is None or c['area'] > best['area']:
                best = c
        if best is None:
            return None
        mask = close_fill(best['mask'], kernel_size=25, max_grow=12)
        return mask
    if mode == 'diff':
        comps = diff_comps(look, base, thr=cfg.get('thr', 30))
        if not comps:
            return None
        main = comps[0]
        mask = main['mask'].copy()
        for c in comps[1:]:
            if c['area'] >= 2000 and _bbox_overlap(c['bbox'], main['bbox']):
                mask = np.maximum(mask, c['mask'])
        mask = close_fill(mask)
        return keep_largest(mask)
    # flood 模式（浅色衣服）
    cands = flood_regions(look, cfg['band'])
    if not cands:
        return None
    lab, regions = flat_regions(look)
    comps = diff_comps(look, base, min_area=500)
    best = None
    for reg in cands:
        bbox = cv2.boundingRect(reg)
        ys, xs = np.nonzero(reg)
        flood_mean = np.clip(look[reg > 0].mean(axis=0), 0, 255)
        grown = grow_regions(lab, regions, reg, bbox)
        mask = np.maximum(reg, grown)
        # 只补「位置被灌水区包围、且颜色明显不同」的深色部件（水手领 / 深色袖口等）
        pad = 100
        fx0, fy0, fw, fh = bbox
        for c in comps:
            if c['area'] >= max(int(reg.sum()) * 1.2, 500):
                continue
            x, y, w, h = c['bbox']
            inside = (x >= fx0 - pad and y >= fy0 - pad
                      and x + w <= fx0 + fw + pad and y + h <= fy0 + fh + pad)
            if not inside:
                continue
            if np.linalg.norm(c['mean'] - flood_mean) < 55:
                continue
            mask = np.maximum(mask, c['mask'])
        mask = close_fill(mask, kernel_size=21, max_grow=10)
        mask = keep_largest(mask)
        if best is None or int(mask.sum()) > int(best.sum()):
            best = mask
    return best


def grow_regions(lab: np.ndarray, regions: list[dict], seed_mask: np.ndarray,
                 bbox, max_dist: float = 45, max_extra: float = 1.8) -> np.ndarray:
    """从灌水区域出发，按「颜色相近 + 邻接 + bbox 附近」生长，补齐领口/袖口/罗纹等平涂块。"""
    keep: set[int] = set()
    seed_mask_bool = seed_mask > 0
    colors = []
    seed_area = 0
    for r in regions:
        m = lab == r['id']
        if np.logical_and(m, seed_mask_bool).sum() > 0.5 * r['area']:
            keep.add(r['id'])
            colors.append(r['mean'])
            seed_area += r['area']
    if not keep:
        return seed_mask
    palette = np.array(colors, np.float32)
    x0, y0, w, h = bbox
    ex = (x0 - 25, y0 - 25, x0 + w + 25, y0 + h + 25)
    total = seed_area
    changed = True
    while changed:
        changed = False
        keep_d = cv2.dilate(np.isin(lab, list(keep)).astype(np.uint8), np.ones((7, 7), np.uint8)) > 0
        for r in regions:
            if r['id'] in keep or r['area'] > 0.2 * seed_area:
                continue
            m = lab == r['id']
            if not np.logical_and(m, keep_d).any():
                continue
            cx, cy = r['centroid']
            if not (ex[0] <= cx <= ex[2] and ex[1] <= cy <= ex[3]):
                continue
            d = np.linalg.norm(palette - r['mean'][None, :], axis=1).min()
            if d > max_dist:
                continue
            if total + r['area'] > max_extra * seed_area + 20000:
                continue
            keep.add(r['id'])
            total += r['area']
            changed = True
    return np.isin(lab, list(keep)).astype(np.uint8)


# ---------------------------------------------------------------- 主构建

def build_shape(shape: str, src: Path, out: Path, qa_dir: Path, layers_meta: dict) -> dict:
    base = load_rgb(src / f'base-bandeau-{shape}.png')
    base_alpha = remove_white_alpha(base)
    art = out / 'art' / shape
    (art / 'layers').mkdir(parents=True, exist_ok=True)

    b_rgb, b_alpha = resize_rgba(base, base_alpha)
    save_webp(b_rgb, b_alpha, art / 'base.webp')
    ys, xs = np.nonzero(b_alpha > 40)
    bounds = {'top': round(float(ys.min()) / TARGET[1], 4), 'bottom': round(float(ys.max() + 1) / TARGET[1], 4)}

    hair_front = hair_front_mask(base)
    o_rgb, o_alpha = resize_rgba(base, hair_front)
    save_webp(o_rgb, o_alpha, art / 'overlay.webp')

    layer_paths: dict[tuple[str, str], str] = {}
    layer_pixels: dict[tuple[str, str], tuple[np.ndarray, np.ndarray]] = {}
    for cat, ids in (('dress', DRESSES), ('top', TOPS), ('bottom', BOTTOMS)):
        for ident, _, _ in ids:
            look_path = src / f'{shape}-only-{cat}-{ident}.png'
            look_v2 = src / f'{shape}-only-{cat}-{ident}-v2.png'
            cfg = LAYER_PLAN[(cat, ident)]
            if cfg['mode'] == 'whiteout' and look_v2.exists():
                look_path = look_v2
            look = load_rgb(look_path)
            if cfg['mode'] == 'whiteout':
                wo_path = src / f'{shape}-whiteout-{cat}-{ident}-v2.png'
                if not wo_path.exists():
                    wo_path = src / f'{shape}-whiteout-{cat}-{ident}.png'
                wo = load_rgb(wo_path)
                wa = whiteout_alpha(wo)
                if 'target_frac' in cfg:
                    target = flood_target(look, cfg.get('band', (0.30, 0.80)), cfg['target_frac'][shape])
                else:
                    target = whiteout_target(look, base, wo, wa)
                if target is None:
                    raise SystemExit(f'配准目标失败: {shape} {cat}-{ident}')
                extra = cfg.get('extra_scale', 1.0)
                if isinstance(extra, dict):
                    extra = extra[shape]
                rgb1152, a1152, iou = layer_from_whiteout(wo, wa, target, extra_scale=extra,
                                                          align_probe=cfg.get('align_probe'))
                a1152 = a1152.astype(np.float32) * (hair_front == 0)  # 头发处留洞，由 overlay 补回
                a1152 = np.clip(cv2.GaussianBlur(a1152, (0, 0), 0.9) * 1.05 - 6, 0, 255)
                l_rgb, l_alpha = resize_rgba(np.clip(rgb1152, 0, 255).astype(np.uint8), a1152)
                print(f'    配准 IoU={iou:.2f} extra={extra}')
            else:
                mask = matte(look, base, cfg)
                if mask is None:
                    raise SystemExit(f'抠图失败: {shape} {cat}-{ident}')
                # 硬约束：图层不能包含 look 的背景（白底），否则会把白块贴上舞台
                look_fg = remove_white_alpha(look) > 40
                mask = mask & cv2.dilate(look_fg.astype(np.uint8), np.ones((5, 5), np.uint8))
                # 头发处留洞（由最上层 overlay 补回），再羽化 + premultiplied 缩放
                mask = mask & (hair_front == 0)
                a1152 = np.clip(cv2.GaussianBlur(mask.astype(np.float32) * 255.0, (0, 0), 0.9) * 1.12 - 12, 0, 255)
                l_rgb, l_alpha = resize_rgba(np.clip(look, 0, 255).astype(np.uint8), a1152)
            rel = f'art/{shape}/layers/{"dress" if cat == "dress" else cat}-{ident}.webp'
            save_webp(l_rgb, l_alpha, out / rel)
            layer_paths[(cat, ident)] = rel
            layer_pixels[(cat, ident)] = (l_rgb, l_alpha)
            area = round(float((l_alpha > 40).mean()), 4)
            print(f'  {rel}  面积 {area:.1%}')

    # QA 拼图：所有组合 + 全部连衣裙 + 单层
    qa_dir.mkdir(parents=True, exist_ok=True)
    canvas = np.zeros((TARGET[1], TARGET[0], 3), np.float32)
    canvas[:] = 255

    def compose(keys) -> np.ndarray:
        img = np.full((TARGET[1], TARGET[0], 3), 255.0, np.float32)
        a = b_alpha.astype(np.float32) / 255.0
        img = img * (1 - a[..., None]) + np.clip(b_rgb, 0, 255).astype(np.float32) * a[..., None]
        for k in keys:
            rgb, al = layer_pixels[k]
            a2 = al.astype(np.float32) / 255.0
            img = img * (1 - a2[..., None]) + np.clip(rgb, 0, 255).astype(np.float32) * a2[..., None]
        a3 = o_alpha.astype(np.float32) / 255.0
        img = img * (1 - a3[..., None]) + np.clip(o_rgb, 0, 255).astype(np.float32) * a3[..., None]
        return np.clip(img, 0, 255).astype(np.uint8)

    cells = []
    for top, _, _ in TOPS:
        for bottom, _, _ in BOTTOMS:
            cells.append((f'{top}+{bottom}', compose([('bottom', bottom), ('top', top)])))
    for ident, _, _ in DRESSES:
        cells.append((f'dress-{ident}', compose([('dress', ident)])))
    for ident, _, _ in TOPS:
        cells.append((f'only-{ident}', compose([('top', ident)])))
    for ident, _, _ in BOTTOMS:
        cells.append((f'only-{ident}', compose([('bottom', ident)])))
    W, H, cols = 260, 462, 5
    rows = (len(cells) + cols - 1) // cols
    sheet = Image.new('RGB', (cols * W, rows * (H + 18)), (255, 255, 255))
    from PIL import ImageDraw
    draw = ImageDraw.Draw(sheet)
    for i, (label, img) in enumerate(cells):
        sheet.paste(Image.fromarray(img).resize((W, H), Image.LANCZOS), ((i % cols) * W, (i // cols) * (H + 18)))
        draw.text(((i % cols) * W + 4, (i // cols) * (H + 18) + H + 3), label, fill=(30, 30, 30))
    sheet.save(qa_dir / f'v7-layers-{shape}.jpg', quality=90)

    # 悬浮鲸鱼兜底图（默认 Q 版女仆装，184×327，透明背景 RGBA）
    if shape == 'chibi':
        def compose_rgba(keys) -> tuple[np.ndarray, np.ndarray]:
            img = np.zeros((TARGET[1], TARGET[0], 3), np.float32)
            acc = np.zeros((TARGET[1], TARGET[0]), np.float32)

            def over(rgb, al):
                nonlocal img, acc
                a2 = np.clip(al.astype(np.float32) / 255.0, 0, 1)
                img = img * (1 - a2[..., None]) + np.clip(rgb, 0, 255).astype(np.float32) * a2[..., None]
                acc = acc * (1 - a2) + a2

            over(b_rgb, b_alpha)
            for k in keys:
                rgb, al = layer_pixels[k]
                over(rgb, al)
            over(o_rgb, o_alpha)
            return np.clip(img, 0, 255).astype(np.uint8), np.clip(acc * 255, 0, 255).astype(np.uint8)

        prgb, pa = compose_rgba([('dress', 'maid')])
        ys, xs = np.nonzero(pa > 20)
        prgb = prgb[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
        pa = pa[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
        ratio = min(184 / pa.shape[1], 327 / pa.shape[0])
        nw, nh = max(1, round(pa.shape[1] * ratio)), max(1, round(pa.shape[0] * ratio))
        prgb = cv2.resize(prgb, (nw, nh), interpolation=cv2.INTER_AREA)
        pa = cv2.resize(pa, (nw, nh), interpolation=cv2.INTER_AREA)
        pet = np.zeros((327, 184, 4), np.uint8)
        x0, y0 = (184 - nw) // 2, (327 - nh) // 2
        pet[y0:y0 + nh, x0:x0 + nw, :3] = prgb
        pet[y0:y0 + nh, x0:x0 + nw, 3] = pa
        tmp_pet = out / 'art' / 'pet-default.webp.tmp'
        Image.fromarray(pet).save(tmp_pet, 'WEBP', quality=85, method=6)
        os.replace(tmp_pet, out / 'art' / 'pet-default.webp')

    return {'shape': shape, 'bounds': bounds, 'layer_paths': layer_paths}


def make_icons(src: Path, out: Path) -> None:
    icon_root = src.parent / 'raw3'
    for ident, filename in ICON_SOURCES.items():
        icon_src = icon_root / filename
        if not icon_src.exists():
            raise SystemExit(f'missing icon source: {icon_src}')
        rgb = load_rgb(icon_src)
        save_thumb(rgb, remove_white_alpha(rgb), out / 'art' / 'icons' / f'{ident}.webp')


def make_bg_thumbs(out: Path) -> None:
    for bid, _, _, _ in BACKGROUNDS:
        bg_file = out / 'art' / f'{bid}.webp'
        if not bg_file.exists():
            print(f'  WARN missing background {bg_file}')
            continue
        im = Image.open(bg_file).convert('RGB')
        side = min(im.size)
        im = im.crop(((im.width - side) // 2, (im.height - side) // 2,
                      (im.width + side) // 2, (im.height + side) // 2)).resize((200, 200), Image.LANCZOS)
        thumb = out / 'art' / 'thumbs' / f'{bid}.webp'
        thumb.parent.mkdir(parents=True, exist_ok=True)
        im.save(thumb, 'WEBP', quality=86, method=6)


def build_manifest(shape_info: dict) -> dict:
    items = {'outfits': [{'id': 'none', 'name': '不穿套装', 'emoji': '🚫', 'desc': '换成上衣 + 下装搭配。'}]}
    for ident, name, desc in DRESSES:
        items['outfits'].append({'id': ident, 'name': name, 'desc': desc,
                                 'icon': f'art/icons/{ident}.webp', 'z': Z_ORDER['dress'],
                                 'layer': {s: shape_info[s]['layer_paths'][('dress', ident)] for s in shape_info}})
    items['tops'] = [{'id': ident, 'name': name, 'desc': desc, 'icon': f'art/icons/{ident}.webp',
                      'z': Z_ORDER['top'],
                      'layer': {s: shape_info[s]['layer_paths'][('top', ident)] for s in shape_info}}
                     for ident, name, desc in TOPS]
    items['bottoms'] = [{'id': ident, 'name': name, 'desc': desc, 'icon': f'art/icons/{ident}.webp',
                         'z': Z_ORDER['bottom'],
                         'layer': {s: shape_info[s]['layer_paths'][('bottom', ident)] for s in shape_info}}
                        for ident, name, desc in BOTTOMS]
    items['backgrounds'] = [{'id': i, 'name': n, 'desc': d, 'file': f'art/{i}.webp',
                             'thumb': f'art/thumbs/{i}.webp', 'floor': floor}
                            for i, n, d, floor in BACKGROUNDS]
    items['effects'] = [{'id': i, 'name': n, 'desc': d, 'emoji': e} for i, n, d, e in EFFECTS]
    return {
        'version': 5,
        'title': '大肥鱼衣橱 · 换装间',
        'character': '大肥鱼 · 经典鲸鱼娘',
        'credits': CREDITS,
        'shapes': [{'id': sid, 'name': name, 'desc': desc,
                    'base': f'art/{sid}/base.webp', 'overlay': f'art/{sid}/overlay.webp',
                    'bounds': shape_info[sid]['bounds']}
                   for sid, name, desc in SHAPES],
        'categories': [
            {'id': 'outfits', 'name': '套装', 'emoji': '👗', 'stateKey': 'outfit'},
            {'id': 'tops', 'name': '上衣', 'emoji': '👚', 'stateKey': 'top'},
            {'id': 'bottoms', 'name': '下装', 'emoji': '👘', 'stateKey': 'bottom'},
            {'id': 'backgrounds', 'name': '背景', 'emoji': '🏙️', 'stateKey': 'bg'},
            {'id': 'effects', 'name': '特效', 'emoji': '❄️', 'stateKey': 'effect'},
        ],
        'items': items,
        'defaults': {'shape': 'chibi', 'outfit': 'maid', 'top': 'sweater', 'bottom': 'plaid',
                     'bg': 'bg-snow', 'effect': 'snow'},
        'bubbles': BUBBLES,
    }


def build(src: Path, out: Path, qa_dir: Path, only_shape: str | None = None) -> None:
    shapes = [s for s in SHAPES if not only_shape or s[0] == only_shape]
    shape_info = {}
    for shape, _, _ in shapes:
        print(f'[{shape}] 素体 / 叠层 / 图层 …')
        shape_info[shape] = build_shape(shape, src, out, qa_dir, {})
    print('图标 …')
    make_icons(src, out)
    make_bg_thumbs(out)
    # 若只构建了一个身形，manifest 需合并另一个身形的已有图层信息（增量调试用）
    if only_shape:
        manifest_path = out / 'manifest.json'
        if manifest_path.exists():
            old = json.loads(manifest_path.read_text())
            for shape in old.get('shapes', []):
                sid = shape['id']
                if sid in shape_info:
                    continue
                shape_info[sid] = {'bounds': shape['bounds'], 'layer_paths': {}}
                for cat in ('outfits', 'tops', 'bottoms'):
                    key = {'outfits': 'dress', 'tops': 'top', 'bottoms': 'bottom'}[cat]
                    for item in old['items'][cat]:
                        if item['id'] == 'none':
                            continue
                        shape_info[sid]['layer_paths'][(key, item['id'])] = item['layer'][sid]
    # 清理不再被 manifest 引用的旧图层 / 图标（内容收敛后删掉历史素材）
    referenced_layers = set()
    for info in shape_info.values():
        referenced_layers.update(info['layer_paths'].values())
    for shape, _, _ in shapes:
        for stale in (out / 'art' / shape / 'layers').glob('*.webp'):
            rel = f'art/{shape}/layers/{stale.name}'
            if rel not in referenced_layers:
                stale.unlink()
    for stale in (out / 'art' / 'icons').glob('*.webp'):
        if stale.stem not in ICON_SOURCES:
            stale.unlink()
    # 清理旧版「整套立绘」产物（新素材写完之后再删，避免构建期间素材缺失）
    for shape, _, _ in shapes:
        art = out / 'art' / shape
        for pattern in ('dress-*.webp', 'combo-*.webp'):
            for stale in art.glob(pattern):
                stale.unlink()
        thumbs = art / 'thumbs'
        if thumbs.is_dir():
            for stale in thumbs.glob('*'):
                stale.unlink()
            thumbs.rmdir()
    manifest = build_manifest(shape_info)
    tmp_manifest = out / 'manifest.json.tmp'
    tmp_manifest.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    os.replace(tmp_manifest, out / 'manifest.json')
    print(f'manifest -> {out / "manifest.json"}')
    print(f'shapes={len(shape_info)} layers={sum(len(v["layer_paths"]) for v in shape_info.values())}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--src', default='/home/ubuntu/dsh/.scratch/feiyu-gen/raw12')
    parser.add_argument('--out', default=str(ROOT / 'docs/dress-up'))
    parser.add_argument('--qa-dir', default='/home/ubuntu/dsh/.scratch/feiyu-art')
    parser.add_argument('--shape', default=None, choices=['chibi', 'girl'])
    args = parser.parse_args()
    build(Path(args.src), Path(args.out), Path(args.qa_dir), args.shape)
