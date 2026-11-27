# 4.0 Phase 1 美术 brief · 两套验证穿搭资产规格

> 状态：**Phase 1 规格定稿（2026-11-27）· 资产未生成**。本文件是 4.0 首批服装/配饰的**可执行资产规格书**：
> 画什么、怎么生成/后处理、怎么验收、怎么走 G1。**正式资产不在本任务产出**；每件必须 G1 用户确认后才能进源包。
> 权威链路：槽位/页/锚定契约 = [`slot-registry.json`](slot-registry.json) + [SLOT-REGISTRY.md](SLOT-REGISTRY.md)；
> 决策 = [ADR-4.0-SLOTS.md](ADR-4.0-SLOTS.md)；执行计划 = [PLAN-4.0-SLOTS.md](../PLAN-4.0-SLOTS.md) §7/§8/§11/§12；
> 设计语言 = [DESIGN.md](DESIGN.md)；整层服装契约 = [2.5D-RUNTIME.md](2.5D-RUNTIME.md) §6.6；
> 耳饰锚定证据 = `.scratch/p0-slot-spike/REPORT.md` + `out/RESULTS.md`（T7–T20）。
> 当前分支 `feat/4.0-phase1-art`（Lead 管理）；**本文件不生成资产、不改 manifest/代码**。

## 0. 交付范围速览

| # | item id | 槽位 | z | 页（4.0 全量） | 穿搭 | 生成方式 | G1 |
|---|---|---|---:|---|---|---|---|
| A1 | `commute-top`（drawable）/ outfit `commute` | topBody（整层） | 64 | 5 `atlas-6.webp` | 日常通勤 | AI（Seedream，待批准） | ✅ |
| A2 | `commute-skirt`（drawable）/ outfit `commute` | bottom（整层） | 30 | 5 `atlas-6.webp` | 日常通勤 | AI（Seedream，待批准） | ✅ |
| B1 | `acc-loafer-navy` | shoes | 20 | 6 `atlas-7.webp` | 日常通勤 | 矢量参数化 | ✅ |
| B2 | `acc-sock-white` | socks | 18 | 7 `atlas-8.webp` | 日常通勤 | 矢量参数化 | ✅ |
| B3 | `acc-earring-pearl` | earring | 68 | 9 `atlas-10.webp` | 日常通勤 | 矢量参数化 | ✅ |
| B4 | `acc-necklace-fine` | necklace | 64.5 | 8 `atlas-9.webp` | 日常通勤 | 矢量参数化 | ✅ |
| B5 | `acc-sneaker-canvas` | shoes | 20 | 6 `atlas-7.webp` | 水手运动 | 矢量参数化 | ✅ |
| B6 | `acc-headband` | headwear | 72 | 10 `atlas-11.webp` | 水手运动 | 矢量参数化 | ✅ |
| B7 | `acc-whale-charm` | handheld | 66 | 11 `atlas-12.webp` | 水手运动 | 矢量参数化 | ✅ |

- 日常通勤 = **1 套 pre-composed combo `commute`**（新白衬衫 + 新藏青及膝裙作为一套组合资产出**第 5 个 combo 页**，
  不做上衣×下装交叉组合页；见 SLOT-REGISTRY §1.3/§4）。
- 水手运动 = **复用现有 `sailor-plaid` combo**（页 4）+ 新配饰（帆布鞋/发带/手持），不新增服装页。
- 4.0 全量页序：base(0) → maid(1) → hoodie-plaid(2) → hoodie-pleated(3) → sailor-plaid(4) → **commute(5)** →
  shoes(6) → socks(7) → necklace(8) → earring(9) → headwear(10) → handheld(11)（`maxPages=12` 用满，无空闲页）。
- 首屏页集合：日常通勤 `[0,5,6,7,8,9]`；水手运动 `[0,4,6,10,11]`（页并集规则见 SLOT-REGISTRY §4.2）。

## 1. 总则（所有资产必须遵守）

### 1.1 内容基调（最高优先，用户已批准）

- 保守、日常、可识别「大肥鱼」：**长袖 / 有领 / 及膝以上长度**；**禁止**露肩露背、蕾丝抹胸、超短裙、
  公主大蓬蓬裙、机甲战斗装、纯性感路线（DESIGN.md §3.3/§3.4）。
- **短脖子 chibi 禁高领/紧口（D-017 教训，硬红线）**：commute 白衬衫必须**开领/小翻领**，领口不得贴住或遮住
  chibi 颈根；任何领部元素不得覆盖露颈区（视觉门禁 neck 2x 区域 + `QA-REGISTRY` D-017/D-018/D-019）。
- 必须露：**鲸鱼尾巴、鲸鱼耳鳍、头顶呆毛**（DESIGN.md §3.2）。所有新层不得遮住这三处：
  裙层不得覆盖尾鳍可见区（沿用现有 maid/hoodie 裙的轮廓关系）；上衣/配饰不得遮耳鳍；发带不得盖呆毛根。
- 台词/信息条文案沿用现有克制口径（陪伴/吃饭/日常），不得有身体评价。

### 1.2 画布 / 分辨率 / 格式（硬契约）

| 项 | lo（1x） | hi（2x，4.0 硬需求） |
|---|---|---|
| 画布 | **675×1200**（与角色 canvas 完全对齐） | **1350×2400** |
| 格式 | PNG RGBA（直通 alpha，**不预乘**） | 同左（真 2x，**禁止 lo 的 Lanczos 放大**） |
| 背景 | 全透明；不得烘焙白底/棋盘格/文字/水印 | 同左 |
| trim | **不做**：alpha bbox trim + UV 重映射由 `tools/art/build_2d5.py` 自动完成 | 同左 |
| 线稿/AA | 1x 线宽 ≥1.5px（细线会糊）；AA 边 1–2px | 2x 线宽 2–3px |
| 透明度 | alpha 只在角色/服装轮廓内有值；轮廓外必须 0（不留半透明阴影/雾） | 同左 |

- 服装为 **v3 paper-doll 整层**（每套 2 个整层 drawable：`{combo}-top` z64 / `{combo}-skirt` z30，
  单张全画布纹理 + 单网格）；配饰为 **整层配饰 drawable**（每个 item 通常 1 个 drawable，单侧资产 + 运行时镜像）。
