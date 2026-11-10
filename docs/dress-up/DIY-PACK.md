# DIY 增量 outfit pack（v1）· 格式与 runtime 消费

> 本文是 **S2 产出 / S3 消费** 的规范：DIY 自动绑定只产出**增量**套装（不自带 base rig/图集/骨架），
> 运行时由 2.5D runtime 动态合并、逐 drawable 上传纹理。页面（`docs/dress-up/diy-packs.js`）经宿主路由读取后调用
> `runtime.addOutfitPack()` / `removeOutfitPack()`；`.dshskin` 导入导出走宿主 `/feiyu/diy/import`。
> 相关：`docs/dress-up/DIY-PIPELINE.md`（宿主生成管线）、`.scratch/diy2/S2-S3-PACK-SPEC.md`（草案/决策记录）。

## 1. 目录与文件

```
~/.dsh/feiyu/diy/
├── registry.json                       # 已安装索引（页面 boot 读取）
└── packs/<itemId>/
    ├── diy-pack.json                   # 本规范 §2
    ├── tex/<drawableId>.webp           # 每个 drawable 一张 lossless 纹理（局部 UV 0..1）
    └── static/{body,sleeve}.png        # QA 未过（fallback=static）时的静态贴片
```

宿主路由（`lib/diy.js`，仅同源、默认关闭时 404 = 最小暴露）：

| 路由 | 说明 |
|---|---|
| `GET /feiyu/diy/registry.json` | 已安装索引（`cache-control: no-store`） |
| `GET /feiyu/diy/packs/<id>/diy-pack.json` / `tex/*.webp` / `static/*.png` | pack 文件（路径白名单，拒绝穿越） |
| `POST /feiyu/diy/remove` | 删除安装（`{id}`，需 `x-feiyu-diy: 1` + 同源） |
| `POST /feiyu/diy/import` | 导入 `.dshskin`（`{bundle}`，同上） |

## 2. `diy-pack.json`（formatVersion 1）

```jsonc
{
  "format": "feiyu-diy-pack",
  "formatVersion": 1,
  "item": "diy-top-20261104102500",        // 全局唯一 itemId（= registry key = outfit id 前缀）
  "name": "白衬衫",
  "shape": "chibi",
  "category": "top",                      // top|bottom|dress|coat|outfit
  "base": { "skeletonBones": 59,          // v2.4 起允许 ≤ base rig 骨数（前缀骨架兼容）；旧 59 骨 pack 可用于 65 骨场景
             "boneNames": ["root", "..."],     // 可选：与 base rig 骨架前缀逐名校验（binder 自动写）
             "skeletonVersion": 3 },          // 可选：base rig 版本（诊断用）
  "drawables": [{
    "id": "diy-top-...-body",
    "slot": "topBody", "z": 40, "role": "topBody",
    "texture": "tex/diy-top-...-body.webp",
    "texSize": [317, 360],
    "rect": [169, 527, 486, 887],
    "mesh": {
      "positions": [[x, y], ...],         // canvas 675×1200 绑定姿态坐标
      "uvs": [[u, v], ...],               // 相对本 drawable 纹理的 0..1 局部 UV
      "bones": [[i, j, k, l], ...],       // base rig 59 骨索引（= 动态合并目标骨架顺序）
      "weights": [[w, w, w, w], ...],     // ≤4 骨/顶点、Σ≈1
      "deform": [[headW, chestW], ...],   // 0..1，头部 yaw/pitch 与呼吸 deform
      "indices": [a, b, c, ...]
    }
  }],
  "outfits": {
    "diy-top-20261104102500": {           // key 必须以 diy- 开头；页面 setLook({outfit:<itemId>})
      "name": "白衬衫", "topBody": ["diy-top-...-body"], "sleeve": ["diy-top-...-sleeve"],
      "bottom": ["bottom-plaid"]          // 可引用 base rig 既有 drawable id
    }
  }
}
```

