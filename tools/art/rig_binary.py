#!/usr/bin/env python3
"""大肥鱼衣橱 rig.bin 二进制编码器（feiyu-rig-binary v1）

把 `docs/dress-up/art/2d5/<shape>/rig.json` 的 mesh 荷载编码成运行时零拷贝
消费的二进制：

    [0, 8)        b"FYRIGB" + major=1 + minor=0
    [8, 12)       u32 LE headerLen（header JSON 字节数，含尾部对齐补空格）
    [12, 12+H)    header JSON（UTF-8 紧凑分隔符；BIN0=12+H 必为 4 的倍数）
    [BIN0, ...)   binary 段：逐 drawable 4 字节对齐写
                  positions f32×2V / uvs f32×2V / bones u16×4V /
                  weights f32×4V / deform f32×2V / indices u16×I

header JSON = 原 rig 对象（键顺序保持），但每个 `drawables[i]` 删除 `mesh`、
改为 `meshMeta:{vertexCount,indexCount,offsets:{positions,uvs,bones,weights,deform,indices}}`
（offsets 为相对 BIN0 的字节偏移），顶层追加
`binaryRig:{format:'feiyu-rig-binary',version:1,meshLayout:'flat-f32',bytes:<整个 bin 字节数>}`。

格式规范见 `.scratch/p1-320/RIG-BINARY.md`；解码器 `docs/dress-up/rig-binary.js`；
契约测试 `tests/rig-binary.test.mjs`。

确定性：无时间戳，JSON 键顺序 = 输入对象顺序，浮点 IEEE754 f32 最近偶数舍入；
同一输入两次编码输出逐字节一致。所有 f32/u16 显式小端（sys.byteorder != 'little'
时逐数组 byteswap），文件与 headerLen 4 字节对齐，gap 补 0。

用法：
    python3 tools/art/rig_binary.py --rig docs/dress-up/art/2d5/chibi/rig.json \
        --out /tmp/chibi/rig.bin [--report]
"""

from __future__ import annotations

import argparse
import array
import hashlib
import json
import math
import struct
import sys
from pathlib import Path

MAGIC = b'FYRIGB'
FORMAT = 'feiyu-rig-binary'
VERSION = 1
MINOR = 0
MESH_LAYOUT = 'flat-f32'
HEADER_PREFIX = 12                 # magic(8) + u32 headerLen(4)
UINT16_MAX = 0xFFFF

# 每个 drawable 的数组写入顺序（同时是 offsets 键顺序，见规范表格）。
ARRAY_KEYS = ('positions', 'uvs', 'bones', 'weights', 'deform', 'indices')
# 每顶点/索引的字节数（×V 或 ×I）；positions/uvs/bones/deform 8B/顶点，
# weights 16B/顶点，indices 2B/索引。
ARRAY_BYTES_PER_V = {'positions': 8, 'uvs': 8, 'bones': 8, 'weights': 16, 'deform': 8}
ARRAY_BYTES_PER_I = {'indices': 2}
FLOAT_PAIR_WIDTH = {'uvs': 2, 'deform': 2}   # positions 特判（决定 V）
BONE_WIDTH = 4
WEIGHT_WIDTH = 4


class RigEncodeError(ValueError):
    """rig → rig.bin 编码错误（结构缺失/长度不一致/取值越界/布局非法）。"""


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise RigEncodeError(message)


def _drawable_name(drawable: object, index: int) -> str:
    if isinstance(drawable, dict) and isinstance(drawable.get('id'), str):
        return drawable['id']
    return f'#{index}'


def _numeric(value: object, where: str) -> float:
    """JSON 数字 → f64（bool 不算数字，拒绝 NaN/Infinity）。"""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise RigEncodeError(f'{where} 必须是数字，实际 {type(value).__name__}: {value!r}')
    number = float(value)
    if not math.isfinite(number):
        raise RigEncodeError(f'{where} 不是有限浮点数: {value!r}')
    return number


def _flatten_rows(rows: object, width: int, where: str) -> list[float]:
    """嵌套 [[a,b],...] → 扁平 float 列表（严格 width 列）。"""
    if not isinstance(rows, list):
        raise RigEncodeError(f'{where} 必须是数组')
    flat: list[float] = []
    for i, row in enumerate(rows):
        if not isinstance(row, (list, tuple)) or len(row) != width:
            raise RigEncodeError(f'{where}[{i}] 必须是长度 {width} 的数组，实际 {row!r}')
        for j, value in enumerate(row):
            flat.append(_numeric(value, f'{where}[{i}][{j}]'))
    return flat


