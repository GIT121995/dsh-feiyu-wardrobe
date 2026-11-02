#!/usr/bin/env python3
"""大肥鱼衣橱 v6 · 身体部件掩膜生成器（arms / hair）

用纯 CV（肤色 / 蓝色分割 + 连通块筛选 + 描边补全 + 保守侧向阈值）从白底素体
（1152×2048）半自动生成两张源分辨率掩膜，供 tools/build_wardrobe.py v6 使用：

    tools/masks/<shape>/arms.png   手臂 + 手（含轮廓描边；排除胸/颈/脸/腿）
    tools/masks/<shape>/hair.png   全部可见前发（含手臂下方长发丝/呆毛/耳鳍描边）；
                                   不含鲸鱼尾巴、不含「后背中央那缕长发」、
                                   不含低饱和蓝灰投影（会成白衣服上的鬼影）

输入：/home/ubuntu/dsh/.scratch/feiyu-gen/raw12/base-bandeau-{chibi,girl}.png
      （与 build_wardrobe.py 的 --src 默认值一致；可用 --src 覆盖）
输出：PNG RGBA，RGB 全 255 白、A = 掩膜 0-255；尺寸恒为 1152×2048。
      build_wardrobe.load_mask 支持 RGBA 取最后一通道。

用法：
    python3 tools/build_masks.py                 # 重建 4 张掩膜（确定性，重跑逐像素一致）
    python3 tools/build_masks.py --only chibi    # 只重建一个身形
    python3 tools/build_masks.py --check         # 只校验：已落盘掩膜是否与重建结果逐像素一致
    python3 tools/build_masks.py --qa-dir DIR    # 额外输出中间调试图（可选）

算法说明 / QA 结论 / 已知误差见 tools/masks/README.md。
"""

from __future__ import annotations

import argparse
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

HERE = Path(__file__).resolve().parent          # <repo>/tools
ROOT = HERE.parent                              # <repo>
MASKS_DIR = HERE / 'masks'
DEFAULT_SRC = Path('/home/ubuntu/dsh/.scratch/feiyu-gen/raw12')

SOURCE = (1152, 2048)          # (width, height) 源分辨率，契约 §3
SHAPES = ('chibi', 'girl')

# ---------------------------------------------------------------- 每身形常量
# 均由视觉 QA 迭代标定（源分辨率像素坐标）。改动请同步 tools/masks/README.md。
PARAMS: dict[str, dict] = {
    'girl': {
        # arms：中央「胸/颈」排除矩形 (x0, x1, y0, y1)。
        # 上身肤色块 x∈[326,836]，左/右手臂内缘约 455–458 / 712–715
        # → 走廊取 460..712，只切中央 252px，两侧手臂（含手）完整保留。
        'arms_corridor': (460, 712, 634, 1300),
    },
    'chibi': {
        # chibi 上半身更宽：胸 V 从 y≈947 到 bandeau 上缘 y≈1075；
        # 手臂内缘在 y>1095 后收到 416/431（左）与 691/701（右），故走廊只到 y=1095。
        'arms_corridor': (438, 702, 947, 1095),
    },
}

# ---------------------------------------------------------------- 通用常量
# arms
ARMS_COMP_TOP_RANGE = (0.27, 0.56)   # 上身肤色连通块 bbox-top / 身高 的允许区间
ARMS_MIN_COMP_AREA = 0.015           # 上身肤色块最小面积（占画布比例，防选到碎块）
ARMS_MIN_COMP_WIDTH_FRAC = 0.30      # 上身块必须够宽（双臂横跨 ≥30% 画宽；腿/脸不够宽）
ARMS_DARK_LUM = 110                  # 「深色轮廓线」亮度上限
ARMS_OUTLINE_REACH = 3               # 描边补全半径（px）
ARMS_DILATE_PX = 2                   # 最终外扩（含抗锯齿边，契约建议 1–2px）