约束：**不新增骨骼/物理链**（bones 索引指向 base rig 骨架前缀；v2.4 起旧 59 骨 pack 在 65 骨场景按前缀兼容、
运行时标记 `legacyBones`，超出场景骨数/骨名不匹配仍拒绝；裙摆权重复用 base `skirtP/M` 链）；
纹理独立（不并入 base 图集）；`item` 与 registry/outfit id 一致；单 pack 1–2 个 drawable。

## 3. runtime API（`runtime-2d5.js`）

```js
// 页面/宿主同源动态追加（不重载 base rig；参数/物理/时间/造型状态保留）
const result = await runtime.addOutfitPack({
  pack,                                   // diy-pack.json 解析对象
  packId: item.id,                        // = registry item id
  assetBase: `/feiyu/diy/packs/${item.id}/`, // 纹理 fetch 前缀（也可传 textures:{path:Image}）
});
// → { ok, packId, drawableIds:[...], outfits:[...], textures:2, textureBytes, memory }

runtime.getOutfitPacks();                 // → [{packId, drawableIds, outfits}]
runtime.getOutfits();                     // 含动态 outfit id（setLook 可直接命中）
runtime.setLook({ outfit: item.id });     // 选中即动效换装
runtime.removeOutfitPack(item.id);        // 释放 VAO/VBO/纹理 + 删除 outfit；当前造型自动回退
```

- 多纹理：每个 DIY drawable 独立 GL 纹理（`drawDrawable` 按 `drawable.tex` 绑定）；`setMipmaps/quality`
  会按各自图片重传；`destroy/切身形` 释放全部 DIY 资源。
- 失败回退：`addOutfitPack` 校验失败 → `pack_invalid`（不残留 GL 资源）；QA `fallback=static` 的套装
  页面走静态贴片（`pack/static/body.png` + `sleeve.png`，675×1200 全画布叠加，UI 提示不支持骨骼动画）。
- 实测（headless SwANGLE，无 GPU；真机未测）：单 pack 动态加载 **42–82ms**、移除 0–2ms；
  额外显存 **0.77–1.79 MiB**（2 纹理，mipmap ×4/3）；移除后纹理/VAO/显存计数回到基线；
  磁盘 **307–594 KB/件**（JSON 124–176KB + 2 lossless 纹理）。

## 4. registry.json（v1）

```jsonc
{
  "version": 1, "updatedAt": "...",
  "items": {
    "diy-top-...": {
      "id": "diy-top-...", "name": "白衬衫", "shape": "chibi", "category": "top",
      "packDir": "packs/diy-top-...", "animated": true, "fallback": "none",
      "qa": { "pass": true, "grade": "pass", "coverage": {...}, "split": {...} },
      "seedream": { "images": 2, "costYuan": 0.6 }
    }
  }
}
```

页面 boot：`GET registry.json`（404 → 无 DIY，不报错）→ `inject(manifest)` 把 animated 套装加入衣柜
outfits 分类（图标 = pack 纹理缩略图）；`fallback=static` 的套装用 `static/` 贴片。

## 5. `.dshskin`（S3 v1，客户端导出 + 宿主导入）

```jsonc
{ "format": "feiyu-diy-skin", "version": 1,
  "entry": { "id", "name", "shape": "chibi", "category", "animated", "fallback" },
  "pack": { /* diy-pack.json 原样 */ },
  "textures": [{ "path": "tex/xxx.webp", "dataURL": "data:image/webp;base64,..." }],
  "static": [{ "path": "static/body.png", "dataURL": "..." }] }
```

导入：宿主校验 format/version/item/shape/纹理完整性后写 `packs/<id>/` + registry；非法包整体拒绝且不落盘。
导出/导入均不经过 LLM（浏览器 ↔ 宿主本机）。

## 5.5 v2.2 cutout 兼容（v2.2.1 起；v2.3 资产沿用）