- **不得重画素体/脸/头发/耳鳍/尾巴**；不得把皮肤/手/头发像素烘进服装层（`--clean-garment-skin` 类清理是兜底，
  不是许可）；不得改角色比例/姿势（所有层与现有 production canvas 坐标对齐）。
- 产线口径：源包只冻结构建真正读取的文件；新增资产走 **assets-v5 源包**（`npm run pack:sources -- --version assets-v5`），
  构建产物（rig/图集/rig.bin）由 `build_prod.py` + `build_2d5.py` 确定性生成，**不要手改产物**。
- **构建契约变化（Phase 2，本 brief 的 2x 交付物就是给它准备的输入）**：v3.2.1 的 hi tier 服装/配饰仍保持 1x
  （`build_hi_tier` 只把 body/hair/face/tail 做 2x）；4.0 要求 hi 的 outfit/accessory 页也 2x
  （SLOT-REGISTRY §7、ADR §6）。因此新增 `layers-2x/`、`layer-2x.png` 源约定 + build 扩槽位，
  Phase 2 实施；Phase 1 交付必须同时含真 2x 源。

### 1.3 配色公式（60/30/10，对齐 DESIGN.md §3.1）

| 角色 | 色 | 参考值（可微调，G1 定） |
|---|---|---|
| 60% 主色 | 米饭白 / 深海蓝 | 白衬衫 `#F8FAFC`（**不用纯白**，避免白底/白布 diff 退化）；藏青裙 `#1E3A8A` |
| 30% 辅色 | 藏青 / 白 | 阴影 `#E2E8F0`（白布）/ `#172554`（藏青）；高光 `#FFFFFF` / `#3B5BA8` |
| 10% 点缀 | 鱼粮金 / 少量粉 | `#F59E0B` / `#FBBF24`；粉仅节日/情绪色，4.0 首批不用或 ≤5% |

- 线稿统一深色：`#0F172A`/`#1E293B`；与现有 8 套 production 服装的平涂 + cel shading + 深色描边一致。
- 颜色变体（2–3 个/单品，矢量换色，零 API 成本）：首批每件先交付 **1 个主变体**；变体 id 用颜色后缀
  （如 `acc-loafer-navy`/`acc-loafer-black`），由同一矢量母版换色批量生成，不重复设计。

### 1.4 命名 / 落盘路径 / 元数据（源包 assets-v5）

```
art/garments/{shape}/commute/layers/top.png            # lo 675×1200 RGBA 全画布
art/garments/{shape}/commute/layers/skirt.png
art/garments/{shape}/commute/layers-2x/top.png         # 4.0 新增：hi 2x 1350×2400（真 2x）
art/garments/{shape}/commute/layers-2x/skirt.png
art/accessories/{shape}/{group}/{item}/layer.png       # lo 675×1200 RGBA，单侧资产（见各件）
art/accessories/{shape}/{group}/{item}/layer-2x.png    # hi 1350×2400 真 2x
art/accessories/{shape}/{group}/{item}/item.json       # 锚定/镜像/颜色/名称元数据（下）
```

- `{shape}` = `chibi` | `girl`；`{group}` = registry pagGroup（shoes/socks/necklace/earring/headwear/handheld）；
  `{item}` = 上表 item id；**每个 item 每身形各一套**（配饰位置/比例按身形分别作者化）。
- 图标：`docs/dress-up/art/icons/{item}.webp`（256×256 lossless WebP，透明底，由矢量母版导出；命名同 item id）。
- `item.json`（art 交付契约，Phase 2 build 读取后生成 `rig.items`，字段以 SLOT-REGISTRY §5.2 为准）：

```jsonc
{
  "format": "feiyu-art-item", "version": 1,
  "id": "acc-loafer-navy", "slot": "shoes", "group": "shoes", "z": 20,
  "name": "藏青乐福鞋", "desc": "通勤的白袜子好搭档。",
  "mirror": true, "mode": "pair",
  "source": "vector",                          // vector | ai
  "colors": ["navy"],                          // 本变体颜色名
  "anchor": {
    "socket": "footL/footR",                   // 与 registry socket 一致
    "geometryFrame": "canvas",                 // 全画布层按 675×1200 canvas 作者化
    "pivotCanvasL": [284.5, 1153.8],           // 美术作者化锚点（canvas 坐标，1x）
    "pivotCanvasR": [382.9, 1154.3],           // 成对/对称第二侧；pair 每侧各一
    "offsetL": [-17.39, 9.67],                 // 骨局部 px = R(-angle)·(pivot-base)
    "offsetR": [-21.28, -9.55]
  }
}
```

- **anchor 语义（Phase 0 spike 定稿，必须按此写）**：`offset` = **socket 骨局部 px**，
  世界坐标 = `bone.base + R(bone.angle) · offset`；几何默认 `geometryFrame:"canvas"`（运行时绕锚点旋转
  `R(θ_now − θ_bind)`）。**禁止把 canvas 偏移直接当 local**；换算公式 `offset = R(−angle) · (pivot − base)`
  （往返 0px 已验）。下文各件给的 anchor = **pivot canvas（美术作者化）+ 骨局部 offset（程序消费）** 两份。

### 1.5 组织与验收节奏

1. 所有产出先落 `.scratch/p1-art/`（staging，不进 git 源包）：`vector/`、`ai/`、`g1/`（contact sheet）、`provenance/`。
2. 每个批次出 **G1 contact sheet**（1x/2x、两身形、上身合成 + 单独 alpha）→ 用户 G1 → 通过项才复制进
   `tools/art` 源包 staging（assets-v5）→ 构建 → 资产级验收。
3. 未 G1 的资产不得进源包/不得进构建产物/不得升资产版本。

## 2. 单品 brief

> 每件字段：slot/z/page/socket·seat/mirror、画布尺寸/bbox、设计元素、色板、生成方式、后处理、验收要点、G1。
> 尺寸均为 **lo 675×1200 canvas px**（hi = ×2）；bbox 为参考区间，G1 抓帧后以实测为准（±8px 容差）。

### 2.1 日常通勤 combo `commute`（第 5 个 combo 页）

#### A1 `commute-top` — 白衬衫（topBody 整层，z64）

