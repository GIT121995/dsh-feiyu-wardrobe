# tools/art · 2.5D 资产构建管线（W0 入仓）

> 大肥鱼衣橱的 production 2.5D 资产（`docs/dress-up/art/2d5/{chibi,girl}/`）由本目录脚本
> 从**冻结的源素材包**确定性重建。W0 之前这套管线只存在于 `.scratch/` 工作目录（M2/M4/P2/T1/T2/T3
> 各阶段交付），仓库里只有半套 `tools/build_2d5.py`；W0-a 把 builder 参数化入仓、源素材打包走
> GitHub Release asset，并加构建确定性测试。
>
> - 产出资产：v3.2.0 口径（chibi 48 drawables / girl 49，65 骨，lo/hi 各 **5 页懒加载图集**）。
> - 源素材 **132.9MB raw / tarball 89.8MB**，**不入 git**，走 GitHub Release（tag `assets-v2`）的 `assets-src-v2.tar.zst`。
> - 运行时零依赖；构建依赖见 `tools/requirements.txt`（python3 + numpy + opencv-python-headless + Pillow）。

## 目录

```
tools/art/
├── build_prod.py        # 主 builder：源素材 → 2 身形 cutout source rig + 纹理 → 调 build_2d5.py
├── build_2d5.py         # 图集打包器：best-fit 图集 + UV 重映射 + 定点化 + pixelEqual 校验（M3b 多页版）
├── vendor/
│   └── overlay_hands.py # T2 手部精修 overlay（vendored；hands 根由参数传入）
├── pack-sources.mjs     # 源素材树 → assets-src-v2.tar.zst + manifest.json + sources.json + VERSION + SHA256SUMS
├── fetch-sources.mjs    # 下载/解包 assets-src-v2.tar.zst（sha256 + manifest 逐文件校验）→ .cache/assets-src/
└── README.md
```

## 快速开始（复现 v2.5.0 资产）

```bash
# 1) 取源素材（下载 ~90MB / 解包 132.9MB → .cache/assets-src/，gitignored；或 --from <已有 tar.zst>）
npm run fetch:sources

# 2) 构建（→ tools/art/dist/{chibi,girl}/，gitignored；中间产物在 .cache/build/）
npm run build:assets

# 3) 构建契约 + 与官方 dist 逐字节比对
npm run verify:full
```

> 源不在默认位置（CI 缓存 / 本地已解包到别处）时不需要仓库内 `.cache/`，直接传 `--src`：
>
> ```bash
> npm run build:assets -- --src /path/to/assets-src --workdir /tmp/feiyu-build --outdir /tmp/feiyu-dist
> FEIYU_ASSETS_SRC=/path/to/assets-src FEIYU_ASSET_VERIFY_DIST=1 npm test
> ```

高 DPI/真机视觉门禁见 `docs/VISUAL-QA.md` 与 `npm run visual:qa`；发版检查见 `npm run release:prepare`。

## 源素材包（assets-src-v4）

官方包：GitHub Release `assets-v4` 的 `assets-src-v4.tar.zst`（`https://github.com/GIT121995/dsh-feiyu-wardrobe/releases/download/assets-v4/assets-src-v4.tar.zst`，sha256 `01047896…4da7e`；v3.0.1 artfix 后）。

| 包内路径 | 内容 | 来源（历史工程） |
|---|---|---|
| `art/` | M2 cutout 分件：`MANIFEST.json` + `base/{shape}/`（parts-index/clean-body/parts）+ `garments/{shape}/{6 组合}/` | `.scratch/cutout/art` |
| `m4/` | production 模板：`dist/{shape}/{rig.json, tex/hair-*, tex/face-*}` + `assets/art-v2/{shape}/`（body/arms/hair 层 + `layers/` 6 个服装 source） | `.scratch/m4` |
| `prod/` | P3 冻结构建输入：`seamfill-{shape}.npz` + `ref/{shape}_{combo}_rgba.png`（rest 颜色移植参考） | `.scratch/p5/rig/assets` |
| `hands/` | T2 手部精修：`overlay-1x/{shape}.png`、`masks/hands-mask-{shape}.png`、`refined2x/{shape}/hand-tex.png`（实验 2x） | `.scratch/p5/hands` |
| `feet/` | P2 脚部精修：`{shape}/feet.png`、`{shape}/masks/feet.png` | `.scratch/polish2/hands-feet` |
| `VERSION` | 源包版本：`assets-v2` | 由 pack 脚本写入 |
| `sources.json` | 上述布局映射（审计/升级参考） | 由 pack 脚本写入 |
| `manifest.json` | payload 文件清单（相对路径/大小/sha256），fetch 侧逐文件校验 | 由 pack 脚本写入 |