# hair
HAIR_BLUE = dict(b_minus_r=30, b_minus_g=6, b_min=40)   # 蓝色发丝分割
HAIR_MIN_BLUE_AREA = 100             # 蓝色连通块最小面积（过滤噪点）
HAIR_TAIL_MIN_AREA = 20000           # 「尾巴」判定：面积阈值…
HAIR_TAIL_Y_FRAC = 0.55              # …且质心在 身体上缘+55% 身高 以下
HAIR_BACK_CENTER_FRAC = 0.045        # 「后背中央长发」判定：质心 x 距身体中心 ±4.5% 身宽…
HAIR_BACK_TOP_FRAC = 0.55            # …且 bbox 顶部在 身体上缘+55% 身高 以下
HAIR_DARK_LUM = 100                  # 发丝深色描边亮度上限
HAIR_OUTLINE_REACH = 2               # 描边补全半径（px）
HAIR_MIN_KEEP_AREA = 200             # 最终连通块最小面积
HAIR_LOW_SAT = 0.20                  # 低饱和排除：饱和度 (max-min)/max 上限
HAIR_BRIGHT_LUM = 170                # 低饱和排除：亮度（三通道均值）下限


# ---------------------------------------------------------------- 基础工具

def load_rgb(path: Path) -> np.ndarray:
    return np.asarray(Image.open(path).convert('RGB')).astype(np.int16)


def foreground_alpha(rgb: np.ndarray, thresh: int = 26) -> np.ndarray:
    """白底 → 前景 alpha（0/255）。与 tools/build_wardrobe.py remove_white_alpha 同算法。"""
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


def skin_mask(rgb: np.ndarray) -> np.ndarray:
    """素体肤色：暖白高亮（臂/肩/面/腿共用；白色连体衣不满足 r-g / g-b 条件）。"""
    r, g, b = rgb[:, :, 0], rgb[:, :, 1], rgb[:, :, 2]
    lum = rgb.mean(axis=2)
    return (r - g >= 6) & (g - b >= 2) & (r > 225) & (lum > 195)


def blue_mask(rgb: np.ndarray) -> np.ndarray:
    """蓝发/蓝尾巴：b 明显高于 r/g 且不太暗。

    b-r 阈值取 30（而非常见的 18）：白色连体衣的蓝灰阴影 b-r≈19–30 且亮度高，
    会紧贴发丝被并入 hair 连通块（画到白毛衣上就是淡蓝污染），收紧后分离干净
    （发丝像素 b-r 的 2% 分位≈34，边缘抗锯齿≈30；白色衣物阴影 p95≈30）。
    """
    r, g, b = rgb[:, :, 0], rgb[:, :, 1], rgb[:, :, 2]
    return ((b - r > HAIR_BLUE['b_minus_r'])
            & (b - g > HAIR_BLUE['b_minus_g'])
            & (b > HAIR_BLUE['b_min']))


def _components(mask: np.ndarray):
    """8 连通块：返回 (labels, stats, centroids)。"""
    n, lab, stats, cent = cv2.connectedComponentsWithStats(
        (mask > 0).astype(np.uint8), connectivity=8)
    return lab, stats, cent


def _ellipse(ksize: int) -> np.ndarray:
    return cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (ksize, ksize))


def _dilate(mask: np.ndarray, px: int) -> np.ndarray:
    """圆形核膨胀 px 像素（px>=1）。"""
    if px <= 0:
        return mask.astype(bool)
    return cv2.dilate(mask.astype(np.uint8), _ellipse(2 * px + 1)) > 0


def _keep_final_comps(mask: np.ndarray, min_area: int,
                      seeds: np.ndarray | None = None) -> np.ndarray:
    """保留面积 >= min_area 的连通块；若给 seeds，则只保留与 seeds 有重叠的块。"""
    lab, stats, _ = _components(mask)
    out = np.zeros(mask.shape, bool)
    for i in range(1, stats.shape[0]):
        if int(stats[i, cv2.CC_STAT_AREA]) < min_area:
            continue
        m = lab == i
        if seeds is not None and not np.any(m & seeds):
            continue
        out |= m
    return out


def _body_box(fg: np.ndarray) -> tuple[int, int, int, int]:
    """前景 bbox：(x0, y0, x1, y1)，含端点。"""
    ys, xs = np.nonzero(fg > 0)
    return int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())