| 项 | 规格 |
|---|---|
| drawable/outfit | drawable `commute-top`（slot `topBody`，z 64）；`rig.outfits.commute.topBody = ["commute-top"]` |
| 页 | 第 5 combo 页（索引 5 / `atlas-6.webp`）；与 `commute-skirt` 同页（每套 outfit 一页） |
| bbox 目标 | chibi ≈ x[150,545] y[500,915]；girl ≈ x[120,565] y[330,800]（含袖；肩线对齐 `body-torso` rect 顶：chibi y588 / girl y429） |
| 下摆 | 至 hip 线：chibi y≈855±25、girl y≈735±25；与裙腰重叠 20–40px（视觉「塞进裙腰」，top z64 在裙 z30 之上） |
| 袖 | 长袖（保守基调）；袖口至腕：chibi y≈820–860、girl y≈665–705（手 z65 在袖上 → 手必须可见；不得画手/烘手）；可选「袖口盖到半手」藏手萌，G1 定 |
| 领 | **小翻领开领（V 形/敞口）**，领口最低点不得高于 chibi 颈根下 8px；**严禁高领/紧口**（D-017）；露颈区不得覆盖 |
| 设计元素 | 主体白衬衫（`#F8FAFC`，阴影 `#E2E8F0`，线稿 `#0F172A`）；前襟 4–5 颗鱼粮金小纽扣（≤8px）；可选左胸小鲸鱼刺绣（≤24×18px，深海蓝）/胸袋（≤40×36px，不破坏保守感）；袖口可加金色细边 |
| 生成 | **AI**（Seedream edit，参考=素体 + 现有 maid/hoodie 整层服装风格；需 G1+预算批准后执行，见 §3.2） |
| 后处理 | look→flatout `#808080` diff 成层 → alpha 清理/边缘 1–2px 羽化 → 去烘焙皮肤（手/臂/发）→ 2x 交付；trim 由 build_2d5 做 |
| 验收 | garment-hygiene：烘焙皮肤=0、非功能 alpha 孔洞=0；neck 2x 区域不新增遮挡/假脖（D-017/18/19）；肩线/袖口/下摆落点 ±8px；换下装（maid/sailor 裙）不穿模 |
| G1 | 必须（正反面/收腰/领型/刺绣样式） |

#### A2 `commute-skirt` — 藏青及膝裙（bottom 整层，z30）

| 项 | 规格 |
|---|---|
| drawable/outfit | drawable `commute-skirt`（slot `bottom`，z 30，physics `skirt`）；`rig.outfits.commute.bottom = ["commute-skirt"]` |
| 页 | 第 5 combo 页（`atlas-6.webp`） |
| 长度（保守基线） | **不得短于现有 production 裙**：chibi 裙摆 y ≥ 1062（maid-skirt rect bottom）；girl ≥ 947；目标 chibi y≈1062–1090、girl y≈947–975。腰线 y≈810–830（chibi）/690–710（girl），对齐 hips/腰线 |
| 版型/尺度 | A 字或微百褶；裙摆半宽 ≤190px（chibi）/≤175px（girl）；**不得大于现有裙横向尺度**，保证 whale tail 尾鳍从裙摆侧后方露出（尾 rect：chibi x[401,635] y[805,1165]；girl x[405,640] y[685,1012]；裙层不得在尾鳍可见区涂不透明） |
| 设计元素 | 藏青 `#1E3A8A`（阴影 `#172554`、高光 `#3B5BA8`、线稿 `#0F172A`）；腰头 2px 鱼粮金细线（`#F59E0B`，10% 点缀上限）；可选裙摆近处小鲸鱼刺绣（≤20px）；褶皱/省道用线稿表达，不做大面积渐变 |
| 生成 | **AI**（同 A1 流程；与 top 同一 look 一次生成后按腰线分割，见 §3.2） |
| 后处理 | 同 A1；分割腰线要平直（±3px），裙/上衣交界无杂边 |
| 验收 | 裙长/腰线/尾鳍露出（tail 可见像素 ≥ 现有 maid 同级）；裙摆不与腿/袜穿模；z30 下被 top 覆盖关系正确；物理（skirt sway）Phase 3 抓帧 |
| G1 | 必须（长度/版型/腰线/刺绣） |

- `rig.outfits.commute = { "name": "日常通勤", "topBody": ["commute-top"], "bottom": ["commute-skirt"] }`；
  4.0 默认造型（首屏口径）= commute + `shoes/socks/necklace/earring`（`rig.defaults.outfit` 切换在 Phase 2 接线，Phase 1 不改 manifest）。
- 这两个 drawable 让 combo 页成为**第 5 个 combo 页**（不生成上衣×下装交叉组合页；任意混搭 = 运行期页并集）。

### 2.2 配饰（7 件；单侧资产 + 运行时镜像，几何朝向 `geometryFrame="canvas"`）

> 配饰锚点参考：**耳饰为 Phase 0 spike 已验证值**（registry `rules.anchoring.earringAnchors`）；
> 其余 5 槽为 spike `out/RESULTS.md` T20 的**候选锚点**（顶点加权质心），需美术在交付时微调 + G1 确认。
> 所有 `layer.png` 都是**全画布 675×1200**，只画一侧（左），另一侧由运行时按镜像模式生成；2x 同构。

#### B1 `acc-loafer-navy` — 藏青乐福鞋（shoes）

| 项 | 规格 |
|---|---|
| slot/页 | shoes / z20 / 第 6 页（索引 6 / `atlas-7.webp`）；`mirror:true`，pair |
| 单只尺寸 | chibi ≈95–115 × 42–55px；girl ≈85–105 × 38–50px；贴脚背/脚踝（foot 骨区），鞋口不高于踝（chibi y≥1128、girl y≥1120），鞋头不越出 leg alpha 轮廓 >3px |
| 设计 | 藏青皮面（`#1E3A8A`/`#172554`/`#3B5BA8`）+ 横带 + 鱼粮金小扣（≤8×6px）+ 白/奶白鞋底 1–2px + 深色线稿；不画脚/皮肤 |
| 锚点（候选） | chibi pivot L(284.5,1153.8) → 骨局部 `[-17.39,9.67]`；girl pivot L(310.3,1154.2) → `[-20.54,34.39]`（footL，angle −80°）。右鞋由成对骨镜像（轴=成对骨中点，chibi 337 / girl 341；**不得假设画布中线 337.5**）；若左右美术不对称 >2px，用 `offsetR` 按侧覆盖 |
| 生成 | 矢量参数化（几何+平涂+线稿；2x 直接渲染 1350×2400） |
| 变体 | navy（默认）/ black / brown（矢量换色） |
| 验收 | mirror 对偶位置/尺度对称（±2px）；脚部轮廓不越界；z20 在袜 z18 上、裙 z30 下（裙盖鞋口 ≤10px 合理）；2x shoes 区域 crop 无锯齿/无 1px 线 |
| G1 | 必须（鞋型/颜色/扣件/鞋底比例） |