- **当前 v2 包（v2.7.0 下架毛衣后）**：**271 files / 132,915,144 B（132.9MB）raw**；`tar --sort=name --mtime=@0 --pax-option=delete=atime,delete=ctime`
  + `zstd -19` → **89,799,309 B（89.8MB，ratio 0.68）**，sha256 `2e6a003bd4b4695e7550142dbed2d1487d70e8a8c7d0f3110384e791ec3dc934`
  （见 `.scratch/p7/SHA256SUMS`）。同一 staging 树重复打包 / 从已解包树回炉打包均得到相同 sha256（确定性）。
  `fetch-sources.mjs` 内置该 sha256 固定值（发布者也可用 `FEIYU_ASSETS_SRC_SHA256` / `--sha256` 覆盖）。
- **源包不是**历史工程全量快照：只冻结 `build_prod.py` 实际读取的文件（排除 M2 `work/qa/masks`、M4 未引用 webp/layer、
  T2 `work/`、P3 中间 `tex/` 等可由构建再生的产物）。
- **升级源包**（下一次资产改动）：从新的 M2/M4/交付目录重新 staging（本仓库历史的 staging 映射见
  `.scratch/p7/pipeline/stage-sources.mjs` 与 `.scratch/p7/pipeline/REPORT.md`）→ `npm run pack:sources -- --version assets-v2`
  → 上传新 Release asset → 更新 `fetch-sources.mjs` 的 `PINNED_SHA256`/URL → 重新基线 `docs/dress-up/art/2d5`。

## `build_prod.py` 命令与 flag

```bash
python3 tools/art/build_prod.py [--shape chibi|girl|both] [--build-atlas]
    [--src <源根>] [--workdir <中间产物>] [--outdir <dist 根>] [--tool <build_2d5 路径>]
    [--generator-id <provenance>] [--source-note <provenance>]
    [--skip-hair-split] [--skip-hands] [--hands-2x] [--hands-dir <T2 根>]
```

| flag | 默认 | 说明 |
|---|---|---|
| `--shape` | `both` | 身形选择 |
| `--build-atlas` | off | 只写 source rig/纹理；开启后再跑 `build_2d5.py` 产出运行时 dist |
| `--src` | `<repo>/.cache/assets-src` | 源包根（布局见上表） |
| `--workdir` | `<repo>/.cache/build` | 中间产物根（`assets/tex/{shape}`、`assets/{shape}-cutout.feiyu.json`、`assets/build-stats.json`） |
| `--outdir` | `<repo>/tools/art/dist` | dist 输出根（`<outdir>/{chibi,girl}/{rig.json,atlas.webp,atlas-2.webp…,build-report.json}`） |
| `--tool` | `tools/art/build_2d5.py` | 图集打包器路径 |
| `--master-config` | 无 | v2.6 素体母版重贴图契约（可重复；身形取自 config 的 `shape`）。见下文「v2.6 母版重贴图」 |
| `--clean-garment-skin` | off | v2.6.1：删除服装纹理里**烘焙的素体皮肤**（女仆装"四只手"根因）。alpha-only、不重建 mesh（rig.json 逐字节不变）。见下文「服装修复」 |
| `--generator-id` | `cutout/prod/tools/build_prod.py` | 写进 rig.json 的 provenance 字符串；**保持历史值**才能与 v2.5.0 官方 dist 逐字节一致 |
| `--source-note` | `M2 cutout art（production，源工程不入库）` | 写进 rig.json `cutout.source` 的 provenance 字符串（同上） |
| `--skip-hair-split` | off | T1 拆发关闭（v2.4.0 hair 口径，QA 归因用） |
| `--skip-hands` | off | T2 手部 overlay 关闭（QA 归因用） |
| `--hands-2x` | off | 实验：T2 2x 手部纹理（未进发布，A2 变体） |
| `--hands-dir` | `<src>/hands` | T2 交付根覆盖 |