def _face_bbox(rgb: np.ndarray, fg: np.ndarray) -> tuple[int, int, int, int] | None:
    """面部肤色块 bbox：用于把「蓝色虹膜」从 hair 掩膜里排除掉。

    取「面积足够大的肤色块里 bbox-top 最小的那个」= 脸（girl top≈392、chibi≈576；
    手臂/上身块 top 更靠下，腿块更靠下）。
    """
    sk = skin_mask(rgb) & (fg > 0)
    lab, stats, _ = _components(sk)
    h, w = fg.shape
    best = None
    for i in range(1, stats.shape[0]):
        area = int(stats[i, cv2.CC_STAT_AREA])
        if area < 0.005 * h * w:
            continue
        top = int(stats[i, cv2.CC_STAT_TOP])
        if best is None or top < best[0]:
            best = (top, stats[i])
    if best is None:
        return None
    st = best[1]
    return (int(st[cv2.CC_STAT_LEFT]), int(st[cv2.CC_STAT_TOP]),
            int(st[cv2.CC_STAT_LEFT] + st[cv2.CC_STAT_WIDTH] - 1),
            int(st[cv2.CC_STAT_TOP] + st[cv2.CC_STAT_HEIGHT] - 1))


# ---------------------------------------------------------------- arms 掩膜

def build_arms(rgb: np.ndarray, fg: np.ndarray, params: dict) -> np.ndarray:
    """手臂+手掩膜（uint8 0/255）。

    步骤：
      1. 肤色分割（r-g>=6 & g-b>=2 & r>225 & lum>195）。
      2. 取「上身肤色连通块」：bbox-top 落在身高 27%–56%、面积足够大、且 bbox 横跨
         ≥30% 画宽的最大块（双腿/脸是独立连通块，天然排除；手在腰线附近与腿纵坐标
         重叠，靠「连通块 + 侧向走廊」而不是 y 带区分）。
      3. 侧向走廊排除中央胸/颈（每身形常量，只切中央 252–264px，手臂不受影响）。
      4. 补深色轮廓描边（lum<110 且距肤色 ≤3px），再外扩 2px 把抗锯齿边纳入。
      5. 与前景 alpha 相交；只保留与肤色核心连通的部分（去孤立描边碎点）。
    """
    h, w = fg.shape
    lum = rgb.mean(axis=2)
    skin = skin_mask(rgb) & (fg > 0)
    lab, stats, _ = _components(skin)

    ylo, yhi = int(ARMS_COMP_TOP_RANGE[0] * h), int(ARMS_COMP_TOP_RANGE[1] * h)
    min_area = ARMS_MIN_COMP_AREA * h * w
    min_w = ARMS_MIN_COMP_WIDTH_FRAC * w
    cand = [i for i in range(1, stats.shape[0])
            if int(stats[i, cv2.CC_STAT_AREA]) >= min_area
            and int(stats[i, cv2.CC_STAT_WIDTH]) >= min_w
            and ylo <= int(stats[i, cv2.CC_STAT_TOP]) <= yhi]
    if not cand:
        raise RuntimeError('未找到上身肤色连通块（肤色阈值/身形常量需重新标定）')
    upper = max(cand, key=lambda i: int(stats[i, cv2.CC_STAT_AREA]))
    comp = lab == upper

    x0, x1, cy0, cy1 = params['arms_corridor']
    yy = np.arange(h)[:, None]
    xx = np.arange(w)[None, :]
    corridor = (xx >= x0) & (xx <= x1) & (yy >= cy0) & (yy <= cy1)
    core = comp & ~corridor

    near = _dilate(core, ARMS_OUTLINE_REACH)
    outline = (lum < ARMS_DARK_LUM) & near & (fg > 0)
    mask = core | outline
    mask = _dilate(mask, ARMS_DILATE_PX) & (fg > 0)
    mask = _keep_final_comps(mask, min_area=1, seeds=core)   # 去掉与手臂无关的描边碎点
    return mask.astype(np.uint8) * 255


# ---------------------------------------------------------------- hair 掩膜