#### B2 `acc-sock-white` — 白短袜（socks）

| 项 | 规格 |
|---|---|
| slot/页 | socks / z18 / 第 7 页（`atlas-8.webp`）；`mirror:true`，pair |
| 单只尺寸 | chibi ≈60–80 × 55–85px；girl ≈55–75 × 70–110px；袜口 y≈1040–1070（chibi）/995–1030（girl）；贴 shin alpha 轮廓（越界 ≤3px）；袜尖到踝、被鞋口覆盖 ≤10px |
| 设计 | 米饭白 `#F8FAFC`（阴影 `#E2E8F0`）+ 1px 罗纹/袜口细线（深蓝/金） + 可选小鲸鱼刺绣 ≤14px；不画腿/脚皮肤 |
| 锚点（候选） | chibi pivot L(282.2,1060.3) → 骨局部 `[-65.3,-1.8]`；girl pivot L(291.8,1013.2) → `[-108.2,5.8]`（shinL，angle −90°） |
| 生成/变体 | 矢量；white（默认）/ cream / navy |
| 验收 | z18 在鞋 z20 下、裙 z30 下（裙摆可盖袜口）；mirror 对偶；不遮尾；2x 无糊边 |
| G1 | 必须（袜长/袜口细节） |

#### B3 `acc-earring-pearl` — 珍珠耳钉（earring）

| 项 | 规格 |
|---|---|
| slot/页 | earring / z68 / 第 9 页（`atlas-10.webp`）；`mirror:true`，symmetry（单侧资产 + 运行时镜像对偶） |
| 几何 | **18×22px 矩形**（单侧宽度 ≤18px，用户口径）；锚点 = 矩形上边中点（spike 口径）；局部 x∈[-9,9]、y∈[0,22]；stud 6×6 金 `#FBBF24` + 珍珠 8–10px（`#FFFDF5`/`#F8FAFC`，高光 `#FFFFFF`，底阴影 `#CBD5E1`） |
| 落位约束 | 耳鳍底缘/耳翼露出带；**不遮眼（eye occlusion=0）**；**bangs(hairFront) 覆盖 <50%**（spike 实测候选位 ≤2%）；不得上移到刘海覆盖区 |
| 锚点（**已验证**，按侧美术锚定推荐值） | chibi：pivot L(75,445)/R(589,431)；骨局部 offset L`[95,−262.5]`/R`[109,251.5]`。girl：pivot L(148,317)/R(537,318)；offset L`[68,−189.5]`/R`[67,199.5]`。备选（对称内缩，完全在轮廓内）：chibi pivot (83.5,429)/(591.5,429)、offset L`[111,−254]`/R`[111,254]`；girl (164.5,309)/(510.5,309)、L`[76,−173]`/R`[76,173]` |
| anchor 语义 | 见 §1.4：offset = 骨局部 px；pivot canvas 换算 `offset = R(−angle)·(pivot−base)`（head.angle=−90°）；**禁止 canvas 偏移直接当 local**（会落到躯干） |
| 生成/变体 | 矢量（≤18px 小图 1x 清晰度优先，AI 不划算）；pearl（默认）/ gold / gold+pearl |
| 验收 | 2x ear 区域 crop：可见、不遮眼、不被刘海盖（bangs coverage <50%）；左右按侧锚定/镜像残差（chibi 美术不对称 Δx≈11px/Δy≈14px 是允许的，变换误差必须 0）；头 roll/yaw/pitch ±25° 相对脸锚点不漂移（Phase 2/3） |
| G1 | 必须（尺寸 16 vs 18 / 按侧 vs 对称内缩） |

#### B4 `acc-necklace-fine` — 细项链（necklace）

| 项 | 规格 |
|---|---|
| slot/页 | necklace / z64.5 / 第 8 页（`atlas-9.webp`）；单实例 |
| 尺寸 | chibi bbox ≈80–120 × 25–55px；girl ≈70–110 × 25–50px；链宽 ≤2px@1x（≥1.5px 可见）；吊坠（可选）≤12×14px；居中，链弧**落锁骨上缘**（chibi y≈585–640 / girl y≈440–480） |
| 约束 | **不得盖住露颈区（D-017）**：不进入颈区、不高于领口/不挂下巴；z64.5 在 topBody 64 上（压在衣身/领口上） |
| 设计 | 鱼粮金细链 `#FBBF24`（或珍珠白）+ 小珍珠/小鲸鱼吊坠（`#F8FAFC` + `#60A5FA`）；平涂 + 1px 深色描边 |
| 锚点（候选） | 单 socket `chest`：chibi pivot (337.5,591.3) → 骨局部 `[48.7,0]`；girl pivot (337.5,447.5) → `[52.5,0]`（chest，angle −90°） |
| 生成/变体 | 矢量；fine-gold（默认）/ fine-silver / pearl |
| 验收 | neck 2x region 不新增遮挡（像素断言，D-017/19）；居中 ±2px；与衬衫领口不冲突（不压领尖到看不清）；2x 链线不断/不粗 |
| G1 | 必须（吊坠样式/长度） |

#### B5 `acc-sneaker-canvas` — 帆布鞋（shoes，水手运动）

| 项 | 规格 |
|---|---|
| slot/页 | shoes / z20 / 第 6 页（`atlas-7.webp`，与乐福鞋同页组）；pair |
| 尺寸 | 同 B1（低帮帆布鞋，可略高帮 ≤8px；单只 chibi ≈95–115×45–60、girl ≈85–105×40–55） |
| 设计 | 白帆布 `#F8FAFC` + 藏青鞋头/鞋带 `#1E3A8A` + 金色鞋眼（≤4px）+ 白橡胶底；可选小鲸鱼小刺绣；不画脚 |
| 锚点（候选） | 同 B1 左/右 foot 骨；按侧可覆盖 |
| 生成/变体 | 矢量；white-navy（默认）/ white-red / black |
| 验收 | 同 B1；与水手服色板协调（白/深海蓝/金）；2x shoes 区域 |
| G1 | 必须（配色/鞋带/鞋头） |