def _flatten_bones(rows: object, where: str) -> list[int]:
    """bones 嵌套 [[b0,b1,b2,b3],...] → 扁平 uint16 列表。"""
    if not isinstance(rows, list):
        raise RigEncodeError(f'{where} 必须是数组')
    flat: list[int] = []
    for i, row in enumerate(rows):
        if not isinstance(row, (list, tuple)) or len(row) != BONE_WIDTH:
            raise RigEncodeError(f'{where}[{i}] 必须是长度 {BONE_WIDTH} 的数组，实际 {row!r}')
        for j, value in enumerate(row):
            if isinstance(value, bool) or not isinstance(value, int):
                raise RigEncodeError(f'{where}[{i}][{j}] 必须是整数，实际 {value!r}')
            if not 0 <= value < 65536:
                raise RigEncodeError(f'{where}[{i}][{j}] 超出 uint16 范围 [0,65535]: {value}')
            flat.append(value)
    return flat


def _flatten_indices(values: object, where: str) -> list[int]:
    if not isinstance(values, list):
        raise RigEncodeError(f'{where} 必须是数组')
    flat: list[int] = []
    for i, value in enumerate(values):
        if isinstance(value, bool) or not isinstance(value, int):
            raise RigEncodeError(f'{where}[{i}] 必须是整数，实际 {value!r}')
        if not 0 <= value < 65536:
            raise RigEncodeError(f'{where}[{i}] 超出 uint16 范围 [0,65535]: {value}')
        flat.append(value)
    return flat


def _f32_bytes(values: list[float], where: str) -> bytes:
    """float 列表 → 小端 f32 字节（array 'f' 即 IEEE754 单精度）。"""
    try:
        buffer = array.array('f', values)
    except OverflowError as error:             # |value| > float32 上限，JSON 里本不该出现
        raise RigEncodeError(f'{where}: 数值超出 f32 表示范围: {error}') from error
    _require(buffer.itemsize == 4, f'平台 array("f").itemsize={buffer.itemsize}，需要 4 字节 f32')
    if sys.byteorder != 'little':
        buffer.byteswap()          # 大端平台：显式转小端
    return buffer.tobytes()


def _u16_bytes(values: list[int], where: str) -> bytes:
    """uint16 列表 → 小端 u16 字节。"""
    buffer = array.array('H', values)
    _require(buffer.itemsize == 2, f'平台 array("H").itemsize={buffer.itemsize}，需要 2 字节 u16')
    if sys.byteorder != 'little':
        buffer.byteswap()          # 大端平台：显式转小端
    return buffer.tobytes()


def _array_sizes(vertex_count: int, index_count: int) -> dict[str, int]:
    sizes = {key: vertex_count * width for key, width in ARRAY_BYTES_PER_V.items()}
    sizes['indices'] = index_count * ARRAY_BYTES_PER_I['indices']
    return sizes


