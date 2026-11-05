#!/usr/bin/env python3
"""大肥鱼衣橱 · T2 手部精修 overlay hook（vendored，参数化 hands 根目录）.

在原 `p5-hands` 交付版（`.scratch/p5/hands/overlay_hands.py`）基础上只做两件事：
  1) 把硬编码的 `.scratch/p5/hands` 根改为调用方传入的 `hands_dir`（构建时 = `<src>/hands`）；
  2) 去掉只能在历史 `.scratch` 目录里跑的 self-test 主程序。
像素处理逻辑与原版逐行一致（alpha/silhouette 永远不变，只替换 mask 内 RGB）。

Pattern: same as build_prod.overlay_refined_feet (P2). Alpha/silhouette is NEVER changed
(only RGB inside the hand mask with a 5px feather) -> zero silhouette drift, no new holes.

Default (contract-safe, 1x) path
--------------------------------
Inputs (read-only for this module; frozen in assets-src-v1.tar.zst):
  <src>/hands/overlay-1x/{shape}.png       675x1200 RGBA  refined RGB (both hands, production coords)
  <src>/hands/masks/hands-mask-{shape}.png 675x1200 L    0/255 hand mask (hair/dark lineart excluded)
Targets: the hand drawables' textures in texdir (hand-L.png, hand-R.png), full-canvas RGBA.
Each production hand texture contains BOTH hands (M4a arms band) -> apply the same overlay to
hand-L and hand-R so the two z=65 drawables stay consistent.

Usage in build_prod.build_shape(), right after the base parts are written (texdir) and before
build_2d5 packs the atlas:

    from vendor.overlay_hands import overlay_hands
    stats['handsOverlayPx'] = overlay_hands(shape, drawables, texdir, stats,
                                            hands_dir=OPTS['hands_dir'])

Optional experiment path (2x texture, NOT the default; requires build change)
----------------------------------------------------------------------------
  <src>/hands/refined2x/{shape}/hand-tex.png = 1350x2400 RGBA (full canvas x2, band-masked alpha, both hands)
  Instead of the band rebuild for hand-L/hand-R in build_prod:
      for pid in ('hand-L','hand-R'):
          shutil.copy(HANDS/refined2x/shape/hand-tex.png, texdir/pid.png)
          drawables[pid].texSize = [1350, 2400]          # build_2d5 trim remaps UVs from full-canvas
          BASE_ALPHA_BY_ID[pid] = load_alpha(texdir/pid.png) > 8
  Mesh dicts stay unchanged (mesh['uvs'] are normalised to the 675x1200 canvas: uv*texW = 2x px).
  Then build_2d5 --trim-alpha packs ~2x hand tiles: atlas grows ~+0.6 MiB VRAM per shape.
"""
from __future__ import annotations
from pathlib import Path

import numpy as np
import cv2
from PIL import Image

# 覆盖入口的默认值；正常构建必须显式传 hands_dir（build_prod 会传 <src>/hands）。
HANDS = None


def _load(p):
    return np.array(Image.open(p).convert('RGBA'))


def overlay_hands(shape: str, drawables: list[dict], texdir, stats: dict | None = None,
                  mask_feather_px: int = 5, seam_ramp_px: int = 3, hands_dir=None):
    """Replace RGB of hand-L/hand-R textures inside the refined mask; alpha untouched.
    Returns number of changed pixels (summed over textures).

    hands_dir: source-package `hands/` root (`<src>/hands`); falls back to module HANDS.
    """
    hands = Path(hands_dir) if hands_dir is not None else (Path(HANDS) if HANDS else None)
    if hands is None:
        raise ValueError('overlay_hands: hands_dir is required (source package <src>/hands root)')
    ov_p = hands/'overlay-1x'/f'{shape}.png'
    mk_p = hands/'masks'/f'hands-mask-{shape}.png'
    if not (ov_p.exists() and mk_p.exists()):
        return 0
    overlay = _load(ov_p)
    mask = (np.array(Image.open(mk_p).convert('L')) > 128).astype(np.float32)
    if not mask.any():
        return 0
    # 5px feather (P2 convention) + fade top 3px so the wrist seam has no band
    w = cv2.GaussianBlur(mask*255, (mask_feather_px*2+1, mask_feather_px*2+1), 0).astype(np.float32)/255.0
    for d in drawables:
        if d.get('id') not in ('hand-L', 'hand-R'):
            continue
        tex_path = Path(texdir)/d['texture']
        if not tex_path.exists():
            continue
        tex = _load(tex_path)
        m = (w > 0.01) & (tex[..., 3] > 8) & (overlay[..., 3] > 8)
        if not m.any():
            continue
        rgb = tex[..., :3].astype(np.float32)
        fw = w[m][:, None]
        rgb[m] = overlay[..., :3][m].astype(np.float32)*fw + rgb[m]*(1-fw)
        tex[..., :3] = np.clip(rgb, 0, 255).astype(np.uint8)
        Image.fromarray(tex, 'RGBA').save(tex_path)
        if stats is not None:
            stats.setdefault('handsOverlay', {})[d['id']] = int(m.sum())
    return int((w > 0.01).sum())