#### B6 `acc-headband` — 发带（headwear，水手运动）

| 项 | 规格 |
|---|---|
| slot/页 | headwear / z72 / 第 10 页（`atlas-11.webp`）；单实例 |
| 尺寸 | chibi bbox ≈260–360 × 30–55px（横跨头顶）；girl ≈240–330 × 28–50px；带体沿头顶发际弧线（chibi y≈60–130 / girl y≈95–165），带宽 18–24px@1x |
| 约束 | **不得遮挡刘海/眼睛**（bangs/eye 区像素断言，同耳饰口径：遮挡 <50%、eye occlusion=0）；不得盖耳鳍/呆毛（呆毛根处留空或带体在其后）；z72 > hairFront 70（运行时在刘海之上 → 设计放在发际线/头顶，不覆盖刘海主体） |
| 设计 | 藏青 `#1E3A8A` 带体 + 白双边线/鱼粮金小鲸鱼刺绣（≤16px）；可选 深蓝/白/金 条纹（60/30/10） |
| 锚点（候选） | 单 socket `head`：chibi pivot (337.5,42) → 骨局部 `[498,0]`；girl pivot (337.5,74) → `[311,0]`（head，angle −90°） |
| 生成/变体 | 矢量；navy（默认）/ red / white |
| 验收 | head 2x 区域：不遮眼/刘海、不盖呆毛根、不盖耳鳍；与 commute/水手造型都兼容（可跨穿）；2x 无锯齿 |
| G1 | 必须（宽度/颜色/是否带鲸鱼耳鳍造型） |

#### B7 `acc-whale-charm` — 手持小鲸鱼挂件（handheld，水手运动）

| 项 | 规格 |
|---|---|
| slot/页 | handheld / z66 / 第 11 页（`atlas-12.webp`，全量最后一页）；单实例，socket `handR` |
| 尺寸 | chibi ≈70–110 × 90–140px；girl ≈60–100 × 80–130px；**允许越界出画布**（bbox 可超出 675×1200）；挂绳/连接点对齐 handR 掌中，鲸鱼垂在手侧下 |
| 设计 | 深海蓝鲸鱼 `#1E3A8A`/`#60A5FA` + 白肚 `#F8FAFC` + 金橙小鳍 `#F59E0B` + 金色挂绳 `#FBBF24`；平涂 + 深色描边；z66 在 hand 65 上（挂件画在手之上/挂绳穿手） |
| 锚点（候选） | 单 socket `handR`：chibi pivot (461,845.6) → 骨局部 `[10.65,0.06]`；girl pivot (466.5,711.6) → `[32.88,−7.05]`（handR，angle 84.3°/82.1°） |
| 生成/变体 | 矢量；blue（默认）/ pink / cream |
| 验收 | 右手握持位置正确（不换左手）；z66 在 hand 上；不遮脸/躯干关键区（渲染在身侧/下方）；wrist 2x 区域 crop；2x 无缺口 |
| G1 | 必须（尺寸/配色/挂绳） |

## 3. 生成与后处理

### 3.1 矢量参数化（配饰优先：B1–B7 —— 零 API 成本，先做）

- 理由：1x 下清晰（细线可控）、可批量颜色变体、2x 直接渲染无放大糊边、确定性可复现。
- 流程（由配饰矢量原型任务产出工具，本 brief 定交付规格）：
  1. 以 **2x canvas（1350×2400）** 为基准矢量绘制（线宽 2–3px@2x）；锚点按 §2 的 pivot 定位；
  2. 导出 2x PNG（1350×2400 RGBA）→ 确定性下采样到 lo（Lanczos/区域平均，记录算法）得到 675×1200；
  3. 校验：alpha 只在单侧轮廓内（对侧空）、bbox 与目标 ±8px、锚点=预期 pivot；
  4. 变体 = 同一个矢量母版换色（颜色表集中在脚本/JSON），不重复绘制；
  5. 记录 provenance（脚本路径/参数/版本，写 `.scratch/p1-art/provenance/{item}.json`）。
- 禁止：用 AI 放大 1x 矢量、手绘 1x 后 Lanczos 升 2x（4.0 2x 硬需求）。

### 3.2 AI 服装生成（A1/A2；**当前不执行，等用户 G1 + 预算批准**）

- 工具链：`/home/ubuntu/dsh/seedream_image_api.py`（火山方舟 Ark）；key 在 `~/.config/seedream/env`；
  **必须 `ARK_MODEL=doubao-seedream-5-0-flash-260915`**（pro 未开通）；默认 `--size 2K`；≈¥0.3/张；
  「肤色连体衣」等词会 400（内容审核），prompt 避开。
- 流程（每身形）：
  1. 参考图：素体全身（正面/三分之四）+ 现有 maid/hoodie 整层服装 style ref + 用户 G1 定的设计要点；
     prompt 复用 `.scratch/feiyu-gen/gen-outfit-concepts.py` 的 KEEP 约束（同角色/脸/发/耳鳍/尾/姿势/比例/白底平涂）。
  2. 生成「白衬衫+藏青及膝裙」look（2K）→ 同姿势 flat-color-out `#808080` 版（**不用纯白**：白/浅色衣服
     纯白 diff 会退化，M0 结论；`#808080` 5/5 可用）。
  3. 成层：look − flatout 做 alpha/matte → 按已知裙腰线（y）与颜色（白 vs 藏青）分割 top/skirt 两整层 →
     fill-under-hair / 边缘羽化 / 去烘焙皮肤（手/臂/发）→ 输出 675×1200 lo + 1350×2400 hi。
     hi 的诚实约束：Seedream 2K 竖图约 1152×2048，**高度不足 1350×2400** → 二选一：① 生成后做 AI/人工 2x
     精修（线稿/边缘锐化，需 G1 检查无亚像素糊/伪线条）；② 服装改走矢量平涂获得真 2x。**禁止仅用 Lanczos
     放大 lo 当 2x**；provenance 记录生成/精修来源与分辨率。
  4. 若自动成层不达标（腰线杂边/白色退化）：fallback ① 追加 1–2 张单件 look（上/下装分别生成）；
     fallback ② 转矢量平涂服装（最后手段，需 G1 同意）。