def _encode_mesh_into(mesh: object, drawable_id: str, binary: bytearray) -> dict:
    """校验一个 drawable 的 mesh 并追加 binary 段，返回 header 用 meshMeta。

    offsets 相对 binary 段起点 BIN0；每个数组起点 4 字节对齐（gap 补 0）。
    """
    where = f'drawable {drawable_id}'
    _require(isinstance(mesh, dict), f'{where}: mesh 必须是对象')
    for key in ARRAY_KEYS:
        _require(key in mesh, f'{where}: mesh 缺少字段 {key}')
    unknown = sorted(key for key in mesh if key not in ARRAY_KEYS)
    _require(not unknown, f'{where}: mesh 含未知字段 {unknown}（二进制只承载 {list(ARRAY_KEYS)}）')

    positions = mesh['positions']
    _require(isinstance(positions, list), f'{where}: mesh.positions 必须是数组')
    vertex_count = len(positions)
    _require(vertex_count >= 1, f'{where}: vertexCount 必须 ≥ 1')
    _require(vertex_count < 65536, f'{where}: vertexCount={vertex_count} 超出 uint16 上限 65535')
    for key in ('uvs', 'bones', 'weights', 'deform'):
        rows = mesh[key]
        _require(isinstance(rows, list), f'{where}: mesh.{key} 必须是数组')
        _require(len(rows) == vertex_count,
                 f'{where}: mesh.{key} 长度 {len(rows)} 与 vertexCount {vertex_count} 不一致')

    indices = mesh['indices']
    _require(isinstance(indices, list), f'{where}: mesh.indices 必须是数组')
    index_count = len(indices)
    _require(index_count < 65536, f'{where}: indexCount={index_count} 超出 uint16 上限 65535')
    _require(index_count % 3 == 0, f'{where}: indexCount={index_count} 不是 3 的倍数（三角形列表）')

    raw = {
        'positions': _f32_bytes(_flatten_rows(positions, 2, f'{where}.positions'), f'{where}.positions'),
        'uvs': _f32_bytes(_flatten_rows(mesh['uvs'], 2, f'{where}.uvs'), f'{where}.uvs'),
        'bones': _u16_bytes(_flatten_bones(mesh['bones'], f'{where}.bones'), f'{where}.bones'),
        'weights': _f32_bytes(_flatten_rows(mesh['weights'], WEIGHT_WIDTH, f'{where}.weights'),
                              f'{where}.weights'),
        'deform': _f32_bytes(_flatten_rows(mesh['deform'], 2, f'{where}.deform'), f'{where}.deform'),
        'indices': _u16_bytes(_flatten_indices(indices, f'{where}.indices'), f'{where}.indices'),
    }

    expected = _array_sizes(vertex_count, index_count)
    for key, data in raw.items():
        _require(len(data) == expected[key],
                 f'{where}: {key} 编码 {len(data)}B ≠ 期望 {expected[key]}B')

    offsets: dict[str, int] = {}
    for key in ARRAY_KEYS:
        pad = (-len(binary)) % 4
        if pad:
            binary.extend(b'\x00' * pad)
        offsets[key] = len(binary)
        binary.extend(raw[key])

    return {'vertexCount': vertex_count, 'indexCount': index_count, 'offsets': offsets}


def _validate_layout(metas: list[dict], binary_len: int) -> None:
    """编码后自检：offsets 对齐、区间落在 binary 段内且互不重叠。"""
    ranges: list[tuple[int, int, int, str]] = []
    for index, meta in enumerate(metas):
        sizes = _array_sizes(meta['vertexCount'], meta['indexCount'])
        for key in ARRAY_KEYS:
            start = meta['offsets'][key]
            _require(start % 4 == 0, f'offsets 未 4 字节对齐: drawable#{index}.{key} → {start}')
            end = start + sizes[key]
            _require(end <= binary_len,
                     f'offsets 越界: drawable#{index}.{key} [{start},{end}) 超出 binary {binary_len}B')
            if sizes[key] > 0:
                ranges.append((start, end, index, key))
    ranges.sort()
    for previous, current in zip(ranges, ranges[1:]):
        _require(current[0] >= previous[1],
                 f'offsets 区间重叠: drawable#{previous[2]}.{previous[3]} [{previous[0]},{previous[1]}) '
                 f'vs drawable#{current[2]}.{current[3]} [{current[0]},{current[1]})')


def _drawable_header(drawable: dict, mesh_meta: dict) -> dict:
    """删除 drawable.mesh（保持其余字段与键顺序），在 mesh 原位置换成 meshMeta。"""
    header_drawable = {}
    for key, value in drawable.items():
        if key == 'mesh':
            header_drawable['meshMeta'] = mesh_meta
        else:
            header_drawable[key] = value
    return header_drawable


def _build_header(rig: dict, mesh_metas: list[dict]) -> dict:
    header = {}
    for key, value in rig.items():
        if key == 'drawables':
            header[key] = [_drawable_header(drawable, meta)
                           for drawable, meta in zip(value, mesh_metas)]
        elif key == 'binaryRig':
            continue                    # 由编码器统一追加
        else:
            header[key] = value
    header['binaryRig'] = {
        'format': FORMAT,
        'version': VERSION,
        'meshLayout': MESH_LAYOUT,
        'bytes': 0,                     # encode_rig 内迭代填入
    }
    return header