`build_2d5.py` 单独使用：

```bash
python3 tools/art/build_2d5.py --rig <source rig.json> --texdir <纹理目录> \
    --out <dist 根> --shape chibi|girl [--trim-alpha] [--max-width 4096] [--max-side 4096] [--pad 1]
```

- 单页：`rig.atlas` + `atlas.webp`；多页（≤6）：`rig.atlases` + `drawables[].atlas`。
  v3.2.0 起 lo/hi 各 **5 页懒加载套装页**（第 0 页必须 base）：`base`（不被任何 outfit
  slot 引用的 drawable）、`maid`、`hoodie-plaid`、`hoodie-pleated`、`sailor-plaid`；
  文件名依次 `atlas.webp` / `atlas-2.webp` … `atlas-5.webp`。旧输入（无 `atlasPages` 且
  drawable 无 `atlas`）仍走历史单页路径，输出形状不变。
- lossless WebP RGBA、逐 drawable 透明 padding、UV 重映射到图集空间、定点化（positions 0.01px / uvs 1e-5 / weights 1e-4）。
- 默认 `--out docs/dress-up/art/2d5`（独立使用时；builder 会显式传 `--out`）。
- 校验失败退出码 1；**不要手改产物**，改源/脚本后重跑。

## v3.2.0 懒加载套装页（5 页图集，方案 C）

`build_prod.py` 在写 lo source rig 前按 `rig.outfits` 引用计算 `rig.atlasPages`，`build_2d5.py`
据此逐页打包（hi tier 用同一分组，base 页放 2x，套装页放 1x）：

| idx | id | file | lo 内容 | hi 内容 |
|---|---|---|---|---|
| 0 | `base` | `atlas.webp` | 所有非 outfit drawable | hi_ids（2x body/hair/face/tail）+ 常驻 1x `seam-fill` |
| 1 | `maid` | `atlas-2.webp` | `outfits.maid` 引用的 drawable | 同套 1x 服装整层（来自 lo 纹理） |
| 2 | `hoodie-plaid` | `atlas-3.webp` | 同上 | 同上 |
| 3 | `hoodie-pleated` | `atlas-4.webp` | 同上 | 同上 |
| 4 | `sailor-plaid` | `atlas-5.webp` | 同上 | 同上 |

- 分组**不看源包版本**：v3 整层路径（每套 2 个整层 drawable）与旧分件路径（每套 6–9 个分件）都按
  `outfits[combo]` 的服装 slot 引用归类；每个 drawable 恰好归属一页（构建期断言，违反直接退出码 1）。
- `seam-fill` 不被任何 outfit 引用且必须常驻（素体填充），归 base 页；hi base 页因此含 1 个 1x 图块。
- 页数上限 `MAX_PAGES=6`（`build_2d5.py`）；增加/调整套装顺序要同步 `LAZY_OUTFIT_COMBOS`、
  runtime `MAX_ATLASES` 与 `index.html`/client-config preload。

## v3.2.0 rig 二进化（rig.bin 二进制 rig）

`build_2d5.py` 在写 `rig.json` 后调用同目录 `rig_binary.py::encode_rig()` 生成 `rig.bin`，
再用 Node `zlib.brotliCompressSync`（q11）预压缩出 `rig.bin.br`（Node 不可用时告警跳过，
静态服务器动态 brotli 兜底）：