- 成本控制：每身形核心 2 张（look+flatout）+ 0–2 张重试 → 2 身形共 4–8 张 ≈ **¥1.2–2.4/轮**（PLAN §7 口径
  ¥0.3/张）；Phase 1 申请预算上限 **≤¥10 / ≤20 张**（含重试），每轮生成记录张数/金额。
- **AI 服装生成当前不执行**：等用户 G1（设计要点 + 预算）批准后再跑；先完成 B1–B7 矢量配饰。

### 3.3 后处理与确定性（所有资产）

- 统一：alpha 清理（剔除孤立小岛 <8px、轮廓外半透明雾 → 0）、1–2px 边缘羽化、颜色量化到 8-bit、
  无随机噪声/抖动；不得锐化出光晕。
- 2x 交付：真 2x（矢量直接渲染 / AI 高分辨率生成后重采样），与 lo 的 alpha 轮廓差 ≤1px；
  hi tier 若缺 2x，build 会 Lanczos 占位——**占位只允许管线调试，不允许进 G1/源包**。
- 构建侧：`build_prod.py --build-atlas` + `build_2d5.py` 生成 rig/atlas/rig.bin；每页 `pixelEqual=true`、
  每 drawable 恰好一页、页 ≤4096；双跑 md5 一致；官方 dist 逐字节校验（`npm run verify:full`）。
- 源包：新增资产后按 `npm run pack:sources -- --version assets-v5` 打包（确定性 tar），更新
  `fetch-sources.mjs` 的 pin；构建日志/`build-report.json` 作为交付证据。

## 4. 成本与排期（按 PLAN §7 口径）

| 阶段 | 内容 | 成本 | 工时（估） |
|---|---|---|---|
| P1a 矢量配饰 | B1–B7 × 2 身形 × 2 分辨率 + 主变体（+可选 2 变体） | **¥0**（API） | 2–2.5 人天 |
| G1 评审 1 | 配饰 contact sheet（两身形/1x+2x/上身合成） | — | 0.5 人天（用户） |
| P1b AI 服装 | A1/A2：look+flatout（2 身形）+ 重试 + 后处理；**需 G1/预算批准后才执行** | **¥1.2–2.4/轮**，Phase 1 上限 **≤¥10 / ≤20 张** | 1–1.5 人天 |
| G1 评审 2 | 通勤造型 contact sheet | — | 0.5 人天（用户） |
| P1c 打包/构建/资产级验收 | assets-v5 源包、构建、页/预算/2x 检查、拆装合成图 | ¥0 | 1–1.5 人天 |
| **合计** | | **≤¥10（Seedream）** | **≈5–6 人天 + 2 次用户 G1** |

- 分阶段顺序：**零成本矢量先做 → G1 → AI 服装（G1+预算后）→ G1 → 打包/构建**。
- 依赖：① 用户 G1（§7 开放项）；② Ark key/`ARK_MODEL=flash`；③ 3.3.0 构建侧页泛化（配饰页可打包，
  Phase 0 原型已证结构可行，生产接入在 3.3.0）；④ Phase 2 runtime 配饰渲染（`socketBind`/mirror/2x）——
  **1x/2x 真实抓帧视觉验收在 Phase 2 完成后做**；Phase 1 先做资产级验收 + spike/合成预览级 G1。
- 风险：AI 白衬衫成层退化（fallback §3.2）；**AI 出图分辨率不足 2x**（1152×2048 < 1350×2400 → 需 AI/人工精修
  或改矢量，见 §3.2，G1 检查）；耳饰左右不对称（按侧 anchor，已验证）；chibi 高领禁忌（开领设计 +
  neck 区域门禁）；配饰页 2x 显存（hi 全量 ~90–110MiB，设备门槛见 SLOT-REGISTRY §7.3，Phase 3 headless 校准）；
  4.0 页容量已用满 12 页（4.1 加资产必须先扩 `maxPages`，另立 ADR）；真机仍未测（D-008 wontfix）。

## 5. 验收标准（Phase 1 资产级 + Phase 2/3 视觉级）

### 5.1 每件技术验收（进源包/G1 前）

- [ ] lo 675×1200 RGBA 全透明画布；hi 1350×2400 真 2x；无白底/文字/水印/预乘。
- [ ] alpha 只含本件轮廓；配饰为单侧（左）资产，对侧空（pair/symmetry 镜像由运行时做）；无孤立杂岛/半透明雾。
- [ ] 服装：整层 top/skirt 分开、互不重复绘制身体/皮肤/头发；配饰：不画身体/手/发。
- [ ] 锚点与 §2 表一致（pivot canvas ±8px；骨局部 offset 由 `offset = R(−angle)·(pivot−base)` 重算 0 误差）；
  `item.json` 字段符合 §1.4 与 SLOT-REGISTRY §5.2。
- [ ] 页归属：A1/A2→combo 页 5（commute）；B1/B5→shoes 页；B2→socks；B4→necklace；B3→earring；B6→headwear；B7→handheld；
  每 drawable 恰好一页、每页非空。
- [ ] 构建：`build_2d5` pixelEqual=true；rig.bin/rig.json 生成成功；双跑 md5 一致；官方 dist 校验（含新页）。
- [ ] 无烘焙皮肤（手/臂/发/脸）/无假脖子/无 1px 白雾（D-017/D-018/D-019/garment-hygiene 口径）。

### 5.2 视觉验收（Phase 2 完成后；1x/2x 抓帧）

- [ ] **2 身形 × 2 套（commute / sailor+配饰）× 1x+2x 抓帧**；默认造型（commute 全套）与素体系对照。
- [ ] 拆装组合：换鞋/袜/耳饰/项链/发带/手持的开/关组合；现有上衣×下装混搭（hoodie+sailor 裙等）页并集正确；
      配饰页缺失时延迟应用/淡入、首帧不裸脚/无配饰。
