#!/usr/bin/env python3
"""换装 4.0 素材构建：v0.9 多槽位分层（v6 契约，见 docs/dress-up/LAYER-MODEL.md）。

把画布拆成 7 个深度 strata（drawOrder，从下到上）：
    body → topUnder → bottom → topBody → arms → sleeve → hair

输入目录（默认 .scratch/feiyu-gen/raw12）里按命名约定存放：
  base-bandeau-<shape>.png           素体（白色无肩带连体衣，1152×2048，纯白背景）
  <shape>-only-<cat>-<id>.png        单件穿着 look（同一素体上生成，构图一致）
  <shape>-only-bottom-<id>-knee.png  及膝下装 look（v0.10.1：下装直接在这里取裙成层）
  <shape>-whiteout-<cat>-<id>.png    白底单件图（上衣取衣服调色板 / 形状配准用）

新增输入掩膜（源分辨率 1152×2048，0-255 alpha PNG，由 tools/build_masks.py 生成）：
  tools/masks/<shape>/arms.png       手臂+手（含手臂轮廓描边，略保守）
  tools/masks/<shape>/hair.png       全部可见前发（含手臂下方长发丝、呆毛），不含尾巴

输出：
  art/<shape>/body.webp              整张素体（最底层，= 旧 v5 base.webp 内容）
  art/<shape>/arms.webp              body RGB + alpha = arms_mask × foreground_alpha
  art/<shape>/hair.webp              body RGB + alpha = hair_mask × foreground_alpha
  art/<shape>/layers/<cat>-<id>-body.webp    每件上衣/连衣裙主体（不挖头发洞）
  art/<shape>/layers/<cat>-<id>-sleeve.webp  袖子 = garment_alpha × dilate(arms_mask,6px)，羽化 1px
  art/<shape>/layers/bottom-<id>.webp        下装单层（RGB/alpha 原样取自及膝 look，不缩放）
  art/pet-default.webp               按 drawOrder 合成的默认穿搭（Q 版女仆装，184×327，透明）
  manifest.json                      v6（drawOrder / shapes[].layers / items[].layers）

依赖：pillow + numpy + opencv-python（仅构建用，运行时不依赖）。

用法:
  python3 tools/build_wardrobe.py --src /home/ubuntu/dsh/.scratch/feiyu-gen/raw12 --out docs/dress-up
  python3 tools/build_wardrobe.py --shape chibi --masks-dir /tmp/pf/masks   # 单身形调试
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import time
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
TARGET = (675, 1200)
SOURCE = (1152, 2048)
GLOBAL = TARGET[0] / SOURCE[0]

SHAPES = [('chibi', 'Q版', '大头小身子的可爱版本'), ('girl', '少女版', '六头身的少女比例')]

# mask-forge 冻结的掩膜版本（LWW 文件，A=掩膜；构建时做 md5 回归，不一致只告警不阻断）
FROZEN_MASK_MD5 = {
    'chibi/arms': '236ab154a3069ec1e857852267ea6644',
    'chibi/hair': '45bd3e2ee82213b39deec96a41f0fb33',
    'girl/arms': 'c6fdf571d5db297f164f73694b94b69f',
    'girl/hair': '3ac7a0855cb82b396d814be42c4e2087',
}

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

# v6 的 7 个深度槽位（从下到上）。前端按此顺序动态建层。
DRAW_ORDER = ['body', 'topUnder', 'bottom', 'topBody', 'arms', 'sleeve', 'hair']
SHAPE_SLOTS = ('body', 'arms', 'hair')
ITEM_SLOTS = ('topUnder', 'bottom', 'topBody', 'sleeve')

# 每件单品的抠图策略：
#   flood = 线稿灌水 + 平涂色块区域生长（浅色衣服）
#   diff  = 与素体像素差主块 + 填洞（彩色衣服）
#   thr   = diff 阈值（浅色礼服可调低）
LAYER_PLAN = {
    # 上装：单独生成时 AI 会把上衣画大/画长，且 look 里的白色素体会被 diff 灌水带进来；
    # 统一走「白底单件图 + 形状 IoU 配准」——图层只含衣服本体，位置/大小由配准决定。
    ('top', 'sweater'): {'mode': 'whiteout', 'target_frac': {'chibi': 0.57, 'girl': 0.46}},
    ('top', 'hoodie'): {'mode': 'whiteout', 'target_frac': {'chibi': 0.57, 'girl': 0.46}},
    # 水手服（v0.9.1 修）：look 里的水手服是「连体式」（衬衫 + 白色下装连成一片），
    # 用「浅色衬衫主体 ↔ look 白色区域」配准会被连体衣下摆拉偏/拉小 → 衣领整体偏下、
    # 缩 5%，合成时脖子/肩膀露出素体皮肤（用户反馈「肩膀肉露出来」）。
    # 改成用「领结」配准：whiteout 与 look 里领结都完整可见且形状一致（质心差 <2px），
    # 深蓝领子外翼在 look 里被头发挡住（形状不一致）故不参与；水手服不需要额外缩放。
    ('top', 'sailor'): {'mode': 'whiteout', 'target_frac': {'chibi': 0.57, 'girl': 0.46},
                        'align_probe': 'bow'},
    # 下装（v0.10.1 修）：whiteout 单件图被 AI 重画成「宽腰短裙」，与在体 look 的裙形/比例
    # 不一致；旧实现再用 extra_scale 整件放大（chibi ×1.72 / girl ×1.40），导致裙腰偏低、
    # 裙长/格纹/裙摆全部失真（用户反馈「裙子像被放大后罩上去」）。
    # 改为直接取「及膝 look」成层：腰带顶 / 下摆 / 腰宽从 look 检测，左右缘由裙面左缘
    # 稳健拟合 + 镜像重建，RGB 直接取自 look，不做任何缩放/配准。输入为 <id>-knee.png。
    ('bottom', 'plaid'): {'mode': 'look', 'look_suffix': '-knee'},
    ('bottom', 'pleated'): {'mode': 'look', 'look_suffix': '-knee'},
    # 连衣裙：直接对 look 做 diff 主块 matte（v1/v2 两轮 QA 已确认位置/大小正确）
    ('dress', 'maid'): {'mode': 'diff', 'thr': 30},
}
# 单品主体放哪个槽位：水手服下摆应被裙子盖住 → topUnder；毛衣/卫衣/女仆装 → topBody
MAIN_SLOT = {
    ('dress', 'maid'): 'topBody',
    ('top', 'sweater'): 'topBody',
    ('top', 'hoodie'): 'topBody',
    ('top', 'sailor'): 'topUnder',
}

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

# sleeve 层参数（契约 §3）：dilate(arms_mask, 6px) 再羽化 1px
SLEEVE_DILATE_PX = 6
SLEEVE_FEATHER_SIGMA = 1.0
SLEEVE_MIN_FRAC = 0.002  # 袖子像素占比低于此值视为无袖 → 不产出 sleeve 层

# 水手服「领结」配准（v0.9.1）：领结在 whiteout 与 look 里都是完整可见的实心亮蓝，
# 用它做 probe/target 做 scale+translation 搜索；领子外翼在 look 里被头发挡住、形状不一致，
# 只用来在 whiteout 里框定「领结在领子下方」的位置，不参与形状匹配。
SAILOR_BOW_SCALES = np.arange(0.80, 1.25, 0.01)  # 领结尺度搜索范围（AI 两张图重画误差 ±25%）
SAILOR_BOW_MIN_PX = 300      # 领结掩膜最少像素（太少说明特征没提取到）
SAILOR_BOW_MIN_IOU = 0.45    # 配准 IoU 低于此判定失败 → 回退默认整件形状配准
SAILOR_BOW_SCALE_RANGE = (0.50, 1.60)  # 配准尺度合法区间

# 少女版卫衣橙色蝴蝶结在 whiteout 里丢失 → build patch 从 look 补回（契约 §6）
BOW_ORANGE_MIN_LOOK = 400      # look 里至少这么多橙色像素才认为「有蝴蝶结」
BOW_WHITEOUT_FRAC = 0.35      # whiteout 配准结果橙色像素 < look 的 35% → 判定蝴蝶结丢失
BOW_WHITEOUT_MIN = 200         # whiteout 里至少这么多橙色像素才认为是「自带蝴蝶结」


# ---------------------------------------------------------------- 通用图像工具

def load_rgb(path: Path) -> np.ndarray:
    return np.asarray(Image.open(path).convert('RGB')).astype(np.int16)


def load_mask(path: Path) -> np.ndarray:
    """读源分辨率掩膜（0-255 alpha）。支持 L / LA / RGBA / RGB。"""
    if not path.exists():
        raise SystemExit(f'缺少掩膜: {path}（由 tools/build_masks.py 生成，见 LAYER-MODEL.md §3）')
    im = Image.open(path)
    if im.size != SOURCE:
        raise SystemExit(f'掩膜尺寸必须是 {SOURCE}: {path} 实际 {im.size}')
    if im.mode in ('RGBA', 'LA'):
        arr = np.asarray(im)
        return arr[:, :, arr.shape[2] - 1].astype(np.uint8)
    if im.mode == 'L':
        return np.asarray(im).astype(np.uint8)
    return np.asarray(im.convert('L')).astype(np.uint8)


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


def resize_alpha(mask: np.ndarray, size=TARGET) -> np.ndarray:
    """源分辨率 0-255 掩膜 → 目标尺寸平滑 alpha（float32 0-255）。"""
    return np.clip(cv2.resize(mask.astype(np.float32) / 255.0, size,
                              interpolation=cv2.INTER_AREA), 0, 1) * 255.0


def ellipse(radius: int) -> np.ndarray:
    return cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (radius * 2 + 1, radius * 2 + 1))


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


# ---------------------------------------------------------------- 合成工具（QA / pet 用）

def over(dst_rgb: np.ndarray, dst_a: np.ndarray, rgb: np.ndarray, alpha: np.ndarray):
    """source-over：dst 在下，src 在上。dst_a 0-255（用于透明画布）。"""
    a = np.clip(alpha.astype(np.float32) / 255.0, 0, 1)
    out_rgb = dst_rgb * (1 - a[..., None]) + np.clip(rgb, 0, 255).astype(np.float32) * a[..., None]
    out_a = dst_a * (1 - a) + a * 255.0
    return out_rgb, out_a


def compose(layers: list[tuple[np.ndarray, np.ndarray]],
            opaque_bg: tuple[int, int, int] | None = (255, 255, 255)) -> tuple[np.ndarray, np.ndarray]:
    """按顺序叠加。opaque_bg 给 RGB 底色（白色 = 网页/QA），None = 透明画布。"""
    h, w = TARGET[1], TARGET[0]
    if opaque_bg is None:
        img = np.zeros((h, w, 3), np.float32)
        acc = np.zeros((h, w), np.float32)
    else:
        img = np.zeros((h, w, 3), np.float32)
        img[:] = opaque_bg
        acc = np.full((h, w), 255.0, np.float32)
    for rgb, alpha in layers:
        img, acc = over(img, acc, rgb, alpha)
    return np.clip(img, 0, 255).astype(np.uint8), np.clip(acc, 0, 255).astype(np.uint8)


def resize_premult(rgb: np.ndarray, alpha: np.ndarray, size: tuple[int, int]):
    """缩放 premultiplied 画布（compose(opaque_bg=None) 的产物）：RGB 已含 alpha 权重。"""
    a = np.clip(alpha.astype(np.float32) / 255.0, 0, 1)
    rgb2 = cv2.resize(rgb.astype(np.float32), size, interpolation=cv2.INTER_AREA)
    a2 = np.clip(cv2.resize(a, size, interpolation=cv2.INTER_AREA), 0, 1)
    safe = np.maximum(a2, 1e-4)[..., None]
    out = np.where(a2[..., None] > 0.004, rgb2 / safe, 0.0)
    return np.clip(out, 0, 255), a2 * 255


# ---------------------------------------------------------------- 衣服抠图（matte，沿用 v0.8）

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


# ---------------------------------------------------------------- 下装：在体 look 直接成层（v0.10.1）

# 用户反馈「裙子像被放大后罩上去」：whiteout 单件图被 AI 重画成宽腰短裙，再按顶部
# 锚点整件放大（旧 extra_scale chibi ×1.72 / girl ×1.40）→ 裙腰/裙长/格纹/裙摆全部失真。
# 下装改为直接取「及膝 look」：腰带顶/下摆/腰宽从 look 检测，左右缘由裙面左缘做稳健
# 直线拟合再镜像（裙子在角色身上左右基本对称；右缘常被尾巴/手挡住不可靠），RGB 取自 look。
LOOK_BELT_CENTER_BAND = (0.30, 0.70)  # 腰带横条中心必须落在画面中间带（避开两侧头发/手臂）
LOOK_BELT_MIN_FRAC = 0.12             # 腰带横条长度至少占画面宽 12%
LOOK_TOP_SEARCH = (0.34, 0.73)        # 腰带纵向搜索范围（占画面高）


def _runs_of(row: np.ndarray) -> list[tuple[int, int, int]]:
    """一行二值 mask 的连续段（start, end, length）。"""
    xs = np.nonzero(row)[0]
    if len(xs) == 0:
        return []
    return [(int(g[0]), int(g[-1]), len(g))
            for g in np.split(xs, np.where(np.diff(xs) > 1)[0] + 1)]


def _look_dark_navy(rgb: np.ndarray) -> np.ndarray:
    """look 里的深蓝色（腰带）：蓝主导、偏暗。白 bandeau/肤色/头发高光不在此范围。"""
    r, g, b = (rgb[:, :, 0].astype(np.int32), rgb[:, :, 1].astype(np.int32),
               rgb[:, :, 2].astype(np.int32))
    return (b - r > 15) & (b > 50) & (rgb.mean(axis=2) < 140)


def look_belt_anchor(look: np.ndarray) -> dict:
    """裙腰深蓝色腰带：中央横向长条里最宽的一段，返回上下沿/左右沿/中心。

    look 里两侧头发是深蓝，也会形成长横条；用「中心带」过滤掉（腰带在角色中线附近），
    再用同一段连续行的最长横条确定腰带高度。白 bandeau 是白的、肤色偏红，都不参与。
    """
    h, w = look.shape[:2]
    dn = _look_dark_navy(look)
    rows: list[tuple[int, int, int, int]] = []
    for y in range(int(LOOK_TOP_SEARCH[0] * h), int(LOOK_TOP_SEARCH[1] * h)):
        best = None
        for x0, x1, length in _runs_of(dn[y]):
            cx = (x0 + x1) / 2.0
            if not (LOOK_BELT_CENTER_BAND[0] * w <= cx <= LOOK_BELT_CENTER_BAND[1] * w):
                continue
            if length < LOOK_BELT_MIN_FRAC * w:
                continue
            if best is None or length > best[2]:
                best = (x0, x1, length)
        if best is not None:
            rows.append((y, best[0], best[1], best[2]))
    if not rows:
        raise SystemExit('下装 look 腰带检测失败：找不到中央深蓝色横向长条')
    lmax = max(r[3] for r in rows)
    band = [r for r in rows if r[3] >= 0.80 * lmax]
    groups: list[list[tuple[int, int, int, int]]] = []
    cur = [band[0]]
    for r in band[1:]:
        if r[0] == cur[-1][0] + 1:
            cur.append(r)
        else:
            groups.append(cur)
            cur = [r]
    groups.append(cur)
    group = max(groups, key=len)
    top, bot = group[0][0], group[-1][0]

    def longest(y: int) -> int:
        return max((r[2] for r in _runs_of(dn[y])
                    if LOOK_BELT_CENTER_BAND[0] * w <= (r[0] + r[1]) / 2
                    <= LOOK_BELT_CENTER_BAND[1] * w), default=0)

    while top - 1 >= 0 and longest(top - 1) >= 0.60 * lmax:
        top -= 1
    while bot + 1 < h and longest(bot + 1) >= 0.60 * lmax:
        bot += 1
    _, x0, x1, length = max(group, key=lambda r: r[3])
    return {'top': int(top), 'bot': int(bot), 'x0': int(x0), 'x1': int(x1),
            'cx': float((x0 + x1) / 2.0), 'width': int(length), 'peak': int(lmax)}


def look_garment_top(look: np.ndarray, belt: dict) -> int:
    """裙子上沿（含腰带高光/描边）：腰带横向范围内「高饱和蓝色」占比首次稳定的行。

    旧实现用 look↔base 的 diff 顶边，但白 bandeau 底边也会被 AI 重画 → diff 顶边比真实
    裙腰高 40-80px（chibi 尤甚）。这里只信裙子本体的颜色：白 bandeau/肤色饱和度低，
    腰带（含高光）高饱和蓝色，逐行扫到第一段稳定蓝色即为裙腰上沿。
    """
    h, w = look.shape[:2]
    hsv = cv2.cvtColor(np.clip(look, 0, 255).astype(np.uint8), cv2.COLOR_RGB2HSV)
    blue = (hsv[:, :, 1] > 50) & (look[:, :, 2] > 55)
    x0, x1 = max(0, belt['x0']), min(w, belt['x1'] + 1)
    frac = blue[:, x0:x1].mean(axis=1)
    for y in range(max(0, belt['top'] - 40), min(h - 12, belt['top'] + 30)):
        if frac[y] > 0.5 and frac[y:y + 10].mean() > 0.6:
            return int(y)
    return int(belt['top'])


def _look_outside(rgb: np.ndarray) -> np.ndarray:
    """白底 / 肤色（用于找下摆：衣物→皮肤/白底的过渡）。"""
    r, g, b = (rgb[:, :, 0].astype(np.int32), rgb[:, :, 1].astype(np.int32),
               rgb[:, :, 2].astype(np.int32))
    lum = rgb.mean(axis=2)
    white = (rgb.min(axis=2) > 228) & (np.abs(r - g) < 10) & (np.abs(g - b) < 14)
    skin = (r - g > 4) & (g - b > -12) & (r > 195) & (lum > 155)
    return white | skin


def _robust_line(ys: list[int], xs: list[int]) -> tuple[float, float]:
    """稳健直线拟合（迭代剔除外点），返回 (slope, intercept)。"""
    ys_a = np.asarray(ys, np.float64)
    xs_a = np.asarray(xs, np.float64)
    keep = np.ones(len(xs_a), bool)
    slope, intercept = np.polyfit(ys_a, xs_a, 1)
    for _ in range(10):
        slope, intercept = np.polyfit(ys_a[keep], xs_a[keep], 1)
        residual = np.abs(slope * ys_a + intercept - xs_a)
        sigma = np.median(residual[keep]) + 1e-6
        nk = residual < max(4.0, 2.5 * sigma)
        if nk.sum() < max(4, int(0.3 * len(xs_a))) or np.array_equal(nk, keep):
            break
        keep = nk
    return float(slope), float(intercept)


def skirt_mask_from_look(look: np.ndarray, base: np.ndarray,
                         hair_src: np.ndarray, arms_src: np.ndarray) -> tuple[np.ndarray, dict]:
    """在体 look → 裙子掩膜（0/1，源分辨率），不缩放。

    1. 与素体 diff 主块 + close_fill 得到裙面（白格纹/白底小洞先填上）；
    2. 踢掉 hair/arms 掩膜（它们画在裙子前，会污染左右缘；最终 mask 由直线+镜像重建）；
    3. 腰带顶 / 下摆 / 腰宽从 look 检测，左缘稳健拟合 → 右缘镜像；
    4. 与 look 前景相交，剪掉梯形外扩到白背景的边角。
    """
    h, w = look.shape[:2]
    comps = diff_comps(look, base, thr=30, min_area=1200)
    if not comps:
        raise SystemExit('下装 look diff 主块失败')
    body = (np.abs(base - 255).max(axis=2) > 25)
    bys, bxs = np.nonzero(body)
    by0, by1 = float(bys.min()), float(bys.max())
    bw = float(bxs.max() - bxs.min())
    pick = None
    for c in comps:
        x, y, cw_, ch = c['bbox']
        cy = y + ch / 2.0
        if not (by0 + 0.30 * (by1 - by0) < cy < by0 + 0.80 * (by1 - by0)):
            continue
        if cw_ < 0.22 * bw or cw_ / max(ch, 1) < 0.55:
            continue
        if pick is None or c['area'] > pick['area']:
            pick = c
    if pick is None:
        pick = comps[0]
    solid = close_fill(pick['mask'], kernel_size=31, max_grow=14)
    occ = cv2.dilate((hair_src > 127).astype(np.uint8), np.ones((3, 3), np.uint8))
    occ |= cv2.dilate((arms_src > 127).astype(np.uint8), np.ones((3, 3), np.uint8))
    edge = solid & (occ == 0)

    belt = look_belt_anchor(look)
    top = look_garment_top(look, belt)
    cx = belt['cx']

    outside = _look_outside(look)
    trans: list[int] = []
    for x in range(belt['x0'] + 8, int(cx) - 12, 2):
        y = max(top + 30, belt['bot'] + 5)
        while y < h - 150:
            if outside[y, x] and outside[y:y + 150, x].mean() > 0.92:
                while y > top + 30 and outside[y - 1, x]:
                    y -= 1
                trans.append(y)
                break
            y += 1
    if len(trans) < 8:
        raise SystemExit(f'下装下摆检测失败（有效过渡列 {len(trans)}）')
    hem = int(np.percentile(trans, 60))

    ys: list[int] = []
    xs: list[int] = []
    for y in range(belt['bot'] + 12, hem - 2):
        row = np.nonzero(edge[y])[0]
        if len(row) == 0:
            continue
        left = int(row.min())
        if left > cx - 20 or left < cx - 320:
            continue
        ys.append(y)
        xs.append(left)
    if len(xs) < 20:
        raise SystemExit(f'下装左缘拟合点不足（{len(xs)}）')
    slope, intercept = _robust_line(ys, xs)
    if abs(slope * top + intercept - belt['x0']) > 10:
        intercept = belt['x0'] - slope * top
    left_top = slope * top + intercept
    left_hem = slope * hem + intercept
    waist_w = 2.0 * (cx - left_top)
    hem_w = 2.0 * (cx - left_hem)
    if not (0.08 * h <= hem - top <= 0.60 * h):
        raise SystemExit(f'下装裙长异常: top={top} hem={hem}')
    if not (-0.60 <= slope <= 0.05) or hem_w < 1.05 * waist_w or hem_w > 3.5 * waist_w:
        raise SystemExit(f'下装裙形异常: slope={slope:.3f} waist={waist_w:.0f} hem={hem_w:.0f}')

    mask = np.zeros((h, w), np.uint8)
    for y in range(top, hem + 1):
        left = int(round(slope * y + intercept))
        right = int(round(2.0 * cx - left))
        mask[y, max(0, left):min(w - 1, right) + 1] = 1
    # 剪掉梯形外扩到纯白背景的边角；裙内白色格纹是封闭区，不受影响
    mask &= (remove_white_alpha(look) > 40).astype(np.uint8)
    mask = fill_holes(mask)
    inter = int(np.logical_and(mask > 0, pick['mask'] > 0).sum())
    union = int(np.logical_or(mask > 0, pick['mask'] > 0).sum())
    info = {'mode': 'look', 'top': top, 'hem': hem,
            'waist_y': top, 'waist_w': int(round(waist_w)),
            'hem_w': int(round(hem_w)), 'cx': round(float(cx), 1),
            'slope': round(slope, 4), 'area': int(mask.sum()),
            'iou': round(inter / max(union, 1), 4)}
    return mask, info



def register_shape(alpha: np.ndarray, target: np.ndarray,
                   scales: np.ndarray | None = None) -> tuple[float, float, float, float]:
    """形状 IoU 配准（FFT 互相关做全图平移搜索 + 缩放扫描）。

    scales 缺省用粗网格 0.30–1.55（整件衣服）；领结这类小特征传细网格。
    """
    ys, xs = np.nonzero(alpha > 127)
    if len(ys) == 0:
        return 1.0, 0.0, 0.0, 0.0
    ay0, ay1, ax0, ax1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
    a = (alpha[ay0:ay1, ax0:ax1] > 127).astype(np.float32)
    tgt = (target > 127).astype(np.float32)
    th, tw = tgt.shape
    ii = cv2.integral(tgt)
    best = (1.0, 0.0, 0.0, -1.0)
    for s in (np.arange(0.30, 1.55, 0.03) if scales is None else scales):
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


# ---- 水手服显著特征（深蓝领子 + 亮蓝领结）掩膜 ----

def vivid_blue(rgb: np.ndarray) -> np.ndarray:
    """亮蓝（领结填充色）：b 高、b-r 大、亮度中等；深蓝领子/暗发阴影不在此范围。"""
    r, g, b = rgb[:, :, 0].astype(np.int32), rgb[:, :, 1].astype(np.int32), rgb[:, :, 2].astype(np.int32)
    lum = rgb.mean(axis=2)
    return (b - r > 45) & (b > 115) & (lum > 80) & (lum < 190)


def dark_navy(rgb: np.ndarray) -> np.ndarray:
    """深蓝（水手领 / 领结描边）：蓝主导且暗。"""
    r, g, b = rgb[:, :, 0].astype(np.int32), rgb[:, :, 1].astype(np.int32), rgb[:, :, 2].astype(np.int32)
    lum = rgb.mean(axis=2)
    return (b - r > 25) & (b > 45) & (lum < 125)


def sailor_accent(rgb: np.ndarray) -> np.ndarray:
    """水手服显著特征并集（深蓝领子 + 亮蓝领结）。"""
    return dark_navy(rgb) | vivid_blue(rgb)


def sailor_bow_probe(wo: np.ndarray, wa: np.ndarray) -> np.ndarray | None:
    """从白底单件图里提取「领结」掩膜（源分辨率 bool，找不到返回 None）。

    做法：先用深蓝领子+亮蓝领结的并集框出领子区域；领结 = 领子区域下半部、
    身体中线附近的亮蓝连通块（领子高光/描边在上半部，被排除；外翼也会被排除）。
    """
    acc = sailor_accent(wo) & (wa > 127)
    ys, xs = np.nonzero(acc)
    if len(xs) < SAILOR_BOW_MIN_PX:
        return None
    ax0, ax1, ay0, ay1 = int(xs.min()), int(xs.max()), int(ys.min()), int(ys.max())
    aw, ah = ax1 - ax0 + 1, ay1 - ay0 + 1
    bow = (vivid_blue(wo) & (wa > 127)).astype(np.uint8)
    n, lab, stats, cent = cv2.connectedComponentsWithStats(bow, 8)
    keep = np.zeros_like(bow)
    for i in range(1, n):
        if stats[i, cv2.CC_STAT_AREA] < 200:
            continue
        if stats[i, cv2.CC_STAT_TOP] < ay0 + 0.35 * ah:  # 领子上半部的高光/描边
            continue
        if abs(cent[i][0] - (ax0 + ax1) / 2.0) > 0.40 * aw:  # 离衣服中线太远 → 不是领结
            continue
        keep[lab == i] = 1
    if int(keep.sum()) < SAILOR_BOW_MIN_PX:
        return None
    return keep


def register_sailor_bow(wo: np.ndarray, wa: np.ndarray,
                        look: np.ndarray) -> tuple[float, float, float, float] | None:
    """用领结做配准：whiteout 领结为 probe，look 亮蓝领结为 target。

    领结在两张图里都完整可见、形状一致；蓝色头发虽然也是亮蓝，但领结是唯一的
    「小型实心领结形状」，全图 IoU 搜索不会被头发带走（实测 IoU≈0.91，发丝不干扰）。
    返回 (scale, dx, dy, iou)；特征提取失败/配准不可信返回 None（调用方回退）。
    """
    probe = sailor_bow_probe(wo, wa)
    if probe is None:
        return None
    target = vivid_blue(look).astype(np.uint8) * 255
    if int((target > 127).sum()) < SAILOR_BOW_MIN_PX:
        return None
    s, dx, dy, iou = register_shape(probe.astype(np.uint8) * 255, target, scales=SAILOR_BOW_SCALES)
    lo, hi = SAILOR_BOW_SCALE_RANGE
    if not (lo <= s <= hi) or iou < SAILOR_BOW_MIN_IOU:
        return None
    return s, dx, dy, iou


def layer_from_whiteout(wo: np.ndarray, wa: np.ndarray, target: np.ndarray,
                        align_probe: str | None = None,
                        look: np.ndarray | None = None,
                        ) -> tuple[np.ndarray, np.ndarray, float, dict]:
    """白底单件图按形状配准回 look 坐标 → (rgb, alpha, iou, 配准信息)。

    配准方式（align_probe）：
      - `bow`（水手服）：用「领结」做显著特征配准（见 register_sailor_bow）。
        领结配准失败 → 回退默认整件形状配准，并在结果里标 fallback。
      - `light`：只拿浅色像素（衬衫主体）做形状配准，深色领子/蝴蝶结不参与。
      - None：整件 alpha 默认形状配准。

    下装不再走这里（v0.10.1 起 `mode='look'` 直接取在体 look），故不再需要整件放大。
    """
    info = {'mode': 'shape', 'fallback': False}
    s = dx = dy = iou = 0.0
    registered = False
    if align_probe == 'bow':
        bow = register_sailor_bow(wo, wa, look) if look is not None else None
        if bow is not None:
            s, dx, dy, iou = bow
            info['mode'] = 'bow'
            registered = True
        else:
            info['fallback'] = True   # 回退默认整件形状配准
    if not registered:
        probe = wa
        if align_probe == 'light':
            light = np.clip(wo, 0, 255).astype(np.uint8).mean(axis=2) > 150
            probe = ((wa > 127) & light).astype(np.uint8) * 255
            info['mode'] = 'light'
        s, dx, dy, iou = register_shape(probe, target)
    info.update({'scale': round(float(s), 4), 'dx': round(float(dx), 2),
                 'dy': round(float(dy), 2), 'iou': round(float(iou), 4)})
    h, w = wo.shape[:2]
    M = np.float32([[s, 0, dx], [0, s, dy]])
    rgb = cv2.warpAffine(np.clip(wo, 0, 255).astype(np.uint8), M, (w, h), flags=cv2.INTER_LINEAR)
    a = cv2.warpAffine(wa, M, (w, h), flags=cv2.INTER_LINEAR)
    return rgb, a, iou, info


# ---------------------------------------------------------------- 蝴蝶结补丁（v6 build patch）

def orange_mask(rgb: np.ndarray) -> np.ndarray:
    """橙色蝴蝶结像素（r-g>60 & g-b>30 & r>170；不误伤肤色/腮红）。"""
    r, g, b = rgb[:, :, 0], rgb[:, :, 1], rgb[:, :, 2]
    return ((r - g > 60) & (g - b > 30) & (r > 170)).astype(np.uint8)


def patch_lost_bow(look: np.ndarray, rgb1152: np.ndarray, a1152: np.ndarray,
                   look_fg: np.ndarray) -> tuple[np.ndarray, np.ndarray, int]:
    """少女版卫衣橙色蝴蝶结在 whiteout 里丢失：从 look 的橙色像素补回主体层。

    只在「whiteout 配准结果几乎没有橙色、而 look 里明显有橙色」时打补丁，
    chibi 的 whiteout 自带蝴蝶结 → 自动跳过，避免重复画。
    返回 (rgb, alpha, 补丁像素数)。
    """
    lo = orange_mask(look)
    wo_orange = int((orange_mask(rgb1152) & (a1152 > 127)).sum())
    look_orange = int(lo.sum())
    if look_orange < BOW_ORANGE_MIN_LOOK:
        return rgb1152, a1152, 0
    # whiteout 已自带蝴蝶结（橙色像素量接近 look，如 chibi）→ 跳过，避免重复画
    if wo_orange >= max(BOW_WHITEOUT_MIN, BOW_WHITEOUT_FRAC * look_orange):
        return rgb1152, a1152, 0
    near = cv2.dilate((a1152 > 127).astype(np.uint8), ellipse(40)) > 0
    patch = (lo > 0) & near & (look_fg > 0)
    # 外扩 1px 收进抗锯齿边缘，避免补丁边缘出现一圈白线
    patch = cv2.dilate(patch.astype(np.uint8), ellipse(1)) > 0
    patch &= near & (look_fg > 0)
    rgb1152 = rgb1152.copy()
    a1152 = a1152.copy()
    rgb1152[patch] = look[patch]
    a1152[patch] = 255.0
    return rgb1152, a1152, int(patch.sum())



# ---------------------------------------------------------------- 袖口线（look 真值）

def hand_region_from_look(look: np.ndarray, arms_src: np.ndarray) -> tuple[np.ndarray, list[int]]:
    """确定「手部」区域（源分辨率 0-255），用于把 sleeve 从手上裁掉。

    验收 §5.1「长袖袖口正确盖住手腕、手在袖口外」：v6 的 sleeve = garment_alpha ×
    dilate(arms)，whiteout 配准有 1-2% 尺度误差时袖子会把 base 的手盖住（v0.8「手消失」
    缺陷会借 sleeve 层复活），所以这里给 sleeve 加一道手部裁切兜底：
      1) 几何兜底：两条手臂连通块各自最下端 22% 一定是手/指尖；
      2) look 真值增强：look 里手臂下半段露出的皮肤（短袖/中袖的前臂）也算手部。
    袖口线以下从 sleeve alpha 里减掉；手臂层在 sleeve 之上，会把 base 的手画回来。
    """
    r, g, b = look[:, :, 0], look[:, :, 1], look[:, :, 2]
    lum = look.mean(axis=2)
    skin = ((r - g > 6) & (g - b > -8) & (r > 200) & (lum > 165))
    n, lab, stats, _ = cv2.connectedComponentsWithStats((arms_src > 127).astype(np.uint8), 8)
    comps = sorted((i for i in range(1, n) if stats[i, cv2.CC_STAT_AREA] > 2000),
                   key=lambda i: -stats[i, cv2.CC_STAT_AREA])[:2]
    h, w = arms_src.shape[:2]
    hand = np.zeros((h, w), bool)
    cuffs: list[int] = []
    for i in comps:
        x0, y0, ww, hh = (stats[i, cv2.CC_STAT_LEFT], stats[i, cv2.CC_STAT_TOP],
                          stats[i, cv2.CC_STAT_WIDTH], stats[i, cv2.CC_STAT_HEIGHT])
        m = (lab == i)
        geom = np.zeros_like(m)
        geom[y0 + int(0.78 * hh):y0 + hh, :] = True
        geom &= m
        low = np.zeros_like(m)
        low[y0 + int(0.55 * hh):y0 + hh, :] = True
        sm = cv2.dilate((skin & m & low).astype(np.uint8), np.ones((9, 9), np.uint8)) > 0
        sm &= m
        part = geom | sm
        hand |= part
        ys = np.nonzero(part.any(axis=1))[0]
        cuffs.append(int(ys.min()) if len(ys) else -1)
    return (hand.astype(np.uint8)) * 255, cuffs

# ---------------------------------------------------------------- 单身形构建

def build_garment(shape: str, cat: str, ident: str, src: Path, base: np.ndarray,
                  arms_target: np.ndarray, arms_src: np.ndarray,
                  hair_src: np.ndarray) -> dict:
    """构建一件上衣/连衣裙/下装的 body（+sleeve）层（源分辨率 matte → 目标尺寸 webp 像素）。

    返回 {'layers': {slot: (rgb, alpha)}, 'iou': float, 'bow_px': int, 'skirt': dict}
    """
    cfg = LAYER_PLAN[(cat, ident)]
    if cfg['mode'] == 'look':
        # 下装：使用「及膝」在体 look（AI 编辑旧 look 得到，保持角色/姿势/画布不变）
        look_path = src / f'{shape}-only-{cat}-{ident}{cfg.get("look_suffix", "")}.png'
        if not look_path.exists():
            raise SystemExit(f'缺少及膝 look: {look_path}（见 PROMPTS.md §2）')
    else:
        look_path = src / f'{shape}-only-{cat}-{ident}.png'
        look_v2 = src / f'{shape}-only-{cat}-{ident}-v2.png'
        if cfg['mode'] == 'whiteout' and look_v2.exists():
            look_path = look_v2
    look = load_rgb(look_path)
    look_fg = remove_white_alpha(look) > 40  # 该 look 自身的前景（白底图的轮廓内部都算）
    iou = 0.0
    bow_px = 0
    align: dict = {}
    skirt: dict = {}
    if cfg['mode'] == 'look':
        mask, skirt = skirt_mask_from_look(look, base, hair_src, arms_src)
        iou = float(skirt['iou'])
        # 在体 look 直接成层：alpha = 裙掩膜羽化，RGB = look（格纹/腰带/褶皱原样）
        a1152 = np.clip(cv2.GaussianBlur(mask.astype(np.float32) * 255.0, (0, 0), 0.9) * 1.05 - 6, 0, 255)
        rgb1152 = np.clip(look, 0, 255).astype(np.uint8)
    elif cfg['mode'] == 'whiteout':
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
        rgb1152, a1152, iou, align = layer_from_whiteout(
            wo, wa, target, align_probe=cfg.get('align_probe'), look=look)
        # v6：不再挖头发洞（最上层 hair 负责盖回）；只做羽化，保持衣服完整
        a1152 = np.clip(cv2.GaussianBlur(a1152.astype(np.float32), (0, 0), 0.9) * 1.05 - 6, 0, 255)
        if (cat, ident) == ('top', 'hoodie'):
            rgb1152, a1152, bow_px = patch_lost_bow(look, rgb1152, a1152, look_fg)
    else:
        mask = matte(look, base, cfg)
        if mask is None:
            raise SystemExit(f'抠图失败: {shape} {cat}-{ident}')
        # 硬约束：图层不能包含 look 的背景（白底），否则会把白块贴上舞台
        mask = mask & cv2.dilate(look_fg.astype(np.uint8), np.ones((5, 5), np.uint8))
        a1152 = np.clip(cv2.GaussianBlur(mask.astype(np.float32) * 255.0, (0, 0), 0.9) * 1.12 - 12, 0, 255)
        rgb1152 = np.clip(look, 0, 255).astype(np.uint8)
    l_rgb, l_alpha = resize_rgba(np.clip(rgb1152, 0, 255).astype(np.uint8), a1152)

    main_slot = MAIN_SLOT.get((cat, ident), 'bottom')
    layers: dict[str, tuple[np.ndarray, np.ndarray]] = {main_slot: (l_rgb, l_alpha)}
    if cat != 'bottom':
        # sleeve = garment_alpha × dilate(arms_mask_target, 6px)，羽化 1px；RGB 与主体层完全相同
        arm_bin = (arms_target > 127).astype(np.uint8)
        grown = cv2.dilate(arm_bin, ellipse(SLEEVE_DILATE_PX)).astype(np.float32)
        sleeve = (l_alpha.astype(np.float32) / 255.0) * grown
        # 验收 §5.1 兜底：用 look 真值的袖口线减掉手部（否则配准误差会让袖口盖住手 → 手消失）
        hand_src, cuffs = hand_region_from_look(look, arms_src)
        if cuffs:
            hand_t = resize_alpha(hand_src) / 255.0
            sleeve = sleeve * (1.0 - hand_t)
        sleeve = cv2.GaussianBlur(sleeve, (3, 3), SLEEVE_FEATHER_SIGMA)
        sleeve = np.clip(sleeve, 0, 1) * 255.0
        if float((sleeve > 20).mean()) >= SLEEVE_MIN_FRAC:
            layers['sleeve'] = (l_rgb.copy(), sleeve)
    return {'layers': layers, 'iou': float(iou), 'bow_px': bow_px, 'look': look,
            'align': align, 'skirt': skirt, 'cuffs': cuffs if cat != 'bottom' else []}


def build_qa_sheet(shape: str, name: str, qa_dir: Path, shape_px: dict,
                   item_px: dict) -> None:
    """v9-layers-<shape>.jpg：全部组合 + 女仆装 + 单层 + 单件拼图。"""

    def layers_for(outfit: str | None = None, top: str | None = None, bottom: str | None = None):
        chosen: dict[str, tuple[np.ndarray, np.ndarray]] = {'body': shape_px['body']}
        if outfit:
            chosen.update(item_px[('dress', outfit)])
        else:
            if top:
                chosen.update(item_px[('top', top)])
            if bottom:
                chosen.update(item_px[('bottom', bottom)])
        for slot in SHAPE_SLOTS:
            chosen.setdefault(slot, shape_px[slot])
        return [chosen[slot] for slot in DRAW_ORDER if slot in chosen]

    cells: list[tuple[str, np.ndarray]] = []
    for top, _, _ in TOPS:
        for bottom, _, _ in BOTTOMS:
            cells.append((f'{top}+{bottom}', compose(layers_for(top=top, bottom=bottom))[0]))
    for ident, _, _ in DRESSES:
        cells.append((f'dress-{ident}', compose(layers_for(outfit=ident))[0]))
    cells.append(('bare-body+arms+hair', compose(layers_for())[0]))
    for ident, _, _ in TOPS:
        cells.append((f'only-{ident}', compose(layers_for(top=ident))[0]))
    for ident, _, _ in BOTTOMS:
        cells.append((f'only-{ident}', compose(layers_for(bottom=ident))[0]))

    W, H, cols = 250, 445, 5
    rows = (len(cells) + cols - 1) // cols
    sheet = Image.new('RGB', (cols * W, rows * (H + 18)), (255, 255, 255))
    draw = ImageDraw.Draw(sheet)
    for i, (label, img) in enumerate(cells):
        sheet.paste(Image.fromarray(img).resize((W, H), Image.LANCZOS),
                    ((i % cols) * W, (i // cols) * (H + 18)))
        draw.text(((i % cols) * W + 4, (i // cols) * (H + 18) + H + 3), label, fill=(30, 30, 30))
    qa_dir.mkdir(parents=True, exist_ok=True)
    sheet.save(qa_dir / f'v9-layers-{shape}.jpg', quality=90)


def _crop2x(img: np.ndarray, x0f: float, x1f: float, y0f: float, y1f: float,
            scale: int = 2) -> np.ndarray:
    h, w = img.shape[:2]
    x0, x1 = int(w * x0f), int(w * x1f)
    y0, y1 = int(h * y0f), int(h * y1f)
    crop = img[y0:y1, x0:x1]
    return cv2.resize(crop, ((x1 - x0) * scale, (y1 - y0) * scale), interpolation=cv2.INTER_NEAREST)


def build_audit(shape: str, audit_dir: Path, shape_px: dict, item_px: dict,
                look_src: dict, stats: dict) -> None:
    """洋红底空洞检查 + 手在裙前 / 长发在衣服前 / 蝴蝶结 局部审计图。"""
    audit_dir.mkdir(parents=True, exist_ok=True)

    def layers_for(outfit=None, top=None, bottom=None, with_hair=True):
        chosen: dict[str, tuple[np.ndarray, np.ndarray]] = {'body': shape_px['body']}
        if outfit:
            chosen.update(item_px[('dress', outfit)])
        else:
            if top:
                chosen.update(item_px[('top', top)])
            if bottom:
                chosen.update(item_px[('bottom', bottom)])
        for slot in ('arms', 'hair'):
            chosen[slot] = shape_px[slot]
        return [chosen[slot] for slot in DRAW_ORDER if slot in chosen
                and (with_hair or slot != 'hair')]

    # ---- 洋红底空洞检查（所有组合）----
    combos = [(f'{t}+{b}', dict(top=t, bottom=b)) for t, _, _ in TOPS for b, _, _ in BOTTOMS]
    combos += [(f'dress-{i}', dict(outfit=i)) for i, _, _ in DRESSES]
    combos += [('bare', {})]
    holes_report = {}
    cells = []
    for label, kw in combos:
        layer_list = layers_for(**kw)
        union_a = np.zeros((TARGET[1], TARGET[0]), np.float32)
        for _, al in layer_list:
            union_a = np.maximum(union_a, al.astype(np.float32))
        comp, _ = compose(layer_list, opaque_bg=(255, 0, 255))
        magenta = (comp[:, :, 0] > 235) & (comp[:, :, 1] < 25) & (comp[:, :, 2] > 235)
        sil = fill_holes((union_a > 20).astype(np.uint8)) > 0
        sil = cv2.erode(sil.astype(np.uint8), np.ones((5, 5), np.uint8)) > 0
        body_a = shape_px['body'][1]
        bad_hole = magenta & sil & (body_a > 200)     # 身体不透明区出现洋红 = 真缺陷（构造上应为 0）
        bg_gap = magenta & sil & (body_a <= 200)      # 发丝/手臂围出的背景缝隙（素材固有，正常）
        n_bad, n_gap = int(bad_hole.sum()), int(bg_gap.sum())
        n_comp, _, cstats, _ = cv2.connectedComponentsWithStats(bad_hole.astype(np.uint8), 8)
        bad_max = int(cstats[1:, cv2.CC_STAT_AREA].max()) if n_comp > 1 else 0
        holes_report[label] = {'bad': n_bad, 'bad_max': bad_max, 'bg_gap': n_gap}
        cell = comp.copy()
        if n_bad:
            cell[bad_hole] = (255, 0, 0)
        if n_gap:
            cell[bg_gap] = (0, 160, 0)
        cells.append((f'{label} bad={n_bad} bg_gap={n_gap}', cell))
    W, H, cols = 250, 445, 4
    rows = (len(cells) + cols - 1) // cols
    sheet = Image.new('RGB', (cols * W, rows * (H + 18)), (20, 20, 20))
    draw = ImageDraw.Draw(sheet)
    for i, (label, img) in enumerate(cells):
        sheet.paste(Image.fromarray(img).resize((W, H), Image.LANCZOS),
                    ((i % cols) * W, (i // cols) * (H + 18)))
        draw.text(((i % cols) * W + 4, (i // cols) * (H + 18) + H + 3), label, fill=(240, 240, 240))
    sheet.save(audit_dir / f'magenta-holes-{shape}.jpg', quality=90)
    stats.setdefault('magenta_holes', {})[shape] = holes_report

    # ---- 手在裙前：下摆两侧 2x 局部放大（白底）----
    hand_cells = []
    for label, kw in (('sweater+plaid', dict(top='sweater', bottom='plaid')),
                      ('hoodie+pleated', dict(top='hoodie', bottom='pleated'))):
        comp, _ = compose(layers_for(**kw))
        for side, (x0, x1) in (('L', (0.10, 0.42)), ('R', (0.58, 0.90))):
            crop = _crop2x(comp, x0, x1, 0.52, 0.74)
            hand_cells.append((f'{label} {side} hand/skirt', crop))
    cw = max(c.shape[1] for _, c in hand_cells)
    chh = max(c.shape[0] for _, c in hand_cells)
    sheet = Image.new('RGB', (2 * cw, 2 * (chh + 16)), (255, 255, 255))
    draw = ImageDraw.Draw(sheet)
    for i, (label, crop) in enumerate(hand_cells):
        x, y = (i % 2) * cw, (i // 2) * (chh + 16)
        sheet.paste(Image.fromarray(crop), (x, y))
        draw.text((x + 4, y + chh + 2), label, fill=(30, 30, 30))
    sheet.save(audit_dir / f'hand-in-front-skirt-{shape}.jpg', quality=92)

    # ---- 长发丝在衣服前：with hair vs without hair 对比 ----
    comp_h, _ = compose(layers_for(top='sweater', bottom='plaid', with_hair=True))
    comp_n, _ = compose(layers_for(top='sweater', bottom='plaid', with_hair=False))
    crop_h = _crop2x(comp_h, 0.14, 0.86, 0.42, 0.80)
    crop_n = _crop2x(comp_n, 0.14, 0.86, 0.42, 0.80)
    w, hh = crop_h.shape[1], crop_h.shape[0]
    sheet = Image.new('RGB', (2 * w, hh + 18), (255, 255, 255))
    draw = ImageDraw.Draw(sheet)
    sheet.paste(Image.fromarray(crop_n), (0, 0))
    sheet.paste(Image.fromarray(crop_h), (w, 0))
    draw.text((4, hh + 3), 'no hair layer', fill=(30, 30, 30))
    draw.text((w + 4, hh + 3), 'with hair layer (v9) - strands over clothes', fill=(30, 30, 30))
    sheet.save(audit_dir / f'hair-over-clothes-{shape}.jpg', quality=92)

    # ---- 少女卫衣橙色蝴蝶结局部 ----
    if shape == 'girl':
        comp, _ = compose(layers_for(top='hoodie'))
        crop_final = _crop2x(comp, 0.38, 0.62, 0.32, 0.44, scale=4)
        # look 真值：look 白底抠图 → 目标尺寸，同一坐标裁切
        look = look_src[('top', 'hoodie')]
        look_fg = remove_white_alpha(look)
        l_rgb, l_a = resize_rgba(look, look_fg)
        white = np.full((TARGET[1], TARGET[0], 3), 255.0, np.float32)
        truth, _ = compose([(l_rgb, l_a)], opaque_bg=(255, 255, 255))
        crop_truth = _crop2x(truth, 0.38, 0.62, 0.32, 0.44, scale=4)
        # 仅主体层（body+garment）看蝴蝶结是否在图层里
        g_layers = item_px[('top', 'hoodie')]
        body_layer = g_layers[item_px_top_slot(g_layers)]
        cell, _ = compose([shape_px['body'], body_layer], opaque_bg=(255, 255, 255))
        crop_layer = _crop2x(cell, 0.38, 0.62, 0.32, 0.44, scale=4)
        w2, h2 = crop_final.shape[1], crop_final.shape[0]
        sheet = Image.new('RGB', (3 * w2, h2 + 18), (255, 255, 255))
        draw = ImageDraw.Draw(sheet)
        for i, (label, crop) in enumerate((('final composite', crop_final),
                                           ('look ground truth', crop_truth),
                                           ('body layer only', crop_layer))):
            sheet.paste(Image.fromarray(crop), (i * w2, 0))
            draw.text((i * w2 + 4, h2 + 3), label, fill=(30, 30, 30))
        sheet.save(audit_dir / 'bow-girl-hoodie.jpg', quality=92)

    # ---- 袖子/衣身接缝 2x 检查 ----
    seam_cells = []
    for label, kw in (('sweater+plaid', dict(top='sweater', bottom='plaid')),):
        comp, _ = compose(layers_for(**kw))
        seam_cells.append((f'{label} waist 2x', _crop2x(comp, 0.28, 0.72, 0.38, 0.56, scale=2)))
        seam_cells.append((f'{label} cuff 2x', _crop2x(comp, 0.12, 0.40, 0.48, 0.62, scale=2)))
        seam_cells.append((f'{label} cuff R 2x', _crop2x(comp, 0.60, 0.88, 0.48, 0.62, scale=2)))
    w3 = max(c.shape[1] for _, c in seam_cells)
    h3 = max(c.shape[0] for _, c in seam_cells)
    sheet = Image.new('RGB', (w3, len(seam_cells) * (h3 + 16)), (255, 255, 255))
    draw = ImageDraw.Draw(sheet)
    for i, (label, crop) in enumerate(seam_cells):
        sheet.paste(Image.fromarray(crop), (0, i * (h3 + 16)))
        draw.text((4, i * (h3 + 16) + h3 + 2), label, fill=(30, 30, 30))
    sheet.save(audit_dir / f'seam-2x-{shape}.jpg', quality=92)

    # ---- 与单件 look 真值对照：build 合成 vs look vs 差异热图（查配准/抠图/丢失部件）----
    look_pairs = [('sweater', ('top', 'sweater'), dict(top='sweater')),
                  ('hoodie', ('top', 'hoodie'), dict(top='hoodie')),
                  ('sailor', ('top', 'sailor'), dict(top='sailor')),
                  ('plaid', ('bottom', 'plaid'), dict(bottom='plaid')),
                  ('pleated', ('bottom', 'pleated'), dict(bottom='pleated')),
                  ('maid', ('dress', 'maid'), dict(outfit='maid'))]
    rows = []
    look_diff = {}
    for label, key, kw in look_pairs:
        comp, _ = compose(layers_for(**kw))
        look = look_src[key]
        look_fg = remove_white_alpha(look)
        l_rgb, l_a = resize_rgba(look, look_fg)
        truth, _ = compose([(l_rgb, l_a)], opaque_bg=(255, 255, 255))
        diff = np.abs(comp.astype(np.int16) - truth.astype(np.int16)).max(axis=2)
        fg = l_a > 40
        look_diff[label] = round(float(diff[fg].mean()), 2) if fg.any() else 0.0
        heat = np.full((TARGET[1], TARGET[0], 3), 255, np.uint8)
        hot = diff > 40
        heat[hot] = (255, 60, 60)
        rows.append((label, comp, truth, heat))
    W, H, cols = 250, 445, 3
    sheet = Image.new('RGB', (cols * W, len(rows) * (H + 16)), (255, 255, 255))
    draw = ImageDraw.Draw(sheet)
    for r, (label, comp, truth, heat) in enumerate(rows):
        for c, img in enumerate((comp, truth, heat)):
            x, y = c * W, r * (H + 16)
            sheet.paste(Image.fromarray(img).resize((W, H), Image.LANCZOS), (x, y))
            tag = ('build', 'look-truth', 'diff>40')[c]
            draw.text((x + 3, y + H + 2), f'{label} {tag}', fill=(30, 30, 30))
    sheet.save(audit_dir / f'look-vs-build-{shape}.jpg', quality=90)
    stats['look_diff'] = look_diff

    # ---- 身体部件层（body/arms/hair）单独可视化：确认 arms 是完整双臂+手、hair 完整 ----
    body_rgb = shape_px['body'][0]
    mag = np.zeros((TARGET[1], TARGET[0], 3), np.float32)
    mag[:] = (255, 0, 255)
    layer_cells = []
    layer_cells.append(('body (full base)', compose([shape_px['body']], opaque_bg=(255, 0, 255))[0]))
    layer_cells.append(('arms layer', compose([shape_px['arms']], opaque_bg=(255, 0, 255))[0]))
    layer_cells.append(('hair layer', compose([shape_px['hair']], opaque_bg=(255, 0, 255))[0]))
    layer_cells.append(('arms+body', compose([shape_px['body'], shape_px['arms']], opaque_bg=(255, 0, 255))[0]))
    W, H = 250, 445
    sheet = Image.new('RGB', (len(layer_cells) * W, H + 16), (20, 20, 20))
    draw = ImageDraw.Draw(sheet)
    for i, (label, img) in enumerate(layer_cells):
        sheet.paste(Image.fromarray(img).resize((W, H), Image.LANCZOS), (i * W, 0))
        draw.text((i * W + 3, H + 2), label, fill=(240, 240, 240))
    sheet.save(audit_dir / f'shape-layers-{shape}.jpg', quality=90)

    # ---- 头发层「白衣服上的淡蓝鬼影」检查：低饱和高亮像素若被 hair 掩膜包进来就会盖到衣服上 ----
    lum = body_rgb.mean(axis=2)
    mx, mn = body_rgb.max(axis=2), body_rgb.min(axis=2)
    sat = (mx - mn) / np.maximum(mx, 1)
    ghost = (shape_px['hair'][1] > 127) & (sat < 0.18) & (lum > 180)
    stats['hair_ghost_px'] = int(ghost.sum())
    ghost_comp, _ = compose(layers_for(top='sweater', bottom='plaid'))
    ghost_vis = ghost_comp.copy()
    ghost_vis[ghost] = (255, 0, 0)
    crop_ghost = _crop2x(ghost_vis, 0.24, 0.76, 0.30, 0.62, scale=4)
    Image.fromarray(crop_ghost).save(audit_dir / f'hair-ghost-{shape}.jpg', quality=92)
    # 白毛衣 4x 特写（无高亮，直接肉眼看有无淡蓝鬼影；chibi 是重灾区）
    crop_sweater = _crop2x(ghost_comp, 0.26, 0.74, 0.28, 0.62, scale=4)
    Image.fromarray(crop_sweater).save(audit_dir / f'sweater-4x-{shape}.jpg', quality=92)

    # ---- maid + plaid 正面腰部特写（检查背部中央那缕头发有没有在裙面/围裙上留下深色竖线）----
    waist_cells = []
    for label, kw in (('maid', dict(outfit='maid')), ('plaid only', dict(bottom='plaid'))):
        comp, _ = compose(layers_for(**kw))
        waist_cells.append((label, _crop2x(comp, 0.34, 0.66, 0.42, 0.68, scale=3)))
    ww = max(c.shape[1] for _, c in waist_cells)
    hh = max(c.shape[0] for _, c in waist_cells)
    sheet = Image.new('RGB', (len(waist_cells) * ww, hh + 16), (255, 255, 255))
    draw = ImageDraw.Draw(sheet)
    for i, (label, crop) in enumerate(waist_cells):
        sheet.paste(Image.fromarray(crop), (i * ww, 0))
        draw.text((i * ww + 4, hh + 2), f'{label} front waist 3x', fill=(30, 30, 30))
    sheet.save(audit_dir / f'waist-center-{shape}.jpg', quality=92)


def item_px_top_slot(layers: dict) -> str:
    for slot in ('topBody', 'topUnder'):
        if slot in layers:
            return slot
    raise KeyError(layers.keys())


def build_shape(shape: str, src: Path, out: Path, qa_dir: Path, audit_dir: Path,
                masks_dir: Path) -> dict:
    print(f'[{shape}] 读素体 / 掩膜 / 图层 …')
    base = load_rgb(src / f'base-bandeau-{shape}.png')
    base_alpha = remove_white_alpha(base)
    art = out / 'art' / shape
    (art / 'layers').mkdir(parents=True, exist_ok=True)

    b_rgb, b_alpha = resize_rgba(base, base_alpha)
    save_webp(b_rgb, b_alpha, art / 'body.webp')
    ys, xs = np.nonzero(b_alpha > 40)
    bounds = {'top': round(float(ys.min()) / TARGET[1], 4), 'bottom': round(float(ys.max() + 1) / TARGET[1], 4)}

    arms_src = load_mask(masks_dir / shape / 'arms.png')
    hair_src = load_mask(masks_dir / shape / 'hair.png')
    arms_alpha = (arms_src.astype(np.uint16) * base_alpha.astype(np.uint16) // 255).astype(np.uint8)
    hair_alpha = (hair_src.astype(np.uint16) * base_alpha.astype(np.uint16) // 255).astype(np.uint8)
    a_rgb, a_alpha = resize_rgba(base, arms_alpha)
    h_rgb, h_alpha = resize_rgba(base, hair_alpha)
    save_webp(a_rgb, a_alpha, art / 'arms.webp')
    save_webp(h_rgb, h_alpha, art / 'hair.webp')
    arms_target = resize_alpha(arms_src)
    print(f'  body/arms/hair 面积: arms={float((a_alpha > 40).mean()):.1%} '
          f'hair={float((h_alpha > 40).mean()):.1%}')

    shape_px = {'body': (b_rgb, b_alpha), 'arms': (a_rgb, a_alpha), 'hair': (h_rgb, h_alpha)}
    shape_layers = {'body': f'art/{shape}/body.webp',
                    'arms': f'art/{shape}/arms.webp',
                    'hair': f'art/{shape}/hair.webp'}
    item_layers: dict[tuple[str, str], dict[str, str]] = {}
    item_px: dict[tuple[str, str], dict[str, tuple[np.ndarray, np.ndarray]]] = {}
    look_src: dict[str, np.ndarray] = {}
    stats: dict = {'sleeve': {}, 'bow': {}, 'iou': {}}

    for cat, ids in (('dress', DRESSES), ('top', TOPS), ('bottom', BOTTOMS)):
        for ident, _, _ in ids:
            g = build_garment(shape, cat, ident, src, base, arms_target, arms_src, hair_src)
            look_src[(cat, ident)] = g['look']
            main_slot = MAIN_SLOT.get((cat, ident), 'bottom')
            rels: dict[str, str] = {}
            for slot, (rgb, alpha) in g['layers'].items():
                if slot == 'bottom':
                    rel = f'art/{shape}/layers/bottom-{ident}.webp'
                else:
                    # 契约 §2/§3：主体层统一 *-body.webp，袖子 *-sleeve.webp（manifest 里再映射到 topBody/topUnder）
                    suffix = '-body' if slot in ('topBody', 'topUnder') else f'-{slot}'
                    rel = f'art/{shape}/layers/{cat}-{ident}{suffix}.webp'
                save_webp(rgb, alpha, out / rel)
                rels[slot] = rel
            item_layers[(cat, ident)] = rels
            item_px[(cat, ident)] = g['layers']
            stats['iou'][f'{cat}-{ident}'] = round(g['iou'], 3)
            if g.get('skirt'):
                sk = dict(g['skirt'])
                a = g['layers'][main_slot][1]
                sy_, sx_ = np.nonzero(a > 127)
                sk['layer_bbox'] = [int(sx_.min()), int(sy_.min()),
                                    int(sx_.max() - sx_.min() + 1), int(sy_.max() - sy_.min() + 1)]
                sk['layer_waist_y'] = round(float(sy_.min()) / TARGET[1], 4)
                sk['layer_hem_y'] = round(float(sy_.max() + 1) / TARGET[1], 4)
                stats.setdefault('skirt', {})[f'{cat}-{ident}'] = sk
            stats['bow'][f'{cat}-{ident}'] = g['bow_px']
            if g.get('align'):
                stats.setdefault('align', {})[f'{cat}-{ident}'] = g['align']
            if g.get('cuffs'):
                stats.setdefault('cuffs', {})[f'{cat}-{ident}'] = g['cuffs']
            sleeve_a = g['layers'].get('sleeve')
            if sleeve_a is not None:
                stats['sleeve'][f'{cat}-{ident}'] = round(float((sleeve_a[1] > 40).mean()), 4)
            area = round(float((g['layers'][main_slot][1] > 40).mean()), 4)
            align_note = ''
            if g.get('align') and g['align'].get('mode') == 'bow':
                al = g['align']
                align_note = (f' 领结配准 s={al["scale"]:.2f} dx={al["dx"]:.0f} '
                              f'dy={al["dy"]:.0f} iou={al["iou"]:.2f}')
            elif g.get('align') and g['align'].get('fallback'):
                align_note = ' 领结配准失败→回退整件形状配准'
            print(f'  {cat}-{ident}: 主体面积 {area:.1%}'
                  + (f' sleeve {stats["sleeve"].get(f"{cat}-{ident}", 0):.1%}'
                     if 'sleeve' in g['layers'] else ' 无袖')
                  + (f' 蝴蝶结补丁 {g["bow_px"]}px' if g['bow_px'] else '')
                  + align_note)
            if g.get('skirt'):
                sk = g['skirt']
                print(f'    在体 look 成层: 腰线y={sk["top"]} 下摆y={sk["hem"]} '
                      f'腰宽={sk["waist_w"]} 摆宽={sk["hem_w"]} '
                      f'look-diff IoU={sk["iou"]:.3f}（源 1152×2048，不缩放）')

    build_qa_sheet(shape, shape, qa_dir, shape_px, item_px)
    build_audit(shape, audit_dir, shape_px, item_px, look_src, stats)

    # ---- 程序化验收指标（手在裙前 / 长发在衣服前）----
    def layers_for(outfit=None, top=None, bottom=None):
        chosen: dict[str, tuple[np.ndarray, np.ndarray]] = {'body': shape_px['body']}
        if outfit:
            chosen.update(item_px[('dress', outfit)])
        else:
            if top:
                chosen.update(item_px[('top', top)])
            if bottom:
                chosen.update(item_px[('bottom', bottom)])
        for slot in ('arms', 'hair'):
            chosen[slot] = shape_px[slot]
        return [chosen[slot] for slot in DRAW_ORDER if slot in chosen]

    def visible_frac(comp, mask, rgb_ref):
        m = mask & (np.abs(comp.astype(np.int16) - rgb_ref.astype(np.int16)).max(axis=2) < 16)
        return float(m.sum()) / max(int(mask.sum()), 1)

    def hand_free_frac(comp, mask):
        """手部区域最上层不是衣服（= arms 或 hair 层）的比例；发丝压手属正常构图。"""
        ok = np.zeros_like(mask)
        for ref in (shape_px['arms'][0], shape_px['hair'][0]):
            ok |= np.abs(comp.astype(np.int16) - ref.astype(np.int16)).max(axis=2) < 16
        return float((mask & ok).sum()) / max(int(mask.sum()), 1)

    hand_checks = {}
    h_alpha = shape_px['arms'][1]
    # 手部核心区 = 两条手臂连通块各自最下端 12%（指尖/手心，任何长袖都不该盖住这里）
    n_arm, lab_arm, stats_arm, _ = cv2.connectedComponentsWithStats((h_alpha > 127).astype(np.uint8), 8)
    comps = sorted((i for i in range(1, n_arm) if stats_arm[i, cv2.CC_STAT_AREA] > 800),
                   key=lambda i: -stats_arm[i, cv2.CC_STAT_AREA])[:2]
    hand_mask = np.zeros((TARGET[1], TARGET[0]), bool)
    for i in comps:
        top = stats_arm[i, cv2.CC_STAT_TOP]
        hgt = stats_arm[i, cv2.CC_STAT_HEIGHT]
        band = lab_arm == i
        band[: int(top + 0.88 * hgt), :] = False
        hand_mask |= band
    # 去掉 1px 抗锯齿边缘（边缘与下层混色，不代表手被遮住）
    hand_mask = cv2.erode(hand_mask.astype(np.uint8), np.ones((3, 3), np.uint8)) > 0
    for top, _, _ in TOPS:
        for bottom, _, _ in BOTTOMS:
            comp, _ = compose(layers_for(top=top, bottom=bottom))
            frac = hand_free_frac(comp, hand_mask)
            hand_checks[f'{top}+{bottom}'] = round(frac, 3)
    for ident, _, _ in DRESSES:
        comp, _ = compose(layers_for(outfit=ident))
        hand_checks[f'dress-{ident}'] = round(hand_free_frac(comp, hand_mask), 3)
    stats['hand_core_visible'] = hand_checks
    hair_over = {}
    for top in ('sweater', 'hoodie'):
        for bottom in ('plaid', 'pleated'):
            comp, _ = compose(layers_for(top=top, bottom=bottom))
            gmask = np.zeros((TARGET[1], TARGET[0]), bool)
            for layer in item_px[('top', top)].values():
                gmask |= layer[1] > 127
            if bottom:
                gmask |= item_px[('bottom', bottom)][('bottom')][1] > 127
            m = (shape_px['hair'][1] > 200) & gmask
            hair_over[f'{top}+{bottom}'] = round(visible_frac(comp, m, shape_px['hair'][0]), 3)
    stats['hair_over_clothes'] = hair_over
    print(f'  QA: 手部核心区未被衣服覆盖比例 {hand_checks}')
    print(f'  QA: 长发盖在衣服上可见 {hair_over}')
    return {'shape': shape, 'bounds': bounds, 'shape_layers': shape_layers,
            'item_layers': item_layers, 'item_px': item_px, 'shape_px': shape_px,
            'stats': stats}


# ---------------------------------------------------------------- pet / 图标 / 背景缩略图

def build_pet_default(out: Path, chibi: dict) -> None:
    """悬浮鲸鱼兜底图：按 drawOrder 合成默认穿搭（Q 版女仆装），184×327 透明背景。"""
    shape_px = chibi['shape_px']
    chosen = {'body': shape_px['body']}
    chosen.update(chibi['item_px'][('dress', 'maid')])
    for slot in ('arms', 'hair'):
        chosen[slot] = shape_px[slot]
    layers = [chosen[slot] for slot in DRAW_ORDER if slot in chosen]
    img, acc = compose(layers, opaque_bg=None)
    ys, xs = np.nonzero(acc > 20)
    img = img[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
    acc = acc[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
    ratio = min(184 / acc.shape[1], 327 / acc.shape[0])
    nw, nh = max(1, round(acc.shape[1] * ratio)), max(1, round(acc.shape[0] * ratio))
    prgb, pa = resize_premult(img, acc, (nw, nh))
    pet = np.zeros((327, 184, 4), np.uint8)
    x0, y0 = (184 - nw) // 2, (327 - nh) // 2
    pet[y0:y0 + nh, x0:x0 + nw, :3] = np.clip(prgb, 0, 255).astype(np.uint8)
    pet[y0:y0 + nh, x0:x0 + nw, 3] = np.clip(pa, 0, 255).astype(np.uint8)
    target = out / 'art' / 'pet-default.webp'
    tmp = target.with_name(target.name + '.tmp')
    target.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(pet).save(tmp, 'WEBP', quality=85, method=6)
    os.replace(tmp, target)
    print(f'  pet-default -> {target.relative_to(out)}  ({nw}x{nh} in 184x327)')


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


# ---------------------------------------------------------------- manifest v6

def _item_layers_for(shape_info: dict, cat_key: str, ident: str) -> dict:
    layers = {}
    for sid, _, _ in SHAPES:
        info = shape_info.get(sid)
        if not info:
            continue
        lay = info['item_layers'].get((cat_key, ident))
        if lay:
            layers[sid] = {slot: lay[slot] for slot in ITEM_SLOTS if slot in lay}
    return layers


def build_manifest(shape_info: dict) -> dict:
    items = {'outfits': [{'id': 'none', 'name': '不穿套装', 'emoji': '🚫', 'desc': '换成上衣 + 下装搭配。'}]}
    for ident, name, desc in DRESSES:
        items['outfits'].append({'id': ident, 'name': name, 'desc': desc,
                                 'icon': f'art/icons/{ident}.webp',
                                 'layers': _item_layers_for(shape_info, 'dress', ident)})
    items['tops'] = [{'id': ident, 'name': name, 'desc': desc, 'icon': f'art/icons/{ident}.webp',
                      'layers': _item_layers_for(shape_info, 'top', ident)}
                     for ident, name, desc in TOPS]
    items['bottoms'] = [{'id': ident, 'name': name, 'desc': desc, 'icon': f'art/icons/{ident}.webp',
                         'layers': _item_layers_for(shape_info, 'bottom', ident)}
                        for ident, name, desc in BOTTOMS]
    items['backgrounds'] = [{'id': i, 'name': n, 'desc': d, 'file': f'art/{i}.webp',
                             'thumb': f'art/thumbs/{i}.webp', 'floor': floor}
                            for i, n, d, floor in BACKGROUNDS]
    items['effects'] = [{'id': i, 'name': n, 'desc': d, 'emoji': e} for i, n, d, e in EFFECTS]
    return {
        'version': 6,
        'title': '大肥鱼衣橱 · 换装间',
        'character': '大肥鱼 · 经典鲸鱼娘',
        'credits': CREDITS,
        'drawOrder': DRAW_ORDER,
        'shapes': [{'id': sid, 'name': name, 'desc': desc,
                    'bounds': shape_info[sid]['bounds'],
                    'layers': {slot: shape_info[sid]['shape_layers'][slot] for slot in SHAPE_SLOTS}}
                   for sid, name, desc in SHAPES if sid in shape_info],
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


def validate_build(out: Path, manifest: dict) -> list[str]:
    """校验 manifest 与素材：schema v6 + 文件存在 + 尺寸正确 + v5 字段已移除。"""
    problems: list[str] = []
    if manifest.get('version') != 6:
        problems.append(f'version != 6: {manifest.get("version")}')
    if manifest.get('drawOrder') != DRAW_ORDER:
        problems.append(f'drawOrder 不符合契约: {manifest.get("drawOrder")}')
    for shape in manifest.get('shapes', []):
        if set(shape) & {'base', 'overlay'}:
            problems.append(f'shape {shape["id"]} 仍含 v5 字段 base/overlay')
        if set(shape.get('layers', {})) != set(SHAPE_SLOTS):
            problems.append(f'shape {shape["id"]} layers 槽位不全: {list(shape.get("layers", {}))}')
        for slot, rel in shape.get('layers', {}).items():
            p = out / rel
            if not p.exists():
                problems.append(f'缺文件 {rel}')
                continue
            w, h = Image.open(p).size
            if (w, h) != TARGET:
                problems.append(f'{rel} 尺寸 {w}x{h} != {TARGET[0]}x{TARGET[1]}')
    for cat in ('outfits', 'tops', 'bottoms'):
        for item in manifest['items'][cat]:
            if item['id'] == 'none':
                continue
            if 'layer' in item or 'z' in item:
                problems.append(f'item {item["id"]} 仍含 v5 字段 layer/z')
            for sid, lay in item.get('layers', {}).items():
                for slot, rel in lay.items():
                    if slot not in ITEM_SLOTS:
                        problems.append(f'item {item["id"]} 非法槽位 {slot}')
                    p = out / rel
                    if not p.exists():
                        problems.append(f'缺文件 {rel}')
                        continue
                    w, h = Image.open(p).size
                    if (w, h) != TARGET:
                        problems.append(f'{rel} 尺寸 {w}x{h} != {TARGET[0]}x{TARGET[1]}')
    pet = out / 'art' / 'pet-default.webp'
    if not pet.exists():
        problems.append('缺 art/pet-default.webp')
    else:
        w, h = Image.open(pet).size
        if (w, h) != (184, 327):
            problems.append(f'pet-default 尺寸 {w}x{h} != 184x327')
    return problems


# ---------------------------------------------------------------- 旧素材清理

def collect_referenced(manifest: dict) -> set[str]:
    refs: set[str] = set()

    def walk(node):
        if isinstance(node, dict):
            for v in node.values():
                walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)
        elif isinstance(node, str) and node.startswith('art/') and node.endswith('.webp'):
            refs.add(node)

    walk(manifest)
    refs.add('art/pet-default.webp')
    # B1-lite 脸部动画补丁是运行时特效层（wardrobe-core.FACE_PATCHES 引用），不进 manifest；
    # 这里显式声明，避免清理孤儿文件时被误删（v0.10.0 重建时踩到）。
    for shape in ('chibi', 'girl'):
        for name in ('eye_blink', 'eye_smile', 'mouth_mid', 'mouth_open'):
            refs.add(f'art/{shape}/face/{name}.webp')
    return refs


def cleanup_stale(out: Path, manifest: dict, built_shapes: list[str]) -> list[str]:
    """按新 manifest 引用清理旧素材（v5 残留 base.webp/overlay.webp/无后缀图层等）。"""
    refs = collect_referenced(manifest)
    removed: list[str] = []
    for shape in built_shapes:
        art = out / 'art' / shape
        if not art.is_dir():
            continue
        for f in sorted(art.rglob('*.webp')):
            rel = f.relative_to(out).as_posix()
            if rel not in refs:
                f.unlink()
                removed.append(rel)
        # 旧版「整套立绘」产物 / 空目录
        for pattern in ('dress-*.webp', 'combo-*.webp'):
            for stale in art.glob(pattern):
                stale.unlink()
                removed.append(stale.relative_to(out).as_posix())
        for d in sorted((p for p in art.rglob('*') if p.is_dir()), reverse=True):
            if not any(d.iterdir()):
                d.rmdir()
    for stale in (out / 'art' / 'icons').glob('*.webp'):
        if stale.stem not in ICON_SOURCES:
            stale.unlink()
            removed.append(stale.relative_to(out).as_posix())
    return removed


# ---------------------------------------------------------------- 增量构建（--shape 调试用）

def load_prev_shape_info(out: Path, missing_shapes: list[str]) -> dict:
    manifest_path = out / 'manifest.json'
    if not manifest_path.exists():
        raise SystemExit('单身形调试构建需要已有 v6 manifest；请先完整构建一次')
    old = json.loads(manifest_path.read_text())
    if old.get('version') != 6:
        raise SystemExit('已有 manifest 不是 v6；请先完整构建一次')
    shapes_by_id = {s['id']: s for s in old.get('shapes', [])}
    cat_key = {'outfits': 'dress', 'tops': 'top', 'bottoms': 'bottom'}
    info = {}
    for sid in missing_shapes:
        shp = shapes_by_id.get(sid)
        if not shp:
            raise SystemExit(f'旧 manifest 缺少身形 {sid}；请先完整构建一次')
        item_layers = {}
        for cat, key in cat_key.items():
            for item in old['items'][cat]:
                if item['id'] == 'none':
                    continue
                lay = item.get('layers', {}).get(sid)
                if lay:
                    item_layers[(key, item['id'])] = dict(lay)
        info[sid] = {'shape': sid, 'bounds': shp['bounds'],
                     'shape_layers': dict(shp['layers']), 'item_layers': item_layers}
    return info


def write_report(audit_dir: Path, shape_info: dict, removed: list[str],
                 mask_md5: dict, cmd: str, orphans: list[str], tmp_files: list[str],
                 refs: set[str], qa_dir: Path | None = None) -> None:
    audit_dir.mkdir(parents=True, exist_ok=True)
    checks: list[tuple[str, str, bool, str]] = []
    # 洋红空洞：身体不透明区（body alpha>200）出现洋红才算缺陷；阈值 <50px 且无 >=3px 连通块：
    # 合成边缘 1-2px 的抗锯齿接缝/发丝围出的背景缝隙可能残留个位数 px，不构成「人物内部空洞」。
    for sid, info in shape_info.items():
        stats = info.get('stats') or {}
        mag = stats.get('magenta_holes', {}).get(sid, {})
        n_bad = sum(v['bad'] for v in mag.values())
        bad_max = max((v['bad_max'] for v in mag.values()), default=0)
        checks.append((f'{sid} 洋红底身体内空洞',
                       '<50px 且无≥3px 连通块', n_bad < 50 and bad_max < 3,
                       f'共 {n_bad}px / 最大连通块 {bad_max}px'))
        hd = stats.get('hand_core_visible', {}) or {}
        checks.append((f'{sid} 手部核心区（指尖/手心）未被衣服覆盖',
                       '所有组合 >=0.95', bool(hd) and min(hd.values()) >= 0.95,
                       f'min={min(hd.values()) if hd else 0:.2f}'))
        ho = stats.get('hair_over_clothes', {}) or {}
        checks.append((f'{sid} 长发盖在衣服上',
                       '所有组合 >=0.95', bool(ho) and min(ho.values()) >= 0.95,
                       f'min={min(ho.values()) if ho else 0:.2f}'))
        checks.append((f'{sid} 白色衣服上头发层鬼影',
                       '<500px（低饱和高亮像素被 hair 掩膜带入）',
                       stats.get('hair_ghost_px', 0) < 500, f'{stats.get("hair_ghost_px", 0)}px'))
    if 'girl' in shape_info:
        bow = (shape_info['girl'].get('stats') or {}).get('bow', {}).get('top-hoodie', 0)
        checks.append(('girl 卫衣橙色蝴蝶结补丁', '>500px', bow > 500, f'{bow}px'))
    # 水手服领结配准（v0.9.1）：没走 fallback、IoU 足够、尺度接近 1 → 衣领不会被拉偏/拉小
    for sid, info in shape_info.items():
        al = (info.get('stats') or {}).get('align', {}).get('top-sailor')
        if not al:
            continue
        ok = (al.get('mode') == 'bow' and not al.get('fallback')
              and al.get('iou', 0) >= 0.5 and 0.85 <= al.get('scale', 0) <= 1.15)
        checks.append((f'{sid} 水手服领结配准', 'bow 配准 IoU>=0.5 且 scale∈[0.85,1.15]',
                       ok, str(al)))
    # 下装（v0.10.1）：直接在体 look 成层，不做任何缩放；记录腰线/下摆/腰宽/摆宽
    for sid, info in shape_info.items():
        sk = (info.get('stats') or {}).get('skirt') or {}
        if not sk:
            continue
        vals = '; '.join(
            f'{k.split("-")[1]}: y={v["top"]}→{v["hem"]} 腰宽={v["waist_w"]} 摆宽={v["hem_w"]} '
            f'层bbox={v["layer_bbox"]} look-IoU={v["iou"]}'
            for k, v in sk.items())
        checks.append((f'{sid} 下装按在体 look 1:1 成层（无 extra_scale）',
                       '腰线/下摆/腰宽来自 look；look-diff IoU>=0.65（diff 含 bandeau 底边/尾巴，仅作护栏）',
                       all(v['iou'] >= 0.65 for v in sk.values()), vals))
    checks.append(('manifest v6 / 675×1200 / 引用文件存在', 'validate_build 无问题', not orphans,
                   '见构建日志'))
    checks.append(('art/ 无孤儿文件 / 无 .tmp', '0', not orphans and not tmp_files,
                   f'orphan={len(orphans)} tmp={len(tmp_files)}'))
    if mask_md5:
        bad_md5 = {k: v for k, v in mask_md5.items() if FROZEN_MASK_MD5.get(k) != v}
        checks.append(('掩膜与 mask-forge 冻结版本一致', 'md5 全匹配', not bad_md5,
                       '全匹配' if not bad_md5 else str(bad_md5)))
    lines = ['# v0.9 图层素材构建 QA 报告（pipeline-forge）', '',
             f'- 生成时间：{time.strftime("%Y-%m-%d %H:%M:%S")}',
             '',
             '## 如何复现', '',
             '```bash',
             cmd,
             '```', '',
             '- 输入：`/home/ubuntu/dsh/.scratch/feiyu-gen/raw12`（素体 / 单件 look / whiteout / '
             '`*-only-bottom-*-knee.png` 及膝下装 look）+ '
             '`tools/masks/<shape>/{arms,hair}.png`（mask-forge 冻结版，源分辨率 1152×2048）',
             '- 输出：`docs/dress-up/art`（675×1200 WebP）+ `docs/dress-up/manifest.json`（v6）',
             f'- drawOrder：`{" → ".join(DRAW_ORDER)}`',
             '',
             '## 最终产物清单', '',
             '```',
             'art/<shape>/body.webp                 素体（最底层，= v0.8 base.webp 内容）',
             'art/<shape>/arms.webp                 手臂+手层（body RGB × arms_mask）',
             'art/<shape>/hair.webp                 完整前发层（body RGB × hair_mask，最上层）',
             'art/<shape>/layers/<cat>-<id>-body.webp     上衣/连衣裙主体（不挖头发洞）',
             'art/<shape>/layers/<cat>-<id>-sleeve.webp   袖子（garment_alpha × dilate(arms,6px)，袖口线以下裁掉手）',
             'art/<shape>/layers/bottom-<id>.webp         下装单层',
             'art/pet-default.webp                  默认穿搭合成图（Q 版女仆装，184×327 透明）',
             'art/icons/*.webp  art/bg-*.webp  art/thumbs/bg-*.webp   图标/背景（沿用）',
             'manifest.json                         v6（shapes[].layers / items[].layers）',
             '```', '',
             f'- 被 manifest / 运行时特效引用的素材文件数：{len(refs)}',
             '']
    if mask_md5:
        lines += ['## 输入掩膜（冻结）', '']
        lines += [f'- `{k}.png`  md5 `{v}`' for k, v in sorted(mask_md5.items())]
        lines.append('')
    lines += ['## 自动校验', '', '| 检查项 | 判定阈值 | 结果 | 数值 |', '|---|---|---|---|']
    for name, thr, ok, val in checks:
        lines.append(f'| {name} | {thr} | {"PASS" if ok else "FAIL"} | {val} |')
    lines.append('')
    lines.append(f'总判定：**{"PASS" if all(ok for _, _, ok, _ in checks) else "FAIL"}**')
    lines.append('')
    lines.append('> 说明：洋红底检查里，「发丝/手臂围出的背景缝隙」在洋红底上本来就该透出背景'
                 '（不是人物内部空洞），单独计入 bg_gap 字段；只有 body 不透明区出现洋红才算缺陷。')
    lines.append('')
    qa_root = str(qa_dir) if qa_dir is not None else '/home/ubuntu/dsh/.scratch/feiyu-art'
    lines += ['## 人工 QA 图（read_image 逐张确认）', '',
              f'- `{qa_root}/v9-layers-<shape>.jpg`：每身形全部组合'
              '（3 上衣×2 下装 + 女仆装 + 素体单层 + 单件），带标签',
              f'- `{audit_dir}/`：',
              '  - `magenta-holes-<shape>.jpg` 洋红底全组合空洞检查（绿色=发丝缝隙，红色=缺陷）',
              '  - `hand-in-front-skirt-<shape>.jpg` 手在裙前 2x 局部（左右手）',
              '  - `hair-over-clothes-<shape>.jpg` 长发在衣服前：with/without hair 对比',
              '  - `bow-girl-hoodie.jpg` girl 卫衣橙色蝴蝶结（最终合成 / look 真值 / body 层）',
              '  - `sweater-4x-<shape>.jpg` 白毛衣 4x 特写（查淡蓝鬼影，chibi 重点）',
              '  - `hair-ghost-<shape>.jpg` 鬼影检测叠加图（红=低饱和高亮像素）',
              '  - `waist-center-<shape>.jpg` maid/下装正面腰部 3x（查背部中央头发竖线）',
              '  - `shape-layers-<shape>.jpg` body/arms/hair 三部件层单独可视化（查手臂完整）',
              '  - `look-vs-build-<shape>.jpg` build 合成 / 单件 look 真值 / 差异热图',
              '  - `seam-2x-<shape>.jpg` 袖子/衣身接缝 2x', '']
    lines.append('## 分身形细节')
    for sid, info in shape_info.items():
        stats = info.get('stats') or {}
        lines.append(f'### {sid}')
        lines.append(f'- bounds: {info["bounds"]}')
        lines.append(f'- 配准 IoU: {stats.get("iou", {})}')
        if stats.get('align'):
            lines.append(f'- 白底单品配准方式: {stats.get("align")}')
        lines.append(f'- sleeve 面积占比: {stats.get("sleeve", {})}')
        lines.append(f'- 蝴蝶结补丁像素: {stats.get("bow", {})}')
        if stats.get('skirt'):
            lines.append(f'- 下装 look 直接成层（源坐标 / 目标层 bbox）: {stats.get("skirt")}')
        mag = stats.get('magenta_holes', {}).get(sid, {})
        bad = {k: v['bad'] for k, v in mag.items() if v.get('bad')}
        gaps = {k: v['bg_gap'] for k, v in mag.items() if v.get('bg_gap')}
        lines.append(f'- 洋红底「身体内空洞」: {"全部 0（通过）" if not bad else bad}')
        lines.append(f'- 发丝围出的背景缝隙（非缺陷）: {gaps}')
        lines.append(f'- 手部核心区未被衣服覆盖: {stats.get("hand_core_visible", {})}')
        lines.append(f'- 长发盖在衣服上可见率: {stats.get("hair_over_clothes", {})}')
        lines.append(f'- 与 look 真值平均差异（0-255，越小越好）: {stats.get("look_diff", {})}')
        lines.append('')
    lines += ['## 已知瑕疵（诚实报告）', '',
              '1. **base 侧发压在毛衣/卫衣肩袖上会出现 1-2px 深色细丝**：v6「hair 层最上层」设计近似——'
              'base 画里这几缕发丝本来在手臂/衣服前，look 真值里 AI 重画后位置略有差异；'
              '合成图上表现为袖肩处细深色丝，不是洞、不影响验收 1-3。',
              '2. **下装按在体 look 1:1 成层**：v0.10.1 起不再用 whiteout 整件放大'
              '（旧 chibi ×1.72 / girl ×1.40）；裙腰顶 / 下摆 / 腰宽由及膝 look 检测，'
              '左右缘由裙面左缘稳健拟合 + 镜像重建，RGB 直接取自 look（格纹比例/腰带/褶皱与 look 一致）。',
              '3. **手部验收以 4x QA 图为准**：自动指标只统计「手部核心区（指尖/手心）未被衣服覆盖」'
              '（arms 或 hair 层在最上层都算露出，发丝压手属正常），完整视觉结论见 hand-in-front-skirt-<shape>.jpg。',
              '4. 掩膜边界有 1-2px CV 误差；sleeve 用 look 袖口线兜底裁手（见代码 hand_region_from_look）。',
              '5. pet-default.webp 内容 174×327 居中放进 184×327 画布（与 v0.8 行为一致）。',
              '']
    lines.append('## 旧素材清理')
    if removed:
        lines.extend(f'- 删除 {r}' for r in removed)
    else:
        lines.append('- 无')
    lines.append('')
    (audit_dir / 'REPORT.md').write_text('\n'.join(lines) + '\n')


# ---------------------------------------------------------------- 主构建

def build(src: Path, out: Path, qa_dir: Path, audit_dir: Path, masks_dir: Path,
          only_shape: str | None = None) -> None:
    t0 = time.time()
    for stale_tmp in out.rglob('*.tmp'):
        stale_tmp.unlink()
    shapes = [s for s in SHAPES if not only_shape or s[0] == only_shape]
    # 正式构建前先确认掩膜齐全（避免跑到一半才发现）
    missing = [str(masks_dir / s / f) for s, _, _ in shapes
               for f in ('arms.png', 'hair.png') if not (masks_dir / s / f).exists()]
    if missing:
        raise SystemExit('缺少身体部件掩膜（mask-forge 产出，见 LAYER-MODEL.md §3）：\n  '
                         + '\n  '.join(missing)
                         + '\n（调试可用 --masks-dir 指向临时启发式掩膜）')
    shape_info = {}
    for shape, _, _ in shapes:
        shape_info[shape] = build_shape(shape, src, out, qa_dir, audit_dir, masks_dir)
    if only_shape:
        skipped = [s[0] for s in SHAPES if s[0] != only_shape]
        shape_info.update(load_prev_shape_info(out, skipped))
    print('图标 / 背景缩略图 …')
    make_icons(src, out)
    make_bg_thumbs(out)
    if 'chibi' in shape_info and 'item_px' in shape_info['chibi']:
        print('pet-default …')
        build_pet_default(out, shape_info['chibi'])
    for stale_tmp in out.rglob('*.tmp'):
        stale_tmp.unlink()
    manifest = build_manifest(shape_info)
    tmp_manifest = out / 'manifest.json.tmp'
    tmp_manifest.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    os.replace(tmp_manifest, out / 'manifest.json')
    print(f'manifest -> {out / "manifest.json"}')
    problems = validate_build(out, manifest)
    removed = cleanup_stale(out, manifest, [s[0] for s in shapes])
    refs = collect_referenced(manifest)
    orphans, tmp_files = [], []
    for f in sorted((out / 'art').rglob('*')):
        if not f.is_file():
            continue
        rel = f.relative_to(out).as_posix()
        if f.suffix == '.tmp':
            tmp_files.append(rel)
        elif rel not in refs:
            orphans.append(rel)
    mask_md5 = {}
    for shape, _, _ in shapes:
        for part in ('arms', 'hair'):
            fp = masks_dir / shape / f'{part}.png'
            mask_md5[f'{shape}/{part}'] = hashlib.md5(fp.read_bytes()).hexdigest()
    cmd = ('python3 tools/build_wardrobe.py --src /home/ubuntu/dsh/.scratch/feiyu-gen/raw12 '
           '--out docs/dress-up')
    write_report(audit_dir, shape_info, removed, mask_md5, cmd, orphans, tmp_files, refs, qa_dir)
    if orphans:
        problems.append(f'art/ 存在未被 manifest 引用的孤儿文件: {orphans[:5]}')
    if tmp_files:
        problems.append(f'art/ 存在遗留 .tmp: {tmp_files[:5]}')
    bad_md5 = {k: v for k, v in mask_md5.items() if FROZEN_MASK_MD5.get(k) != v}
    if bad_md5:
        print(f'WARN 掩膜 md5 与冻结版本不一致（可能是 mask-forge 更新）: {bad_md5}')
    print(f'清理旧素材 {len(removed)} 个文件')
    if problems:
        print('素材校验失败：')
        for p in problems:
            print('  -', p)
        raise SystemExit(1)
    print(f'校验通过：2 身形 × {len(TOPS) + len(DRESSES)} 上衣/裙 + {len(BOTTOMS)} 下装；'
          f'耗时 {time.time() - t0:.1f}s')
    print(f'QA 拼图 -> {qa_dir}/v9-layers-<shape>.jpg')
    print(f'审计图 -> {audit_dir}/')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--src', default='/home/ubuntu/dsh/.scratch/feiyu-gen/raw12')
    parser.add_argument('--out', default=str(ROOT / 'docs/dress-up'))
    parser.add_argument('--qa-dir', default='/home/ubuntu/dsh/.scratch/feiyu-art')
    parser.add_argument('--audit-dir', default='/home/ubuntu/dsh/.scratch/feiyu-layer-audit/pipeline')
    parser.add_argument('--masks-dir', default=str(ROOT / 'tools/masks'))
    parser.add_argument('--shape', default=None, choices=['chibi', 'girl'])
    args = parser.parse_args()
    build(Path(args.src), Path(args.out), Path(args.qa_dir), Path(args.audit_dir),
          Path(args.masks_dir), args.shape)