> v2.3.0 仅替换手/脚精修像素（资产版本 15、页面模块 v19）：base rig 的 drawable id/slot/骨架/物理链与 v2.2 完全一致，
> 已安装 pack（v2.2 refs）无需重建，按本节规则兼容；旧 v2.1 refs 由运行时迁移兜底。
> v2.7.0 下架白色高领毛衣（资产 v21 / 页面 v24）：base rig 删除毛衣 drawable，其余部件/骨架/物理链不变；
> 旧 v2.1 refs 里的毛衣/裙子引用由运行时迁移映射到现有 hoodie-plaid 部件。

v2.2 起 base rig 为 cutout 分部件（`hoodie-plaid-torso/-skirt` 等），不再有 v2.1 的 generic
`bottom-plaid` / 单件上衣/袖 id（毛衣相关 id 已于 v2.7.0 随下架删除，仅保留在运行时迁移表旧键中）。兼容策略：

- **新 pack（v2.2.1 binder）**：`tools/diy/bind_layers.py` 的 pairing 从 base rig 的可用组合套装动态读取
  （v2.7.0 起优先 hoodie-plaid：top/coat/dress → hoodie-plaid 裙对；bottom → hoodie-plaid 上衣/分段袖），
  `pairingSource` 写入 pack 报告，不再写死 v2.1 id；legacy `sleeve` 槽位继续支持（DIY 自带袖层仍放 `sleeve` z60/61）。
- **旧 pack（v2.1 生成）**：runtime `addOutfitPack` 注册时调用
  `migrateDiyPackOutfits(outfits, scene.drawableById, ownIds, {category})`：
  缺失的 v2.1 base 引用按迁移表映射到现有部件（`bottom-plaid→hoodie-plaid-skirt/-skirt-under`、
  `bottom-pleated→hoodie-pleated-skirt/-skirt-under`、旧毛衣上衣→`hoodie-plaid-torso`、旧毛衣袖→
  `hoodie-plaid-sleeve-upper/fore × L/R`；`hoodie-body/hoodie-sleeve` 同样映射 hoodie-plaid 部件）；
  旧 dress/outfit pack 本来没有下装 → 按品类自动补 hoodie-plaid 裙对（避免光腿）；bottom pack 可自动补 hoodie-plaid 上衣/袖；
  目标均缺失则安全置空并记 `unmapped`（不抛错、不改 pack 原对象），`getState().look.slots` 语义不变。
- 迁移只在运行时内存中生效，不写回 pack/registry，也不退回 v2.1 资产（v2.1 人物资产已删除）。
- **v2.4 骨架前缀兼容**：`normalizeDiyPack(pack, { bones, boneNames })` 允许 `packBones ≤ sceneBones`（旧 59 骨 pack
  可在 v2.4 的 65 骨场景使用，返回 `legacyBones=true`；v2.4 binder 新 pack 为 65 骨并写入 `base.boneNames`）；`packBones > sceneBones`/缺失/骨名前缀不一致
  仍拒绝；`lib/diy-pipeline.js` 的 qa 从 base rig 动态读骨架（不再写死 59），registry 条目记录
  `skeleton:{packBones,baseBones,legacy}`；binder 输出 `base.boneNames/skeletonVersion`。
- E2E 断言（v2.2.1 起）：选中任一 DIY pack 后 `look.slots.bottom` 非空且 bottom drawable 在 active；
  旧 pack ×3 + 新 pack ×1 均验证（`.scratch/cutout/diy-v22/`）。

## 6. 兼容与限制

- `formatVersion` 只升不降；S3 遇到未知版本 → 拒绝并回退 static。未知字段忽略。
- S3 仅 `chibi`；girl 需 base rig 同构后再支持。
- 真机性能/兼容未测（所有数字为 headless 服务器侧）。
- 安全检查：路径白名单 + 同源 + `x-feiyu-diy` 头；默认关闭时路由 404；key 不经过页面/不落日志。