- [ ] 穿模门禁：新增 2x 区域 `ear`（耳饰）、`necklace`（锁骨）、`wrist`（手持）、`shoes`（脚踝/鞋口）、
      `hem`（裙摆/袜口）——区域从 registry/socket 推导，不写死 canvas 坐标；bangs coverage <50%、
      eye occlusion=0、neck 不新增遮挡、鞋袜贴轮廓（越界 ≤3px）、裙摆尾鳍露出。
- [ ] 内容审查：无露肩露背/超短裙/高领；chibi 颈部可见；耳鳍/呆毛/尾巴可见；配色 60/30/10。
- [ ] 视觉 baseline：80 → ~120 张（新增区域/造型，PLAN §9/Phase 3）；baseline 体积 ≤3MiB 上限；人工 review 后提交。

### 5.3 首屏 / 性能 / 版本门禁

- [ ] **默认造型 lo 首屏 payload ≤1.2MB = 1,200,000B（十进制硬门禁，≈1.14MiB）**：
      页集合 `[0,5,6,7,8,9]`（base+commute+shoes+socks+necklace+earring），brotli 传输字节实测；
      参照基线 chibi 1,009,691B（默认 maid）。预算等式：`135,717(rig.bin.br) + 674,382(base) + commute页 + 4×配饰页 + Δrig ≤ 1,200,000B`
      → `commute页 + 4 配饰页 + Δrig ≤ 389,901B`；推荐分配：commute 页 ≤230KB（与 maid 199,592B 同量级）、
      单配饰页 ≤15KB（4 页 ≤60KB）、`rig.bin.br` 增量 ≤40KB → 合计 ≈337KB，留 ≈52KB 余量。
      保守口径（Phase 0 第二路验证）：1,200,000B 门禁下相对基线新增余量 190.3KB；若 combo 页按 maid 同量级替换，
      则 4 配饰页 + rig 增量须 ≤190.3KB（单配饰页 ≤47.6KB 上限，推荐 ≤15KB/页）。Phase 1 构建后实测，
      超了回 §7 降级（handheld/headwear 移出首屏）或资产返工。
- [ ] hi 2x：hi 全页驻留 ≤110MiB（headless 实测，Phase 3 校准）；单页 ≤4096²；设备门槛按 SLOT-REGISTRY §7.3。
- [ ] 版本：资产 v26 → **v27+**、页面 v29 → **v30+**（随 dist/页面变更递增，cache-bust 门禁）；
      `manifest.version 8 → 9`（Phase 2 接线）；旧存档/旧 DIY pack 迁移不抛错、不丢件、不裸装。
- [ ] 发布措辞保留「**未真机验证**（D-008 wontfix，headless SwANGLE 为准）」。

## 6. G1 流程与记录表模板

**G1 = 用户逐件确认**；未确认不得进源包/构建/发布。流程：

1. 批次产出 → `.scratch/p1-art/g1/{batch}/`：contact sheet（纯色/棋盘底 1x 全身 + 2x 局部放大 + 两身形 + 上身合成）
   + `preview.json`（每件 item/slot/页/尺寸/锚点/颜色）。
2. Lead 提交 G1：逐件勾选通过/修改/拒绝 + 意见（可批量）。
3. 通过 → 复制进源包 staging（assets-v5）并登记下表；修改 → 迭代（单件 ≤2 轮，超轮上报 Lead 重估）；
   拒绝 → 回退设计（记录原因）。
4. 所有资产进入构建前，检查本表「通过」计数 = 交付清单数。

**G1 记录表（模板，逐件追加）**

| 日期 | 批次 | item id | shape | 变体 | 类型 | 预览路径 | 2x 检查 | G1 结论 | 意见 | 记录人 |
|---|---|---|---|---|---|---|---|---|---|---|
| 2026-__-__ | P1a | acc-loafer-navy | chibi | navy | 矢量 | `.scratch/p1-art/g1/...` | ✅ | 通过/修改/拒绝 | | Lead |
| 2026-__-__ | P1a | acc-loafer-navy | girl | navy | 矢量 | | ✅ | | | Lead |
| 2026-__-__ | P1b | commute（A1+A2） | chibi | — | AI | | ✅ | | | Lead |
| 2026-__-__ | P1b | commute（A1+A2） | girl | — | AI | | ✅ | | | Lead |
| | | acc-sock-white / acc-earring-pearl / acc-necklace-fine / acc-sneaker-canvas / acc-headband / acc-whale-charm | 两身形 | | 矢量 | | ✅ | | | Lead |

**G1 检查清单（每件）**：① 轮廓/比例与角色协调；② 颜色符合 60/30/10 与现有服装；③ 保守基调（无露肩露背/超短裙/
高领）；④ 耳鳍/呆毛/尾巴未被遮；⑤ 锚点/落位符合 §2；⑥ 2x 是真实 2x（非 lo 放大）；⑦ 与两套造型可组合；
⑧ 无文字/水印/白底/皮肤烘焙。

## 7. 待用户 G1 确认的开放项（≤10 行）

1. **白衬衫剪裁**：长袖 vs 七分袖；袖口是否盖到半手（藏手萌）；下摆塞进裙腰（推荐）vs 外放。
2. **衬衫领型**：小翻领开领（推荐，短脖 chibi 友好）确认；是否加左胸小鲸鱼刺绣/胸袋。
3. **藏青裙版型/长度**：A 字 vs 微百褶 vs 直筒；长度 = 现有 maid 裙齐平（推荐）或略长。
4. **主色确认**：白衬衫 `#F8FAFC`（非纯白）/藏青 `#1E3A8A`/点缀金 `#F59E0B` ≤10%，是否需调整。
5. **乐福鞋**：颜色 navy（推荐）/黑/棕；金色扣件；首批只做 1 色还是直接 2–3 色变体。
6. **白短袜**：长度踝袜 vs 及小腿中段；袜口罗纹/细线样式。
7. **珍珠耳钉**：尺寸 16 vs **18** 宽（推荐 18×22，已验不遮眼）；锚定用「按侧美术锚点」（推荐，已验证）还是「对称内缩」。
8. **细项链**：吊坠=无吊坠细链 / 小珍珠 / 小鲸鱼（推荐小珍珠或小鲸鱼）；长度落锁骨上缘。
9. **帆布鞋/发带/手持**：帆布鞋配色（白+藏青推荐）；发带颜色/宽度/是否带鲸鱼耳鳍造型；小鲸鱼挂件尺寸/配色/挂绳。
10. **AI 服装生成预算**：批准 Phase 1 上限 **≤20 张 / ≤¥10**（2 身形，含重试）后执行；不批准则仅交付矢量配饰 + 服装另议。