| 产物 | 用途 | chibi 实测 |
|---|---|---|
| `rig.json` | 工具/QA/运行时 JSON 回退（内容不变） | 1,658,242B / gzip ≈285KiB |
| `rig.bin` | 运行时实际加载（header JSON + flat-f32 typed array 段） | 1,005,272B（raw 60.6% of JSON） |
| `rig.bin.br` | 构建期 brotli q11 预压缩（首屏直接发） | 135,914B（≈133KiB） |

- 格式规范：`.scratch/p1-320/RIG-BINARY.md`；解码器 `docs/dress-up/rig-binary.js`（浏览器+Node 通用，
  零拷贝 flat typed array；JSON 回退 `toRuntimeRig` 归一成同一形状）。
- **确定性**：`rig.bin` 双跑 md5 一致；`.br` 用语义校验（brotli 解压 == `rig.bin`，避免 Node/libbrotli
  版本差异造成跨机假红）。`build-report.json` 的 `rig.binary = {bytes, sha256, gzipBytes, brotliBytes}` 记录实际产物。
- **官方 dist 比对**：`verify:full` 同时校验 `rig.json` + `rig.bin` + 全部 5 页 atlas 逐字节一致。
- 已知限制：`.br` 依赖构建机 Node 的 brotli 实现（本机 Node v22.23.2）；跨机重建只需语义等价即可。

## v2.6 母版重贴图（`--master-config`）

v2.6.0「素体 B」= 用 art 阶段产出的单一素体母版（`master-1x.png`，675×1200，与画布 identity 对齐）
重写 **body 部件纹理的 RGB**，alpha/几何/骨骼/槽位/drawable 数全部不变：

```bash
python3 tools/art/build_prod.py --build-atlas \
    --master-config <art-girl>/retexture.json --master-config <art-chibi>/retexture.json
```

- 契约来源：`v26-art-{girl,chibi}/retexture.json`（两种格式都支持：girl `feiyu-master-retexture-v1`
  的 `master.1x` + `drawables[].id` + `retextureRule.visibleMask`；chibi 的 `master.file`(2x) + `draws[]`）。
- 重贴范围：仅 body-slot drawables：`body-head / body-torso / leg-L / leg-R / arm-upper-L/R /
  arm-fore-L/R / hand-L/R`；tail、seam-fill、hair-*、face-*、服装 drawable **不重贴**。
- 取色：1x 母版 → 纹理同坐标 identity；2x 母版 → 1x 纹理用双线性半像素采样
  `((x+0.5)*2-0.5)`（与 art POC 一致）；2x 纹理（`--hands-2x` 实验）按半分辨率采样。
  重贴后对每张纹理重做 `color_bleed`（母版只有 8px 外扩），保持边缘/mipmap 行为。
- **顺序（关键）**：在 T1 拆发（`finalize_girl_hair`）**之后**、服装 seam-extend / rest 颜色移植**之前**执行。
  T1 的 `split_girl_back_hair` 用 RGB 蓝色判据找烘焙发、`finalize_girl_hair` 把手臂发岛 RGB 复制进
  `hair-arm-girl`；先重贴会破坏这些源色（发岛变肤色/丢失）。重贴前所有 body RGB 后处理
  （feet/hands overlay、T1 补画）都已完成，母版 RGB 最终覆盖，保证 rest 合成与母版一致；
  之后只剩服装/网格步骤，不写 body RGB。
- **可见像素策略**：girl 配置带 `visibleMask`（`body-visible-rest-1x.png`）→ 只重写静置可见像素，
  发/脸遮住的隐藏区保留 v2.5 值（±25° 姿态行为不回归）；chibi 无 mask → 全量重写
  （chibi 母版在 allowed-change 之外 = v2.5 基像素，rest 等价）。
- build-stats 记录 `stats['master']`（config 路径/母版尺寸/visibleOnly/changedPx/perDrawable），便于 QA 对账。

## v2.6.1 服装烘焙皮肤清理（`--clean-garment-skin`）

**Bug**：M2 的服装件是从整图切出来的，`maid-sleeve-fore-L/R` 等纹理的隐藏填充区里烘焙了**手的副本**
（`*-skirt*`/`apron` 等同理会烘焙腿/身体皮肤副本）。运行时 hand(z65) + sleeveFore(z62) 叠加 → 每侧 2 只手
（"四只手"，v2.5 起历史 bug；副本分散在多个服装层，只清袖子会从裙子里透出来）。

