#!/usr/bin/env python3
"""大肥鱼衣橱 · production cutout builder（2.5D 资产构建器，资产 v17/v2.5.0 口径）.

把冻结的源素材（M2 cutout 分件 + M4 production 模板 + P2/T2 精修交付 + P3 冻结
输入）组装成 2 身形 × 6 套装的 cutout rig，再调用 `tools/art/build_2d5.py`
（单页 lossless WebP 图集 + trim-alpha）输出运行时资产：

    <repo>/.cache/assets-src/          # 源根（fetch-sources.mjs 下载，源工程不入 git）
      art/                             # M2 cutout art
      m4/dist/{shape}, m4/assets/art-v2/{shape}
      feet/{shape}                     # P2 脚部精修
      hands/                           # T2 手部精修 overlay 数据
      prod/                            # P3 冻结输入（seamfill + rest-colour ref）
    <repo>/.cache/build/               # 中间产物（texdir / source rig / build-stats）
    <repo>/tools/art/dist/             # 输出 dist/{shape}/{rig.json,atlas.webp,build-report.json}

v2.5 口径相对 P3（v2.4.0）的改动（T1 + T2 合并，见 W0 REPORT §构建验证）：
  * split_girl_back_hair 保留 5,117px 抽取，但不再 inline 重绘底层（P3 的 24 轮
    BFS 把自己的蓝色源反馈回去 -> repaint 污染；底层改为 finalize_girl_hair 里
    的确定性 nearest-fill，仅隐藏像素 -> rest 对齐 0px）。
  * finalize_girl_hair：把烘焙在 arm-upper-L 纹理里的 3,207px 分离发岛抽成新
    `hair-arm-girl` drawable（z=66，production 发束权重）；重绘底层；去除烘焙在
    tail 纹理里的 old-white-hair 白须（521px，rest 不可见）。
  * 手部：overlay_hands.py 在 mask 内替换 hand-L/R 纹理 RGB（alpha 不变，5px
    feather），union mask 同步套两张纹理。
  * 65 骨不变，chibi 契约不变（85 drawables）。

构建说明：
  * 输入路径全部相对 `--src`（默认 <repo>/.cache/assets-src）解析；`--outdir`
    默认 <repo>/tools/art/dist；中间产物写 `--workdir`（默认 <repo>/.cache/build，
    gitignored）。
  * 默认输出 v2.5.0 官方 dist 的逐字节复现：rig.json 里两个 provenance 字符串
    （`generator` / `cutout.source`）默认保留历史值以保持 md5 一致；换资产口径时
    用 `--generator-id/--source-note` 显式覆盖。
  * 依赖：python3 + numpy / opencv-python-headless / Pillow（tools/requirements.txt）。
"""
import argparse
import json
import math
import os
import shutil
import subprocess
import sys

import numpy as np
import cv2
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))          # <repo>/tools/art
REPO = os.path.dirname(os.path.dirname(HERE))              # <repo>
SRC = os.path.join(REPO, '.cache', 'assets-src')           # --src 覆盖
WORK = os.path.join(REPO, '.cache', 'build')               # --workdir 覆盖（中间产物）
M2 = os.path.join(SRC, 'art')                              # M2 cutout art
M4 = os.path.join(SRC, 'm4')                               # M4 production 模板
FEET_DIR = os.path.join(SRC, 'feet')                       # P2 脚部精修交付
PROD_IN = os.path.join(SRC, 'prod')                        # P3 冻结输入（seamfill/ref）
TOOL = os.path.join(HERE, 'build_2d5.py')                  # 图集打包器（可 --tool 覆盖）
OUTDIR = os.path.join(HERE, 'dist')                        # 输出 dist 根（--outdir 覆盖）
GEN_ID = 'cutout/prod/tools/build_prod.py'                 # rig.json provenance（保持历史值）
SOURCE_NOTE = 'M2 cutout art（production，源工程不入库）'   # rig.json cutout.source（保持历史值）
W, H = 675, 1200
H_, W_ = H, W   # aliases used by the P3 helper
COLOR_BLEED_PX = 2          # M4b: 3->2px
# z / slot overrides required by B-M4a spec (tail 8.5, skirt-under 29 comes from M2)
NEW_SLOTS = ['legs', 'armUpper', 'armFore', 'hand', 'collar', 'sleeveUpper', 'sleeveFore']
BASE_Z = {'body-head': 11.0, 'body-torso': 10.0, 'tail': 8.5,
          'leg-thigh-L': 9.2, 'leg-thigh-R': 9.2, 'leg-shin-L': 9.0, 'leg-shin-R': 9.0,
          'arm-upper-L': 45.0, 'arm-upper-R': 45.0, 'arm-fore-L': 48.0,
          'arm-fore-R': 48.0, 'hand-L': 65.0, 'hand-R': 65.0}
BASE_ALPHA_BY_ID = {}
BASE_SLOT = {'body-head': 'body', 'body-torso': 'body', 'tail': 'body',
             'leg-thigh-L': 'legs', 'leg-thigh-R': 'legs', 'leg-shin-L': 'legs',
             'leg-shin-R': 'legs', 'arm-upper-L': 'armUpper', 'arm-upper-R': 'armUpper',
             'arm-fore-L': 'armFore', 'arm-fore-R': 'armFore',
             'hand-L': 'hand', 'hand-R': 'hand'}
GEN = {'shape': None, 'stats': {}}
# T3 build switches (Lead: A/B dists — hands-only fallback vs full hair split).
# The merged builder is the single source of truth; the flags only decide which
# T1/T2 deliveries are applied, so `python3 tools/build_prod.py --build-atlas`
# reproduces the shipped dist by default.
MASTER_CFG = {}   # v2.6: shape -> normalised art retexture contract (--master-config)
# v2.6.1 fix: garment drawables may bake skins/palms of body parts (the M2 cutout
# parts were cut from the full look image; hidden-fill copies of hands/legs ended up
# inside garment textures -> maid outfit shows 2 hands per side = "four hands").
GARMENT_SLOTS = ('topUnder', 'bottom', 'topBody', 'sleeve', 'sleeveUpper',
                 'sleeveFore', 'collar')
OPTS = {
    'skip_hair': False,     # --skip-hair-split: pin v2.4.0 hair state (T1 changes off)
    'skip_hands': False,    # --skip-hands: no T2 hand overlay (attribution run)
    'hair_patch': None,     # --hair-patch PATH: T1 hair-patch-spec.json override
    'hands_dir': os.path.join(SRC, 'hands'),   # T2 delivery root（<src>/hands）
    'hands_2x': False,      # --hands-2x: experimental 2x hand textures (T2 refined2x)
    'clean_garment_skin': False,  # --clean-garment-skin: v2.6.1 baked skin/palm cleanup
    'outdir': OUTDIR,       # --outdir PATH: default <repo>/tools/art/dist
}
# ---- T1 v2.5 girl full hair split constants ----
HAIR_SLOTS_ALL = ('hairBack', 'strands', 'hairFront', 'face')
GIRL_LIMB_PARTS = ['arm-upper-L', 'arm-upper-R', 'arm-fore-L', 'arm-fore-R',
                   'hand-L', 'hand-R']
GIRL_HAIR_BODY_PARTS = ['body-head', 'body-torso', 'leg-L', 'leg-R']
GIRL_OUTFIT_COMBOS = ['maid', 'sweater-plaid', 'sweater-pleated', 'hoodie-plaid',
                      'hoodie-pleated', 'sailor-plaid']
LIMB_ISLAND_MAX_PX = 2500   # arm-band alpha components below this are hair islands
HAIR_ARM_ID = 'hair-arm-girl'
HAIR_ARM_Z = 66.0


def log(*a):
    print(*a)