def build_hair(rgb: np.ndarray, fg: np.ndarray, params: dict) -> np.ndarray:
    """前发掩膜（uint8 0/255）。

    步骤：
      1. 蓝色分割（b-r>30 & b-g>6 & b>40）。
      2. 逐连通块排除三类「不是前发」的蓝色块：
         a. 虹膜（bbox 完全落在面部肤色块 bbox 内）；
         b. 蓝鲸尾巴（面积 ≥20000 且质心在身体上缘+55%身高以下）；
         c. 后背中央那缕长发（质心 x 在身体中心 ±4.5% 身宽内 且 bbox-top 在
            身体上缘+55%身高以下）——它在真值 look 里被裙子/围裙盖住，
            必须留在 body 层，否则会在裙面正中画出一道深色竖线。
      3. 补深色描边（lum<100 且距蓝色块 ≤2px），把被内部分割线切碎的发束连起来
         （发丝内部深色分缝、呆毛细线、耳鳍描边都在这一步补齐）。
      4. 与前景 alpha 相交，保留 ≥200px 连通块。
      5. 排除「低饱和 + 亮」像素（sat<0.20 & lum>170）：连体衣上的头发蓝灰投影 /
         耳鳍浅蓝高光不是发色像素，留在最上层 hair 会变成白衣服上的淡蓝鬼影；
         深色描边（lum 很暗）与蓝发主体/高光（sat 通常 >0.3）不受影响。
    """
    h, w = fg.shape
    lum = rgb.mean(axis=2)
    bx0, by0, bx1, by1 = _body_box(fg)
    body_cx = (bx0 + bx1) / 2.0
    body_w = bx1 - bx0
    body_h = by1 - by0
    tail_line = by0 + HAIR_TAIL_Y_FRAC * body_h
    back_line = by0 + HAIR_BACK_TOP_FRAC * body_h
    face = _face_bbox(rgb, fg)

    bm = blue_mask(rgb) & (fg > 0)
    lab, stats, cent = _components(bm)

    kept = np.zeros((h, w), bool)
    excluded: list[dict] = []
    for i in range(1, stats.shape[0]):
        area = int(stats[i, cv2.CC_STAT_AREA])
        if area < HAIR_MIN_BLUE_AREA:
            continue
        left = int(stats[i, cv2.CC_STAT_LEFT])
        top = int(stats[i, cv2.CC_STAT_TOP])
        ww = int(stats[i, cv2.CC_STAT_WIDTH])
        hh = int(stats[i, cv2.CC_STAT_HEIGHT])
        cx, cy = float(cent[i][0]), float(cent[i][1])
        m = lab == i

        is_eye = (face is not None
                  and left >= face[0] and top >= face[1]
                  and left + ww - 1 <= face[2] and top + hh - 1 <= face[3])
        is_tail = area >= HAIR_TAIL_MIN_AREA and cy > tail_line
        is_back_center = (abs(cx - body_cx) <= HAIR_BACK_CENTER_FRAC * body_w
                          and top > back_line)
        for flag, kind in ((is_eye, 'iris'), (is_tail, 'tail'), (is_back_center, 'back-center')):
            if flag:
                excluded.append(dict(kind=kind, area=area, bbox=(left, top, ww, hh),
                                     centroid=(round(cx), round(cy))))
                break
        else:
            kept |= m

    near = _dilate(kept, HAIR_OUTLINE_REACH)
    out = kept | ((lum < HAIR_DARK_LUM) & near)
    out &= fg > 0
    out = _keep_final_comps(out, min_area=HAIR_MIN_KEEP_AREA)

    mx = rgb.max(axis=2).astype(np.float32)
    mn = rgb.min(axis=2).astype(np.float32)
    sat = (mx - mn) / np.maximum(mx, 1.0)
    out &= ~((sat < HAIR_LOW_SAT) & (lum > HAIR_BRIGHT_LUM))

    params.setdefault('_excluded', []).append(excluded)   # 仅供 --qa-dir 调试输出
    return out.astype(np.uint8) * 255


# ---------------------------------------------------------------- 落盘 / 校验

def as_rgba(mask: np.ndarray) -> np.ndarray:
    """掩膜 → RGBA：RGB 全 255 白，A = 掩膜值（build_wardrobe.load_mask 支持取最后一通道）。"""
    h, w = mask.shape
    rgba = np.empty((h, w, 4), np.uint8)
    rgba[:, :, :3] = 255
    rgba[:, :, 3] = mask
    return rgba


def save_mask(mask: np.ndarray, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + '.tmp')
    Image.fromarray(as_rgba(mask), 'RGBA').save(tmp, 'PNG')
    tmp.replace(path)


def read_mask_file(path: Path) -> np.ndarray:
    arr = np.asarray(Image.open(path))
    return arr[:, :, -1].astype(np.uint8) if arr.ndim == 3 else arr.astype(np.uint8)


