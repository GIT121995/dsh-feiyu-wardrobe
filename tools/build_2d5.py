#!/usr/bin/env python3
"""大肥鱼衣橱 2.5D runtime 资产构建器（M3 产品化 + B-M3b 多页图集）

把 POC 产出的 rig JSON + 每 drawable 裁剪纹理，整理成产品运行时直接消费的
「每身形 1–2 张图集 + 紧凑 rig JSON」：

    docs/dress-up/art/2d5/<shape>/
    ├── rig.json           紧凑 rig（浮点定点化、去 runtime 不用的字段、UV 重映射到图集空间）
    ├── atlas.webp         图集页（lossless WebP RGBA，逐 drawable 2px 透明 padding；多页时 atlas-2.webp …）
    └── build-report.json  构建报告（逐页图集尺寸/矩形/字节数/pixelEqual/校验结果）

输入契约（M4 按 `.scratch/m3/ASSET-SPEC-2D5.md` 交付同结构）：
  --rig      POC 形态 rig JSON（skeleton/deformers/physics/drawables/outfits/slots；可选多页字段）
  --texdir   纹理目录（drawable.texture 的 basename 必须能在该目录找到；尺寸 = drawable.texSize）
  --out      输出目录（<out>/<shape>/rig.json 等）
  --shape    chibi | girl

多页图集（B 方案 cutout；≤2 页，单张 ≤4096×4096）：
  输入 rig 用以下任一方式指定 drawable 归属页（两页时触发多页输出）：
    a) `rig.atlasPages = [{"id":"base","file":"atlas.webp"}, {"id":"cutout","file":"atlas2.webp"}]`
       + `drawables[].atlas = "base" | "cutout"`（缺省归第一页）；
    b) `rig.atlasPages = [{"id":"base","drawables":[id,...]}, {"id":"cutout","drawables":[id,...]}]`
       （drawables 列表显式分组；file 可省略，默认 atlas.webp / atlas-2.webp）。

  单页/未提供多页字段 → 走旧单图集路径（输出形状与历史版本完全一致，`rig.atlas` + 单 `atlas.webp`）。

确定性：同一输入两次构建输出逐字节一致（无时间戳；图集编码固定参数）。
校验：默认回读每页 atlas 与内存合成逐像素比对（lossless 必须完全相等）；UV 落在所属页图集矩形内；
      outfit 引用的 drawable 必须存在；失败退出码 1。

用法：
    python3 tools/build_2d5.py \
        --rig /home/ubuntu/dsh/.scratch/m2-full/poc/chibi-v2-m3.feiyu.json \
        --texdir /home/ubuntu/dsh/.scratch/m2-full/poc/assets/m3/chibi \
        --out docs/dress-up/art/2d5 --shape chibi
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

HERE = Path(__file__).resolve().parent          # <repo>/tools
ROOT = HERE.parent                              # <repo>
DEFAULT_OUT = ROOT / 'docs' / 'dress-up' / 'art' / '2d5'

# 定点精度：positions 0.01px、uvs 1e-5（≈0.006px@598px 纹理）、weights 1e-4、deform 1e-3。
PRECISION = {'positions': 2, 'uvs': 5, 'weights': 4, 'deform': 3, 'skeleton': 2}
PAD = 2                  # 图集每 drawable 四周透明 padding（px）
MAX_WIDTH = 2048         # 单页图集最大宽度（GL ES 3.0 最低保证 2048；cutout 页可 --max-width 4096）
MAX_SIDE = 4096          # 单页图集最大边长（宽/高；SPEC 约束）
MAX_PAGES = 2            # 每身形最多图集页数（cutout 首版）
OUTFIT_SLOTS = ('topUnder', 'bottom', 'topBody', 'sleeve', 'sleeveUpper', 'sleeveFore', 'collar')
GENERATOR = 'tools/build_2d5.py'


def load_rig(path: Path) -> dict:
    data = json.loads(path.read_text(encoding='utf-8'))
    if not isinstance(data, dict):
        raise SystemExit(f'rig 不是对象：{path}')
    for key in ('drawables', 'skeleton', 'outfits', 'slots', 'physics', 'deformers'):
        if key not in data:
            raise SystemExit(f'rig 缺少字段 {key}：{path}')
    return data


def drawable_id(d: dict) -> str:
    return d.get('id') or Path(d.get('texture') or '').stem


def trim_texture(d: dict, img: Image.Image) -> Image.Image:
    """按 alpha>0 bbox 裁剪纹理，并把 mesh uvs 从「原纹理归一化」重映射到裁剪后局部坐标。

    用于 cutout 部件纹理（每部件常是 675×1200 全画布，带大量透明 padding）。texSize 同步更新。
    """
    alpha = img.getchannel('A')
    bbox = alpha.getbbox()
    if bbox is None:
        raise SystemExit(f'drawable {drawable_id(d)} 纹理全透明，无法裁剪')
    x0, y0, x1, y1 = bbox
    # 外扩 1px（不超出原图），容纳 mesh 在 alpha 边缘外的少量顶点
    x0, y0 = max(0, x0 - 1), max(0, y0 - 1)
    x1, y1 = min(img.width, x1 + 1), min(img.height, y1 + 1)
    if (x0, y0, x1, y1) == (0, 0, img.width, img.height):
        return img
    tw, th = x1 - x0, y1 - y0
    src_w, src_h = img.width, img.height
    mesh = d['mesh']
    # 裁掉透明 padding 后，mesh 边缘顶点可能落到裁剪框外 → clamp 到 [0,1]（这些位置原就是透明像素）
    mesh['uvs'] = [
        [round(min(1.0, max(0.0, (float(u) * src_w - x0) / tw)), 6),
         round(min(1.0, max(0.0, (float(v) * src_h - y0) / th)), 6)]
        for u, v in mesh['uvs']
    ]
    d['texSize'] = [tw, th]
    return img.crop((x0, y0, x1, y1))


def load_texture(texdir: Path, d: dict, trim_alpha: bool = False) -> tuple[Image.Image, str]:
    """按 drawable.texture 的 basename 读纹理；尺寸必须与 texSize 一致（trim 时按 alpha bbox 裁剪）。"""
    """按 drawable.texture 的 basename 读纹理；尺寸必须与 texSize 一致。"""
    tex = d.get('texture') or ''
    name = Path(tex).name
    path = texdir / name
    if not name or not path.is_file():
        raise SystemExit(f'drawable {drawable_id(d)} 纹理缺失：{path}')
    img = Image.open(path)
    if img.mode != 'RGBA':
        img = img.convert('RGBA')
    size = d.get('texSize')
    if size and tuple(size) != img.size:
        raise SystemExit(f'drawable {drawable_id(d)} 纹理尺寸 {img.size} != texSize {tuple(size)}')
    if trim_alpha:
        img = trim_texture(d, img)
    return img, name


def pack_rects(sizes: list[tuple[int, int]], pad: int, max_width: int) -> tuple[int, int, list[tuple[int, int]]]:
    """Best-fit decreasing height 打包（比货架省 ~5% 图集面积）。

    按高度降序逐块放置：在已有「行」里选一个高度足够、剩余高度浪费最小的行；
    放不下则新开一行。返回图集宽高与每块左上角（含 padding 的外框）。
    """
    order = sorted(range(len(sizes)), key=lambda i: (-sizes[i][1], -sizes[i][0], i))
    rows: list[list[int]] = []          # [y, height, usedWidth]
    pos: list[tuple[int, int]] = [(0, 0)] * len(sizes)
    for i in order:
        w, h = sizes[i]
        ww, hh = w + 2 * pad, h + 2 * pad
        best = None
        for row in rows:
            if row[2] + ww > max_width or hh > row[1]:
                continue
            waste = row[1] - hh
            if best is None or waste < best[0]:
                best = (waste, row)
        if best is None:
            row = [sum(r[1] for r in rows), hh, 0]
            rows.append(row)
        else:
            row = best[1]
        pos[i] = (row[2] + pad, row[0] + pad)
        row[2] += ww
    width = max((r[2] for r in rows), default=0)
    height = sum(r[1] for r in rows)
    return width, height, pos


def round_floats(values: list, ndigits: int) -> list:
    return [[round(float(v), ndigits) for v in row] for row in values]


def resolve_pages(rig: dict) -> list[dict] | None:
    """解析多页图集分组；返回 None = 旧单图集路径。

    返回 [{id, file, indices:[drawable 下标…]}]（按输入页顺序）。
    """
    drawables = rig['drawables']
    spec = rig.get('atlasPages')
    has_atlas_field = any(isinstance(d.get('atlas'), str) and d.get('atlas') for d in drawables)
    if not spec and not has_atlas_field:
        return None
    if spec is not None and (not isinstance(spec, list) or not spec):
        raise SystemExit('atlasPages 必须是非空数组')
    entries = list(spec) if spec else []
    if not entries:
        # 只有 drawables[].atlas：按首次出现顺序推断页
        order: list[str] = []
        for d in drawables:
            pid = d.get('atlas')
            if isinstance(pid, str) and pid and pid not in order:
                order.append(pid)
        entries = [{'id': pid} for pid in order]
    if len(entries) > MAX_PAGES:
        raise SystemExit(f'图集页数 {len(entries)} > 上限 {MAX_PAGES}（每身形 ≤2 页）')
    page_ids: list[str] = []
    page_files: list[str] = []
    explicit: dict[str, str] = {}
    for i, entry in enumerate(entries):
        if not isinstance(entry, dict):
            raise SystemExit(f'atlasPages[{i}] 不是对象')
        pid = entry.get('id')
        if not isinstance(pid, str) or not pid:
            raise SystemExit(f'atlasPages[{i}].id 缺失')
        if pid in page_ids:
            raise SystemExit(f'atlasPages 页 id 重复：{pid}')
        page_ids.append(pid)
        file = entry.get('file')
        if file is not None and (not isinstance(file, str) or not file or '/' in file or '\\' in file or not file.endswith('.webp')):
            raise SystemExit(f'atlasPages[{i}].file 非法（需 .webp basename）：{file}')
        page_files.append(file or ('atlas.webp' if i == 0 else f'atlas-{i + 1}.webp'))
        for did in entry.get('drawables') or []:
            if not isinstance(did, str):
                raise SystemExit(f'atlasPages[{i}].drawables 含非字符串 id')
            if did in explicit:
                raise SystemExit(f'drawable {did} 同时出现在多页分组的 drawables 里')
            explicit[did] = pid
    files = set(page_files)
    if len(files) != len(page_files):
        raise SystemExit(f'图集文件名重复：{page_files}')
    groups: dict[str, list[int]] = {pid: [] for pid in page_ids}
    unknown_explicit = [did for did in explicit if all(drawable_id(d) != did for d in drawables)]
    if unknown_explicit:
        raise SystemExit(f'atlasPages.drawables 引用了不存在的 drawable：{unknown_explicit[:5]}')
    for i, d in enumerate(drawables):
        did = drawable_id(d)
        pid = explicit.get(did) or d.get('atlas') or page_ids[0]
        if pid not in groups:
            raise SystemExit(f'drawable {did} 的 atlas={pid} 未在 atlasPages 声明')
        groups[pid].append(i)
    pages = []
    for i, pid in enumerate(page_ids):
        if not groups[pid]:
            raise SystemExit(f'图集页 {pid} 没有任何 drawable（建议移除该页）')
        pages.append({'id': pid, 'file': page_files[i], 'indices': groups[pid]})
    if len(pages) <= 1:
        # 只有一页 → 保持旧单图集输出形状（向后兼容）
        return None
    return pages


def remap_page(drawables: list[dict], images: list[Image.Image], pos: list[tuple[int, int]],
               atlas_w: int, atlas_h: int, page_file: str, page_id: str,
               legacy: bool = False) -> None:
    """把一页的 drawable UV 从「裁剪矩形归一化」重映射到该页图集空间 + 定点化。

    legacy=True（单图集旧路径）不写 drawables[].atlas，保持历史输出形状不变。
    """
    for d, img, (px, py) in zip(drawables, images, pos):
        tw, th = img.size
        mesh = d['mesh']
        mesh['uvs'] = [
            [round((px + float(u) * tw) / atlas_w, PRECISION['uvs']),
             round((py + float(v) * th) / atlas_h, PRECISION['uvs'])]
            for u, v in mesh['uvs']
        ]
        mesh['positions'] = round_floats(mesh['positions'], PRECISION['positions'])
        mesh['weights'] = round_floats(mesh['weights'], PRECISION['weights'])
        mesh['deform'] = round_floats(mesh['deform'], PRECISION['deform'])
        d['texture'] = page_file
        d['atlasRect'] = [px, py, tw, th]
        if legacy:
            d.pop('atlas', None)
        else:
            d['atlas'] = page_id
        d.pop('source', None)
        mesh.pop('cell', None)
        mesh.pop('grid', None)


def validate_uvs(drawables: list[dict], atlas_w: int, atlas_h: int) -> list[str]:
    errors: list[str] = []
    for d in drawables:
        px, py, tw, th = d['atlasRect']
        for u, v in d['mesh']['uvs']:
            if not (0.0 <= u <= 1.0 and 0.0 <= v <= 1.0):
                errors.append(f'{d["id"]}: uv 越界 ({u},{v})')
                break
            ax = u * atlas_w
            ay = v * atlas_h
            if not (px - 0.51 <= ax <= px + tw + 0.51 and py - 0.51 <= ay <= py + th + 0.51):
                errors.append(f'{d["id"]}: uv 落在图集矩形外 ({u},{v}); ax={ax:.2f} ay={ay:.2f} rect={[px,py,tw,th]} atlas={atlas_w}x{atlas_h}')
                break
    return errors


def validate_outfits(rig: dict) -> list[str]:
    known = {d['id'] for d in rig['drawables']}
    errors: list[str] = []
    for outfit_id, outfit in (rig.get('outfits') or {}).items():
        if not isinstance(outfit, dict):
            continue
        for slot in OUTFIT_SLOTS:
            for did in outfit.get(slot) or []:
                if did not in known:
                    errors.append(f'{outfit_id}.{slot}:{did}')
    return errors


def round_skeleton(rig: dict) -> None:
    for bone in rig['skeleton']['bones']:
        bone['base'] = [round(float(bone['base'][0]), PRECISION['skeleton']),
                        round(float(bone['base'][1]), PRECISION['skeleton'])]
    for dfm in rig['deformers']:
        if isinstance(dfm.get('pivot'), list):
            dfm['pivot'] = [round(float(v), PRECISION['skeleton']) for v in dfm['pivot']]
    for chain in rig['physics']:
        chain['nodes'] = round_floats(chain['nodes'], PRECISION['skeleton'])


def write_atlas(atlas: Image.Image, path: Path, verify: bool) -> tuple[int, bool]:
    atlas.save(path, format='WEBP', lossless=True, quality=100, method=6, exact=True)
    atlas_rgba = np.asarray(atlas, dtype=np.uint8)
    decoded = np.asarray(Image.open(path).convert('RGBA'), dtype=np.uint8)
    pixel_equal = bool(decoded.shape == atlas_rgba.shape and np.array_equal(decoded, atlas_rgba))
    if verify and not pixel_equal:
        raise SystemExit(f'图集回读与内存合成不一致（lossless 校验失败）：{path.name}')
    return path.stat().st_size, pixel_equal


def build(rig_path: Path, texdir: Path, out_dir: Path, shape: str, pad: int,
          max_width: int, verify: bool, max_side: int = MAX_SIDE,
          trim_alpha: bool = False) -> dict:
    rig = load_rig(rig_path)
    if rig.get('shape') and rig['shape'] != shape:
        raise SystemExit(f'rig shape={rig["shape"]} 与 --shape={shape} 不一致')
    if max_width > max_side:
        raise SystemExit(f'--max-width {max_width} > 单张上限 {max_side}')
    pages = resolve_pages(rig)
    drawables = rig['drawables']

    out_dir = out_dir / shape
    out_dir.mkdir(parents=True, exist_ok=True)

    if pages is None:
        # ---------------- 旧单图集路径（输出形状与历史版本一致） ----------------
        images: list[Image.Image] = []
        sizes: list[tuple[int, int]] = []
        for d in drawables:
            img, _name = load_texture(texdir, d, trim_alpha=trim_alpha)
            images.append(img)
            sizes.append(img.size)
        atlas_w, atlas_h, pos = pack_rects(sizes, pad, max_width)
        if atlas_w <= 0 or atlas_h <= 0:
            raise SystemExit('空图集')
        if atlas_w > max_side or atlas_h > max_side:
            raise SystemExit(f'图集 {atlas_w}x{atlas_h} 超过单张上限 {max_side}x{max_side}')
        atlas = Image.new('RGBA', (atlas_w, atlas_h), (0, 0, 0, 0))
        for img, (px, py) in zip(images, pos):
            atlas.alpha_composite(img, (px, py))
        remap_page(drawables, images, pos, atlas_w, atlas_h, 'atlas.webp', 'default', legacy=True)
        round_skeleton(rig)
        atlas_bytes, pixel_equal = write_atlas(atlas, out_dir / 'atlas.webp', verify)
        rig['atlas'] = {'file': 'atlas.webp', 'width': atlas_w, 'height': atlas_h,
                        'padding': pad, 'format': 'webp-lossless-rgba'}
        m3 = dict(rig.get('m3') or {})
        m3.update({'version': 1, 'generator': GENERATOR, 'atlas': True, 'textureCrop': True})
        rig['m3'] = m3
        rig['format'] = rig.get('format') or 'feiyu-rig'
        rig['product'] = {'generator': GENERATOR, 'atlas': True}
        rig.pop('atlasPages', None)
        rig_bytes = json.dumps(rig, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
        (out_dir / 'rig.json').write_bytes(rig_bytes)
        uv_errors = validate_uvs(drawables, atlas_w, atlas_h)
        if uv_errors:
            raise SystemExit('UV 校验失败：' + '; '.join(uv_errors[:5]))
        outfit_errors = validate_outfits(rig)
        if outfit_errors:
            raise SystemExit('outfit 引用缺失 drawable：' + ', '.join(outfit_errors[:5]))
        report = {
            'shape': shape,
            'sourceRig': rig_path.name,
            'sourceRigBytes': rig_path.stat().st_size,
            'generator': GENERATOR,
            'padding': pad,
            'trimAlpha': trim_alpha,
            'pages': 1,
            'atlas': {'width': atlas_w, 'height': atlas_h, 'bytes': atlas_bytes,
                      'pixelEqual': pixel_equal, 'rects': len(drawables)},
            'rig': {'bytes': len(rig_bytes), 'gzipBytes': len(gzip.compress(rig_bytes, 9)),
                    'sha256': hashlib.sha256(rig_bytes).hexdigest()},
            'drawables': _drawable_report(drawables),
            'textureTotal': _texture_total([{'width': atlas_w, 'height': atlas_h, 'bytes': atlas_bytes}]),
        }
        (out_dir / 'build-report.json').write_text(
            json.dumps(report, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
        return report

    # ---------------- 多页图集路径（cutout；≤2 页） ----------------
    atlas_infos: list[dict] = []
    page_pixels: list[dict] = []
    for page in pages:
        subset = [drawables[i] for i in page['indices']]
        images: list[Image.Image] = []
        sizes: list[tuple[int, int]] = []
        for d in subset:
            img, _name = load_texture(texdir, d, trim_alpha=trim_alpha)
            images.append(img)
            sizes.append(img.size)
        atlas_w, atlas_h, pos = pack_rects(sizes, pad, max_width)
        if atlas_w <= 0 or atlas_h <= 0:
            raise SystemExit(f'空图集页：{page["id"]}')
        if atlas_w > max_side or atlas_h > max_side:
            raise SystemExit(f'图集页 {page["id"]} 尺寸 {atlas_w}x{atlas_h} 超过单张上限 {max_side}x{max_side}')
        atlas = Image.new('RGBA', (atlas_w, atlas_h), (0, 0, 0, 0))
        for img, (px, py) in zip(images, pos):
            atlas.alpha_composite(img, (px, py))
        remap_page(subset, images, pos, atlas_w, atlas_h, page['file'], page['id'])
        atlas_bytes, pixel_equal = write_atlas(atlas, out_dir / page['file'], verify)
        uv_errors = validate_uvs(subset, atlas_w, atlas_h)
        if uv_errors:
            raise SystemExit(f'UV 校验失败（页 {page["id"]}）：' + '; '.join(uv_errors[:5]))
        atlas_infos.append({'id': page['id'], 'file': page['file'], 'width': atlas_w, 'height': atlas_h,
                            'padding': pad, 'format': 'webp-lossless-rgba'})
        page_pixels.append({'id': page['id'], 'file': page['file'], 'width': atlas_w, 'height': atlas_h,
                            'bytes': atlas_bytes, 'pixelEqual': pixel_equal, 'rects': len(subset)})

    round_skeleton(rig)
    rig['atlases'] = atlas_infos
    rig['atlas'] = dict(atlas_infos[0])          # 兼容旧消费者（首张）
    m3 = dict(rig.get('m3') or {})
    m3.update({'version': 1, 'generator': GENERATOR, 'atlas': True, 'multiAtlas': True,
               'atlasPages': len(atlas_infos), 'textureCrop': True})
    rig['m3'] = m3
    rig['format'] = rig.get('format') or 'feiyu-rig'
    rig['product'] = {'generator': GENERATOR, 'atlas': True, 'pages': len(atlas_infos)}
    rig.pop('atlasPages', None)
    rig_bytes = json.dumps(rig, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    (out_dir / 'rig.json').write_bytes(rig_bytes)
    outfit_errors = validate_outfits(rig)
    if outfit_errors:
        raise SystemExit('outfit 引用缺失 drawable：' + ', '.join(outfit_errors[:5]))
    report = {
        'shape': shape,
        'sourceRig': rig_path.name,
        'sourceRigBytes': rig_path.stat().st_size,
        'generator': GENERATOR,
        'padding': pad,
        'trimAlpha': trim_alpha,
        'pages': len(atlas_infos),
        'atlas': {'width': page_pixels[0]['width'], 'height': page_pixels[0]['height'],
                  'bytes': page_pixels[0]['bytes'], 'pixelEqual': page_pixels[0]['pixelEqual'],
                  'rects': page_pixels[0]['rects']},
        'atlases': page_pixels,
        'rig': {'bytes': len(rig_bytes), 'gzipBytes': len(gzip.compress(rig_bytes, 9)),
                'sha256': hashlib.sha256(rig_bytes).hexdigest()},
        'drawables': _drawable_report(drawables),
        'textureTotal': _texture_total(page_pixels),
    }
    (out_dir / 'build-report.json').write_text(
        json.dumps(report, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    return report


def _drawable_report(drawables: list[dict]) -> list[dict]:
    return [
        {
            'id': d['id'], 'slot': d.get('slot'), 'z': d.get('z'),
            'atlas': d.get('atlas'), 'atlasRect': d['atlasRect'], 'texSize': d['texSize'],
            'verts': len(d['mesh']['positions']),
            'tris': len(d['mesh']['indices']) // 3,
        }
        for d in drawables
    ]


def _texture_total(pages: list[dict]) -> dict:
    tex_bytes = sum(int(p.get('bytes', 0)) for p in pages)
    pixel_bytes = sum(int(p.get('width', 0)) * int(p.get('height', 0)) * 4 for p in pages)
    return {
        'atlasBytes': tex_bytes,
        'pages': len(pages),
        'bytesPerPixel': 4,
        'texMiB': round(pixel_bytes / 1048576, 2),
        'texMiBwithMipmap': round(pixel_bytes * 4 / 3 / 1048576, 2),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description='构建 2.5D 产品资产（紧凑 rig + 1–2 页图集）')
    parser.add_argument('--rig', required=True, help='POC rig JSON 路径（可选 atlasPages/drawables[].atlas）')
    parser.add_argument('--texdir', required=True, help='POC 纹理目录（drawable.texture 的 basename）')
    parser.add_argument('--out', default=str(DEFAULT_OUT), help='输出目录（默认 docs/dress-up/art/2d5）')
    parser.add_argument('--shape', required=True, choices=['chibi', 'girl'])
    parser.add_argument('--pad', type=int, default=PAD, help=f'图集 padding（默认 {PAD}px）')
    parser.add_argument('--max-width', type=int, default=MAX_WIDTH,
                        help=f'单页图集最大宽度（默认 {MAX_WIDTH}；cutout 可设 4096）')
    parser.add_argument('--max-side', type=int, default=MAX_SIDE,
                        help=f'单页图集最大边长上限（默认 {MAX_SIDE}）')
    parser.add_argument('--trim-alpha', action='store_true',
                        help='按 alpha bbox 裁剪纹理（cutout 部件纹理常带透明 padding；会重映射 UV）')
    parser.add_argument('--no-verify', action='store_true', help='跳过图集回读逐像素校验')
    args = parser.parse_args(argv)
    report = build(Path(args.rig), Path(args.texdir), Path(args.out), args.shape,
                   args.pad, args.max_width, verify=not args.no_verify, max_side=args.max_side,
                   trim_alpha=args.trim_alpha)
    if report.get('atlases'):
        pages = report['atlases']
        atlas_txt = ' + '.join(f"{p['id']} {p['width']}x{p['height']} {p['bytes'] / 1024:.0f}KiB" for p in pages)
        equal_txt = all(p['pixelEqual'] for p in pages)
        rects = sum(p['rects'] for p in pages)
    else:
        atlas = report['atlas']
        atlas_txt = f"{atlas['width']}x{atlas['height']} {atlas['bytes'] / 1024:.0f} KiB"
        equal_txt = atlas['pixelEqual']
        rects = atlas['rects']
    rig = report['rig']
    print(f'[{args.shape}] pages {report.get("pages", 1)} · atlas {atlas_txt} · rig '
          f'{rig["bytes"] / 1024:.0f} KiB (gzip {rig["gzipBytes"] / 1024:.0f} KiB) · '
          f'drawables {rects} · pixelEqual {equal_txt} · tex {report["textureTotal"]["texMiB"]} MiB')
    return 0


if __name__ == '__main__':
    sys.exit(main())