**修复（v3，v2.6.1 fix2）**：`--clean-garment-skin` 对服装 drawable（slot ∈ topUnder/bottom/topBody/
sleeve/sleeveUpper/sleeveFore/collar）做**分类处理**（早期"全删 alpha"版本会把被手遮住的白色隐藏垫层
暴露成白斑）：

- **布料内部**手形像素（到最近非删除布料像素距离 ≤6px）→ **不删 alpha，RGB 补画为布料**：
  8px 窗口内「非皮肤、非白」布料主色均值（不足则用 `cv2.distanceTransformWithLabels` 最近邻布料色），
  2px 高斯平滑 + 边界 1px 羽化；保证不露白、不留手形；
- **伸出布料轮廓的凸出部分**（距离 >6px）→ 删除 alpha（+1px 羽化 + 旧 alpha bbox 钉住，rig.json 不变）；
- 布料保护/防洞逻辑保留（白布/蓝布不删、per-outfit 覆盖守卫）；
- 统计：build-stats `stats['garmentSkinClean']` = interiorRepaintPx / protrudingRemovedPx / droppedNoCoverPx / perDrawable。

旧版流程描述（供对照）：`--clean-garment-skin` 对服装 drawable 删除烘焙皮肤 alpha：

- 分类器：暖肤色 `R-B>=10, R-G>=2, G-B>=1, R>170` ∩ 底层 body 皮肤 alpha（`tail`/`seam-fill` 不算）；
  白布（`sat<=8 & L>200`，袖口白边 sat≈3.5）与蓝/藏青布（`B-R>20`）**永不删除**；
- 深色轮廓线：手部的暗线稿通过形态学 close + 连通域并入 hand blob（面积≥80、宽高≥12），
  删除时 blob 外扩 2px 捕获轮廓/AA 晕；只作用于服装 alpha>0；
- **防洞**：两遍计算，删除后该像素必须仍被至少一个「自己不在该处删除」的 drawable 覆盖，否则放弃删除
  → 静置洋红洞保持 0；
- 删除区 alpha 边缘 1px 羽化（ring alpha×0.5）；
- **不重建 mesh**：只改纹理 alpha，rig.json/骨架/顶点/UV 全部逐字节不变；build-stats 记录
  `stats['garmentSkinClean']`（removedPx/droppedNoCoverPx/perDrawable）。

v2.6.1 重建（两身形 + 母版 v3.1 + 服装清理）：

```bash
python3 tools/art/build_prod.py --build-atlas --clean-garment-skin \
    --src .cache/assets-src \
    --master-config <src>/master/girl/config.json \
    --master-config <src>/master/chibi/config.json
```

## 确定性与验收口径

- 同源双跑：`rig.json` + **全部 atlas 页**（`atlas.webp`、`atlas-2…5.webp`）**md5 逐字节一致**
  （无时间戳/随机序；图集打包与 JSON 序列化固定）。
- 与官方 `docs/dress-up/art/2d5/{chibi,girl}` 比对：`rig.json` + **全部 atlas 页** **逐字节一致**；
  `build-report.json` 允许差异（v2.5 实测三文件全一致；字段级差异说明见 `.scratch/p7/pipeline/REPORT.md`）。
  rig.json 里两个 provenance 字符串（`generator`、`cutout.source`）是**资产契约的一部分**，默认保持历史值，
  仅换资产口径时才用 `--generator-id/--source-note` 覆盖。
- `tests/asset-build.test.mjs`：`npm test` 在源缺失时 skip（保持 `verify` 快速）；`verify:full` 在源就绪时做
  manifest 契约 + 双跑确定性 + 官方 dist md5 比对。图集必须 `pixelEqual=true`（逐页）。