def build_masks_for(shape: str, src: Path) -> tuple[np.ndarray, np.ndarray, dict]:
    """算出一个身形的 (arms, hair) 掩膜（uint8 0/255）+ 统计信息。不落盘。"""
    src_path = src / f'base-bandeau-{shape}.png'
    if not src_path.exists():
        raise SystemExit(f'缺少素体源图: {src_path}')
    rgb = load_rgb(src_path)
    if (rgb.shape[1], rgb.shape[0]) != SOURCE:
        raise SystemExit(f'素体源图尺寸应为 {SOURCE}（W,H），实际 '
                         f'{(rgb.shape[1], rgb.shape[0])}: {src_path}')
    fg = foreground_alpha(rgb)
    params = dict(PARAMS[shape])
    arms = build_arms(rgb, fg, params)
    hair = build_hair(rgb, fg, params)
    info = dict(shape=shape,
                arms_px=int((arms > 0).sum()), hair_px=int((hair > 0).sum()),
                arms_bbox=cv2.boundingRect((arms > 0).astype(np.uint8)),
                hair_bbox=cv2.boundingRect((hair > 0).astype(np.uint8)),
                excluded=params.get('_excluded', [[]]))
    return arms, hair, info


def write_debug_overlays(rgb: np.ndarray, arms: np.ndarray, hair: np.ndarray,
                         shape: str, qa_dir: Path) -> None:
    """中间调试图（不属于交付 QA 集，供算法迭代）：掩膜 tint。"""
    qa_dir.mkdir(parents=True, exist_ok=True)
    out = np.clip(rgb, 0, 255).astype(np.uint8).copy()
    am, hm = arms > 0, hair > 0
    out[am] = (0.5 * np.array([255, 0, 0], np.float32) + 0.5 * out[am].astype(np.float32)).astype(np.uint8)
    out[hm] = (0.5 * np.array([0, 200, 0], np.float32) + 0.5 * out[hm].astype(np.float32)).astype(np.uint8)
    Image.fromarray(out).resize((rgb.shape[1] // 2, rgb.shape[0] // 2),
                                Image.LANCZOS).save(qa_dir / f'debug-tint-{shape}.jpg', quality=88)


def main() -> None:
    ap = argparse.ArgumentParser(description='生成 tools/masks/<shape>/{arms,hair}.png')
    ap.add_argument('--src', default=str(DEFAULT_SRC))
    ap.add_argument('--out-dir', default=str(MASKS_DIR))
    ap.add_argument('--only', choices=SHAPES, default=None)
    ap.add_argument('--check', action='store_true',
                    help='只校验：已落盘掩膜与重建结果逐像素一致（不写盘）')
    ap.add_argument('--qa-dir', default=None, help='可选：额外输出中间调试图目录')
    args = ap.parse_args()

    src, out_dir = Path(args.src), Path(args.out_dir)
    qa_dir = Path(args.qa_dir) if args.qa_dir else None
    shapes = [args.only] if args.only else list(SHAPES)

    failed = False
    for shape in shapes:
        arms, hair, info = build_masks_for(shape, src)
        ex = info['excluded']
        print(f'[{shape}] arms={info["arms_px"]}px bbox={info["arms_bbox"]}  '
              f'hair={info["hair_px"]}px bbox={info["hair_bbox"]}')
        for item in (ex[-1] if ex else []):
            print(f'  - 排除 {item["kind"]}: area={item["area"]} bbox={item["bbox"]} '
                  f'centroid={item["centroid"]}')

        if args.check:
            for name, m in (('arms', arms), ('hair', hair)):
                path = out_dir / shape / f'{name}.png'
                if not path.exists():
                    print(f'  --check FAIL：缺少 {path}')
                    failed = True
                    continue
                old = read_mask_file(path)
                if old.shape != m.shape or not np.array_equal(old, m):
                    diff = int((old != m).sum()) if old.shape == m.shape else -1
                    print(f'  --check FAIL：{path} 与重建结果不一致（差异 {diff}px）')
                    failed = True
            if not failed:
                print(f'  --check OK：{shape} 两张掩膜与重建结果逐像素一致')
            continue

        if qa_dir is not None:
            write_debug_overlays(load_rgb(src / f'base-bandeau-{shape}.png'), arms, hair, shape, qa_dir)
        save_mask(arms, out_dir / shape / 'arms.png')
        save_mask(hair, out_dir / shape / 'hair.png')
        print(f'  -> {out_dir / shape / "arms.png"} , {out_dir / shape / "hair.png"}')

    if args.check and failed:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