def _serialize_header(header: dict) -> bytes:
    """紧凑 JSON UTF-8 → 尾部补空格到 4 字节对齐（BIN0 = 12+headerLen 必为 4 倍数）。"""
    raw = json.dumps(header, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode('utf-8')
    pad = (-(HEADER_PREFIX + len(raw))) % 4
    return raw + b' ' * pad


def encode_rig(rig: object) -> bytes:
    """rig JSON 对象 → rig.bin 字节（确定性、小端、4 字节对齐）。"""
    _require(isinstance(rig, dict), 'rig 必须是 JSON 对象')
    drawables = rig.get('drawables')
    _require(isinstance(drawables, list), 'rig.drawables 必须是数组')

    binary = bytearray()
    mesh_metas: list[dict] = []
    for index, drawable in enumerate(drawables):
        drawable_id = _drawable_name(drawable, index)
        _require(isinstance(drawable, dict), f'{drawable_id}: drawable 必须是对象')
        _require('mesh' in drawable, f'{drawable_id}: drawable 缺少 mesh')
        mesh_metas.append(_encode_mesh_into(drawable['mesh'], drawable_id, binary))

    _validate_layout(mesh_metas, len(binary))

    header = _build_header(rig, mesh_metas)
    total = 0
    header_bytes = b''
    for _ in range(8):
        header['binaryRig']['bytes'] = total
        header_bytes = _serialize_header(header)
        _require(len(header_bytes) % 4 == 0,
                 f'headerLen={len(header_bytes)} 未对齐（BIN0 必须是 4 的倍数）')
        new_total = HEADER_PREFIX + len(header_bytes) + len(binary)
        if new_total == total:
            break
        total = new_total
    else:
        raise RigEncodeError('binaryRig.bytes 长度迭代不收敛')

    data = (MAGIC + bytes((VERSION, MINOR)) + struct.pack('<I', len(header_bytes))
            + header_bytes + bytes(binary))
    _require(len(data) == total,
             f'输出字节数 {len(data)} ≠ header 声明 {total}')
    return data


def decode_report(rig: object, data: bytes) -> dict:
    """编码报告（CLI --report 用；不进 .bin，不影响确定性）。"""
    drawables = rig['drawables']                # encode_rig 已校验
    mesh_metas = []
    cursor = 0
    for drawable in drawables:
        mesh = drawable['mesh']
        vertex_count = len(mesh['positions'])
        index_count = len(mesh['indices'])
        sizes = _array_sizes(vertex_count, index_count)
        offsets = {}
        for key in ARRAY_KEYS:
            cursor += (-cursor) % 4
            offsets[key] = cursor
            cursor += sizes[key]
        mesh_metas.append({
            'id': drawable.get('id'),
            'vertexCount': vertex_count,
            'indexCount': index_count,
            'offsets': offsets,
        })
    header_len = struct.unpack_from('<I', data, 8)[0]
    return {
        'format': FORMAT,
        'version': VERSION,
        'minor': MINOR,
        'meshLayout': MESH_LAYOUT,
        'bytes': len(data),
        'headerLen': header_len,
        'binaryBytes': len(data) - HEADER_PREFIX - header_len,
        'drawables': len(drawables),
        'vertices': sum(item['vertexCount'] for item in mesh_metas),
        'indices': sum(item['indexCount'] for item in mesh_metas),
        'sha256': hashlib.sha256(data).hexdigest(),
        'meshMeta': mesh_metas,
    }


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description='大肥鱼衣橱 rig.json → rig.bin 二进制编码器（feiyu-rig-binary v1）')
    parser.add_argument('--rig', required=True, help='输入 rig JSON 路径')
    parser.add_argument('--out', required=True, help='输出 rig.bin 路径')
    parser.add_argument('--report', action='store_true', help='stdout 打印编码报告（JSON）')
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_arg_parser().parse_args(argv)
    try:
        rig = json.loads(Path(args.rig).read_text(encoding='utf-8'))
        data = encode_rig(rig)
        out = Path(args.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(data)
    except (OSError, json.JSONDecodeError, RigEncodeError) as error:
        print(f'rig_binary: {error}', file=sys.stderr)
        return 1

    if args.report:
        report = decode_report(rig, data)
        report['rig'] = str(args.rig)
        report['out'] = str(args.out)
        print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    sys.exit(main())