- v3.2.0 5 页契约（lo/hi 通用，`tests/asset-build.test.mjs` 守）：页序/文件名固定；每个 drawable
  恰好归属一页（`drawable.atlas`=页 id、`drawable.texture`=页文件、`atlasRect`/`mesh.uvs` 相对该页）；
  `rig.atlases`=5 页、`rig.atlas`=atlases[0]、`m3.multiAtlas=true, m3.atlasPages=5`、`product.pages=5`。

## 已知限制（诚实）

- **源包体积**：89.8MB tarball / 132.9MB 解包（zstd -19 实测 ratio 0.68）→ 不入 git，走 GitHub Release；无源时无法构建。
- **构建耗时**：两身形 `--build-atlas` ≈ 4.5–5 分钟（2 核，headless，无 GPU；本机口径）。
- **构建环境**：python3 + numpy/opencv/Pillow；图集编码依赖 Pillow 的 lossless WebP（Pillow/libwebp 版本理论上可能影响
  编码字节；v2.5 基线与本机 Pillow 10.2.0 对齐）。生产环境固定依赖版本（`tools/requirements.txt` 只给下限）。
- **单页 4096 限制**：单张图集 ≤4096×4096；v3.2.0 起 production 为 **5 页懒加载套装页**
  （base + 4 套装），不再把所有 drawable 塞进单页。页数上限 `MAX_PAGES=6`（build_2d5）；
  增加套装时须同步页序表（`build_prod.LAZY_OUTFIT_COMBOS`）与运行时 `MAX_ATLASES`。
- **实验开关不保证基线一致**：`--skip-hair-split/--skip-hands/--hands-2x` 产出的 A/C/A2 变体是 QA/归因产物，
  不代表官方 dist。
- **2x 手部**：T2 的 refined2x 数据保留在源包中（实验），默认构建不使用；收益未证实。
- **历史 `.scratch` 工具**：T1/T2/T3 交付脚本（`.scratch/p5/*/tools`、`.scratch/cutout/prod/tools`）不再作为生产入口；
  本目录文件是合并后的唯一事实来源。


## v2.6 素体母版重贴图（`--master-config`）

v2.6 的 body RGB 来自「素体母版」而非历史部件纹理。源包 v2 起新增 `master/` 目录
（`master/{shape}/config.json` + 母版 + girl 可见掩膜）。重建 v2.6 dist：

```bash
npm run fetch:sources        # assets-src-v2
npm run build:assets:v26     # = build_prod.py --build-atlas + 两个 --master-config
# 或手动：
python3 tools/art/build_prod.py --build-atlas --src .cache/assets-src \
  --master-config .cache/assets-src/master/girl/config.json \
  --master-config .cache/assets-src/master/chibi/config.json
```

验收：重建的 `atlas.webp` + `atlas-2…5.webp` 与 `rig.json` 的 md5 应与仓库
`docs/dress-up/art/2d5/{shape}/` 对应文件一致（v3.2.0 起 rig.json 含 `atlases`/`drawables[].atlas`，
不再是 v2.6 的单页形状）；双跑确定性由 `npm run verify:full` 校验。
v2.5 及以前的重建 = 不传 `--master-config`（历史源包 assets-v1 亦可）。

## v3.1.0 artfix（源包一次性修复；QA 内部代号 v3.0.1）

v3.1.0（内部代号 v3.0.1）在**源包层**修复两类像素缺陷（不重建 mesh、alpha 不变）：

```bash
npm run artfix:v301     # 仅 assets-v3 及更早源包需要；assets-v4 起源包已包含修复
node --test tests/neck-art.test.mjs tests/garment-residue.test.mjs
```

- `art/body-fix/<shape>/neck-overlay.png`：收窄到真实颈轮廓（core=0.90/0.92×素体颈宽、feather 8px），girl 提亮 +8 L 并软化下颌线；元数据写 `neck-overlay.json::v301`。
- `art/garments/<shape>/<combo>/layers/{top,skirt}.png`：手/前臂掩罩内旧渲染残留（皮肤/手描边/手影）清除（镜像补色→块匹配→中性化）。
- 脚本：`tools/art/v301_artfix.py`（对 pristine 源包跑一次；检测到 `v301` 标记会跳过）。