## 8. 附：锚点参考总表（Phase 1 美术作者化用）

> `pivotCanvas` = 1x canvas 坐标（美术对准用）；`offset` = socket 骨局部 px（程序消费，`world = base + R(angle)·offset`）。
> 耳饰为 spike 已验证值；其余为 spike T20 候选（顶点加权质心/解剖参考），美术可 ± 微调但需同步更新 item.json + G1 复核。

| slot | shape | 模式 | bone | pivotCanvas L / R | offset L / R（骨局部 px） | 来源 |
|---|---|---|---|---|---|---|
| shoes | chibi | pair | footL/footR | (284.5,1153.8) / (382.9,1154.3) | [-17.39,9.67] / [-21.28,-9.55] | T20 候选 |
| shoes | girl | pair | footL/footR | (310.3,1154.2) / (372.9,1154.2) | [-20.54,34.39] / [-30.86,-24.11] | T20 候选 |
| socks | chibi | pair | shinL/shinR | (282.2,1060.3) / (389.7,1062.6) | [-65.3,-1.8] / [-67.6,-1.3] | T20 候选 |
| socks | girl | pair | shinL/shinR | (291.8,1013.2) / (394.8,1010.9) | [-108.2,5.8] / [-105.9,-1.2] | T20 候选 |
| necklace | chibi | single | chest | (337.5,591.3) / — | [48.7,0] / — | T20 候选 |
| necklace | girl | single | chest | (337.5,447.5) / — | [52.5,0] / — | T20 候选 |
| earring | chibi | symmetry | head | (75,445) / (589,431) | [95,-262.5] / [109,251.5] | **spike 已验证（按侧）** |
| earring | chibi | symmetry（备选） | head | (83.5,429) / (591.5,429) | [111,-254] / [111,254] | **spike 已验证（对称内缩）** |
| earring | girl | symmetry | head | (148,317) / (537,318) | [68,-189.5] / [67,199.5] | **spike 已验证（按侧）** |
| earring | girl | symmetry（备选） | head | (164.5,309) / (510.5,309) | [76,-173] / [76,173] | **spike 已验证（对称内缩）** |
| headwear | chibi | single | head | (337.5,42) / — | [498,0] / — | T20 候选 |
| headwear | girl | single | head | (337.5,74) / — | [311,0] / — | T20 候选 |
| handheld | chibi | single | handR | (461,845.6) / — | [10.65,0.06] / — | T20 候选 |
| handheld | girl | single | handR | (466.5,711.6) / — | [32.88,-7.05] / — | T20 候选 |

- 镜像轴：**按成对骨中点**，不得假设画布中线 337.5（spike T5：chibi foot 对中点 337、girl foot/shin 对中点 341）。
- pair 模式建议每侧独立 offset（`offsetL/offsetR`，对应两侧各自 socket）；symmetry 模式按 registry
  `perSideAnchor` 允许按侧覆盖（耳鳍左右美术不对称：chibi Δx≈11px/Δy≈14px、girl Δx≈−10px/Δy≈−1px，
  属美术轮廓差异而非变换误差）。
- `geometryFrame:"canvas"`：所有配饰几何按全画布坐标作者化，运行时只在骨上施加旋转/镜像；rest pose 与 canvas 完全一致。

## 9. 附：manifest / categories / state 映射（Phase 2 接线，本任务只定数据口径）

| 类别 id | 名称/emoji（建议） | stateKey（建议） | items（首批） |
|---|---|---|---|
| `outfits`（现有，追加） | 套装 👗 | `outfit` | `commute`（日常通勤；topBody `commute-top` + bottom `commute-skirt`） |
| `shoes`（新增） | 鞋 👟 | `accessories.shoes` | `none` / `acc-loafer-navy` / `acc-sneaker-canvas` |
| `socks`（新增） | 袜 🧦 | `accessories.socks` | `none` / `acc-sock-white` |
| `necklace`（新增） | 项链 📿 | `accessories.necklace` | `none` / `acc-necklace-fine` |
| `earring`（新增） | 耳饰 💎 | `accessories.earring` | `none` / `acc-earring-pearl` |
| `headwear`（新增） | 头饰 🎀 | `accessories.headwear` | `none` / `acc-headband` |
| `handheld`（新增） | 手持 🐳 | `accessories.handheld` | `none` / `acc-whale-charm` |

- 每个配饰分类带 `none` 哨兵项（不戴），与 outfits 的 `none` 一致；`normalizeState` 把
  `none`/缺失/未知 item → 空槽（迁移规则见 SLOT-REGISTRY §6）；`state.accessories` 为 4.0 持久化字段。
- `manifest.version 8 → 9`、`defaults.outfit` 4.0 默认切到 `commute`（Phase 2 接线时执行，Phase 1 不改 manifest）。
- item 字段沿用现有：`{id, name, desc, icon}`；icon = `art/icons/{item}.webp`；另加 `rigItem`/`slot` 供运行时映射
  `rig.items`（SLOT-REGISTRY §5.2）。

## 10. 附：参考文件

- 契约/决策：[slot-registry.json](slot-registry.json) · [SLOT-REGISTRY.md](SLOT-REGISTRY.md) · [ADR-4.0-SLOTS.md](ADR-4.0-SLOTS.md) · [PLAN-4.0-SLOTS.md](../PLAN-4.0-SLOTS.md)
- 设计与运行期：[DESIGN.md](DESIGN.md) · [2.5D-RUNTIME.md](2.5D-RUNTIME.md) §6.6 · [VISUAL-QA.md](../VISUAL-QA.md)
- 证据：`.scratch/p0-slot-spike/REPORT.md`（35/35）+ `out/RESULTS.md`（T7–T20 锚定/可见性/页选择）·
  `.scratch/phase0-prototype/*/EVIDENCE.md`（页容量/首屏口径）· `FEIYU-HANDOFF.md` §30.9/§30.10
- 生成参考：`/home/ubuntu/dsh/seedream_image_api.py` · `.scratch/feiyu-gen/gen-outfit-concepts.py`（KEEP prompt 模板/API 参数）