def smoothstep(a, b, x):
    if b == a:
        return 1.0 if x >= b else 0.0
    t = max(0.0, min(1.0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)


def load_rgba(path):
    return np.array(Image.open(path).convert('RGBA'))


# --------------------------------------------------------------- texture harden
COLOR_BLEED_COUNT = {'px': 0}


def color_bleed(rgba, px=COLOR_BLEED_PX):
    """Extend RGB into transparent pixels adjacent to alpha edges (straight alpha).
    Prevents white/dark fringes when the GPU samples with bilinear mipmaps."""
    out = rgba.astype(np.float32)
    a = out[:, :, 3]
    known = a > 8
    work_known = known.copy()
    work_rgb = out[:, :, :3].copy()
    for _ in range(px):
        if work_known.all():
            break
        # average of known neighbours
        k = work_known.astype(np.float32)
        num = cv2.filter2D(work_rgb * k[:, :, None], -1, np.ones((3, 3), np.float32),
                           borderType=cv2.BORDER_REPLICATE)
        den = cv2.filter2D(k, -1, np.ones((3, 3), np.float32),
                           borderType=cv2.BORDER_REPLICATE)
        grow = (~work_known) & (den > 0.01)
        if not grow.any():
            break
        out[grow, :3] = num[grow] / den[grow][:, None]
        COLOR_BLEED_COUNT['px'] += int(grow.sum())
        work_known = work_known | grow
        work_rgb = out[:, :, :3]
    return out.astype(np.uint8)


REST_SHADOW = 0.0    # disabled: overlap cuts are straight horizontal -> edge shadow renders as bands
REST_BAND = 6.0      # px (<=6px per spec)
REST_FALLOFF = 2.0


def restore_source(part, source, rect, name):
    """Undo M2's baked contact shadow (it darkened whole rows near part rect
    edges -> visible horizontal gray bands) by restoring source RGB where the
    production source layer is opaque. Hidden-fill pixels (source transparent)
    keep M2's colours. Then re-bake a *thin alpha-edge* inner shadow (<=6px,
    strength 0.12) which never produces full-row bands."""
    out = part.astype(np.float32).copy()
    a = part[:, :, 3].astype(np.float32)
    m = a > 8
    if source is not None:
        sm = source[:, :, 3] > 8
        both = m & sm
        out[both, :3] = source[both, :3].astype(np.float32)
    # thin inner-rim shadow only where garment (not skin): caller decides via name
    if name.endswith('-skirt-under'):
        # computed inner lining: only vertical smoothing to kill rect-edge bands
        row_med = []
        for y in range(1200):
            mm = m[y]
            if mm.sum() >= 20:
                row_med.append((y, float(np.median(out[y, mm, :3].mean(1)))))
        if len(row_med) > 30:
            ys = np.array([r[0] for r in row_med])
            vals = np.array([r[1] for r in row_med])
            trend = np.copy(vals)
            for i in range(len(ys)):
                lo, hi = max(0, i - 7), min(len(ys), i + 8)
                trend[i] = np.median(vals[lo:hi])
            dev = vals - trend
            for i, y in enumerate(ys):
                if abs(dev[i]) > 2.0 and (abs(y - rect[1]) < 20 or abs(y - rect[3]) < 20):
                    out[y, m[y], :3] -= dev[i]
    # alpha-edge inner shadow (thin, direction independent -> no rows)
    dist = cv2.distanceTransform((m * 255).astype(np.uint8), cv2.DIST_L2, 5)
    sh = REST_SHADOW * np.exp(-dist / REST_FALLOFF) * (dist < REST_BAND)
    out[:, :, :3] *= (1.0 - sh)[:, :, None]
    out[:, :, :3] = np.clip(out[:, :, :3], 0, 255)
    out[:, :, 3] = a
    return out.astype(np.uint8)


def fill_removed(body_parts, pid, part, rect):
    """M2 clean-body deleted the production 'white hair wisp' pixels (alpha 0).
    In cutout those deletions leave real background holes wherever no hair
    drawable covers them at rest (visible as magenta holes / white blocks).
    Re-add the removed region to the owning body part, painted with the nearest
    colour of the same part (hair region -> hair colour; skin -> skin), so the
    white wisps are gone but the silhouette has no holes."""
    bb = body_parts['body']
    removed = (bb[:, :, 3] > 200) & (part[:, :, 3] < 8)
    if not removed.any():
        return part, 0
    x0, y0, x1, y1 = rect
    m = np.zeros_like(removed)
    m[max(0, y0 - 2):min(H, y1 + 2), max(0, x0 - 2):min(W, x1 + 2)] = True
    removed &= m
    if not removed.any():
        return part, 0
    out = part.astype(np.float32).copy()
    known = out[:, :, 3] > 8
    rgb = out[:, :, :3].copy()
    k = known.astype(np.float32)
    for _ in range(14):
        if not (removed & ~known).any():
            break
        num = cv2.filter2D(rgb * k[:, :, None], -1, np.ones((3, 3), np.float32),
                           borderType=cv2.BORDER_REPLICATE)
        den = cv2.filter2D(k, -1, np.ones((3, 3), np.float32),
                           borderType=cv2.BORDER_REPLICATE)
        grow = removed & ~known & (den > 0.01)
        if not grow.any():
            break
        rgb[grow] = num[grow] / den[grow][:, None]
        k[grow] = 1.0
        known = known | grow
    left = removed & ~known
    if left.any():
        rgb_u8 = np.clip(rgb, 0, 255).astype(np.uint8)
        fixed = cv2.inpaint(rgb_u8, left.astype(np.uint8) * 255, 4, cv2.INPAINT_TELEA)
        rgb[left] = fixed[left]
    out[:, :, :3] = np.clip(rgb, 0, 255)
    out[removed, 3] = 255
    return out.astype(np.uint8), int(removed.sum())


SEAM_EXTEND = 2   # px: expand each garment part 2px into neighbours (M4b: kills 1px seam + feather)


# P2 脚部精修根已由 --src 参数化为 <src>/feet（见文件头 configure_paths）。


def overlay_refined_feet(shape, drawables, texdir, stats):
    """P2-M2: replace the *foot region pixels* of the merged leg parts with the
    P2-refined feet art (m2-art feet.png, detail-transfer composite, 5px feather).
    Alpha/outline is NOT changed (P2 kept the original alpha by design) -> no
    silhouette drift; hands stay untouched (P2 decided hands = original art)."""
    fdir = os.path.join(FEET_DIR, shape)
    feet_p = os.path.join(fdir, 'feet.png')
    mask_p = os.path.join(fdir, 'masks', 'feet.png')
    if not (os.path.exists(feet_p) and os.path.exists(mask_p)):
        return 0
    feet = load_rgba(feet_p)
    mask = (load_rgba(mask_p)[:, :, 3] > 8)
    yy = np.arange(H)[:, None]
    mask = mask & (yy >= 960)          # feet only (safety: below calf)
    # 2px feather on the binary mask + a ~16px vertical fade at the mask top
    # (ankle line): the AI-refined art stops at the mask edge, so a hard cut
    # shows a 1px light band on the shin at 4x. Fade it out deterministically.
    w = cv2.GaussianBlur((mask * 255).astype(np.uint8), (5, 5), 0).astype(np.float32) / 255.0
    ramp = np.clip((yy - 1003) / 16.0, 0, 1).astype(np.float32)
    w = w * ramp
    changed = 0
    for d in drawables:
        if d['id'] not in ('leg-L', 'leg-R'):
            continue
        tex = load_rgba(os.path.join(texdir, d['texture']))
        m = (w > 0.01) & (tex[:, :, 3] > 8) & (feet[:, :, 3] > 8)
        if not m.any():
            continue
        rgb = tex[:, :, :3].astype(np.float32)
        fw = w[m][:, None]
        rgb[m] = feet[:, :, :3][m].astype(np.float32) * fw + rgb[m] * (1 - fw)
        tex[:, :, :3] = np.clip(rgb, 0, 255).astype(np.uint8)
        Image.fromarray(tex, 'RGBA').save(os.path.join(texdir, d['texture']))
        changed += int(m.sum())
    stats['feetOverlayPx'] = changed
    return changed




# ===================================================================== T3 ====
# T3-owned integration hooks (merged onto the T1 builder by
# .scratch/p5/rig/work/merge_t1_hooks.py). T1 content lives in
# split_girl_back_hair / finalize_girl_hair above; --skip-hair-split pins the
# v2.4.0 P3 behaviour via split_girl_back_hair_v24 (verbatim P3 copy below).
# ============================================================================
def _find_hands_overlay(shape):
    """Locate the T2 delivery: one full-canvas refined-hands RGBA overlay + mask
    per shape (Lead-confirmed layout, 2026-11-05):
        <hands_dir>/overlay-1x/{shape}.png          (refined RGB; alpha = arms alpha)
        <hands_dir>/masks/hands-mask-{shape}.png    (binary union hand mask,
                                                     hair/dark lineart excluded)
    Earlier candidate names are kept as fallbacks. Without a mask file the
    overlay alpha channel is used as the mask. Returns (overlay, mask|None)."""
    import glob
    hd = OPTS['hands_dir']
    stems = ['hands-overlay', 'hands_overlay', 'hands', 'hands-after', 'hands_refined']
    ov = None
    cand0 = os.path.join(hd, 'overlay-1x', shape + '.png')
    if os.path.exists(cand0):
        ov = cand0
    if ov is None:
        dirs = [os.path.join(hd, 'refined', shape), os.path.join(hd, shape),
                os.path.join(hd, 'out', shape), os.path.join(hd, 'work', 'refined', shape)]
        for d in dirs:
            for st in stems:
                for ext in ('.png', '.webp'):
                    cand = os.path.join(d, st + ext)
                    if os.path.exists(cand):
                        ov = cand
                        break
                if ov:
                    break
            if ov:
                break
    if ov is None:
        for pat in (os.path.join(hd, 'refined', shape, '*hand*.png'),
                    os.path.join(hd, shape, '*hand*.png')):
            hits = sorted(h for h in glob.glob(pat) if 'mask' not in os.path.basename(h).lower())
            if hits:
                ov = hits[0]
                break
    if ov is None:
        return None
    base = os.path.splitext(os.path.basename(ov))[0]
    cands = [os.path.join(hd, 'masks', f'hands-mask-{shape}.png'),
             os.path.join(hd, 'masks', f'hands-mask-{shape}.webp'),
             os.path.join(os.path.dirname(ov), 'masks', base + '.png'),
             os.path.join(hd, 'masks', shape, base + '.png'),
             os.path.join(os.path.dirname(ov), base + '-mask.png'),
             os.path.join(os.path.dirname(ov), base + '_mask.png'),
             os.path.join(os.path.dirname(ov), 'mask.png')]
    mask = next((c for c in cands if os.path.exists(c)), None)
    return ov, mask


def overlay_refined_hands(shape, drawables, texdir, stats):
    """P5-T2 hand refinement: replace hand-region RGB in EVERY hand drawable's
    texture (P2 `overlay_refined_feet` pattern: in-mask RGB replace + 5px feather
    + **alpha untouched**). Prefers the T2-delivered overlay_hands.py; inline
    fallback below if that delivery is missing.

    Why every hand texture: each P3 production hand texture (hand-L.png /
    hand-R.png) contains BOTH hands' wrist bands (arm parts are rebuilt from the
    whole arms layer by horizontal bands), and both drawables are drawn at z=65,
    so the union overlay must go into both or the last-drawn old texture wins."""
    hands_py = os.path.join(HERE, 'vendor', 'overlay_hands.py')
    if os.path.exists(hands_py):
        try:
            import importlib.util
            spec = importlib.util.spec_from_file_location('p5_overlay_hands', hands_py)
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            n = mod.overlay_hands(shape, drawables, texdir, stats,
                                  hands_dir=OPTS['hands_dir'])
            stats['handsOverlayFile'] = hands_py
            log(f'[{shape}] refined hands overlay via vendor/overlay_hands.py: '
                f'{stats.get("handsOverlay", {})} (mask px {n})')
            return n
        except Exception as e:   # noqa: BLE001 - fall through to inline path
            log(f'[{shape}] vendor/overlay_hands.py failed ({e}); inline fallback')
    found = _find_hands_overlay(shape)
    if not found:
        log(f'[{shape}] refined hands: no T2 delivery under {OPTS["hands_dir"]} '
            f'-> hand overlay skipped (0 px)')
        return 0
    ov_p, mask_p = found
    ov = load_rgba(ov_p)
    if ov.shape[:2] != (H, W):
        raise SystemExit(f'refined hands overlay {ov_p} is {ov.shape[1]}x{ov.shape[0]}, '
                         f'expected full canvas {W}x{H}')
    if mask_p:
        mask = np.array(Image.open(mask_p).convert('L')) > 128
    else:
        mask = ov[:, :, 3] > 8
    w = cv2.GaussianBlur(mask.astype(np.float32) * 255.0, (11, 11), 0).astype(np.float32) / 255.0
    changed = 0
    ntex = 0
    for d in drawables:
        if d['slot'] != 'hand':
            continue
        tp = os.path.join(texdir, d['texture'])
        tex = load_rgba(tp)
        m = (w > 0.01) & (tex[:, :, 3] > 8) & (ov[:, :, 3] > 8)
        if not m.any():
            continue
        rgb = tex[:, :, :3].astype(np.float32)
        fw = w[m][:, None]
        rgb[m] = ov[:, :, :3][m].astype(np.float32) * fw + rgb[m] * (1 - fw)
        tex[:, :, :3] = np.clip(rgb, 0, 255).astype(np.uint8)
        Image.fromarray(tex, 'RGBA').save(tp)
        changed += int(m.sum())
        ntex += 1
    stats['handsOverlayPx'] = changed
    stats['handsOverlayFiles'] = {'overlay': ov_p, 'mask': mask_p, 'textures': ntex}
    log(f'[{shape}] refined hands overlay: {changed}px on {ntex} textures '
        f'({os.path.basename(ov_p)}{" + mask" if mask_p else ""})')
    return changed


def _premul_upscale2x(tex):
    """2x upscale straight-alpha RGBA without halos (premultiply -> resize -> back)."""
    a = tex[:, :, 3:4].astype(np.float32) / 255.0
    pm = np.concatenate([tex[:, :, :3].astype(np.float32) * a,
                         tex[:, :, 3:4].astype(np.float32)], -1)
    up = cv2.resize(pm, (W * 2, H * 2), interpolation=cv2.INTER_CUBIC)
    aa = up[:, :, 3:4] / 255.0
    rgb = np.divide(up[:, :, :3], aa, out=np.zeros_like(up[:, :, :3]), where=aa > 1e-4)
    return np.concatenate([np.clip(rgb, 0, 255), np.clip(up[:, :, 3:4], 0, 255)],
                          -1).astype(np.uint8)


def _find_hands_2x(shape):
    """T2 experimental delivery: 2x full-canvas refined hand texture (1350x2400)
    + mask. Layout: <hands_dir>/refined2x/{shape}/hand-tex.png +
    <hands_dir>/masks/hands-mask-{shape}.png."""
    hd = OPTS['hands_dir']
    d = os.path.join(hd, 'refined2x', shape)
    for st in ('hand-tex', 'hands-2x', 'overlay-2x', 'hands'):
        p = os.path.join(d, st + '.png')
        if os.path.exists(p):
            mask = None
            for m in (os.path.join(hd, 'masks', f'hands-mask-{shape}.png'),
                      os.path.join(hd, 'masks', f'hands-mask-{shape}.webp'),
                      os.path.join(d, st + '-mask.png'), os.path.join(d, 'mask.png'),
                      os.path.join(d, 'hands-mask.png')):
                if os.path.exists(m):
                    mask = m
                    break
            if mask is None:
                found1x = _find_hands_overlay(shape)
                if found1x:
                    mask = found1x[1]
            return p, mask
    return None


def overlay_refined_hands_2x(shape, drawables, texdir, stats):
    """T2 experimental: hand drawables use 2x source textures (1350x2400 full
    canvas). Mesh UVs stay canvas-normalised (build_2d5 packs the trimmed 2x
    texture and remaps UVs) -> same silhouette/contract, only hand texels gain
    resolution. Alpha = 2x upscale of the *production* hand alpha (contract
    preserved), RGB refined inside the T2 mask (10px feather at 2x = 5px@1x).

    Deviation from the T2 overlay_hands.py 2x recipe (copy hand-tex.png as the
    source texture): that recipe would replace the production hand alpha before
    solidify_arm_interior/seam_extend_body and break their canvas-coordinate
    assumptions. Applying at the END of the texture pipeline is the only place
    where the alpha contract is exact; documented in REPORT.md."""
    found = _find_hands_2x(shape)
    if not found:
        log(f'[{shape}] hands-2x requested but no T2 refined2x delivery -> skipped')
        return 0
    tex2x_p, mask_p = found
    refined = load_rgba(tex2x_p)
    if refined.shape[:2] != (H * 2, W * 2):
        raise SystemExit(f'refined2x hand tex {tex2x_p} is {refined.shape[1]}x{refined.shape[0]}, '
                         f'expected {W * 2}x{H * 2}')
    if mask_p:
        mraw = np.array(Image.open(mask_p).convert('L'))
        if mraw.shape[:2] != (H * 2, W * 2):
            mraw = cv2.resize(mraw, (W * 2, H * 2), interpolation=cv2.INTER_LINEAR)
        mask2 = mraw > 128
    else:
        found1x = _find_hands_overlay(shape)
        if not found1x or not found1x[1]:
            mask2 = np.zeros((H * 2, W * 2), bool)
        else:
            m1 = np.array(Image.open(found1x[1]).convert('L'))
            if m1.shape[:2] != (H, W):
                m1 = cv2.resize(m1, (W, H), interpolation=cv2.INTER_LINEAR)
            mask2 = cv2.resize((m1 > 128).astype(np.uint8), (W * 2, H * 2),
                               interpolation=cv2.INTER_LINEAR) > 127
    w2 = cv2.GaussianBlur(mask2.astype(np.float32) * 255.0, (21, 21), 0).astype(np.float32) / 255.0
    changed = 0
    ntex = 0
    for d in drawables:
        if d['slot'] != 'hand':
            continue
        tex = load_rgba(os.path.join(texdir, d['texture']))
        up = _premul_upscale2x(tex)
        m = (w2 > 0.01) & (up[:, :, 3] > 8)
        if m.any():
            rgb = up[:, :, :3].astype(np.float32)
            fw = w2[m][:, None]
            rgb[m] = refined[:, :, :3][m].astype(np.float32) * fw + rgb[m] * (1 - fw)
            up[:, :, :3] = np.clip(rgb, 0, 255).astype(np.uint8)
        name = os.path.splitext(os.path.basename(d['texture']))[0] + '@2x.png'
        Image.fromarray(up, 'RGBA').save(os.path.join(texdir, name))
        d['texture'] = name
        d['texSize'] = [W * 2, H * 2]
        changed += int(m.sum())
        ntex += 1
    stats['hands2xPx'] = changed
    stats['hands2xFiles'] = {'refined': tex2x_p, 'mask': mask_p, 'textures': ntex}
    log(f'[{shape}] hands-2x: {ntex} textures 1350x2400, refined {changed}px '
        f'({os.path.basename(tex2x_p)}{" + mask" if mask_p else ""})')
    return changed


def apply_hair_split(shape, drawables, texdir, rig, stats):
    """Girl back-hair split dispatch.
    default            -> T1 v2.5 full split (split_girl_back_hair + finalize_girl_hair)
    --skip-hair-split  -> split_girl_back_hair_v24 = P3/v2.4.0 behaviour (inline
                          body repaint, no limb-hair layer, no tail-wisp strip)
    The hands-only fallback dist (Lead A/B request) uses --skip-hair-split."""
    if shape != 'girl':
        return
    if OPTS['skip_hair']:
        split_girl_back_hair_v24(drawables, texdir, rig, stats)
    else:
        split_girl_back_hair(drawables, texdir, rig, stats)


def finalize_girl_hair_hook(shape, drawables, texdir, rig, stats):
    """T1 v2.5 finalisation (limb hair layer + under-layer repaint + tail wisp
    strip), gated by --skip-hair-split for the A/B builds."""
    if shape != 'girl' or OPTS['skip_hair']:
        return
    finalize_girl_hair(drawables, texdir, rig, stats)


def split_girl_back_hair(drawables, texdir, rig, stats):
    """P3-B: extract the baked back hair from the girl body parts into an
    independent hair drawable that follows the head, and repaint the covered body
    pixels underneath with nearest non-hair body colours.

    Design note (deviation from the task's "z≈6" wording, quality/memory driven):
    the baked hair is *body-front* pixels (fringe around the face, wisps behind
    the shoulders, long hair between the legs). Putting it BEHIND the body would
    require cutting holes into the body parts plus a separate repaint drawable
    (+~4.8 MiB VRAM) and would break the production layering above legs(9.2)/
    tail(8.5). Instead the new layer sits at z=10.5 (just above body 10, below
    strands 12 / clothes 20+ / bangs 70): the final stacking order is identical
    to production, the body keeps its pixels (repainted under the hair) so head
    yaw reveals plausible body instead of voids, and VRAM only grows by the new
    hair texture. Weights: head=1 above the shoulders, then head->chest->hips
    blend for the long lower hair (a rigid head=1 over between-leg hair swings
    ~200px at yaw 25 and clips; QA gate wins, documented in the report)."""
    names = ['body-head', 'body-torso', 'leg-L', 'leg-R']
    parts = {n: load_rgba(os.path.join(texdir, n + '.png')) for n in names}
    Hm = np.zeros((H_, W_), bool)
    hair_rgb = np.zeros((H_, W_, 3), np.uint8)
    for n in names:
        a = parts[n]
        r, g, b = (a[:, :, i].astype(int) for i in range(3))
        h = (b > r + 8) & (b > g + 3) & (b > 60) & (a[:, :, 3] > 8)
        hair_rgb[h] = a[h, :3]
        Hm |= h
    if not Hm.any():
        return
    # v2.5: NO inline repaint here. P3's 24-iteration BFS never updated its own
    # source buffer, so deep interior pixels averaged the *original blue hair*
    # colours back in (measured: torso under-layer still mean RGB [114,129,156]).
    # The under-layer is repainted in finalize_girl_hair() with a convergent
    # nearest-fill, hidden pixels only (rest parity stays exactly 0px).
    # new head-following hair layer (same RGB as the original baked hair)
    hair = np.zeros((H_, W_, 4), np.uint8)
    hair[Hm, :3] = hair_rgb[Hm]
    hair[Hm, 3] = 255
    hair = color_bleed(hair)
    Image.fromarray(hair, 'RGBA').save(os.path.join(texdir, 'hair-back-girl.png'))
    alpha = hair[:, :, 3].astype(np.float32) / 255
    mesh = build_mesh(alpha, rig, 'hair-back-girl', 'hairBack', '', 10)
    rows_b, rows_w = [], []
    for (x, y) in mesh['positions']:
        w = rig.girl_hair_weights(x, y)
        items = sorted(w.items(), key=lambda kv: -kv[1])[:4]
        sm = sum(v for _, v in items) or 1
        items = [(kk, v / sm) for kk, v in items if v / sm > 1e-4]
        sm = sum(v for _, v in items) or 1
        rows_b.append([rig.bone_index[kk] for kk, _ in items] + [0] * (4 - len(items)))
        rows_w.append([round(v / sm, 4) for _, v in items] + [0.0] * (4 - len(items)))
    mesh['bones'] = rows_b
    mesh['weights'] = rows_w
    # v2.5: P3 left deform[] as computed for the hairBACK fallback = headW 0, so
    # the head-yaw face warp (shader aDeform.x) never applied to this layer while
    # bangs/body-head did -> 7-15px discontinuity at yaw. Recompute per vertex.
    mesh['deform'] = _deform_from_mesh(mesh, [b['id'] for b in rig.tmpl['skeleton']['bones']])
    drawables.append({'id': 'hair-back-girl', 'slot': 'hairBack', 'z': 10.5, 'role': 'hairBack',
                      'texture': 'hair-back-girl.png', 'mesh': mesh,
                      'rect': [0, 0, W_, H_], 'mask': []})
    stats['girlHairBackPx'] = int(Hm.sum())



# --------------------------------------------------- T1 v2.5 full hair split ---
def _mesh_deform_from_weights(mesh, bone_ids):
    """deform[0]=head share, deform[1]=chest share (shader face-warp weights),
    recomputed from the mesh's actual skin weights."""
    out = []
    for bs, ws in zip(mesh['bones'], mesh['weights']):
        hw = sum(w for b, w in zip(bs, ws) if bone_ids[b] == 'head')
        cw = sum(w for b, w in zip(bs, ws) if bone_ids[b] in ('chest', 'spine'))
        out.append([round(min(1.0, hw), 4), round(min(1.0, cw * 0.9), 4)])
    return out


def _deform_from_mesh(mesh, bone_ids):
    return _mesh_deform_from_weights(mesh, bone_ids)


def _alpha_plane(drawables, texdir):
    """full-canvas alpha planes for every drawable texture (trimmed -> placed)."""
    A = {}
    for d in drawables:
        fp = os.path.join(texdir, d['texture'])
        if not os.path.exists(fp):
            continue
        arr = np.array(Image.open(fp).convert('RGBA'))
        if arr.shape[0] != H_ or arr.shape[1] != W_:
            full = np.zeros((H_, W_), np.uint8)
            x0, y0 = int(d['rect'][0]), int(d['rect'][1])
            h, w = arr.shape[:2]
            full[y0:y0 + h, x0:x0 + w] = arr[:, :, 3]
            arr = full
        else:
            arr = arr[:, :, 3]
        A[d['id']] = arr
    return A


def _girl_outfit_visible(drawables, combo):
    ids = set()
    for d in drawables:
        if d['slot'] in BASE_DRAW_SLOTS or d['slot'] in HAIR_SLOTS_ALL:
            ids.add(d['id'])
        elif combo != 'base' and _combo_of(d['id']) == combo:
            ids.add(d['id'])
    return ids


def _above_transparency(drawables, texdir, part_ids):
    """For each part of interest and each outfit, return:
      above_le[pid] = pixels where NOTHING is drawn above the part in ANY outfit
      hidden[pid]   = pixels where the part is fully covered (opaque) in ALL outfits
    Exact alpha-over math, runtime draw order (z then id)."""
    A = _alpha_plane(drawables, texdir)
    seq = sorted(drawables, key=lambda d: (float(d['z']), str(d['id'])))
    above_le = {p: np.ones((H_, W_), bool) for p in part_ids}
    hidden = {p: np.ones((H_, W_), bool) for p in part_ids}
    for combo in ['base'] + GIRL_OUTFIT_COMBOS:
        visible = _girl_outfit_visible(drawables, combo)
        running = np.zeros((H_, W_), np.float32)
        for d in reversed(seq):
            if d['id'] not in visible:
                continue
            if d['id'] in above_le:
                above_le[d['id']] &= (running <= 1.0 / 255.0)
                hidden[d['id']] &= (running >= 0.999)
            a = A[d['id']].astype(np.float32) / 255.0
            running = a + running * (1.0 - a)
    return above_le, hidden


def _load_part(drawables, texdir, pid):
    d = next(x for x in drawables if x['id'] == pid)
    return load_rgba(os.path.join(texdir, d['texture']))


def _save_part(drawables, texdir, pid, arr):
    d = next(x for x in drawables if x['id'] == pid)
    Image.fromarray(arr, 'RGBA').save(os.path.join(texdir, d['texture']))


def nearest_fill_converge(rgb, known, fill, max_iter=400):
    """Deterministic nearest-neighbour wavefront fill whose source is updated
    every iteration (no stale/contaminated colours feed back), Telea fallback."""
    rgb = rgb.astype(np.float32).copy()
    known = known.copy()
    k = known.astype(np.float32)
    for _ in range(max_iter):
        need = fill & ~known
        if not need.any():
            break
        num = cv2.filter2D(rgb * k[:, :, None], -1, np.ones((3, 3), np.float32),
                           borderType=cv2.BORDER_REPLICATE)
        den = cv2.filter2D(k, -1, np.ones((3, 3), np.float32),
                           borderType=cv2.BORDER_REPLICATE)
        grow = need & (den > 0.01)
        if not grow.any():
            break
        rgb[grow] = num[grow] / den[grow][:, None]
        k[grow] = 1.0
        known = known | grow
    left = fill & ~known
    if left.any():
        fixed = cv2.inpaint(np.clip(rgb, 0, 255).astype(np.uint8),
                            left.astype(np.uint8) * 255, 4, cv2.INPAINT_TELEA)
        rgb[left] = fixed[left]
    return np.clip(rgb, 0, 255)


def _nearest_strand_weights(positions, strand_drawables, rig, fallback_dist=24.0):
    """Weights for the extracted limb-hair layer: take the skin weights of the
    nearest *production hair-strand mesh vertex* (the fragments are pieces of
    those strands), fall back to the girl hair y-blend far from any strand."""
    V, B, Wt, Df = [], [], [], []
    for d in strand_drawables:
        m = d['mesh']
        V.append(np.asarray(m['positions'], np.float32))
        B.append(np.asarray(m['bones'], np.int32))
        Wt.append(np.asarray(m['weights'], np.float32))
        Df.append(np.asarray(m.get('deform') or [[0.85, 0.0]] * len(m['positions']), np.float32))
    if not V:
        return None
    V = np.concatenate(V); B = np.concatenate(B); Wt = np.concatenate(Wt); Df = np.concatenate(Df)
    P = np.asarray(positions, np.float32)
    d2 = ((P[:, None, :] - V[None, :, :]) ** 2).sum(2)
    idx = d2.argmin(1)
    dist = np.sqrt(d2[np.arange(len(P)), idx])
    bone_ids = [b['id'] for b in rig.tmpl['skeleton']['bones']]
    bones = B[idx].tolist()
    weights = Wt[idx].tolist()
    deform = Df[idx].tolist()
    n_fb = 0
    for i in range(len(P)):
        if dist[i] > fallback_dist:
            w = rig.girl_hair_weights(float(P[i, 0]), float(P[i, 1]))
            items = sorted(w.items(), key=lambda kv: -kv[1])[:4]
            ssum = sum(v for _, v in items) or 1
            items = [(k, v / ssum) for k, v in items]
            ssum = sum(v for _, v in items) or 1
            bones[i] = [rig.bone_index[k] for k, _ in items] + [0] * (4 - len(items))
            weights[i] = [round(v / ssum, 4) for _, v in items] + [0.0] * (4 - len(items))
            deform[i] = [0.85, 0.0]   # production strand warp weight (see rig.deformers)
            n_fb += 1
    return bones, weights, deform, int(n_fb), float(np.median(dist))


def _sample_rest_color(drawables, texdir, pts, exclude_ids):
    """Colour that the scene would show at `pts` if the excluded drawables were
    not there (alpha-over of the remaining drawables in runtime order). Used to
    repaint the under-layer of extracted hair islands with plausible content
    (the islands stay alpha=opaque so no background hole can open when the hair
    moves away; rest is unchanged because the new hair layer covers them)."""
    ys = np.clip(np.round(pts[:, 1]).astype(int), 0, H_ - 1)
    xs = np.clip(np.round(pts[:, 0]).astype(int), 0, W_ - 1)
    seq = sorted(drawables, key=lambda d: (float(d['z']), str(d['id'])))
    out = np.zeros((len(pts), 3), np.float32)
    out[:] = [250.0, 240.0, 230.0]
    for d in seq:
        if d['id'] in exclude_ids:
            continue
        fp = os.path.join(texdir, d['texture'])
        if not os.path.exists(fp):
            continue
        arr = np.array(Image.open(fp).convert('RGBA'))
        if arr.shape[0] != H_ or arr.shape[1] != W_:
            full = np.zeros((H_, W_, 4), np.uint8)
            x0, y0 = int(d['rect'][0]), int(d['rect'][1])
            h, w = arr.shape[:2]
            full[y0:y0 + h, x0:x0 + w] = arr
            arr = full
        a = arr[ys, xs, 3].astype(np.float32) / 255.0
        rgb = arr[ys, xs, :3].astype(np.float32)
        out = rgb * a[:, None] + out * (1 - a[:, None])
    return out


def finalize_girl_hair(drawables, texdir, rig, stats):
    """T1 v2.5 girl hair finalisation (deterministic, no bones added):
      A) extract the detached hair islands baked in the arm/hand texture band
         (arm-upper-L: 3,207px) -> new `hair-arm-girl` drawable at z=66 with
         production hair-strand weights, so the strands stop following the arms;
      B) repaint the under-layer of P3's 5,117px baked line-art (hidden px only,
         convergent nearest-fill) so head yaw/roll exposes plausible body/cloth;
      C) strip the old-white-hair wisp baked in the tail texture (521px, fully
         covered at rest -> rest parity exact) so the tail physics no longer
         drags hair pixels;
      D) recompute shader deform weights for both new hair layers."""
    bone_ids = [b['id'] for b in rig.tmpl['skeleton']['bones']]
    # ---- alpha-above maps (exact, per outfit) ----
    poi = GIRL_LIMB_PARTS + GIRL_HAIR_BODY_PARTS + ['tail']
    above_le, hidden = _above_transparency(drawables, texdir, poi)
    # ---- A) limb islands -> new head-following hair layer ----
    layer = np.zeros((H_, W_, 4), np.uint8)
    ex_total = 0
    per_part = {}
    for pid in GIRL_LIMB_PARTS:
        a = _load_part(drawables, texdir, pid)
        al = a[:, :, 3]
        n, lab, st, _ = cv2.connectedComponentsWithStats((al > 8).astype(np.uint8), 8)
        islands = np.zeros((H_, W_), bool)
        for i in range(1, n):
            if st[i, 4] < LIMB_ISLAND_MAX_PX:
                islands |= (lab == i)
        if not islands.any():
            per_part[pid] = {'islands': 0, 'extracted': 0}
            continue
        ex = islands & above_le[pid]
        layer[ex] = a[ex]
        ys, xs = np.where(ex)
        pts = np.stack([xs, ys], 1).astype(np.float32)
        behind = _sample_rest_color(drawables, texdir, pts,
                                    (pid, HAIR_ARM_ID))
        a[ex, :3] = np.clip(behind, 0, 255).astype(np.uint8)
        # alpha kept: the extracted island geometry moves with the hair layer; the
        # arm keeps a plausible behind-colour patch, so no background hole can
        # open at the island's rest position under head yaw/roll.
        _save_part(drawables, texdir, pid, a)
        per_part[pid] = {'islands': int(islands.sum()), 'extracted': int(ex.sum())}
        ex_total += int(ex.sum())
    stats['girlArmHairPx'] = ex_total
    stats['girlArmHairParts'] = per_part
    layer = color_bleed(layer)
    Image.fromarray(layer, 'RGBA').save(os.path.join(texdir, HAIR_ARM_ID + '.png'))
    alpha = layer[:, :, 3].astype(np.float32) / 255
    mesh = build_mesh(alpha, rig, HAIR_ARM_ID, 'strands', '', 8)
    strand_drawables = [d for d in drawables if d['slot'] == 'strands']
    nb = _nearest_strand_weights(mesh['positions'], strand_drawables, rig)
    if nb is not None:
        bones, weights, deform, n_fb, med = nb
        mesh['bones'] = bones
        mesh['weights'] = weights
        # v2.5: the shader head-yaw warp weight must be the production strand's
        # deform.x (~0.85), NOT the recomputed head skin weight (which is ~0 for
        # the strand physics-chain weights) -> otherwise the fragments still lag
        # the hair by 25-30px at yaw 25.
        mesh['deform'] = deform
        stats['girlArmHairW'] = {'fallbackVerts': n_fb, 'medianNearestStrandPx': round(med, 2)}
    drawables.append({'id': HAIR_ARM_ID, 'slot': 'strands', 'z': HAIR_ARM_Z,
                      'role': 'strand', 'texture': HAIR_ARM_ID + '.png',
                      'mesh': mesh, 'rect': [0, 0, W_, H_], 'mask': []})
    # ---- B) under-layer repaint of P3's extracted baked line-art ----
    hm = None
    hb = next((d for d in drawables if d['id'] == 'hair-back-girl'), None)
    if hb is not None:
        hm = load_rgba(os.path.join(texdir, hb['texture']))[:, :, 3] > 8
    rep_total = 0
    for pid in GIRL_HAIR_BODY_PARTS:
        a = _load_part(drawables, texdir, pid)
        if hm is None:
            continue
        rep = hm & (a[:, :, 3] > 8) & hidden[pid]
        if not rep.any():
            continue
        known = (a[:, :, 3] > 8) & ~hm
        rgb = nearest_fill_converge(a[:, :, :3], known, rep)
        a[rep, :3] = rgb[rep].astype(np.uint8)
        _save_part(drawables, texdir, pid, a)
        stats['girlHairUnderRepaint_' + pid] = int(rep.sum())
        rep_total += int(rep.sum())
    stats['girlHairUnderRepaintPx'] = rep_total
    # ---- C) tail: the only leftover 'hair' in the tail part is a 521px piece of
    # the OLD white-hair backing (not the blue hair), 100% covered by static
    # layers at rest. It is NOT removed in v2.5: removing it would leave a hole
    # at its rest position once the tail physics swing moves the tail away, and
    # there is no browser window available in T1 to certify a tail-sway frame.
    # Quantified in REPORT.md; T3/T4 can delete it with a real tail-sway QA if
    # wanted (see hair-patch-spec.json).
    tail = _load_part(drawables, texdir, 'tail')
    op = tail[:, :, 3] > 8
    r_, g_, b_ = (tail[:, :, i].astype(int) for i in range(3))
    blue = (b_ > r_ + 8) & (b_ > g_ + 3) & (b_ > 60)
    region = np.zeros((H_, W_), bool)
    region[660:800, 450:545] = True   # upper-right of the fish tail (old hair wisp)
    wisp = op & region & (tail[:, :, :3].min(2) >= 190) & ~blue & hidden['tail']
    stats['girlTailHairPx'] = int(wisp.sum())
    stats['girlTailHairRemovedPx'] = 0
    # ---- D) deform for the P3 hair layer (see split_girl_back_hair) ----
    if hb is None:
        pass
    log(f'[girl] hair-full-split: arm islands {ex_total}px, under-repaint {rep_total}px, '
        f'tail hair {int(wisp.sum())}px -> {HAIR_ARM_ID} z={HAIR_ARM_Z}')
    return ex_total



# P3/v2.4.0 baseline hair split, kept verbatim for --skip-hair-split
# (hands-only fallback dist: exact v2.4.0 rest/hair behaviour).
def split_girl_back_hair_v24(drawables, texdir, rig, stats):
    """P3-B: extract the baked back hair from the girl body parts into an
    independent hair drawable that follows the head, and repaint the covered body
    pixels underneath with nearest non-hair body colours.

    Design note (deviation from the task's "z≈6" wording, quality/memory driven):
    the baked hair is *body-front* pixels (fringe around the face, wisps behind
    the shoulders, long hair between the legs). Putting it BEHIND the body would
    require cutting holes into the body parts plus a separate repaint drawable
    (+~4.8 MiB VRAM) and would break the production layering above legs(9.2)/
    tail(8.5). Instead the new layer sits at z=10.5 (just above body 10, below
    strands 12 / clothes 20+ / bangs 70): the final stacking order is identical
    to production, the body keeps its pixels (repainted under the hair) so head
    yaw reveals plausible body instead of voids, and VRAM only grows by the new
    hair texture. Weights: head=1 above the shoulders, then head->chest->hips
    blend for the long lower hair (a rigid head=1 over between-leg hair swings
    ~200px at yaw 25 and clips; QA gate wins, documented in the report)."""
    names = ['body-head', 'body-torso', 'leg-L', 'leg-R']
    parts = {n: load_rgba(os.path.join(texdir, n + '.png')) for n in names}
    Hm = np.zeros((H_, W_), bool)
    hair_rgb = np.zeros((H_, W_, 3), np.uint8)
    for n in names:
        a = parts[n]
        r, g, b = (a[:, :, i].astype(int) for i in range(3))
        h = (b > r + 8) & (b > g + 3) & (b > 60) & (a[:, :, 3] > 8)
        hair_rgb[h] = a[h, :3]
        Hm |= h
    if not Hm.any():
        return
    # repaint the body under the hair (visible only when the head turns)
    for n in names:
        a = parts[n].copy()
        h = Hm & (a[:, :, 3] > 8)
        if not h.any():
            continue
        rgb = a[:, :, :3].astype(np.float32)
        known = (a[:, :, 3] > 8) & ~h
        src = rgb.copy()
        k = known.astype(np.float32)
        cur = known.copy()
        for _ in range(24):
            need = h & ~cur
            if not need.any():
                break
            num = cv2.filter2D(src * k[:, :, None], -1, np.ones((3, 3), np.float32), borderType=cv2.BORDER_REPLICATE)
            den = cv2.filter2D(k, -1, np.ones((3, 3), np.float32), borderType=cv2.BORDER_REPLICATE)
            grow = need & (den > 0.01)
            if not grow.any():
                break
            rgb[grow] = num[grow] / den[grow][:, None]
            k[grow] = 1.0
            cur = cur | grow
        a[:, :, :3] = np.clip(rgb, 0, 255).astype(np.uint8)
        Image.fromarray(a, 'RGBA').save(os.path.join(texdir, n + '.png'))
    # new head-following hair layer (same RGB as the original baked hair)
    hair = np.zeros((H_, W_, 4), np.uint8)
    hair[Hm, :3] = hair_rgb[Hm]
    hair[Hm, 3] = 255
    hair = color_bleed(hair)
    Image.fromarray(hair, 'RGBA').save(os.path.join(texdir, 'hair-back-girl.png'))
    alpha = hair[:, :, 3].astype(np.float32) / 255
    mesh = build_mesh(alpha, rig, 'hair-back-girl', 'hairBack', '', 10)
    rows_b, rows_w = [], []
    for (x, y) in mesh['positions']:
        w = rig.girl_hair_weights(x, y)
        items = sorted(w.items(), key=lambda kv: -kv[1])[:4]
        sm = sum(v for _, v in items) or 1
        items = [(kk, v / sm) for kk, v in items if v / sm > 1e-4]
        sm = sum(v for _, v in items) or 1
        rows_b.append([rig.bone_index[kk] for kk, _ in items] + [0] * (4 - len(items)))
        rows_w.append([round(v / sm, 4) for _, v in items] + [0.0] * (4 - len(items)))
    mesh['bones'] = rows_b
    mesh['weights'] = rows_w
    drawables.append({'id': 'hair-back-girl', 'slot': 'hairBack', 'z': 10.5, 'role': 'hairBack',
                      'texture': 'hair-back-girl.png', 'mesh': mesh,
                      'rect': [0, 0, W_, H_], 'mask': []})
    stats['girlHairBackPx'] = int(Hm.sum())


def build_seam_fill(shape, rig):
    """Tiny deterministic fill for residual 1px rest holes detected by QA
    (wrist seam gaps). One small drawable at z=7.6 behind hands/sleeves; colour =
    production reference colour, so at rest it simply reads as the neighbouring
    art. Regenerate with tools/make_seam_fill.py after any build change."""
    fp = os.path.join(PROD_IN, f'seamfill-{shape}.npz')
    if not os.path.exists(fp):
        return None
    z = np.load(fp)
    mask = z['mask'].astype(np.uint8) * 255
    rgba = np.zeros((H, W, 4), np.uint8)
    rgba[:, :, :3] = z['rgb']
    rgba[:, :, 3] = cv2.GaussianBlur(mask, (3, 3), 0)
    rgba = color_bleed(rgba)
    out = np.zeros((H, W, 4), np.uint8)
    x0, y0, x1, y1 = [int(v) for v in z['bbox']]
    out = rgba
    return out, int((z['mask']).sum())


def solidify_arm_interior(shape, drawables, texdir):
    """The refined arms layer has semi-transparent wrist creases; arm parts split
    along horizontal bands both inherit the semi alpha there -> tiny background
    holes at the wrist. Make the *interior* of the arms silhouette (distance to
    its outer edge > 2px) fully opaque; the outer AA edge stays as authored."""
    arms = load_rgba(os.path.join(M4, 'assets', 'art-v2', shape, 'arms.png'))
    am = (arms[:, :, 3] > 8).astype(np.uint8)
    dist = cv2.distanceTransform(am, cv2.DIST_L2, 5)
    interior = dist > 2.0
    changed = 0
    for d in drawables:
        if not d['id'].startswith(('arm-', 'hand-')):
            continue
        tex = np.array(Image.open(os.path.join(texdir, d['texture'])).convert('RGBA'))
        m = (tex[:, :, 3] > 8) & interior & (tex[:, :, 3] < 250)
        if not m.any():
            continue
        tex[m, 3] = 255
        Image.fromarray(tex, 'RGBA').save(os.path.join(texdir, d['texture']))
        changed += int(m.sum())
    return changed


def seam_extend_body(drawables, texdir):
    """Close 1px AA gaps between body parts (hand/wrist, neck, knee): extend each
    body part 2px into other body-part coverage (alpha forced opaque). Colours
    come from the production-rest porting / source restore, so the overlap is
    invisible at rest."""
    base = [d for d in drawables if d['slot'] in BASE_DRAW_SLOTS]
    union = np.zeros((H, W), bool)
    for d in base:
        a = np.array(Image.open(os.path.join(texdir, d['texture'])).convert('RGBA'))[:, :, 3]
        d['_a'] = a
        union |= a > 8
    changed = 0
    for d in base:
        a = d['_a']
        own = a > 8
        ext = (cv2.dilate(own.astype(np.uint8), np.ones((5, 5), np.uint8)) > 0) & (a < 250) & union
        if not ext.any():
            continue
        tex = np.array(Image.open(os.path.join(texdir, d['texture'])).convert('RGBA'))
        tex[ext, 3] = 255
        Image.fromarray(tex, 'RGBA').save(os.path.join(texdir, d['texture']))
        changed += int(ext.sum())
        d.pop('_a', None)
    for d in base:
        d.pop('_a', None)
    return changed


def seam_extend(drawables, texdir, base_ids):
    """Garment parts in M2 are butt-cut along straight lines (collar/torso,
    sleeve/torso, torso/skirt). At 4x the 1px AA-on-AA boundary leaves a thin
    gap/seam line. Expand every garment part 1px into opaque neighbour parts of
    the same outfit; the extended RGB is the production-rest colour (ported
    later), so the overlap is invisible and the seam disappears."""
    combos = {}
    for d in drawables:
        if d['slot'] in PORT_SLOTS:
            prefix = d['id'].split('-')[0]
            key = 'sweater' if d['id'].startswith('sweater-') else prefix
            combos.setdefault(_combo_of(d['id']), []).append(d)
    changed = 0
    for combo, parts in combos.items():
        vis = [d for d in drawables if d['slot'] in BASE_DRAW_SLOTS] + parts
        alphas = {}
        for d in vis:
            alphas[d['id']] = np.array(Image.open(os.path.join(texdir, d['texture']))
                                       .convert('RGBA'))[:, :, 3]
        union = np.zeros((H, W), bool)
        for d in parts:
            union |= alphas[d['id']] > 8
        union |= np.zeros((H, W), bool)
        # body coverage too (so garment can extend over body under a garment edge)
        for d in vis:
            union |= alphas[d['id']] > 250
        # union of *any* non-transparent pixel of the same outfit (semi-transparent
        # AA rows at the shared cut must count too, otherwise both sides stay
        # alpha~0.5 and the page background leaks through as a 1px light line)
        union_any = np.zeros((H, W), bool)
        for d in vis:
            union_any |= alphas[d['id']] > 8
        for d in parts:
            a = alphas[d['id']]
            own = a > 8
            ext = (cv2.dilate(own.astype(np.uint8), np.ones((2*SEAM_EXTEND+1, 2*SEAM_EXTEND+1), np.uint8)) > 0) & (a < 250)
            ext &= union_any
            if not ext.any():
                continue
            tex = np.array(Image.open(os.path.join(texdir, d['texture'])).convert('RGBA'))
            tex[ext, 3] = 255
            Image.fromarray(tex, 'RGBA').save(os.path.join(texdir, d['texture']))
            changed += int(ext.sum())
    return changed


def _combo_of(did):
    for c in ['maid', 'sweater-plaid', 'sweater-pleated', 'hoodie-plaid',
              'hoodie-pleated', 'sailor-plaid']:
        if did.startswith(c + '-'):
            return c
    return ''


PORT_SLOTS = {'topUnder', 'topBody', 'bottom', 'collar', 'sleeveUpper', 'sleeveFore'}
BASE_DRAW_SLOTS = {'body', 'legs', 'armUpper', 'armFore', 'hand'}


def port_rest_colors(shape, drawables, outfits, texdir):
    """Rest-composite color porting (deterministic).

    M2's split parts bake hidden-fill / overlap colours into regions that are
    *visible at rest* (wrong z-direction, e.g. skirt extension above the waist,
    sleeve piece over the skirt) -> gray bands / white patches. Instead of
    hand-tuning each part, restore the exact production rest look: for every
    pixel where a garment part is the topmost (among body+garment parts), copy
    the production reference render colour. Geometry/alpha stay cutout; only
    visible rest colours are ported. Hidden/overlap regions keep M2 fills for
    motion.
    """
    refdir = os.path.join(PROD_IN, 'ref')
    base_ids = [d['id'] for d in drawables if d['slot'] in BASE_DRAW_SLOTS]
    changed = 0
    for combo, outfit in outfits.items():
        if combo == 'base':
            continue
        refp = os.path.join(refdir, f'{shape}_{combo}_rgba.png')
        if not os.path.exists(refp):
            continue
        ref = np.array(Image.open(refp).convert('RGBA'))
        ref_a = ref[:, :, 3]
        part_ids = set()
        for slot, ids in outfit.items():
            if isinstance(ids, list) and slot in PORT_SLOTS:
                part_ids.update(ids)
        vis = [d for d in drawables if d['id'] in base_ids or d['id'] in part_ids]
        vis.sort(key=lambda d: d['z'])
        # Port the production rest colour to EVERY pixel of every garment part
        # (not just the topmost ones): at a part cut line the higher part is
        # semi-transparent for 1px and blends with the lower part; if only the
        # topmost pixels are ported that blend shows a 1px hard seam. Porting
        # all pixels makes both sides of every seam equal to the production
        # composite, so the seam is invisible at rest. Hidden/overlap pixels get
        # the production colour of what is above them (plausible under motion).
        for d in vis:
            if d['slot'] not in PORT_SLOTS:
                continue
            tex = np.array(Image.open(os.path.join(texdir, d['texture'])).convert('RGBA'))
            m = (tex[:, :, 3] > 0) & (ref_a > 0)
            if not m.any():
                continue
            tex[m, :3] = ref[m, :3]
            Image.fromarray(tex, 'RGBA').save(os.path.join(texdir, d['texture']))
            changed += int(m.sum())
    log(f'[{shape}] rest-color porting: {changed} garment px')


# ------------------------------------------------------------------ weights ---
class Rig:
    def __init__(self, shape):
        self.shape = shape
        self.tmpl = json.load(open(os.path.join(M4, 'dist', shape, 'rig.json')))
        self.bones = {b['id']: b for b in self.tmpl['skeleton']['bones']}
        self.bone_index = {b['id']: i for i, b in enumerate(self.tmpl['skeleton']['bones'])}
        self.phys = {p['id']: p for p in self.tmpl['physics']}
        self.center = 337.5
        cfg = json.load(open(os.path.join(M2, 'base', shape, 'parts-index.json')))['shape_cfg']
        self.leg_cfg = {
            'hipY': float(cfg['leg_top']) - 18.0,
            'kneeY': float(cfg['knee']),
            'ankleY': float(cfg['ankle']),
            'xL': [float(v) for v in cfg['leg_x']['L']],
            'xR': [float(v) for v in cfg['leg_x']['R']],
        }

    def add_leg_bones(self):
        """P3-A: append thighL/shinL/footL/thighR/shinR/footR (indices 59-64,
        old indices unchanged) and refresh bone index map."""
        bones = self.tmpl['skeleton']['bones']
        assert len(bones) == 59, len(bones)
        c = self.leg_cfg
        for side, xs in (('L', c['xL']), ('R', c['xR'])):
            bones.append({'id': 'thigh' + side, 'parent': 'hips',
                          'base': [xs[0], c['hipY']], 'angle': -90.0,
                          'length': int(round(c['kneeY'] - c['hipY']))})
            bones.append({'id': 'shin' + side, 'parent': 'thigh' + side,
                          'base': [xs[1], c['kneeY']], 'angle': -90.0,
                          'length': int(round(c['ankleY'] - c['kneeY']))})
            bones.append({'id': 'foot' + side, 'parent': 'shin' + side,
                          'base': [xs[2], c['ankleY']], 'angle': -80.0, 'length': 40})
        self.bones = {b['id']: b for b in bones}
        self.bone_index = {b['id']: i for i, b in enumerate(bones)}
        return [b['id'] for b in bones[59:]]

    def leg_weights(self, side, y):
        c = self.leg_cfg
        a1 = smoothstep(c['hipY'] - 10, c['hipY'] + 45, y)
        a2 = smoothstep(c['kneeY'] - 30, c['kneeY'] + 30, y)
        a3 = smoothstep(c['ankleY'] - 15, c['ankleY'] + 15, y)
        w = {'hips': 1 - a1, 'thigh' + side: a1 * (1 - a2),
             'shin' + side: a2 * (1 - a3), 'foot' + side: a3}
        return {k: v for k, v in w.items() if v > 1e-4}

    def girl_hair_weights(self, x, y):
        """head above shoulders, blend head->chest->hips for the long lower hair
        (rigid head=1 over between-leg hair clips at yaw 25 -> QA gate)."""
        a1 = 1.0 - smoothstep(520.0, 700.0, y)     # head share above shoulders
        rest = self.core(x, y, allow_head=False)
        w = {'head': a1}
        s = sum(rest.values()) or 1
        for k, v in rest.items():
            w[k] = w.get(k, 0) + (1 - a1) * v / s
        return {k: v for k, v in w.items() if v > 1e-4}

    def add_leg_collider_meta(self, rig_json):
        """P3-A: capsule colliders legL/legR get aBone/bBone + local offsets so the
        runtime can drive them from the new leg bones (sphere-bone convention
        extended to capsule endpoints). Legacy a/b world coords are preserved."""
        c = self.leg_cfg
        for col in rig_json.get('colliders') or []:
            if col.get('id') not in ('legL', 'legR'):
                continue
            side = 'L' if col['id'] == 'legL' else 'R'
            xs = c['xL'] if side == 'L' else c['xR']
            thigh_base = [xs[0], c['hipY']]
            shin_base = [xs[1], c['kneeY']]
            a, b = col['a'], col['b']
            col['aBone'] = 'thigh' + side
            col['bBone'] = 'shin' + side
            col['aLocal'] = [round(a[0] - thigh_base[0], 2), round(a[1] - thigh_base[1], 2)]
            col['bLocal'] = [round(b[0] - shin_base[0], 2), round(b[1] - shin_base[1], 2)]
            col['legBoneChain'] = ['thigh' + side, 'shin' + side, 'foot' + side]
        rig_json['legs'] = {
            'bones': ['thighL', 'shinL', 'footL', 'thighR', 'shinR', 'footR'],
            'appendedAt': 59, 'joints': {'hipY': c['hipY'], 'kneeY': c['kneeY'], 'ankleY': c['ankleY']},
            'colliderBones': {'legL': ['thighL', 'shinL'], 'legR': ['thighR', 'shinR']},
        }
        rig_json.setdefault('cutout', {})['legBones'] = True
        return rig_json

    def b(self, bid):
        return self.bones[bid]['base']

    def core(self, x, y, allow_head=True):
        hy = self.b('neck')[1]
        cy = self.b('chest')[1]
        sy = self.b('spine')[1]
        hip = self.b('hips')[1]
        head = 1.0 - smoothstep(hy - 25, hy + 25, y)
        neck = (1.0 - head) * (1.0 - smoothstep(hy, hy + 45, y))
        chest = (1.0 - head - neck) * (1.0 - smoothstep(cy, cy + 60, y))
        spine = (1.0 - head - neck - chest) * (1.0 - smoothstep(sy, sy + 80, y))
        hips = max(0.0, 1.0 - head - neck - chest - spine)
        w = {'head': head, 'neck': neck, 'chest': chest, 'spine': spine, 'hips': hips}
        w = {k: v for k, v in w.items() if v > 1e-4}
        if not allow_head:
            hw = w.pop('head', 0.0)
            if hw:
                w['neck'] = w.get('neck', 0) + hw * 0.45
                w['chest'] = w.get('chest', 0) + hw * 0.55
        return w

    def arm(self, x, y, kind, side):
        sy = self.b('upperArm' + side)[1]
        ey = self.b('forearm' + side)[1]
        wy = self.b('hand' + side)[1]
        ua, fa, hd = 'upperArm' + side, 'forearm' + side, 'hand' + side
        if kind == 'upper':
            f = smoothstep(sy - 5, sy + 55, y)
            return {ua: 0.65 + 0.35 * f, 'chest': 0.35 * (1 - f)}
        if kind == 'fore':
            f = smoothstep(ey - 12, ey + 20, y)
            g = smoothstep(wy - 10, wy + 16, y)
            return {ua: 0.35 * (1 - f), fa: 0.65 + 0.35 * f - 0.35 * g, hd: 0.35 * g}
        f = smoothstep(wy - 10, wy + 16, y)
        return {fa: 0.3 * (1 - f), hd: 0.7 + 0.3 * f}

    def tail(self, x, y):
        chain = self.phys['tail']['chain']
        nodes = self.phys['tail']['nodes']
        y0, y1 = nodes[0][1], nodes[-1][1]
        t = max(0.0, min(1.0, (y - y0) / max(1.0, y1 - y0)))
        w = {'hips': 0.35}
        centers = [(i + 0.5) / len(chain) for i in range(len(chain))]
        for bid, c in zip(chain, centers):
            g = math.exp(-((t - c) ** 2) / (2 * 0.2 ** 2))
            if g > 0.02:
                w[bid] = w.get(bid, 0) + g
        s = sum(w.values()) or 1
        return {k: v / s for k, v in w.items()}

    def skirt(self, combo, x, y):
        prefix = 'skirtM' if combo.startswith('maid') else 'skirtP'
        chains = [self.phys[f'{prefix}{i}'] for i in range(6) if f'{prefix}{i}' in self.phys]
        if not chains:
            return {'hips': 1.0}
        nodes = chains[0]['nodes']
        wy, hem = nodes[0][1], nodes[-1][1]
        t = max(0.0, min(1.0, (y - wy) / max(1.0, hem - wy)))
        attach = smoothstep(0.02, 0.28, t)
        waist_x0 = min(c['nodes'][0][0] for c in chains)
        waist_x1 = max(c['nodes'][0][0] for c in chains)
        hem_x0 = min(c['nodes'][-1][0] for c in chains)
        hem_x1 = max(c['nodes'][-1][0] for c in chains)
        halfw = max(20.0, ((waist_x1 - waist_x0) * (1 - t) + (hem_x1 - hem_x0) * t) / 2)
        u = max(-1.15, min(1.15, (x - self.center) / halfw))
        f = max(0.0, min(5.0, (u + 1) / 2 * 5))
        i0, i1 = int(math.floor(f)), min(5, int(math.floor(f)) + 1)
        fr = f - i0
        w = {'hips': 1 - attach * 0.94}

        def chain_weights(cname, t):
            ch = self.phys[cname]['chain']
            centers = [(i + 0.5) / len(ch) for i in range(len(ch))]
            out = {}
            for bid, c in zip(ch, centers):
                g = math.exp(-((t - c) ** 2) / (2 * 0.17 ** 2))
                if g > 0.02:
                    out[bid] = g
            s = sum(out.values()) or 1
            return {k: v / s for k, v in out.items()}

        for idx2, share in ((i0, 1 - fr), (i1, fr)):
            if share < 0.02:
                continue
            for bid, bw in chain_weights(f'{prefix}{idx2}', t).items():
                w[bid] = w.get(bid, 0) + attach * 0.94 * share * bw
        return w

    def weights_for(self, pid, slot, combo, x, y):
        if pid == 'body-head':
            return {'head': 1.0}
        if pid == 'body-torso':
            return self.core(x, y)
        if pid == 'tail':
            return self.tail(x, y)
        if pid.startswith('leg-'):
            return self.leg_weights(pid[-1], y)
        if pid.startswith('arm-upper'):
            return self.arm(x, y, 'upper', 'L' if x < self.center else 'R')
        if pid.startswith('arm-fore'):
            return self.arm(x, y, 'fore', 'L' if x < self.center else 'R')
        if pid.startswith('hand-'):
            return self.arm(x, y, 'hand', 'L' if x < self.center else 'R')
        if slot in ('sleeveUpper',):
            return self.arm(x, y, 'upper', 'L' if x < self.center else 'R')
        if slot in ('sleeveFore',):
            return self.arm(x, y, 'fore', 'L' if x < self.center else 'R')
        if slot in ('bottom',) or pid.endswith('-skirt') or pid.endswith('-skirt-under'):
            return self.skirt(combo, x, y)
        return self.core(x, y, allow_head=False)


def build_mesh(alpha, rig, pid, slot, combo, cell):
    ys_all, xs_all = np.where(alpha > 0.05)
    if len(xs_all) == 0:
        raise SystemExit(f'empty part {pid}')
    x0, x1 = max(0, int(xs_all.min()) - 2), min(W, int(xs_all.max()) + 3)
    y0, y1 = max(0, int(ys_all.min()) - 2), min(H, int(ys_all.max()) + 3)
    gx = max(1, int(round((x1 - x0) / cell)))
    gy = max(1, int(round((y1 - y0) / cell)))
    xs = [x0 + (x1 - x0) * i / gx for i in range(gx + 1)]
    ys = [y0 + (y1 - y0) * j / gy for j in range(gy + 1)]
    cells = []
    am = alpha > 2.0 / 255.0
    for j in range(gy):
        py0 = max(0, int(math.floor(ys[j])))
        py1 = min(H, max(py0 + 1, int(math.ceil(ys[j + 1]))))
        for i in range(gx):
            px0 = max(0, int(math.floor(xs[i])))
            px1 = min(W, max(px0 + 1, int(math.ceil(xs[i + 1]))))
            # keep EVERY cell that contains any non-transparent texel: the quad
            # covers the whole cell, the texture alpha shapes the silhouette.
            # (Sampling only a few interior points dropped boundary cells ->
            # 8-12px staircase notches; that was the visible 4x artifact.)
            if am[py0:py1, px0:px1].any():
                cells.append((i, j))
    vmap, positions, uvs = {}, [], []

    def vid(i, j):
        k = (i, j)
        if k not in vmap:
            vmap[k] = len(positions)
            positions.append([xs[i], ys[j]])
            uvs.append([xs[i] / W, ys[j] / H])
        return vmap[k]

    indices = []
    for i, j in cells:
        a, b, c, d = vid(i, j), vid(i + 1, j), vid(i + 1, j + 1), vid(i, j + 1)
        indices += [a, b, c, a, c, d]
    bones, weights, deform = [], [], []
    for (x, y) in positions:
        w = rig.weights_for(pid, slot, combo, x, y)
        items = sorted(w.items(), key=lambda kv: -kv[1])[:4]
        s = sum(v for _, v in items) or 1
        items = [(k, v / s) for k, v in items if v / s > 1e-4]
        s = sum(v for _, v in items) or 1
        items = [(k, v / s) for k, v in items]
        bones.append([rig.bone_index[k] for k, _ in items] + [0] * (4 - len(items)))
        weights.append([round(v, 4) for _, v in items] + [0.0] * (4 - len(items)))
        hw = sum(v for k, v in items if k == 'head')
        cw = sum(v for k, v in items if k in ('chest', 'spine'))
        deform.append([round(min(1.0, hw), 4), round(min(1.0, cw * 0.9), 4)])
    return {'positions': [[round(x, 2), round(y, 2)] for x, y in positions],
            'uvs': [[round(u, 5), round(v, 5)] for u, v in uvs],
            'bones': bones, 'weights': weights, 'deform': deform,
            'indices': indices, 'cell': cell, 'grid': [gx, gy]}


# -------------------------------------------------------------------- build ---
def source_layer_for(shape, pid, combo, kind):
    """Reference layer for shadow-band detection (production source, read-only)."""
    m4s = os.path.join(M4, 'assets', 'art-v2', shape)
    if kind == 'base':
        p = os.path.join(M2, 'base', shape, 'clean-body.png')
        return load_rgba(p) if os.path.exists(p) else None
    idx = json.load(open(os.path.join(M2, 'garments', shape, combo, 'parts-index.json')))
    p = next((x for x in idx['parts'] if x['pid'] == pid), None)
    if not p or p.get('source') in (None, 'computed-inner'):
        return None
    sp = os.path.join(m4s, p['source'] + '.png')
    return load_rgba(sp) if os.path.exists(sp) else None


def build_clean_fill(shape, base_rects):
    """M2 clean-body deleted the production white-hair-wisp pixels (alpha 0).
    Rather than repainting them onto body parts (which distorts part colour), add
    ONE background drawable at z=7.5 (above hairBack, below strands/body) that
    restores exactly those deleted pixels. Colour comes from the production hair
    layers where present (so gaps read as hair, not white wisps) and otherwise
    from the nearest clean-body pixel. This keeps the silhouette closed at rest
    (static background holes = 0) without re-introducing the white wisp art."""
    body = load_rgba(os.path.join(M4, 'assets', 'art-v2', shape, 'body.png'))
    clean = load_rgba(os.path.join(M2, 'base', shape, 'clean-body.png'))
    removed = (body[:, :, 3] > 200) & (clean[:, :, 3] < 8)
    # orphan clean-body pixels not covered by any rebuilt base part (M4a arm
    # parts are rebuilt from the refined arms layer; the old-body hand/wrist
    # outline can fall outside it -> small enclosed background holes).
    cover = np.zeros((H, W), bool)
    for d in BASE_ALPHA_BY_ID.values():
        cover |= d
    orphan = (clean[:, :, 3] > 200) & ~cover
    # under-arm band: production body pixels that the raised arm uncovers. Fill
    # them behind the arm parts (z 7.5) so arm raise shows skin, not background.
    underarm = (body[:, :, 3] > 200)
    underarm[:520, :] = False
    underarm[985:, :] = False
    underarm[:, :120] = False
    underarm[:, 560:] = False
    removed = removed | orphan | underarm
    if not removed.any():
        return None, 0
    # production hair layers composite (colour reference)
    hair_rgb = np.zeros((H, W, 3), np.float32)
    hair_a = np.zeros((H, W), np.float32)
    cand = ['hair-back.png', 'hair-front-bangs.png'] + \
           [f'hair-strand-{s}{i}.png' for s in 'LR' for i in (1, 2, 3)]
    for name in cand:
        fp = os.path.join(M4, 'assets', 'art-v2', shape, name)
        if not os.path.exists(fp):
            continue
        h = load_rgba(fp).astype(np.float32)
        a = h[:, :, 3:4] / 255.0
        hair_rgb = h[:, :, :3] * a + hair_rgb * (1 - a)
        hair_a = a[:, :, 0] + hair_a * (1 - a[:, :, 0])
    rgb = np.zeros((H, W, 3), np.float32)
    have_hair = removed & (hair_a > 0.25)
    rgb[have_hair] = hair_rgb[have_hair]
    # nearest clean-body colour for the rest
    known = clean[:, :, 3] > 8
    known_rgb = clean[:, :, :3].astype(np.float32)
    k = known.astype(np.float32)
    cur = known.copy()
    for _ in range(30):
        need = removed & ~cur
        if not need.any():
            break
        num = cv2.filter2D(known_rgb * k[:, :, None], -1, np.ones((3, 3), np.float32),
                           borderType=cv2.BORDER_REPLICATE)
        den = cv2.filter2D(k, -1, np.ones((3, 3), np.float32), borderType=cv2.BORDER_REPLICATE)
        grow = need & (den > 0.01)
        if not grow.any():
            break
        rgb[grow] = num[grow] / den[grow][:, None]
        k[grow] = 1.0
        cur = cur | grow
    out = np.zeros((H, W, 4), np.uint8)
    out[removed, :3] = np.clip(rgb[removed], 0, 255).astype(np.uint8)
    out[removed, 3] = 255
    # 2px alpha feather to avoid a hard edge
    a = out[:, :, 3].astype(np.float32)
    a = cv2.GaussianBlur(a, (3, 3), 0)
    out[:, :, 3] = np.clip(a, 0, 255).astype(np.uint8)
    out = color_bleed(out)
    return out, int(removed.sum())


def restore_deleted_body_pixels(parts: dict, body, clean, hair_rgb, hair_a):
    """M4b: restore pixels that M2 clean-body deleted (production body alpha) into
    the nearest base part texture (no extra drawable/page). Alpha from production
    body; RGB from production hair layers where present (white wisps -> hair
    colour), else nearest existing part colour."""
    deleted = (body[:, :, 3] > 200) & (clean[:, :, 3] < 8)
    # M4a arm parts are rebuilt from the refined production arms layer; old-body
    # hand/wrist pixels of clean-body that no rebuilt part covers must be
    # restored too (orphans), else they leave enclosed background holes.
    cover = np.zeros((H, W), bool)
    for n in parts:
        cover |= parts[n][:, :, 3] > 8
    orphan = (clean[:, :, 3] > 200) & ~cover
    deleted = deleted | orphan
    if not deleted.any():
        return parts, 0
    names = list(parts.keys())
    dist_stack = []
    for n in names:
        a = parts[n][:, :, 3] > 8
        dist_stack.append(cv2.distanceTransform((~a).astype(np.uint8), cv2.DIST_L2, 5))
    owner = np.stack(dist_stack).argmin(0).astype(np.int32)
    total = 0
    for i, n in enumerate(names):
        m = deleted & (owner == i)
        if not m.any():
            continue
        part = parts[n].astype(np.uint8).copy()
        rgb = part[:, :, :3].astype(np.float32)
        have = part[:, :, 3] > 8
        k = have.astype(np.float32)
        cur = have.copy()
        for _ in range(16):
            need = m & ~cur
            if not need.any():
                break
            num = cv2.filter2D(rgb * k[:, :, None], -1, np.ones((3, 3), np.float32),
                               borderType=cv2.BORDER_REPLICATE)
            den = cv2.filter2D(k, -1, np.ones((3, 3), np.float32),
                               borderType=cv2.BORDER_REPLICATE)
            grow = need & (den > 0.01)
            if not grow.any():
                break
            rgb[grow] = num[grow] / den[grow][:, None]
            k[grow] = 1.0
            cur = cur | grow
        hm = m & (hair_a > 0.25)
        rgb[hm] = hair_rgb[hm]
        left = m & ~cur & ~hm
        if left.any():
            rgb[left] = hair_rgb[left]
        part[m, :3] = np.clip(rgb[m], 0, 255).astype(np.uint8)
        part[m, 3] = 255
        parts[n] = part
        total += int(m.sum())
    return parts, total


def cell_for(pid, slot):
    """M4b mesh density: 12-14px on big rigid parts, 10px on arms/hands
    (they rotate; coarser would show polygon edges), 2.2x fewer verts overall."""
    if pid in ('body-head', 'body-torso'):
        return 16
    if pid.startswith(('arm-', 'hand-')):
        return 12
    if pid.startswith(('leg-', 'tail')):
        return 14
    if slot in ('bottom', 'topBody', 'topUnder', 'collar', 'sleeveUpper', 'sleeveFore'):
        return 14
    return 14


# ------------------------------------------------- v2.6: body master retexture ---
BODY_MASTER_IDS = ['body-head', 'body-torso', 'leg-L', 'leg-R',
                   'arm-upper-L', 'arm-upper-R', 'arm-fore-L', 'arm-fore-R',
                   'hand-L', 'hand-R']


def load_master_config(path):
    """Normalise an art-stage retexture contract (--master-config) for the builder.

    Supported art deliverables:
      * girl `feiyu-master-retexture-v1`: master{1x}, drawables[].id,
        retextureRule.visibleOnlyRecommended + retextureRule.visibleMask
        (string may carry a Chinese description suffix after the path).
      * chibi v1: master.file (2x working master), draws[].
    Returns a dict consumed by apply_master_retexture()."""
    cfg = json.load(open(path))
    base = os.path.dirname(os.path.abspath(path))
    shape = cfg.get('shape')
    if shape not in ('chibi', 'girl'):
        raise SystemExit(f'master config {path}: missing/invalid shape {shape!r}')
    mref = cfg.get('master')
    if not isinstance(mref, str):
        mref = (mref or {}).get('1x') or (mref or {}).get('file')
    if not mref:
        raise SystemExit(f'master config {path}: no master image (master.1x / master.file)')
    master_path = mref if os.path.isabs(mref) else os.path.normpath(os.path.join(base, mref))
    if not os.path.exists(master_path):
        raise SystemExit(f'master config {path}: master image missing: {master_path}')
    ids = [d.get('id') for d in (cfg.get('drawables') or [])]
    if not ids:
        ids = list(cfg.get('draws') or [])
    ids = [i for i in ids if i]
    if not ids:
        raise SystemExit(f'master config {path}: no body drawables listed')
    unknown = [i for i in ids if i not in BODY_MASTER_IDS]
    if unknown:
        raise SystemExit(f'master config {path}: only body drawables may be retextured, got {unknown}')
    rule = cfg.get('retextureRule') or {}
    visible_mask = None
    if rule.get('visibleOnlyRecommended') and rule.get('visibleMask'):
        ref = str(rule['visibleMask']).split('（')[0].split('(')[0].strip()
        p = ref if os.path.isabs(ref) else os.path.normpath(os.path.join(base, ref))
        if not os.path.exists(p):
            raise SystemExit(f'master config {path}: visibleMask missing: {p}')
        visible_mask = p
    return {'shape': shape, 'config': os.path.abspath(path), 'master': master_path,
            'ids': ids, 'visible_mask': visible_mask}


def apply_master_retexture(shape, drawables, texdir, stats):
    """v2.6 body retexture: body drawables' RGB := art master at the same canvas
    coordinate; **alpha / rect / texSize unchanged** (silhouette + mesh contract).

    Ordering (critical): must run AFTER the T1 hair split.
      * `split_girl_back_hair` detects the baked hair by an RGB blue criterion and
        `finalize_girl_hair` copies the baked arm-island RGB into `hair-arm-girl`;
        retexturing earlier would destroy those source colours (islands would be
        extracted skin-coloured, or not at all).
      * It also runs after feet/hands overlays and T1 under-layer repaints, so the
        master RGB wins over the v2.5 body post-processing (the art master was
        built from the v2.5 final body anyway).
      * Garment-only steps after it (seam_extend / port_rest_colors) never touch
        body RGB; mesh rebuild only reads alpha.
    Visible-only mode (girl) keeps hidden (hair/face-covered) pixels at their v2.5
    values -> ±25° hidden-area behaviour does not regress.
    """
    cfg = MASTER_CFG.get(shape)
    if not cfg:
        return 0
    master = load_rgba(cfg['master'])
    mh, mw = master.shape[:2]
    if (mw, mh) == (W, H):
        master1 = master
        master_canvas = master
    elif (mw, mh) == (W * 2, H * 2):
        master1 = cv2.resize(master, (W, H), interpolation=cv2.INTER_LINEAR)
        master_canvas = master
    else:
        raise SystemExit(f'master image size {mw}x{mh} unsupported '
                         f'(expect {W}x{H} or {W * 2}x{H * 2})')
    vis = None
    if cfg.get('visible_mask'):
        vis = np.array(Image.open(cfg['visible_mask']).convert('L')) > 128
        if vis.shape != (H, W):
            raise SystemExit(f'visible mask {cfg["visible_mask"]} is '
                             f'{vis.shape[1]}x{vis.shape[0]}, expected {W}x{H}')
    if (mw, mh) != (W, H):
        # per-drawable 1x target is the bilinear 2x->1x sample (half-pixel centres)
        pass
    by_id = {d['id']: d for d in drawables}
    changed, per = 0, {}
    for pid in cfg['ids']:
        d = by_id.get(pid)
        if d is None:
            raise SystemExit(f'master retexture: drawable {pid} was not built')
        fp = os.path.join(texdir, d['texture'])
        tex = np.array(Image.open(fp).convert('RGBA'))
        th, tw = tex.shape[:2]
        if (tw, th) == (W, H):
            rgb = master1[:, :, :3]
            sel = np.ones((H, W), bool) if vis is None else vis.copy()
        elif (tw, th) == (W * 2, H * 2):
            rgb = master_canvas[:, :, :3] if (mw, mh) == (W * 2, H * 2) else \
                cv2.resize(master1[:, :, :3], (W * 2, H * 2), interpolation=cv2.INTER_LINEAR)
            sel = np.ones((H * 2, W * 2), bool) if vis is None else \
                cv2.resize(vis.astype(np.uint8), (W * 2, H * 2),
                           interpolation=cv2.INTER_NEAREST) > 0
        else:
            raise SystemExit(f'master retexture: {pid} texture {tw}x{th} unsupported '
                             f'(expect {W}x{H} or {W * 2}x{H * 2})')
        before = tex[:, :, :3].copy()
        tex[sel, :3] = rgb[sel]
        n = int((np.abs(tex[:, :, :3].astype(int) - before.astype(int)).max(-1) > 0).sum())
        # re-extend RGB into transparent pixels (the master only carries an 8px
        # color-bleed) so bilinear/mipmap sampling keeps the v2.5 fringe behaviour
        tex = color_bleed(tex, COLOR_BLEED_PX)
        Image.fromarray(tex, 'RGBA').save(fp)
        per[pid] = {'selPx': int(sel.sum()), 'changedPx': n}
        changed += n
    stats['master'] = {'config': cfg['config'], 'masterFile': cfg['master'],
                       'masterSize': [int(mw), int(mh)],
                       'visibleOnly': bool(cfg.get('visible_mask')),
                       'changedPx': changed, 'perDrawable': per}
    log(f'[{shape}] body master retexture: {changed}px on {len(cfg["ids"])} drawables '
        f'(visibleOnly={bool(cfg.get("visible_mask"))})')
    return changed


# ------------------------------------- v2.6.1: garment baked-skin cleanup ----
def _canvas_tex(texdir, d):
    """Full-canvas RGBA for a drawable (small hair/face textures placed at rect)."""
    arr = np.array(Image.open(os.path.join(texdir, d['texture'])).convert('RGBA'))
    if arr.shape[1] == W and arr.shape[0] == H:
        return arr
    full = np.zeros((H, W, 4), np.uint8)
    x0, y0 = int(d['rect'][0]), int(d['rect'][1])
    h, w = arr.shape[:2]
    full[y0:y0 + h, x0:x0 + w] = arr
    return full


def _garment_skin_mask(rgb, alpha, skin_alpha):
    """Mask of baked body skin (+ its dark line art) inside one garment texture.

    Classifier (tuned against the maid/sweater/hoodie sleeves; measured on the
    production textures):
      * strong garment colours never removed: white cloth (sat<=8 & L>200, the
        cuff/ruffle white has sat~3.5) and blue/navy cloth (B-R>20);
      * loose warm skin: R-B>=10, R-G>=2, G-B>=1, R>170 (the strict R-B>18 form
        misses pale baked-hand highlights) intersected with the underlying body
        skin alpha -> only where a body part actually exists behind;
      * dark baked-hand line art merges into the hand blob via morphological
        close + connected components (hand-sized blobs only, area>=80 & w,h>=12);
      * removal = blob dilated 2px (outline + 1px AA halo), fabric classes kept.
    Returns (skin_mask, remove_mask)."""
    R = rgb[:, :, 0].astype(int)
    G = rgb[:, :, 1].astype(int)
    B = rgb[:, :, 2].astype(int)
    lum = 0.299 * R + 0.587 * G + 0.114 * B
    sat = rgb.max(2).astype(int) - rgb.min(2).astype(int)
    op = alpha > 8
    white = (sat <= 8) & (lum > 200) & op
    blue = (B - R > 20) & op
    warm_any = ((R - B >= 10) & (R - G >= 2) & (G - B >= 1) & (R > 170) &
                op & ~white & ~blue)
    warm_body = warm_any & skin_alpha
    blob = cv2.morphologyEx(warm_body.astype(np.uint8), cv2.MORPH_CLOSE,
                            np.ones((5, 5), np.uint8))
    n, lab, st, _ = cv2.connectedComponentsWithStats(blob, 8)
    keep = np.zeros_like(blob)
    for i in range(1, n):
        x, y, w, h, area = st[i]
        if area < 80 or w < 12 or h < 12:
            continue
        if not warm_body[lab == i].any():
            continue
        keep[lab == i] = 1
    # expand to the whole warm fragment (hand pieces that stick out over the
    # background have no body alpha behind -> skin_alpha would have kept them)
    n2, lab2, st2, _ = cv2.connectedComponentsWithStats(warm_any.astype(np.uint8), 8)
    ids = set(np.unique(lab2[keep])) - {0}
    expand = np.isin(lab2, list(ids)) if ids else keep.astype(bool)
    remove = (cv2.dilate(expand.astype(np.uint8), np.ones((5, 5), np.uint8)) > 0) \
        & op & ~white & ~blue
    return warm_body, remove


def clean_garment_skin(shape, drawables, texdir, stats):
    """v2.6.1: remove baked body skin (duplicated hands/legs) from garment textures.

    Root cause: the M2 garment parts were cut out of the full look image, so hidden
    fill / overlap regions inside e.g. `maid-sleeve-fore-L/R` contain copies of the
    hands (and `*-skirt*` copies of the legs). The topmost copy renders over the real
    hand (sleeveFore z=62 vs hand z=65 -> visible second hand per side, historical
    bug present since v2.5). The copies are duplicated across several garment layers,
    so **all** garment slots must be cleaned (cleaning sleeves only just reveals the
    copy stored in the skirt underneath).

    Contract: only texture alpha is changed; **meshes are NOT rebuilt** -> rig.json
    stays byte-identical (transparent quads render nothing, see REPORT-fix).
    The no-hole guard drops any removal whose pixel would no longer be covered by a
    drawable that is not itself removing it -> rest magenta holes stay 0.
    """
    if not OPTS['clean_garment_skin']:
        return 0
    # union of body-skin alphas ('tail'/'seam-fill' are not skin)
    skin_alpha = np.zeros((H, W), bool)
    for d in drawables:
        if d['slot'] in BASE_DRAW_SLOTS and d['id'] not in ('tail', 'seam-fill'):
            skin_alpha |= _canvas_tex(texdir, d)[:, :, 3] > 8
    cover_cnt = np.zeros((H, W), np.int16)
    alphas = {}
    for d in drawables:
        a = _canvas_tex(texdir, d)[:, :, 3] > 8
        alphas[d['id']] = a
        cover_cnt += a.astype(np.int16)
    # pass 1: per-garment masks
    plans = {}
    for d in drawables:
        if d['slot'] not in GARMENT_SLOTS:
            continue
        tex = _canvas_tex(texdir, d)
        skin, remove = _garment_skin_mask(tex[:, :, :3], tex[:, :, 3], skin_alpha)
        del tex
        if remove.any():
            plans[d['id']] = (skin, remove)
    # pass 2: no transparent holes -- per outfit combo (a pixel may be covered by
    # another outfit's garment which is not rendered in this combo!), keep a removal
    # only if the pixel stays covered by an active drawable that does not remove it.
    ALWAYS_SLOTS_SET = {'body', 'legs', 'armUpper', 'armFore', 'hand', 'hairBack',
                        'strands', 'hairFront', 'face', 'hair-backfill'}
    combo_of = {}   # garment id -> [combo] (each garment belongs to exactly one combo)
    for combo, outfit in rig['outfits'].items():
        for slot, ids in outfit.items():
            if slot in GARMENT_SLOTS and isinstance(ids, list):
                for pid in ids:
                    combo_of.setdefault(pid, []).append(combo)
    cover_kept_by_combo = {}
    for combo in ['base'] + [c for c in rig['outfits'] if c != 'base']:
        if not any(combo in combo_of.get(pid, []) for pid in plans):
            continue
        outfit = rig['outfits'].get(combo) or {}
        outfit_ids = set()
        for slot, ids in outfit.items():
            if slot in GARMENT_SLOTS and isinstance(ids, list):
                outfit_ids.update(ids)
        cover = np.zeros((H, W), bool)
        for d in drawables:
            if d['slot'] not in ALWAYS_SLOTS_SET and d['id'] not in outfit_ids:
                continue
            rm = plans.get(d['id'])
            if rm is not None and d['id'] in outfit_ids:
                continue    # this drawable also removes pixels in this combo
            cover |= alphas[d['id']]
        cover_kept_by_combo[combo] = cover
    changed = 0
    per = {}
    id_of = {d['id']: d for d in drawables}
    for pid, (skin, remove) in plans.items():
        tex = _canvas_tex(texdir, id_of[pid])
        safe = np.ones((H, W), bool)
        for combo in combo_of.get(pid) or ['base']:
            if combo in cover_kept_by_combo:
                safe &= cover_kept_by_combo[combo]
        final = remove & safe
        dropped = int(remove.sum() - final.sum())
        if not final.any():
            continue
        # original alpha bbox (before removal): build_2d5 --trim-alpha crops by the
        # alpha bbox, so a removal at the bbox edge would shrink texSize/atlasRect and
        # change mesh UVs -> rig.json would no longer be byte-identical. Keep an
        # alpha=1/255 (visually invisible) pixel on the removed pixels that sit on the
        # old bbox border so the trim rect (and therefore rig.json) stays identical.
        orig = tex[:, :, 3] > 0
        oy, ox = np.where(orig)
        bx0, by0, bx1, by1 = int(ox.min()), int(oy.min()), int(ox.max()), int(oy.max())
        cols = np.arange(W)[None, :]
        rows = np.arange(H)[:, None]
        bbox_keep = final & ((cols == bx0) | (cols == bx1) | (rows == by0) | (rows == by1))
        ring = (cv2.dilate(final.astype(np.uint8), np.ones((3, 3), np.uint8)) > 0) \
            & ~final & (tex[:, :, 3] > 8)
        tex[final, 3] = 0
        tex[ring, 3] = (tex[ring, 3].astype(np.float32) * 0.5).astype(np.uint8)
        tex[bbox_keep, 3] = 1
        Image.fromarray(tex, 'RGBA').save(os.path.join(texdir, pid + '.png'))
        per[pid] = {'skinPx': int(skin.sum()), 'removedPx': int(final.sum()),
                    'droppedNoCoverPx': dropped, 'featherPx': int(ring.sum()),
                    'bboxPinnedPx': int(bbox_keep.sum())}
        changed += int(final.sum())
    stats['garmentSkinClean'] = {'removedPx': changed,
                                 'droppedNoCoverPx': sum(v['droppedNoCoverPx'] for v in per.values()),
                                 'perDrawable': per}
    log(f'[{shape}] garment baked-skin cleanup: {changed}px on {len(per)} drawables '
        f'(dropped {stats["garmentSkinClean"]["droppedNoCoverPx"]}px no-cover)')
    return changed


def build_shape(shape, page_split='base'):
    rig = Rig(shape)
    LEG_BONES = rig.add_leg_bones()
    texdir = os.path.join(WORK, 'assets', 'tex', shape)
    os.makedirs(texdir, exist_ok=True)
    drawables = []
    COLOR_BLEED_COUNT['px'] = 0
    stats = {'colorBleed': {}, 'bandRows': {}, 'parts': {}}
    # ---------------- base body parts ----------------
    body_parts = {'body': load_rgba(os.path.join(M4, 'assets', 'art-v2', shape, 'body.png'))}
    base_idx = json.load(open(os.path.join(M2, 'base', shape, 'parts-index.json')))
    thigh_parts = {}
    for p in base_idx['parts']:
        pid = p['pid']
        if pid.startswith(('leg-thigh', 'leg-shin')):
            thigh_parts[pid] = p
            continue
        part = load_rgba(os.path.join(M2, 'base', shape, 'parts', pid + '.png'))
        if pid.startswith(('arm-', 'hand-')):
            src = load_rgba(os.path.join(M4, 'assets', 'art-v2', shape, 'arms.png'))
            # M2 base arm parts derive from the old body art (wider/blurrier than
            # the refined production arms layer). Rebuild the arm silhouette from
            # the production arms layer, split by horizontal joint bands; the
            # joint bands overlap 10px and share source pixels so rest has no seam.
            y0, y1 = p['rect'][1], p['rect'][3]
            am = src[:, :, 3].astype(np.float32) / 255.0
            band = np.zeros((H, W), np.float32)
            row_all = np.ones(W, np.float32)
            if pid.startswith('arm-upper'):
                band[y0:y1 + 10, :] = row_all
            elif pid.startswith('arm-fore'):
                band[y0 - 10:y1 + 10, :] = row_all
            else:  # hand
                band[max(0, y0 - 10):H, :] = row_all
            part[:, :, 3] = (am * band * 255.0).clip(0, 255).astype(np.uint8)
            part = restore_source(part, src, p['rect'], pid)
            part = color_bleed(part)
        else:
            src = source_layer_for(shape, pid, None, 'base')
            part = restore_source(part, src, p['rect'], pid)
        fixed = 0
        part = color_bleed(part)
        BASE_ALPHA_BY_ID[pid] = part[:, :, 3] > 8
        stats['bandRows'][pid] = fixed
        stats['parts'][pid] = {'px': int((part[..., 3] > 8).sum()),
                               'rect': p['rect'], 'z': BASE_Z.get(pid, p['z']),
                               'slot': BASE_SLOT.get(pid, 'body')}
        Image.fromarray(part, 'RGBA').save(os.path.join(texdir, pid + '.png'))
        slot = BASE_SLOT.get(pid, 'body')
        z = BASE_Z.get(pid, p['z'])
        alpha = part[:, :, 3].astype(np.float32) / 255
        mesh = build_mesh(alpha, rig, pid, slot, '', cell_for(pid, slot))
        drawables.append({'id': pid, 'slot': slot, 'z': z, 'role': slot,
                          'texture': pid + '.png', 'mesh': mesh,
                          'rect': p['rect'], 'mask': []})
    # ---------------- M4b: merged legs (thigh + shin -> leg L/R) ----------------
    for side in ('L', 'R'):
        th = thigh_parts[f'leg-thigh-{side}']
        sh = thigh_parts[f'leg-shin-{side}']
        a_th = load_rgba(os.path.join(M2, 'base', shape, 'parts', f'leg-thigh-{side}.png'))
        a_sh = load_rgba(os.path.join(M2, 'base', shape, 'parts', f'leg-shin-{side}.png'))
        merged = a_sh.copy()
        # thigh drawn over shin (same source art; thigh's overlap goes under shin)
        m = a_th[:, :, 3] > 8
        merged[m] = a_th[m]
        merged = color_bleed(merged)
        pid = f'leg-{side}'
        Image.fromarray(merged, 'RGBA').save(os.path.join(texdir, pid + '.png'))
        rect = [min(th['rect'][0], sh['rect'][0]), min(th['rect'][1], sh['rect'][1]),
                max(th['rect'][2], sh['rect'][2]), max(th['rect'][3], sh['rect'][3])]
        alpha = merged[:, :, 3].astype(np.float32) / 255
        mesh = build_mesh(alpha, rig, pid, 'legs', '', 12)
        drawables.append({'id': pid, 'slot': 'legs', 'z': 9.1, 'role': 'legs',
                          'texture': pid + '.png', 'mesh': mesh, 'rect': rect, 'mask': []})
        BASE_ALPHA_BY_ID[pid] = merged[:, :, 3] > 8
        stats['parts'][pid] = {'px': int((merged[..., 3] > 8).sum()), 'rect': rect,
                               'z': 9.1, 'slot': 'legs', 'merged': ['leg-thigh-' + side, 'leg-shin-' + side]}
    # ---------------- M4b: restore M2-deleted body pixels into nearest base part ----
    base_rgba = {}
    for d in drawables:
        if d['slot'] in BASE_DRAW_SLOTS:
            base_rgba[d['id']] = load_rgba(os.path.join(texdir, d['texture']))
    hair_rgb = np.zeros((H, W, 3), np.float32)
    hair_a = np.zeros((H, W), np.float32)
    for name in (['hair-back.png', 'hair-front-bangs.png'] +
                 [f'hair-strand-{sd}{i}.png' for sd in 'LR' for i in (1, 2, 3)]):
        fp = os.path.join(M4, 'assets', 'art-v2', shape, name)
        if not os.path.exists(fp):
            continue
        h = load_rgba(fp).astype(np.float32)
        a = h[:, :, 3:4] / 255.0
        hair_rgb = h[:, :, :3] * a + hair_rgb * (1 - a)
        hair_a = a[:, :, 0] + hair_a * (1 - a[:, :, 0])
    base_rgba, restored = restore_deleted_body_pixels(
        base_rgba, body_parts['body'], load_rgba(os.path.join(M2, 'base', shape, 'clean-body.png')),
        hair_rgb, hair_a)
    for d in drawables:
        if d['slot'] in BASE_DRAW_SLOTS and d['id'] in base_rgba:
            Image.fromarray(base_rgba[d['id']], 'RGBA').save(os.path.join(texdir, d['texture']))
            BASE_ALPHA_BY_ID[d['id']] = base_rgba[d['id']][:, :, 3] > 8
    stats['cleanFillPx'] = 0
    stats['restoredDeletedPx'] = restored
    stats['armSolidPx'] = solidify_arm_interior(shape, drawables, texdir)
    stats['bodySeamPx'] = seam_extend_body(drawables, texdir)
    seam = build_seam_fill(shape, rig)
    if seam is not None:
        stex, spx = seam
        Image.fromarray(stex, 'RGBA').save(os.path.join(texdir, 'seam-fill.png'))
        smesh = build_mesh(stex[:, :, 3].astype(np.float32) / 255, rig, 'seam-fill', 'body', '', 10)
        drawables.append({'id': 'seam-fill', 'slot': 'body', 'z': 7.6, 'role': 'body',
                          'texture': 'seam-fill.png', 'mesh': smesh,
                          'rect': [0, 0, W, H], 'mask': [], 'fill': 'qa-detected-rest-holes'})
        stats['seamFillPx'] = spx
    stats['feetPx'] = overlay_refined_feet(shape, drawables, texdir, stats)
    apply_hair_split(shape, drawables, texdir, rig, stats)
    if not OPTS['skip_hands']:
        overlay_refined_hands(shape, drawables, texdir, stats)
    # ---------------- garment parts (6 combos) ----------------
    outfits = {'base': {'name': '素体（cutout）'}}
    combos = ['maid', 'sweater-plaid', 'sweater-pleated', 'hoodie-plaid',
              'hoodie-pleated', 'sailor-plaid']
    for combo in combos:
        gi = json.load(open(os.path.join(M2, 'garments', shape, combo, 'parts-index.json')))
        outfit = {'name': combo + '（cutout）'}
        for p in gi['parts']:
            pid = p['pid']
            slot = p['slot']
            z = float(p['z'])
            part = load_rgba(os.path.join(M2, 'garments', shape, combo, 'parts', pid + '.png'))
            src = source_layer_for(shape, pid, combo, 'garment')
            part = restore_source(part, src, p['rect'], pid)
            fixed = 0
            part = color_bleed(part)
            stats['bandRows'][pid] = fixed
            stats['parts'][pid] = {'px': int((part[..., 3] > 8).sum()), 'rect': p['rect'],
                                   'z': z, 'slot': slot, 'combo': combo}
            Image.fromarray(part, 'RGBA').save(os.path.join(texdir, pid + '.png'))
            alpha = part[:, :, 3].astype(np.float32) / 255
            cell = 9 if slot in ('bottom', 'topBody', 'topUnder') else 8
            mesh = build_mesh(alpha, rig, pid, slot, combo, cell)
            drawables.append({'id': pid, 'slot': slot, 'z': z, 'role': slot,
                              'texture': pid + '.png', 'mesh': mesh,
                              'rect': p['rect'], 'mask': []})
            outfit.setdefault(slot, []).append(pid)
        outfits[combo] = outfit
    # ---------------- reused hair / face production drawables ----------------
    reuse_ids = [d['id'] for d in rig.tmpl['drawables']
                 if d['id'].startswith(('hair-', 'face-'))]
    tmpl_tex = os.path.join(M4, 'dist', shape, 'tex')
    for d in rig.tmpl['drawables']:
        if d['id'] not in reuse_ids:
            continue
        tname = os.path.basename(d['texture'])
        srcp = os.path.join(tmpl_tex, tname)
        dstp = os.path.join(texdir, tname)
        if not os.path.exists(dstp):
            shutil.copy2(srcp, dstp)
        dd = json.loads(json.dumps(d))
        dd['texture'] = tname
        dd.setdefault('mask', [])
        drawables.append(dd)
    # ---------------- T1 v2.5: full girl hair split (no new bones) ----------------
    finalize_girl_hair_hook(shape, drawables, texdir, rig, stats)
    # ---------------- v2.6 body master retexture (MUST be after T1, see fn) --------
    apply_master_retexture(shape, drawables, texdir, stats)
    # ---------------- seam extension + mesh rebuild ----------------
    seam_px = seam_extend(drawables, texdir,
                          [d['id'] for d in drawables if d['slot'] in BASE_DRAW_SLOTS])
    for d in drawables:
        if d['slot'] not in BASE_DRAW_SLOTS and d['slot'] not in PORT_SLOTS:
            continue
        tex = np.array(Image.open(os.path.join(texdir, d['texture'])).convert('RGBA'))
        alpha = tex[:, :, 3].astype(np.float32) / 255
        if d['slot'] in BASE_DRAW_SLOTS:
            combo = ''
        else:
            combo = _combo_of(d['id'])
        cell = cell_for(d['id'], d['slot'])
        d['mesh'] = build_mesh(alpha, rig, d['id'], d['slot'], combo, cell)
    log(f'[{shape}] seam-extend {seam_px}px')

    # ---------------- slots / outfits / rig json ----------------
    tmpl = rig.tmpl
    slots = {'body': [d['id'] for d in drawables if d['slot'] == 'body'],
             'legs': [d['id'] for d in drawables if d['slot'] == 'legs'],
             'armUpper': [d['id'] for d in drawables if d['slot'] == 'armUpper'],
             'armFore': [d['id'] for d in drawables if d['slot'] == 'armFore'],
             'hand': [d['id'] for d in drawables if d['slot'] == 'hand'],
             'hairBack': tmpl['slots'].get('hairBack', []) + (['hair-back-girl'] if any(d['id'] == 'hair-back-girl' for d in drawables) else []),
             'strands': tmpl['slots'].get('strands', []) + ([HAIR_ARM_ID] if any(d['id'] == HAIR_ARM_ID for d in drawables) else []),
             'hairFront': tmpl['slots'].get('hairFront', []),
             'face': tmpl['slots']['face']}
    rig_json = {
        'format': 'feiyu-2.5d', 'version': 2, 'specVersion': 2,
        'artSource': 'cutout-m4a' + ('-girl' if shape == 'girl' else ''),
        'fallbackReason': None,
        'generator': GEN_ID,
        'name': ('Q版' if shape == 'chibi' else '少女版') + ' · cutout production',
        'shape': shape,
        'canvas': tmpl['canvas'],
        'drawOrder': ['hairBack', 'tails', 'legs', 'body', 'face', 'topUnder',
                      'bottom', 'topBody', 'armUpper', 'armFore', 'collar',
                      'sleeveUpper', 'sleeveFore', 'hand', 'hairFront'],
        'skeleton': tmpl['skeleton'],
        'parameters': tmpl['parameters'],
        'deformers': tmpl['deformers'],
        'physics': tmpl['physics'],
        'drawables': drawables,
        'materials': {},
        'slots': slots,
        'outfits': outfits,
        'colliders': tmpl['colliders'],
        'defaults': {'outfit': 'sweater-plaid',
                     'params': tmpl['defaults']['params']},
        'masks': tmpl['masks'],
        'cutout': {
            'overlapPx': json.load(open(os.path.join(M2, 'MANIFEST.json')))['overlap_px'],
            'colorBleedPx': COLOR_BLEED_PX,
            'shadowBandRowsFixed': stats['bandRows'],
            'source': SOURCE_NOTE,
        },
    }
    if OPTS['hands_2x']:
        overlay_refined_hands_2x(shape, drawables, texdir, stats)
    # M4b: single-page atlas (content ~5.1M px, fits <=4096x4096) -> 1 request,
    # no second-page whitespace. build_2d5 legacy single-page path.
    port_rest_colors(shape, drawables, outfits, texdir)
    # v2.6.1 fix: garment textures may bake duplicated body parts (4-hand maid) ->
    # remove them AFTER all garment RGB writes and BEFORE build_2d5; alpha-only, no
    # mesh rebuild so rig.json stays byte-identical.
    clean_garment_skin(shape, drawables, texdir, stats)
    stats['colorBleed'] = {'px': COLOR_BLEED_COUNT['px'], 'pxPerPart': round(COLOR_BLEED_PX, 1)}
    rig.add_leg_collider_meta(rig_json)
    out_rig = os.path.join(WORK, 'assets', f'{shape}-cutout.feiyu.json')
    json.dump(rig_json, open(out_rig, 'w'), separators=(',', ':'))
    log(f'[{shape}] drawables {len(drawables)} · bands fixed {sum(stats["bandRows"].values())} rows '
        f'· colorBleed {stats["colorBleed"]["px"]}px · rig {os.path.getsize(out_rig)//1024}KiB')
    return out_rig, texdir, stats


def run_build_2d5(shape, rig_path, texdir):
    out = OPTS['outdir'] or OUTDIR
    os.makedirs(out, exist_ok=True)
    cmd = [sys.executable, TOOL, '--rig', rig_path, '--texdir', texdir,
           '--out', out, '--shape', shape, '--trim-alpha',
           '--max-width', '4096', '--max-side', '4096', '--pad', '1']
    log('build_2d5:', ' '.join(cmd))
    r = subprocess.run(cmd, capture_output=True, text=True)
    sys.stdout.write(r.stdout[-4000:])
    sys.stderr.write(r.stderr[-4000:])
    if r.returncode != 0:
        raise SystemExit(f'build_2d5 failed for {shape}')
    return os.path.join(out, shape)


def configure_paths(args):
    """把 CLI 路径解析进模块全局（源根 / 中间产物 / 输出）。"""
    global SRC, WORK, M2, M4, FEET_DIR, PROD_IN, TOOL, OUTDIR, GEN_ID, SOURCE_NOTE
    SRC = os.path.abspath(args.src or os.path.join(REPO, '.cache', 'assets-src'))
    WORK = os.path.abspath(args.workdir or os.path.join(REPO, '.cache', 'build'))
    OUTDIR = os.path.abspath(args.outdir or os.path.join(HERE, 'dist'))
    M2 = os.path.join(SRC, 'art')
    M4 = os.path.join(SRC, 'm4')
    FEET_DIR = os.path.join(SRC, 'feet')
    PROD_IN = os.path.join(SRC, 'prod')
    TOOL = os.path.abspath(args.tool or os.path.join(HERE, 'build_2d5.py'))
    GEN_ID = args.generator_id
    SOURCE_NOTE = args.source_note
    OPTS['hands_dir'] = os.path.abspath(args.hands_dir or os.path.join(SRC, 'hands'))
    OPTS['outdir'] = OUTDIR
    missing = [p for p in (M2, M4, FEET_DIR, OPTS['hands_dir'], PROD_IN) if not os.path.isdir(p)]
    if missing:
        raise SystemExit('source package incomplete under ' + SRC + ':\n  '
                         + '\n  '.join(missing)
                         + '\nRun `npm run fetch:sources` first (or pass --src <dir>).')
    if not os.path.isfile(TOOL):
        raise SystemExit(f'build_2d5.py not found: {TOOL}')


def main():
    ap = argparse.ArgumentParser(description='大肥鱼衣橱 2.5D production cutout builder')
    ap.add_argument('--shape', choices=['chibi', 'girl', 'both'], default='both')
    ap.add_argument('--build-atlas', action='store_true')
    ap.add_argument('--src', default=None,
                    help='source package root (default <repo>/.cache/assets-src)')
    ap.add_argument('--workdir', default=None,
                    help='intermediate workdir (default <repo>/.cache/build)')
    ap.add_argument('--outdir', default=None,
                    help='dist output root (default <repo>/tools/art/dist); use for A/B builds')
    ap.add_argument('--tool', default=None,
                    help='build_2d5.py path (default tools/art/build_2d5.py)')
    ap.add_argument('--clean-garment-skin', action='store_true',
                    help='v2.6.1: remove baked body-skin (duplicated hands/legs) from '
                         'garment textures (alpha-only; rig.json unchanged)')
    ap.add_argument('--master-config', action='append', default=[], metavar='JSON',
                    help='v2.6 body master retexture contract (repeatable; shape from config)')
    ap.add_argument('--generator-id', default='cutout/prod/tools/build_prod.py',
                    help='rig.json generator provenance string (keep historical value '
                         'for byte-identical v2.5.0 rebuilds)')
    ap.add_argument('--source-note', default='M2 cutout art（production，源工程不入库）',
                    help='rig.json cutout.source provenance string')
    ap.add_argument('--skip-hair-split', action='store_true',
                    help='pin v2.4.0 hair state (hands-only fallback dist)')
    ap.add_argument('--skip-hands', action='store_true',
                    help='skip T2 refined-hand overlay (attribution builds)')
    ap.add_argument('--hair-patch', default=None,
                    help='T1 hair-patch-spec.json override (informational)')
    ap.add_argument('--hands-dir', default=None,
                    help='T2 delivery root (default <src>/hands)')
    ap.add_argument('--hands-2x', action='store_true',
                    help='experimental: T2 refined2x -> 2x hand source textures')
    args = ap.parse_args()
    configure_paths(args)
    global MASTER_CFG
    for path in args.master_config:
        cfg = load_master_config(path)
        if cfg['shape'] in MASTER_CFG:
            raise SystemExit(f'duplicate --master-config for shape {cfg["shape"]}: {path}')
        MASTER_CFG[cfg['shape']] = cfg
    for shape in sorted(MASTER_CFG):
        log(f'master config [{shape}]: {MASTER_CFG[shape]["config"]} '
            f'(ids={len(MASTER_CFG[shape]["ids"])}, '
            f'visibleOnly={bool(MASTER_CFG[shape]["visible_mask"])})')
    OPTS['skip_hair'] = args.skip_hair_split
    OPTS['skip_hands'] = args.skip_hands
    OPTS['hair_patch'] = args.hair_patch
    OPTS['hands_2x'] = args.hands_2x
    OPTS['clean_garment_skin'] = args.clean_garment_skin
    os.makedirs(os.path.join(WORK, 'assets'), exist_ok=True)
    shapes = ['chibi', 'girl'] if args.shape == 'both' else [args.shape]
    all_stats = {}
    for shape in shapes:
        rig_path, texdir, stats = build_shape(shape)
        all_stats[shape] = stats
        if args.build_atlas:
            d = run_build_2d5(shape, rig_path, texdir)
            rep = json.load(open(os.path.join(d, 'build-report.json')))
            pages = rep.get('atlases') or ([rep['atlas']] if rep.get('atlas') else [])
            log(f'[{shape}] atlas pages {len(pages)} '
                + ', '.join(f"{p.get('width')}x{p.get('height')} pxEqual={p.get('pixelEqual')}"
                            for p in pages))
    json.dump(all_stats, open(os.path.join(WORK, 'assets', 'build-stats.json'), 'w'),
              indent=1, ensure_ascii=False)
    log('done')


if __name__ == '__main__':
    main()
