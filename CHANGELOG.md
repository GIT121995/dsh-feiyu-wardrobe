# Changelog

> 文档路径说明（W0，2026-11-05）：下文历史条目中的 `docs/dress-up/LAYER-ARCHITECTURE.md`、`LAYER-MODEL.md`、`PROMPTS.md`、`PLAN-2.5D-RIG.md`、`RENDERING-EFFECT-EVALUATION.md`、`DIY-UPLOAD.md` 均已归档到 [`docs/archive/`](docs/archive/README.md)（原因与现行替代见该索引）。历史条目原文保留不改，仅作当时发布记录。

## 3.2.0 — 2026-11-12

「P1 性能工程第二步：lazy outfit page（方案 C）+ rig 二进化（rig.bin）+ brotli 传输」

### 核心结果
- **首屏 transfer（lo tier，默认 maid 造型）**：chibi **≈1.47MiB → 0.96MiB**（rig.bin.br 133KiB + base 页 659KiB + maid 页 195KiB）；
  girl **→ 0.80MiB**。**P1「首屏 ≤1MB」目标首次达成**（chibi 0.96MiB / girl 0.80MiB，均为构建产物实测）。
  请求构成 = 2 个 JS + 1 个 rig + 2 个图集页；其余 3 个套装页首帧后空闲预取。
- **rig 解析**：`JSON.parse`（1.6MB）中位 ≈24–29ms → `rig.bin` 零拷贝解码 **≈0.6–0.8ms**（Node 基准；浏览器同量级），
  并消除 10 万+ 嵌套数组的解析分配/GC（DSH 侧边栏多插件场景内存压力同步下降）。
- **质量**：图集仍 lossless WebP；拆分只改打包布局/UV，逐 drawable 纹理像素不变（见 QA 节「纹理像素级等价」）。

### lazy outfit page（方案 C）：lo/hi 5 页图集
- lo/hi 每身形图集由单页/两页改为 **5 页**：`atlas.webp`（base：身体/头发/脸/尾巴等常驻层）
  + `atlas-2.webp`（maid）/ `atlas-3.webp`（hoodie-plaid）/ `atlas-4.webp`（hoodie-pleated）/ `atlas-5.webp`（sailor-plaid）。
  每页 = 该套装 `{combo}-top` + `{combo}-skirt` 两个整层 drawable；页序/文件名固定，**每个 drawable 恰好归属一页**。
- hi tier 同构：base 页 = 2x 主体/发/脸/tail + 常驻 1x `seam-fill`，4 个套装页 = 1x 整层服装。
- 契约：`rig.atlases` 5 项（`rig.atlas`=第一页兼容旧消费者）、`m3.multiAtlas/atlasPages`、`product.pages`、
  `drawables[].atlas/texture`；构建报告 `pages/atlases[]` 逐页 `pixelEqual`。
- 构建：`build_prod.py` 新增 `build_atlas_pages()`（按 `outfits` 引用分组 + 构建期断言：每 drawable 恰好一页、每页非空）；
  `build_2d5.py` `MAX_PAGES` 2→6，旧单页输入仍走历史路径。
- runtime：`MAX_ATLASES` 2→6；`setShape(shape, { look })` 按当前造型选首屏页；`setLook` 缺页时**保留旧造型、
  后台补页完成后自动应用**（不裸身/不闪错套装）；首帧后 ≈220ms 空闲预取其余页；`getAssetInfo()/getTier()`
  暴露 `atlasPages / atlasesLoaded / atlasesPending`；释放场景/destroy 取消预取并删除已加载页纹理。
- 首屏 `index.html` preload 改为 `rig.bin` + base 页（套装页交给 runtime）；client-config 资产清单版本 3→4
  （lo：rig.bin + 5 页；hi：rig.bin + base 页）。

### rig 二进化：feiyu-rig-binary v1
- 新增二进制格式（`.scratch/p1-320/RIG-BINARY.md`）：8B magic + u32 headerLen + header JSON（rig 元数据 +
  每 drawable `meshMeta`）+ 4 字节对齐 binary 段；positions/uvs/weights/deform **f32**、bones/indices **u16**（GL 原生类型，
  渲染逐字节等价）、确定性、显式小端。
- 构建期生成 `rig.bin`（chibi ≈0.96MiB raw / 60.6% of JSON）并 **Node brotli q11 预压缩 `rig.bin.br`**
  （chibi 135,914B ≈133KiB）；`rig.json` 保留（工具/QA/回退）。
- 运行时 `rig.bin` 优先加载、404/解码失败回退 `rig.json`（`toRuntimeRig` 归一成同一扁平 typed array 形状，
  consumer 只认一种）；`uploadDrawable` 改扁平索引读取（DIY pack/JSON 回退统一归一，兼容不变）。
- 新增 `tests/rig-binary.test.mjs`（4 个 rig roundtrip：非 mesh 字段 deepStrictEqual、逐值 `Math.fround`、确定性双跑
  sha256、损坏输入/JSON 回退、体积/耗时诊断）。

### brotli 静态传输
- `lib/webserver.js`：支持 `Accept-Encoding: br`——**构建期 `.br` 预压缩产物优先**（mtime 保护防陈旧）、
  缺省 q5 动态压缩 + size/mtime 进程内缓存、gzip 9 回退、`Vary: accept-encoding`；`.bin` 计入可压缩类型。
- rig 首屏传输 gzip ≈285KiB → **brotli ≈133KiB**（q11 在请求期需 ~2.4s/1.6MB 太慢，故构建期一次生成）。

### QA / 门禁
- 资产契约测试改 5 页（页序/文件名/归属/base 不含 outfit 整层/每套装页恰 2 个整层；hi 2x/1x 页划分）；
  预算门禁改为 **首屏 = rig 传输（`.br` 优先）+ base 页 + 默认套装页 ≤1.0MiB**（v3.1.1 基线 1.47MiB）。
- 构建确定性双跑与官方 dist 逐字节比对扩展到 **rig.bin + 全部 5 页 atlas**；`.br` 用语义校验（解压==rig.bin，
  避免 Node/libbrotli 版本差异造成假红）。
- 视觉门禁：`renderLook` 等造型真正生效（懒加载页兜底）；资产哈希覆盖全部 5 页；
  纹理像素级等价校验：v3.1.1 单页图集逐 drawable 裁切 vs v3.2.0 各页对应 drawable 裁切，**48/49 drawables × 2 身形
  逐像素相等（0px 差异）**——即拆分不改变任何渲染纹理内容。
- 结果：`npm run verify:full` **332 pass / 0 fail / 2 skip**（含 lo chibi 双跑确定性 + 官方 dist 逐字节一致（rig.json/rig.bin/5 页 atlas）、
  hi chibi 双跑 md5 一致）；`visual:qa compare` **80/80 PASS、变更图 0 张**（资产 v25 / 页面 v28 基线重生成）；
  `qa-load-timeline --shape both --dpr 2 --tier auto --assert` **PASS**（chibi firstDraw 2881ms / ready 2918ms、
  girl firstDraw 1330ms / ready 1362ms，headless SwANGLE；不劣于 v3.1.1 的 2948/1343ms）；`npm run typecheck` PASS。
  v3.1.1 → v3.2.0 纹理像素级等价：4 个 dist（lo chibi/girl、hi chibi/girl）逐 drawable 从旧图集裁切 vs 新图集裁切
  **0px 差异**（48/49 drawables × 4；合计 lo 6.02M / hi 19.0M 像素）——拆分不改变任何纹理内容。
  渲染层面（旧基线 vs 新基线截图对比）：54/80 张存在子像素级重采样差异，合计 5,973/22.6M px（0.026%）差异 >10/255、
  最大通道差 25/255；来源是 UV 归一化到新页尺寸后的 5 位小数定点化误差（≤0.03px 采样位移，集中在 AA 边缘），
  无结构/颜色/接缝变化。按门禁流程重生成基线后 `visual:qa compare` **80/80 PASS、0 变更图**（自洽）。
  若未来要求「与旧基线 compare 直接通过」，需把 UV 定点精度从 1e-5 提到 1e-7（rig JSON 约 +60KB，rig.bin 不变）。
- 资产版本 **v24→v25**、页面模块 **v27→v28**。

### 版本与发布
- 资产版本 **v24→v25**、页面模块 **v27→v28**、client-config 协议版本 **3→4**。
- **main `42d626f`**（功能/资产提交）；tag **`v3.2.0`**；npm **`dsh-feiyu-wardrobe@3.2.0`**（`rc` 先行 → 验证后 promote `latest`）；
  **GitHub Release v3.2.0**（notes 取自本条）；本机 profile 升级 **3.2.0** + `restart-dsh.sh --deferred 240` 重启生效；
  重启后线上回归：页面 `?v=28` / 资产 `?v=25`、`rig.bin`/`rig.bin.br`/5 页图集全部 200 且带 `br`/`immutable`、
  profile=3.2.0。
- npm 包：**15.9MB** tarball / 24.7MB unpacked / **110 files**（新增 4×`rig.bin` + 4×`rig.bin.br`、
  `rig-binary.js`、`tests/rig-binary.test.mjs`、`tools/art/rig_binary.py`；`rig.json` 保留作为工具/回退资产）。

### 已知限制 / 下一步
- 首屏收益依赖 brotli（不支持 br 的旧浏览器回退 gzip 后 chibi ≈1.2MiB，仍低于 v3.1.1）。
- 真机仍未测（D-008）；hi tier 首屏仍为后台升级（lo 先出帧不变）；其余遗留同 v3.1.1
  （服装 hi 仍 1x D-005/P3、D-011 袖口 inpaint 白雾、D-010 皮肤亮度待确认等）。
- P1 剩余：解码/上传 offload（createImageBitmap/Worker）、性能门禁进 CI（GitHub Actions）。

## 3.1.1 — 2026-11-12

「P1 性能工程第一步：图集打包器升级（VRAM -36% / 上传量 -36%，像素零回归）」

### 改动
- `tools/art/build_2d5.py::pack_rects` 从「按行 best-fit」升级为**有界 MaxRects-BSSF 确定性打包**：先按内容面积估箱高、逐级放宽直到放得下，返回实际使用边界；纹理不旋转，UV 精度/契约不变。
- 效果（构建报告实测）：
  - lo 图集面积 chibi 5.18M→3.29M px、girl 5.05M→3.32M px；打包利用率 **58–60% → 92%**；
  - **lo mipmap 显存 26.4/25.7 → 16.8/16.9 MiB（-36%）**；hi tier 两页图集 mipmap 显存 **~65 → 54–56MiB（-15–17%）**；
  - 纹理上传像素量同比例下降 → 首帧上传/移动端内存压力下降；
  - 图集文件字节基本不变（1217→1222KiB / 1041→1049KiB；透明空白区压缩几乎免费），首屏 transfer 仍 ≈1.47MiB。
- 视觉：`npm run visual:qa -- --mode compare` 与 v3.1.0 基线对比 **0 张变更图（80/80 通过）**；随后按流程重生成 baseline（资产 v24 / 页面 v27）。
- 预算门禁收紧：lo mipmap 显存 **≤20MiB**、hi tier **≤60MiB**、首屏 payload **≤1.6MiB**（并输出 rig/atlas 占比诊断）；构建确定性（双跑 md5）由 `verify:full` 继续校验。
- 资产版本 **v23→v24**、页面模块 **v26→v27**（rig/atlas 内容因打包布局变化必须递增）。

### 已知 / 下一步（P1 剩余）
- 首屏 transfer ≤1MB 目标**未达**（仍 ~1.47MiB，其中 atlas 1.2MiB）。降 transfer 需要做产品/质量取舍：lo 纹理 0.5x（sidebar 显示足够，立绘卡需 hi 按需加载）/ lo 用 lossy WebP / lazy outfit page（首屏只加载 base+当前套装）——待拍板后作为 3.2.0 处理。
- rig.json 二进化（1.6MB JSON→binary，parse 提速）仍在 P1 待办。

## 3.1.0 — 2026-11-12

「首屏加载体验 + 用户反馈三缺陷修复（加载态/lo 先出图、颈部/下巴、服装手心残留）」

> 版本说明：本次含**首屏 tier 策略行为变更**（自动 hi 设备改为 lo 先出帧 + hi 后台升级），按发版纪律升次版本号；QA 工作流内部代号为 `v3.0.1 runtimefix`。

### 首屏加载（v3.0.0 线上问题：进入换装间「卡着加载不出来」）
- **根因**：v3.0.0 在自动 tier 判定为 hi 的设备（DPR≥2）首屏直接加载 hi tier——`rig.json` 1.66MB + `atlas.webp` 3.05MB + `atlas-2.webp` 0.53MB 才出首帧（headless 实测 firstDraw≈4.0s），且加载期间 figure 区没有任何加载提示。
- **修复**：runtime 首屏渐进 tier——自动 hi 设备先加载 **lo** 立刻出首帧、hi 在后台加载完成后热切换无损升级（`progressiveTier`，显式 `?feiyuTier` override 视为固定 tier 不升级）；页面静态加载态（「正在加载角色…」+ 阶段进度，FCP 后可见）；`index.html` 按 shape/tier 提前 `preload` rig/图集；版本化静态资源返回 `immutable` 长缓存；`client-config.json` 下发版本化资产清单供宿主后台 prefetch。
- **门禁**：`scripts/qa-load-timeline.mjs`（加载提示可见/首帧/ready/结构契约，`--assert`）+ `tests/load-timeline.test.mjs`（判定逻辑；v3.0.0 实测数据必须 FAIL）。
- **实测（headless SwANGLE，本机 2 核、load≈2）**：v3.0.0 `chibi DPR2 hi` firstDraw 3994ms / ready 4019ms、**无加载提示**；v3.0.1 auto 实测加载提示 **0.2–0.3s 可见**、首帧 `tierAtFirstFrame='lo'`（hi 后台升级已启动）、ready 2.8–3.7s。墙钟阈值按该环境实测复标（normal 6000ms sanity）；回归判别靠结构契约（加载提示可见 + `tierAtFirstFrame='lo'` + ready 不劣化 >25%）。真机阈值待 D-008。

### 颈部/下巴（用户反馈「下巴跟脸连不上」）
- artfix：`art/body-fix/<shape>/neck-overlay.png` 收窄到真实颈轮廓（core=0.90/0.92×素体颈宽、feather 8px、从 `jaw+8/+11` 起过渡）；girl 额外 +8 L 提亮并用 `sigmaY=3.0` 高斯软化下颌线。
- 门禁：`tests/neck-art.test.mjs`。实测 chibi 宽度比 1.35→1.13、girl 1.19→1.08；girl ΔL 16→8、下颌逐列 max|ΔL| p90 63→36、色度比 0.88。

### 服装手心残留（用户反馈「穿模」）
- artfix：8 套服装 16 层 `layers/{top,skirt}.png` 的手/前臂掩罩内旧渲染残留（皮肤色/手描边/手影）清除——镜像补色 → 块匹配拷贝 → 顽固像素中性化；alpha 不变，不重建 mesh。
- 门禁：`tests/garment-residue.test.mjs`。v3.0.0 实测残留（chibi sailor-plaid/skirt 826px、hoodie-plaid/skirt 431px 等）修复后全部 0px。

### 源包 / 构建 / 版本
- 源包 **assets-v4**（`assets-src-v4.tar.zst`，含 artfix 后的 `art/garments/**/layers` 与 `art/body-fix/*/neck-overlay.png`）；`npm run fetch:sources` 默认切到 v4 + 新 sha256；`npm run artfix:v301` 仅历史源包（assets-v3 及更早）需要。
- 资产版本 **v22→v23**（rig/atlas 内容变更，页面模块 **v25→v26**）；视觉门禁 baseline 重生成（页面 v26 / 资产 v23）。
- 门禁：`npm run verify` / `verify:full` / `visual:qa --mode compare` / `qa-load-timeline --assert` 全绿。

### 已知限制
- 真机未测（D-008）；hi tier 服装仍 1x（D-005/P3 残留）等限制同 v3.0.0。

## 3.0.0 — 2026-11-11

「2.5D paper-doll 资产重做 + 领口露真实素体颈（资产 v22 / 页面 v25）」

### 核心变更
- **服装整层化（paper-doll）**：8 套服装由 6–9 个分件（torso/skirt/collar/apron/sleeve…）改为 **2 个整层 drawable**：`{combo}-top`（slot `topBody`、z **64**，位于手臂 z45/48 之上、手 z65 之下）与 `{combo}-skirt`（slot `bottom`、z **30**）。每层 675×1200 全画布 RGBA 纹理 + 单网格（cell=9），顶点/权重由既有 rig 自动绑定；不再有分件拼缝与 collar/sleeve 槽位。
- **契约变化**：production rig drawables chibi **69→48** / girl **70→49**；`outfits[combo] = {name, topBody:[combo-top], bottom:[combo-skirt]}`；单页图集重新打包（chibi 4052×1279 / girl 4086×1237）；65 骨、骨架/物理/碰撞、face/hair 部件不变。资产版本 **v21→v22**（`?v=22`）、页面模块 **v24→v25**。
- **假脖子清除**：Phase 0 审计发现 8/8 服装层都烘入了「假脖子」皮肤（头动时颈不动：irises 动 37–49px 而假颈 91–98% 静止）。改造后服装贴图 **烘入皮肤像素 = 0**（`tests/garment-hygiene.test.mjs` 断言），领口内显示的是真实素体颈部。

### 素体颈部修复（G1 用户验收）
- 露出真实素体颈后，原画颈部有重阴影 + 两条肌腱亮条（用户反馈「太黑 / 两根肉须 / 没下巴 / 与脸色差」）。经 G1 多轮对比，用户选定 **W8 + 下巴细线稿**：AI 局部重绘颈部（Seedream，seed 4502/4602）+ 保留 W4 自然明暗 + 颈部色相向脸肤色对齐 85%；下巴区域最终采用**只加细线稿、不加投影**（沿原 v2.7 body 下巴轮廓自动提取并二次拟合的曲线，线色=肤色 L−35、σ1.3px、α0.75、两端渐隐），保证下巴可辨又不出现阴影带；完全无阴影/无下巴线档均已否决（丢下巴）。
- 固化为素体一次性资产补丁 `art/body-fix/{shape}/neck-overlay.png`（675×1200 RGBA，alpha=羽化权重）；builder `apply_neck_overlay()` 在 lo（原尺寸）/ hi（Lanczos 2x → 1350×2400）对 `body-head` 贴图确定性合成：仅改 RGB、tex alpha 与 overlay 外像素逐字节不变（changedPx chibi 10,358 / girl 19,607；hi 41,321 / 75,103）。运行时与参考图颈部 RGB 平均差 0.23–0.68/255、p95 1–3/255；hi/lo 颈 L 差 ≤0.6。

### 运行时 / DIY 兼容
- `resolveLook` 天然支持单层 outfit（topBody/bottom 各 1 项）；旧存档（旧分件 state）与旧 v2.1 / v2.2–2.7 DIY pack 引用经 `LEGACY_V21_BASE_REFS` / 新 `LEGACY_V22_BASE_REFS` 映射到整层 id，自绘层不丢、不裸身；DIY 自动配对改用整层引用。

### 视觉门禁 / 回归
- `scripts/visual-qa.mjs` 新增 **neck** 2x 局部区域（以 neck 骨为基准，覆盖下巴影→领口→锁骨上缘）：baseline **70→80 张**，覆盖 2 身形 × 5 造型；`--mode compare` PASS。
- `tests/garment-hygiene.test.mjs`（新增）：v3 dist 结构（每套 2 层、z 64/30、无分件）、服装贴图 SkinRule 烘入皮肤=0、alpha 孔洞（袖口/领口功能性开口白名单 + 缺陷洞注入验证）。
- 其它测试同步：`dressup-2d5-assets`（48/49 + 整层断言）、`manifest-v8`（requiredDrawables→整层 id）、`runtime-2d5-core` / `diy-v22-compat` / `diy-manifest` / `v2-page`（版本 v25/v22）。`npm run verify:full` 全绿（官方 dist 逐字节一致性 + hi tier 确定性）。
- 视觉登记：D-018（服装烘入假脖子）与 D-019（露颈重阴影/肉须/没下巴/色差）均 **fixed v3.0.0**。

### 可复现
- 源包重打包为 **assets-v3**（`assets-src-v3.tar.zst`，291 文件，135.7MB → 压缩 92.5MB，sha256 `5c0e942e85738b248d9b65ac05df063c187cc8d076ac70ffa0d21f52990cba02`），新增 `art/body-fix/` 颈部 overlay 源；`npm run fetch:sources` 默认拉取 assets-v3 并校验 sha256。两身形 lo+hi dist 由 `npm run build:assets:v26` / `npm run build:assets:hi` 重建。

### 已知限制
- 真机未测（D-008）；hi tier 服装仍 1x（整层服装在 lo 页，DPR2 下上采样；D-005/P3 残留）。
- 素体颈部为一次性 AI 重绘补丁（seed 4502/4602 + 后处理参数固定）；后续如需再调需重新生成 overlay 并重跑门禁。
- 旧分件回退构建（无 `layers/` 源）仍可用，但产物不再与 v2.7.0 官方 dist 逐字节一致（body 颈部 RGB 变了）。

## 2.7.0 — 2026-11-10

「下架白色高领毛衣：上衣项 + `sweater-plaid` / `sweater-pleated` 两个组合整体移除（高领不适配短脖子 chibi 角色，用户拍板）（资产 v21 / 页面 v24）」

### 下架范围
- **上衣项 `sweater`（白色高领毛衣）整体移除**：高领造型不适配短脖子 chibi 角色，用户 2026-11-10 拍板彻底下架（不做替代款）。衣柜上衣只剩 `hoodie`（白色连帽卫衣）/ `sailor`（水手服上衣）；`manifest.defaults.top` 由 `sweater` 改为 `hoodie`。
- **组合 `sweater-plaid` / `sweater-pleated` 移除**：cutout production 组合由 6 个降为 **4 个**（`maid` / `hoodie-plaid` / `hoodie-pleated` / `sailor-plaid`，rig `defaults.outfit=maid`）；两组合对应 drawable（各 8 件，共 16 件）、图集纹理、`art/icons/sweater.webp`、M4 服装 layer 与源包 `art/` 毛衣源一并删除。
- **资产契约变化**：rig drawables chibi **85→69** / girl **86→70**；图集因移除毛衣件重新打包（尺寸/字节变化，`build-report.json` 同步）；65 骨、骨架/物理/其余部件不变。资产版本 **v20→v21**（rig/atlas `?v=21`），页面模块 **v23→v24**（`app.js?v=24`）。

### 兼容回退（旧存档 / 旧 DIY pack 不报错）
- **旧存档**：localStorage 残留的 `top=sweater`（或旧组合）经 `normalizeState` 校验失败 → 回退 `manifest.defaults.top`（`hoodie`）；旧 `outfit=sweater-plaid/sweater-pleated` 同理回退默认套装（`maid`）。
- **旧 v2.1 DIY pack**：`LEGACY_V21_BASE_REFS` 旧键改为映射现有 hoodie-plaid 部件 —— `bottom-plaid`→`hoodie-plaid-skirt/-skirt-under`、`bottom-pleated`→`hoodie-pleated-skirt/-skirt-under`、旧毛衣上衣→`hoodie-plaid-torso`、旧毛衣袖→`hoodie-plaid-sleeve-upper/fore`（L/R 共 4 件）；`hoodie-body/hoodie-sleeve` 同样映射 hoodie-plaid 部件。
- **DIY 自动配对**：`migrateDiyPackOutfits` auto-pair 改用 `hoodie-plaid`（top/coat/dress/outfit 补 hoodie-plaid 裙对，bottom 补 hoodie-plaid 上衣 + 分段袖）；`tools/diy/bind_layers.py` 的 `PAIR_REFERENCE_OUTFITS` 改 hoodie-plaid 优先，legacy 静态回退 `PAIRING['bottom']` 改 hoodie-body/hoodie-sleeve（运行时按迁移表落到 hoodie-plaid 部件）。
- **运行时缺件回退**：`resolveLook` 旧 generic 上衣缺件回退由毛衣改为连帽卫衣（warning `top:?→hoodie`）；cutout rig 上旧 state 命中不了组合时回退 rig 默认套装（`maid`）、记 warnings，均不抛错。

### 回归
- **测试**：`manifest-v8`（tops 仅 hoodie/sailor、defaults.top、4 组合）、`runtime-2d5-core`（套装/动态组合/legacy→hoodie）、`diy-v22-compat`（旧引用→hoodie-plaid 部件、binder `pairingSource=base-rig:hoodie-plaid`）、`wardrobe-state`（默认/非法回退/随机/穿搭描述）、`dressup-2d5-assets`（drawables 69/70）等同步更新；`npm run verify` 全绿。
- **视觉门禁**：`scripts/visual-qa.mjs` 造型 `sweater-plaid` → `hoodie-plaid`（覆盖矩阵仍 2 身形 × 5 造型 × 70 张）；baseline 重生成到 页面 v24 / 资产 v21（删除旧毛衣造型目录），`--mode compare` PASS。

### 可复现
- 源包 `assets-src-v2` 重新打包（删除毛衣源；89.8MB，sha256 `2e6a003b…c934`）；两身形 lo+hi dist 由 `npm run build:assets` / `build:assets:hi` 重建，`verify:full` 确定性/官方 dist 校验同步。

### 已知限制
- 毛衣造型不再可恢复（用户拍板下架，源与 dist 均已删除；旧存档自动回退，不保留切换入口）。
- 真机未测（D-008）；hi tier 服装仍 1x（D-005/P3）等限制同 v2.6.2。

## 2.6.2 — 2026-11-06

「修复：chibi 素体隐藏区黑色残留（头发/手臂摆动时露出体表黑块）（资产 v20/页面 v23）」

### 修复
- **根因**：v2.6.0 的 chibi 素体母版 v3（`master/chibi/master-2x.png`）在头发/侧发/手臂后方遗留了近黑像素（clean-body 去发残留；静止时被发层/肢体完全遮住）。chibi 母版重贴图使用「全量」模式（`visibleOnly=False`）→ 近黑像素被写进 `body-head` / `body-torso` 等素体纹理；`HairSway` 物理/头部动作使发丝错开时，这些像素从发间露出，表现为体侧两道黑色块（用户 2026-11-06 反馈）。**与 v2.6.1 的 2x hi tier 无关**：lo tier 同样复现，属 v2.6.0 母版重贴图副作用。
- **修复**：builder 的母版重贴图（lo）与 hi tier 体表 2x 母版采样增加「隐藏区近黑残留处理」——当 master RGB 近黑（三通道 max<20）而原 v2.5 生产贴图对应像素明显更亮（max>70）且不透明（alpha>32）时判定为残留；**不是简单回填 v2.5 生产色**（那里是白羽/背景白边，露出白块同样异常），而是用「最近的发色 master 像素」做颜色外扩（发色判据 b−r>25 且 b>60），使发丝错开时看到的是头发阴影/发色延续。chibi lo 实际处理 **6,214px**（body-head 3,956 / body-torso 2,086 / 其余 172），hi tier 同规则（2x 母版采样同样处理）。
- **影响范围**：仅 chibi 素体纹理的**隐藏区**像素变化（lo/hi `atlas.webp` 与 `build-report.json` 字节变化；`rig.json`、65 骨、85 drawables、网格/UV、静态 rest 渲染不变）；**girl 资产逐字节不变**（girl 走 visible mask 策略）。资产版本 **v19→v20**（dist 变更必须递增，避免浏览器缓存旧图）；页面模块保持 **v23**。
- **回归**：`tests/asset-build.test.mjs` 增加「chibi 体表近黑像素上限」断言（防止母版隐藏区残留回归）；`verify:full` 构建确定性/官方 dist md5 校验同步更新。

### 已知限制
- 该修复保证"动画时不再露黑块/白块"，隐藏区露出的颜色由最近发色像素外扩得到（发色延续/阴影感），并非为隐藏区重新绘制精细阴影；如需更精致的"发下阴影"效果，仍需后续美术重绘母版隐藏区。
- 真机未测（D-008）；其余限制同 v2.6.1。

## 2.6.1 — 2026-11-06

「高 DPI 2x 资产（hi tier）：DPR≥2 自动启用 2x 素体/发/脸/尾纹理，弱机保持 1x（资产 v19 / 页面 v23）」

### 改进
- **hi（2x）资产档位**：新增 `art/2d5/{shape}-hi/` —— body 10 drawable + 发层 + 脸部 19 件 + 尾鳍改用 **AI 增强重绘的 2x RGB 纹理**（画布 1350×2400、纹理 2x 分辨率；alpha 由 lo alpha 确定性 Lanczos-2x 生成，轮廓/网格/骨骼不变），服装保持 1x。图集打包为 **2 页**（hi 页 2x 大件 + lo 页 1x 服装，每页 ≤4096、pixelEqual）。
  - girl-hi：2 页 4073×3138 + 4080×1050（atlas 2.62MB + 1.03MB），rig 1.91MB，纹理 65.1MiB；chibi-hi：2 页 4016×3214 + 4083×975（3.05MB + 1.02MB），rig 1.98MB，纹理 64.42MiB。结构仍为 65 骨 / 85·86 drawables，rect/mesh 与 lo 逐 drawable 一致。
  - AI 用量：Seedream 共 10 张 ≈¥3（每身形 2 个 seed 全图增强，按轮廓 IoU/chamfer 选优；girl seed 6604 IoU 0.913、chibi seed 8806 IoU 0.913）。AI 只提供「可见 + 不透明 + 距轮廓 ≥1.5px」像素的 RGB，隐藏区/边缘保留确定性基座，轮廓不随 AI 变化。
- **运行时 tier 自适应**：`assetTier()` = DPR≥2 且（deviceMemory≥4 或 hardwareConcurrency≥4）且 MAX_TEXTURE_SIZE≥4096 → hi，否则 lo；hi 加载失败自动回退 lo（不白屏/不卡死，回退原因可查）；调试覆盖 `?feiyuTier=lo|hi` 与 localStorage `feiyu:tier`。资产 **v19**、页面模块 **v23**。
- **lo tier 零变化**：`art/2d5/{shape}/` 资产未改动；DPR1/弱机仍走 1x（首屏 2 请求、纹理 ≈26MiB 不变），hi 只在 DPR≥2 且设备达标时启用。

### 量化（headless Chrome + SwANGLE，DPR2 真实 canvas 像素，lo vs hi）
- 锐度（Laplacian 方差 ×，同姿态同画布、轮廓内膨胀 5px 掩码）：脸 ×2.28、发 ×2.83、膝 ×5.09、手 ×4.70、腹 ×5.88；Sobel 梯度 ×1.26–1.66。
- 几何：全身轮廓 IoU **0.9973–0.9998**（girl bare/maid/sailor 与 chibi maid DPR2），边界最大偏差 ≤1.80px（95 分位 ≤1.00px）；静置 alpha/洋红孔洞 **0**。
- 首屏 payload 增量：+1 请求（rig + 2 页图集）、传输 +1.88MiB（girl）/ +2.03MiB（chibi）、纹理显存 25.7→65.1MiB（girl）/ 26.7→64.4MiB（chibi）；首次 loadMs 约 640→1170ms（headless，不代表真机）。
- E2E：lo tier 与 hi tier（`?feiyuTier=hi`）各 **18/18 PASS**、0 pageerror、0 crash；hi 轮实测 2 页图集 / 3 请求 / 身形切换正常。

### 可复现
- 源包 `assets-src-v2` 更新（新增 `hi/` 63 files；313 files / 164.7MB；sha256 `834e2485…8af5`，GitHub Release assets-v2 已重新上传）；构建：`npm run build:assets`（lo）与新增 `npm run build:assets:hi`（hi）；`verify:full` 含 hi 构建双跑 md5 确定性校验。
- 视觉门禁 lo baseline 更新到页面 v23 / 资产 v19（像素仍与 v2.6.0 一致）；hi DPR2 对比报告与截图见 `.scratch/p8/2x/runtime/review/`（不入 git）。

### 已知限制
- **服装仍为 1x**：hi tier 只覆盖 body/hair/face/tail，衣服仍按 1x 采样（P3 全量 2x 另行立项）。
- **真机未测**（D-008）：全部数字来自 headless SwANGLE；实际设备是否启用 hi 由 DPR/内存/核数/纹理上限自动决定，弱机/DPR1 回退 lo。
- AI 增强存在轻微风格/肤色差异（已做低频色调匹配，DPR1 下肉眼差异小）；D-011 袖口 inpaint 白雾在 2x 下仍可能轻微可见；D-010 皮肤亮度待用户确认。
- **npm 包体积增加**：hi dist 两身形图集+rig ≈11.6MB（未压缩），npm 包由 8.5MB 增至约 20MB（插件离线可用所需，lo 资产不变）。

## 2.6.0 — 2026-11-05

「素体 art v3：统一母版重贴图 + 两件式露脐 + 接缝/双色修复（资产 v18/页面 v22）」

### 改进
- **素体母版 v3（结构性修复）**：所有 body 部件（10 个 body drawable）的 RGB 改为从**单一素体母版**同坐标取色——此前「每块部件各带一套脏颜色」导致的膝/踝横带、髋部横线、手臂段横带、脚/腿双色全部消失。**alpha 逐像素不变、rig.json 与 v2.5 逐字节相同、65 骨 / 85·86 drawables 不变**（几何/绑定/服装完全兼容）。
  量化：膝横带 dip L **+8.53 → −3.88（消失）**；脚-腿 Lab 差 **+11.66 → 0**（70px 渐变统一）；身体静置未解释差异 **0px**（rig QA）。
- **两件式露脐**：白色连体内衣 → 保留抹胸（含下胸束带）+ 短裤（含腰线/裤脚），中间裸腹带改为皮肤（girl 下胸线 y≈489–502 → 短裤腰线 y≈634–648，裸腹 ≈146px，肚脐 (337.5,589)；chibi 裸腹 ≈72–75px，肚脐 (337,701)），腹部肤光影/接触阴影由确定性方法生成。**仅「素体（bare）」状态可见**，日常套装下被衣服遮住。
  说明：Seedream 对素体/内衣特写内容审核拦截（girl torso 编辑 10/10 400；皮肤局部 4 次 1 成功但风格写实未采用）→ 两件式最终由确定性方案交付（AI 实际计费 1 张 ¥0.3；chibi 成功 2 张 ¥0.6）。
- **隐藏区**：girl 只重写静置可见像素（母版 visible mask），发/脸/衣下隐藏区沿用 v2.5 已收敛填充 → ±25° 头转/歪头行为不回归（new-hole=0）。
- **可复现**：W0 管线入仓后，v2.6 dist 可由「源包 assets-src-v2（新增 master/ 母版+重贴图契约）」经 `npm run build:assets:v26` 逐字节重建（验收 atlas md5 一致）。

### v2.6.0 修复（发布前用户反馈）
- **女仆装「四只手」修复（历史 bug）**：根因有两层 —— ① M4 arms 图层是整幅横带，**左右手部件都切出了两只手**，每个 hand drawable 的网格/UV 覆盖双手 → 两个 hand drawable 共渲染 4 只手（且每个被各自手骨形变，产生错位"鬼手"）；② 服装件纹理里烘焙了手/皮肤副本。修复：肢体 alpha/mesh 按部件 rect 列范围裁剪（hand-L/R 各只含自己那只手，网格 bbox 184–241 / 438–497）；P3 look 参考图（`prod/ref`）的鬼手区域用 inpaint 修复后重贴回服装件 → 渲染只剩 2 只手。
- **素体切线/色阶修复**：撤掉 v2.6 给 arm/hand 加的 Lab −3.45 整体调色（该调色在手臂部件 y≈437 水平直切边形成色阶线，也是"亮度变亮"的来源）→ 亮度回到 v2.5；另修掉烘焙的腕 y654–658、踝 y1000–1004 横线（行不连续度 63.5→47.5，重扫 0 残留）。
- **渲染器预乘 alpha 修复（历史 bug）**：纹理直通 alpha 上传 + shader 二次乘 alpha + 预乘混合 → 覆盖率被平方，在每个 sprite 图集 tile 边界出现 1px 暗线（髋 y≈757 横贯双腿）与边缘暗晕。改为标准预乘管线（上传预乘 + shader 直接输出 + mask 分支 rgb/a 同乘）：行扫描 −18.8 → 0，DPR1/2 × mipmap on/off 四组全 0，发丝/衣服边缘暗晕消失。
- **资产版本**：仍为 v18 / 页面 v22（尚未发布过，无需再升）。`rig.json` 因 hand 网格修复**不再与 v2.5 逐字节相同**（结构仍 65 骨 / 85·86 drawables）；atlas girl 4041×1666 / chibi 4059×1722、tex girl 25.68 / chibi 26.66 MiB（均下降，因 hand 部件裁剪）。
- **可复现**：源包 `assets-src-v2` 已更新（含修复后母版 v3.1 + `prod/ref` 修复 + `master/` 契约），sha256 `553bd2bf…6cd3`；重建 v2.6 dist 与仓库逐字节一致。

### 验证
- `npm run verify` **272 tests / 270 pass / 2 skip**（skip=源缺失时资产构建测试按设计跳过）；E2E **18/18**（0 retry/crash/pageerror，资产 v18/页面 v22，首屏 4 请求/2.26MiB）；DIY E2E **4/4**。
- 视觉门禁矩阵 70/70 PASS（vs v2.5 baseline）：99.46% 变化在母版重贴图预期区，严格口径外仅 5px 压缩噪声；静置洋红洞 0；girl yaw/roll ±25 new-hole=0；构建双跑 md5 一致；npm pack 体积不变（8.6MB）。
- **真机未测**：所有数字来自 headless Chrome + SwANGLE（无 GPU），FPS/显存不可代表真机。

### 已知限制
- 皮肤整体亮度略提高（脚/腿/手臂统一到母版肤色），对 v2.5 对比可见；如需更暖/更接近旧观感可回调 Lab 系数（无 AI 成本）。
- 露脐为确定性平涂（有肚脐与柔光影，但不如手绘丰满）；束带/腰线保留原画白色布料边缘（2x 可见 1px 白线）。
- 2x 仍可见 1px 部件拼合 AA 线（只改 RGB 不动 alpha/网格；1x 不可见）。
- 真机性能/显存未测（D-008）。

### 升级
- 升级 profile/npm 后重启 DSH；资产 `?v=18`、页面模块 `?v=22` 保证不吃旧缓存；65 骨不变 → 旧 DIY pack / `.dshskin` 继续兼容。
- 复现 v2.6 资产：`npm run fetch:sources`（assets-src-v2）→ `npm run build:assets:v26`。

## 2.5.0 — 2026-11-05

「观感打磨：girl 肩侧烘焙后发全量拆件 + 双手细节精修（资产 v17/页面 v21）」

### 改进
- **girl 全量拆发（补全 v2.4 的「部分拆分」）**：新增 `hair-arm-girl` 发层（slot `strands`、z=66、65 骨不变、girl drawables 85→**86**），把 production `arm-upper-L` 纹理里被烘焙的 **3,207px 侧发碎片**（13 个 alpha 岛，含发丝+阴影/描边）拆成独立发层，权重/deform 取最近 production 发束顶点（含 shader head-yaw warp）。头转/歪头 ±25° 时与相邻发束的位移差 **46.51px → 0.47px（ratio 0.010）**，肩侧发丝不再「粘」在手臂上。手臂原像素 alpha 保留、RGB 按「拿掉发层后的 rest 合成色」重绘 → 头转不产生背景洞（浏览器 4x + 洋红洞 QA 通过）。
- **修复 v2.4（P3）被遮区补画 bug**：旧 BFS 源缓冲从不更新 → 抽出的 5,117px 发像素底层仍是蓝污染（torso 均值 RGB [114,129,156]）；改为收敛 nearest-fill + Telea fallback，只重绘「全 outfit 都被遮住」的像素（~4.9k px）；yaw/roll 暴露的蓝紫块 blueness>25 从 **2,688→618px**（剩余在尾鳍/深蓝影区，邻域本就深蓝）。顺带修正 `hair-back-girl` 的 mesh deform（P3 留 0 → yaw 时 7–15px 不连续）。
- **双手精修（chibi/girl × L/R 共 4 只手）**：interior-only 高频细节迁移（12 张 Seedream / ¥3.6，0 失败、0 安全过滤拒绝）；**alpha 逐像素不变** → 结构上不可能出现双描边/轮廓漂移；RGB 改善 chibi 446px/纹理、girl 714px/纹理（>6/255，chibi R 因配准最弱降权 0.45）。**收益温和**（1x 几乎无感，如实）；AI 整块重绘因轮廓 IoU 0.927–0.956（<0.98 门禁）被拒绝，只作内部细节源。
- **tail 审计纠正**：v2.4 交接里的「tail 19k 发色 px」实为**蓝色鲸尾鳍本体**（单连通域 18,806px，应随尾链物理解算）；tail 纹理内真发仅 527px old-white-hair 垫层（静置 521/527 被静态层盖住），**本轮保留**（删除需尾摆洋红门禁，未做）。
- **2x 手部纹理实验变体未发布**：本地可单页打包（girl/chibi 85 drawables、pixelEqual、VRAM +0.88/+1.10MiB），但 headless DPR1/DPR2 对比锐度差仅 +0.5–2.7%/+0.6–1.2%（噪声级）、契约有轻微偏离 → **不进发布**（如实记录）。
- 资产版本 **16→17**、页面模块 **v20→v21**（cache-bust）；chibi 契约不变（drawables/图集尺寸/显存不变，仅手部 RGB）；girl 图集 4094×1721→**4064×1779**（单页）、纹理显存 26.88→**27.58MiB**（+0.70）、rig +18,553B（gzip +3,955B）；65 骨/槽位/物理/旧 DIY pack 前缀兼容全部不变。

### 验证
- `npm run verify` **268/268**；v2.5 E2E **18/18**（4 组、0 retry/crash/pageerror，首屏 4 请求/2.29MiB、资产 v17/页面 v21、girl 显存 27.58MiB、active 37）；DIY E2E **4/4**（旧 59 骨 pack 配对渲染、`.dshskin` 导入导出）；4x 抓帧 9 张 0 pageerror。
- rest vs v2.4.0：未解释 chibi **0px** / girl **0–2px**（≤0.0002% 画布，门禁 0.1%）；静置洋红洞 6×2=**0**；girl yaw/roll ±25 new-hole=**0**（洞比 v2.4.0 更少）；构建确定性：A 变体双跑 atlas+rig md5 一致；npm pack **8.6MB / 12.5MB unpacked / 87 files**。
- **真机未测**：所有浏览器数字来自 headless Chrome + SwANGLE（无 GPU），FPS/显存不可代表真机。

### 已知限制
- 双手精修收益温和（alpha 不变、1x 几乎无感；4x 细节改善有限）；手部 2x 实验变体未发布。
- tail 白须 527px 保留（删需尾摆洞 QA）；arm 碎片权重为最近发束顶点拷贝，真实物理摆动下亚像素滑移未测。
- 真机（高 DPR/低端 GPU）未测；无 60fps 承诺。

### 升级
- 升级 profile/npm 后重启 DSH；rig/atlas `?v=17`、页面模块 `?v=21` 保证不吃旧缓存；65 骨不变 → 旧 DIY pack/`.dshskin` 继续兼容。

## 2.4.0 — 2026-11-05

「骨架升级：legBones（59→65 骨）+ girl 后发拆件（部分）+ 旧 DIY pack 前缀兼容」

### 新特性 / 改进
- **legBones（两身形）**：追加 `thighL/shinL/footL/thighR/shinR/footR`（索引 59–64，共 **65 骨**，原索引不变）；leg-L/R 按 y smoothstep 重权（hips→thigh→shin→foot）；腿 collider 增加 `aBone/bBone` 端点绑骨元数据；**当前无用户可见腿部动画**（静置与 v2.3 一致，chibi atlas 逐字节相同），为后续走路/抬腿打基础。
- **girl 后发拆件（部分）**：新增 `hair-back-girl`（hairBack z=10.5），从 body 提取 **5,117px** 发色像素独立成层（跟头/混合权重），body 被遮区 nearest-fill 补画；**仅部分拆分**：其余 ~19k px 在 tail/前发/衣下，未全量独立（诚实记录）。
- **兼容**：骨架版本化——runtime 允许 `packBones ≤ sceneBones` 前缀骨架（旧 59 骨 DIY pack 在 65 骨场景可用，`legacyBones` 标记）；`lib/diy-pipeline.js`/`bind_layers.py` 不再硬编码 59；collider capsule 端点绑骨向后兼容；`MAX_BONES 80`。
- 资产版本 **15→16**、页面模块 **v19→v20**；girl 显存 23.86→**26.88MiB**（新发层 +3.02），chibi 27.13 不变；rig gzip ≈356/337KiB。

### 验证
- `npm run verify` **268/268**（+5 骨架兼容测试）；v2.4 E2E **18/18**（0 retry/crash/pageerror，首屏 4 请求/2.28MiB）；DIY E2E 旧 4 个 59 骨 pack 在 65 骨场景 normalize/register/select/remove 全过、配对渲染、`.dshskin` 导入导出正常、0 pageerror；
- 静置洋红洞 6×2=0；腿弯 ±20/±30 0 洞；girl yaw/roll ±25 无背景洞；换装状态保留；npm pack 8.6MB。

### 已知限制
- girl 后发仅部分拆分（5.1k/27.5k px）；全量需 M2 重新分层（tail/前发/衣下区域）。
- legBones 暂无动画使用；裙 collider 跟骨未做（>±30° 腿/裙可能穿帮，未启用腿部动画）。
- 膝部细线为 M4b 腿件拼合缝（±30° 更明显）；rest girl 差 106–110px（AA 边）；双手未精修（v2.3 说明）；真机未测（headless SwANGLE）。

### 升级
- 升级 profile/npm 后重启 DSH；资产版本 v16/页面 v20 保证不吃旧缓存；旧 v2.1 `.dshskin` 仍走运行时迁移兜底。

## 2.3.0 — 2026-11-04

「细节精修：双脚 AI 精修（chibi + girl）——脚趾/趾甲/脚背更清晰，轮廓零漂移」

### 改进
- **双脚精修**（2 身形）：Seedream 局部精修（2 张 / ¥0.60），detail-transfer 合成（AI 高频细节 + 原图低频色调 + 低频纠偏 + 羽化 5px），**alpha/轮廓/坐标完全不变 → 零漂移**；4x 无接缝/色差。
- **双手保留原稿**：全身 Seedream 重绘手部出现 3–8px 错位/双描边，配准后仍不合格 → 按"不硬用"原则保留原稿（如实说明）。
- **色边根因**：旧 4x 预览的青色/品红彩边来自 JPG（非预乘 upscale + 色度子采样），非资产/合成引入；本轮预览改为预乘 alpha + PNG，并加确定性 defringe。
- 资产版本 **14→15**、页面模块 **v18→v19**；rig.json 与 v2.2 逐字节相同，仅 atlas 像素变化（+7.6/+8.2KB）。
- 文档：2.5D-RUNTIME / DIY-PACK / LAYER-MODEL 更新（仅像素变化，id/骨架不变，DIY 旧 pack 兼容）。

### 验证
- `npm run verify` **263/263**；v2.3 E2E **18/18**（4 组，0 retry/crash/pageerror；首屏 4 请求 / 2.28MiB gzip）；
- 静置洋红洞 6×2=0；换装/切换状态保留；DIY E2E（旧 3+新 1）4/4 配对/渲染通过、0 pageerror；
- 显存（headless SwANGLE，不可代表真机）chibi 27.13MiB / girl 23.86MiB（与 v2.2 持平）；npm pack 8.5MB。

### 已知限制
- 双手未精修（AI 不稳定）；脚踝上缘过渡带来自 P2 素材自身（已渐变弱化）；膝部细线为 M4a/M4b 腿件拼合缝（非本次引入）；girl 后发仍烘焙在 body；无腿骨；真机未测。
### 升级
- 升级 profile/npm 后重启 DSH；资产版本 v15/页面 v19 保证不吃旧缓存；旧 v2.1 `.dshskin` 仍走运行时迁移兜底。

## 2.2.1 — 2026-11-04

「修复：v2.2 cutout 后 DIY 套装缺少配对服饰（DIY 上衣光腿/没有下装）」

- **修复 DIY binder**（`tools/diy/bind_layers.py`）：pairing 不再写死 v2.1 base id，改为从 v2.2 cutout base rig 动态读取——top/coat/dress → v2.2 裙对（`sweater-plaid-skirt`/`-skirt-under` 等），bottom → v2.2 上衣/领/袖分件；记录 `pairingSource`。
- **修复已安装旧 pack**：runtime 新增 `migrateDiyPackOutfits`（`addOutfitPack` 注册前迁移 v2.1 引用到 v2.2 现有部件）；旧 dress/outfit 自动补裙对、bottom 自动补上衣；目标缺失安全置空 + warning，不抛错、不改 pack、不退回 v2.1 资产。
- 页面模块 cache-bust **v17→v18**（runtime 行为变更）；2.5D 资产版本仍 **v14**（资产未改）。
- **验证**：`npm run verify` **263/263**（+5 迁移/binder 测试）；DIY E2E 旧 3 pack + 新 1 pack（真实 Seedream 2 张 ≈¥0.6）选中后 `look.slots.bottom` 非空、bottom drawable 渲染、4x 有裙、0 pageerror；v2.2 E2E **18/18** 回归；npm pack 8.5MB。
- **说明**：v2.2.0 集成时 DIY E2E 只校验 drawable 存在/参数保留，未校验配对服饰，导致该回归漏过；本版补齐断言并如实记录。
- 迁移仅在运行时内存生效（旧 pack 文件仍含 v2.1 refs，重新导入会再次迁移）；如需彻底重写可用新 binder 重新生成。

## 2.2.0 — 2026-11-04

「素体重制：Live2D/Spine 式 cutout——分件 + 关节重叠余量 + 接缝补画，衣服更像穿在身上」

### 新特性 / 改进
- **素体 cutout（2 身形）**：body 拆为 torso / 上臂 / 前臂+手 / 腿 / 头 / 尾 等 13 个部件；服装按 6 组合 × 2 身形拆为 上衣躯干 / 领饰 / 上臂袖 / 前臂袖 / 裙 / 裙内衬；关节 8–12px 重叠余量、被遮挡区域确定性补画、2px 接缝 feather；水手服肩/袖、腋下、腰头、裙头接缝重做。
- **精致素体**：清理 body 层「白发烘焙 / 脸部模糊占位 / 隐藏区条纹」，统一肤色、补画腋下；全部确定性处理（Seedream 0 张）。手脚沿用旧线稿（未精修，如实说明）。
- **runtime**：新增 drawOrder 槽位 `legs/armUpper/armFore/hand/collar/sleeveUpper/sleeveFore`；单页大图集（chibi 4090×1739/85 drawables，girl 4085×1531/84）；`resolveLook` 组合套装优先；保留旧 rig 与 DIY pack 兼容层。
- **缓存**：2.5D 资产版本 `13→14`，页面模块 `v16→v17`。

### 数据 / 验证
- `npm run verify` **258/258**；v2.2 E2E **18/18**（4 组 fresh browser，0 retry/crash/pageerror）；DIY S1/S2/S3 真实 pack 回归通过；**静置洋红洞 6×2 = 0**；换装/身形切换状态保留。
- `npm pack` **8.5MB**（unpacked 12.3MB / 87 files）；2.5D 首屏 chibi **4 请求 / 2.27MiB（gzip）**（v2.1 为 1.55MiB）。
- 显存（headless SwANGLE 无 GPU，**不可代表真机**）：chibi **27.13MiB**（mipmap 36.18）、girl **23.86MiB**；保留 quality 降级档。

### 已知差异（接受并如实记录）
- rest 未解释差异 chibi 0.21–0.33% / girl 0.16–0.19%（1–2px 边缘级，4x 无白块/缺件/灰带）；
- 4x 下仍有 1px 细接缝线（1x 不可见）；girl yaw/arm 极少数 inside-body 背景洞 225–281px（0.028%）；
- 手脚未精修、girl 后发仍烘焙在 body、无腿骨（腿绑 hips）、hoodie 帽子随躯干（后续）。
### 升级 / 回滚
- 升级 profile/npm 后重启 DSH 生效；v2.1.x 可正常回滚（旧 rig/资产格式仍受支持）。

## 2.1.0 — 2026-11-04

「DIY 全链路：agent 一张衣服图 → 自动成层/绑定/QA → 可动 2.5D 套装（安装/删除/.dshskin）」

> DIY 仍**默认关闭**（`diy.enabled=false`）；开启后 agent 可通过 `dsh-feiyu-diy` CLI / `/diy` 命令调用。

### 新特性
- **agent 可调用宿主管线（S2）**：`dsh-feiyu-diy` CLI（plan/run/status/install/list/remove，单行 JSON）+ `/diy` 命令；
  `lib/diy-pipeline.js` 编排 generate（Seedream 2 张/件）→ split（Python 移植 M1 成层，无浏览器）→
  bind（增量 outfit pack）→ qa（宿主结构 QA）→ install（`~/.dsh/feiyu/diy/` + registry）。
  预算/缓存/内容守卫/脱敏沿用 M1；QA 未过自动 `fallback=static`；默认关闭、失败零污染。
- **可动 DIY 套装（S3）**：2.5D runtime 新增 `addOutfitPack/removeOutfitPack/getOutfitPacks`——
  运行时动态合并增量 pack（多纹理、按 drawable 纹理绑定、不重建 base 图集），参数/物理/时间/造型状态保留，
  移除时释放 VAO/VBO/纹理；页面 boot 从宿主读 registry，已安装套装进衣柜（🧵）选中即动效换装；
  QA fallback=static 走静态贴片提示；支持删除、`.dshskin` 导出/导入、面板刷新（生成后可见）。
- **宿主路由**：`GET /feiyu/diy/registry.json`、`GET /feiyu/diy/packs/<id>/...`（白名单路径）、
  `POST /feiyu/diy/remove`、`POST /feiyu/diy/import`；同源 + `x-feiyu-diy` 头；默认关闭时 404（最小暴露）。
- **文档**：新增 `docs/dress-up/DIY-PIPELINE.md`（S2 管线）与 `docs/dress-up/DIY-PACK.md`（增量 pack v1 + runtime API）。

### 数据（真实 Seedream，本分支实测）
- 3 件真实衣服端到端（top/dress/coat）：3/3 成功，6 张图 **¥1.8**，单件 **36.7–39.0s**，增量 pack **307–594KB/件**；
  split Python 移植对 M1 证据 8 件 IoU ≥0.9996；S3 动态加载 **42–82ms/件**、额外显存 **0.77–1.79MiB**，
  移除后资源计数回基线；E2E 全链路 0 pageerror（加载→衣柜→选中→动画→切 base→删除→刷新→`.dshskin` 导入恢复）。

### 兼容/回归
- `npm run verify` **248/248**（tsc + tests；新增 S2 管线 8 组 + S3 core/routes 测试）；页面模块 cache-bust **v16**，2.5D 资产版本仍 v13。
- 旧行为保留：M1 浏览器 DIY 静态衣柜、互动/经济/立绘卡不变；默认关闭时换装间无任何 DIY 网络请求。
- 已知限制：仅 chibi；真机未测；S3 的 QA 为宿主结构级 + S2 证据流程（runtime 帧视觉 QA 后续可加）。
- **验证**：`npm run verify` **248/248**；S3 E2E 全链路（真实 S2 pack）0 pageerror；npm pack 7.2MB（87 files）。
- **升级**：升级 profile/npm 后重启 DSH 生效；页面模块 cache-bust v16、2.5D 资产仍 v13；DIY 默认关闭，开启需宿主 `diy.enabled=true`。

## 2.0.1 — 2026-11-04

「修复：DIY 静态造型出现两层衣服 / 与衣柜选中项不一致」

- **修复（bugfix）**：选中 DIY 上传单品后，2.5D 页面仍绘制当前基础服装层，再叠加 DIY 全画布贴片 → 出现「两层衣服」，且身体显示与衣柜选中项不一致。现在进入 DIY 静态模式会先切到 `bare` 造型（只渲染身体/头发/脸，不渲染任何服装层），再叠加 DIY 贴片；清空/切出 DIY 后恢复原造型。
- 页面模块 cache-bust **v14 → v15**（index.html/app.js/runtime-2d5.js/core）；2.5D 资产版本仍 v13。
- 新增单测：`resolveLook({bare:true})` 不渲染任何服装层且无回退 warnings；页面源码不变量确保 DIY 路径先切 bare 再贴片。
- `npm run verify` **234/234**；E2E **18/18**（v15）。
- 说明：若升级后并非 DIY 造型也看到"两层衣服"，多为旧页面/缓存未刷新（强刷或重开换装间）；本补丁同时换 cache-bust 版本。

## 2.0.0 — 2026-11-04

「2.5D-only：删除 DOM 分层渲染路径（破坏性变更，用户拍板；需要 WebGL2）」

> **破坏性变更**：v1.0.0 的「DOM 分层纸娃娃 + 2.5D 双渲染」收敛为 **2.5D 单一可见路径**。
> 不支持 WebGL2 的浏览器/设备将**无法使用换装间**（仅显示文字提示 + 重试）；这是用户明确接受的取舍。
> 回滚：v1.x 仍可在 npm/git tag 安装；本版本不提供 DOM 回退开关（按设计删除）。

### 移除
- **DOM 人物渲染路径**：`docs/dress-up/app.js` 的 `.figure-layer` 建层/换装 DOM 渲染/B1-lite 脸部补丁（眨眼/口型/笑眼 DOM 层）/DOM↔2.5D 双模式切换与渲染方式按钮；`index.html` 的 `#figure`/`face-layer`/`renderBtn`；`style.css` 的 figure-layer/face-layer/render-btn 样式。
- **渲染开关与配置**：`config.dressUp.render`（`dom|2d5|auto`）、`?render=` URL 参数、`/feiyu/dress-up/render-config.json` 端点（改为 `client-config.json` 仅下发 interaction）。
- **DOM 人物资产与构建工具**：`docs/dress-up/art/{chibi,girl}`（素体/手臂/前发/衣物层/face 补丁）、`tools/{build_masks.py,build_wardrobe.py,prepare_dress.py,masks/}`。
- **静态兜底图**：无 WebGL2/context lost 不提供任何图片/人物兜底（用户 2026-11-04 明确），只显示纯文本提示 + 重试。

### 变更
- **2.5D 唯一路径**：页面 boot 即启动 runtime（按需加载当前身形 rig+图集），首屏 ≈1.5MB/4 请求（gzip）；切身形释放旧 GL 资源、状态保留。
- **manifest v8**：移除 `drawOrder` / `shapes[].layers` / `items[].layers`；保留分类/单品名称图标/背景/特效/台词/默认穿搭/DIY 声明。
- **DIY 改 canvas 静态贴片**：选中 DIY 条目时 runtime 冻结为静态帧、全画布贴片按槽位以 canvas 2D 叠加，UI 提示「DIY 造型为静态，不支持骨骼动画」；宿主 DIY 后端不变（默认关闭）。
- **资产的 DIY 参考掩膜**：`art/diy/masks/chibi/{body,hair,arms}.webp`（DIY 成层算法的不可见输入，非渲染资产，~200KB）。
- 页面模块 cache-bust 升 v14；2.5D 资产版本保持 v13（资产未变）。

### 兼容/回归
- `npm run verify` 全绿（tsc + **233 tests**）；`.scratch/v2/e2e.mjs` **18/18 用例、4 组 fresh browser 全绿**（2.5D-only 默认/换装/身形/眨眼口型/摸头喂食 HUD/DIY 静态贴片/无 WebGL2 纯文本/立绘卡/悬浮鲸鱼/reduced-motion/0 pageerror）。
- **包体**：`npm pack` **10.4MB**（解包 13.7MB，较 v1.0.0 11.0MB 减小）；2.5D 首屏 4 请求 ≈1.55MB（gzip），显存 chibi 17.14 / girl 16.65 MiB；README 换装间预览图已更新为 2.5D 实机画面。
- **真机未测**：性能/内存为服务器侧 headless（SwANGLE 无 GPU）数据，不可代表真机。

## 1.0.0 — 2026-11-03

「2.5D 换装上线（可选 · 默认关闭）+ 养女儿互动：从会眨眼的纸娃娃，到有骨架、会回应的看板娘」

### 新特性
- **2.5D 换装渲染（opt-in）**：自研 WebGL2 canvas 渲染器接入换装间——59 骨/15 链、LBS 蒙皮、头部跟随/歪头/点头（±25°）、呼吸、发丝/裙摆/尾巴 spring、眨眼/笑眼/口型、双身形（Q版/少女版）在线切换；`config.dressUp.render` / 页面「🧊 2.5D」按钮 / `?render=2d5` 三层开关；DOM 分层纸娃娃完整保留可随时回退，失败自动回退 DOM。
- **production 级 2.5D 资产**：6 件服装 × 2 身形（12 组合）2.5D 资产；每身形单张 lossless 图集（40/39 drawable → 1 纹理、1 请求），首屏 ~1.5MB/4 请求，显存 ~17MiB；posed body 孔 0、白毛衣发丝压衣 5655→0、alpha 完整性 0（M2 遗留 8px 已修）。
- **互动（养女儿向）**：摸摸头（点击头部）、喂食（小鱼干 3 / 大餐 8 鱼粮）、心情、亲密度、每日问候、待机台词；与鱼粮经济/状态账本联动（宿主强制冷却/日限/余额校验，失败零变更）；动作库点头/歪头/摸头反馈/喂食/打招呼，全部复用 2.5D 参数总线（59 骨同构）。21 条台词（保守/克制/陪伴日常，无身体评价、无暗示）。
- **性能/降级/内存**：2.5D 按需加载（默认 DOM 时 0 请求）；quality/DPR/物理 30Hz/mask/mipmap 开关；固定步长物理；纹理图集；服务器侧 headless 基准（**真机未测，不可代表真机**）。

### 兼容/回归
- DOM 分层纸娃娃路径零回归（立绘卡/悬浮鲸鱼/背景特效/B1-lite 脸动效照旧）；`?render=dom` 回滚；纯离线路径不变。
- `manifest` v7 不变；state v2（互动账本 additive，v1 自动迁移）；`npm run verify` 273/273（tsc + 测试）。
- 证据：M3 E2E 23/23、M5 E2E 24/24、M4 12 组合 gate 12/12、`ai-polish` 闭环报告（Seedream 补画不进 production，人工剩余 ≈20–30min/身形）。

### 已知限制（诚实）
- 真机性能/内存未测（服务器 headless SwiftShader 无 GPU）；2.5D 默认关闭，真机验证后再评估默认开启；无 60fps 承诺。
- 2.5D 模式暂不渲染 DIY 上传单品（切回分层模式可见）；girl 后发烘焙在 body（头转不跟随）；发束为自动分束、pose raw 外缘缝隙为非 gate 已知项；补画为隐藏区近似。
- DIY 上传（v0.11.0 起）默认关闭，行为不变。

## 0.11.0 — 2026-11-03

「DIY 上传 M1：把你拍的衣服穿到女儿身上（可选 · 默认关闭 · 纯离线路径不变）」

### 新特性（全部 opt-in，默认关闭；纯离线换装路径不变）

- **DIY 上传（换装间「✨ DIY 上传」）**：上传一张衣服照片 → 宿主本地代理调用云端图像 API
  （火山方舟 Seedream）生成「角色穿这件衣服」的 look + 同姿势 flat-color-out（#808080）→
  **浏览器本地 canvas 自动成层**（自适应阈值 diff / 补头发遮挡 / 拆袖 / 自动 QA）→ 预览确认 →
  IndexedDB 本地衣柜 → 用现有 7 槽位渲染直接试穿；支持删除/配额 LRU、`.dshskin` 导入导出。
- **宿主本地代理**（`lib/diy.js` + `lib/diy-provider.js`，路由 `/feiyu/diy/*`）：API key 只在宿主环境
  （`ARK_API_KEY`/`~/.config/seedream/env`），不进前端/日志/错误响应；每日图片数+金额上限、单次费用预估确认、
  重试 ≤2、hash 去重缓存、结构化成本日志（不含 key/原图/原始描述）。
- **内容硬守卫**（客户端+宿主双重，`docs/dress-up/diy-guard.js`）：暴露/超短/性感向/涉未成年人词表直接拒绝
  （不送 API）；偏短/贴身描述自动降级为保守版型；保守 prompt 模板 + 负向词。基于文本词表，图像分类器为后续项。
- **默认关闭 + 首次开启显式同意**：不开启/不生成时零网络请求；首次开启展示云端 API 费用/隐私说明，
  每次生成前费用确认；同意与开关状态存 localStorage（版本化，可撤销）。
- **manifest v7 DIY 扩展**（v6 数据语义不变，仅 version+1 并新增 `diy` 声明）：DIY 记录运行时经
  `diyRecordToItem()` 注入 `items[category]`，`resolveLayers` 零改动消费 blob URL 图层。
- **`.dshskin` v1 分享格式**：store-only ZIP（manifest.json + layers/*.webp + LICENSE/ATTRIBUTION），
  schema/版本/内容策略/路径穿越/sha256 校验；导入非法整包拒绝。

### 安全 / 隐私

- 浏览器只与本机宿主同源路由通信（自定义头 + Origin/Sec-Fetch-Site 校验挡 CSRF）；云端图片 URL 下载后立即丢弃。
- 成本日志/审计只记 sha256 摘要与命中词，不记原始描述；不新增遥测/外链；生成结果只存本机 IndexedDB。

### QA / 成本（2026-11-03 真实 API 实测）

- **8/8 件真实 API 成层通过**（M0 测试集 6 件 + 2 件新 Pexels 照片；含白色/浅色/深色/裙/连衣裙/外套/人物照）；
  自动 QA：α 洞 0、缺衣 0、背景残留 0、同姿势配准 0.03–0.65px、拆袖 bottom 无/top·dress·coat 有。
- 16 张图 = **¥4.8**（单件 ¥0.60 ≤ ¥2.5 gate）；端到端 API 时延 21–35s/件（≤3min gate）；0 失败、0 重试；
  ♻️ hash 缓存命中验证（0 费用）；内容守卫 3/3 拒绝且 0 费用。
- 本地成层 675×1200：安静窗口 warm 中位 **126–166ms**（共享 2 vCPU VM；单测以 CPU 时间 gate <200ms，
  高负载窗口 wall 会抖动，如实记录）；首次冷启动 ~0.5–1s，UI 在等待云端 API 时预热算法。
- `npm run verify` **194/194 tests** 全绿（新增 79 个：守卫/代理/预算/缓存/成层/记录/`.dshskin`/路由）。

### 已知限制

- 目前只支持 **Q版（chibi）** 身形；少女版接入为后续项。
- 内容守卫是文本词表（客户端+宿主），**图像分类器未做**，不宣称完全防护；API 侧对暴露/超短输入不拦截（M0 实测 2/2）。
- 白/浅色衣服依赖 flat-color-out（#808080）路径；成层质量受上传照片清晰度/人物照影响（人物照会整块成层，
  配饰/多件套不拆）；重抽有随机性。
- 本地成层为浏览器 canvas 像素处理：冷启动受 JIT 影响；共享 VM 上 wall 时延会随负载抖动。


## 0.10.1 — 2026-11-03

「下装裙型修复：裙子不再『放大罩上去』——从及膝在体 look 直接成层，零缩放」。

### 修复

- 用户反馈裙子像被放大罩上去、不合身。根因：下装层由 whiteout 单件图（AI 单独画的超短宽腰裙）经 `extra_scale`（chibi 1.72 / girl 1.40）整件放大，裙腰/裙长/格纹比例/裙摆宽度全部失真。
- 下装改为 `mode='look'`：先以旧 look 为参考做一次「只把裙子改长到及膝」的局部编辑（角色/脸/发/姿势/画布不变，裙外像素差 0.69%），构建时直接从这张及膝 look 检测腰带/裙腰/下摆/左右缘并裁出裙子层，**RGB 原样取自 look、零缩放、免配准**；上装 whiteout 路径不变。
- 量化：层 vs look 裙掩膜 IoU **0.281–0.530 → 0.9992–0.9994**；层高 **1.41–1.81× → 1.00×**；摆宽 **1.32–1.90× → 0.94–0.96×**；裙腰 top 与 look 精确对齐（942/945/1137/1174 源 px）；合成图 vs look 平均像素差 29.9–37.5 → 20.4–26.1；构建报告 `look_diff` chibi 51.08/47.19→35.41/34.31、girl 41.21/37.61→24.93/25.10。
- 保守长度：新 look 下摆距膝线 **5–89px（0.3–4.6% 身高，及膝/近及膝）**；旧 look 174–237px（9.1–12.3%，偏短）。
- 顺手修：构建原会把 B1-lite 的 8 张 `art/<shape>/face/*.webp` 当孤儿素材删除（首次构建实际触发，已恢复），`collect_referenced()` 已显式保留；manifest/schema/前端/tests 均未变；构建确定性：54 个 art+manifest md5 一致。
- QA：4x 四联（旧合成|旧 look|新合成|新 look）、14 组合、3x 接缝、洋红空洞 0、手部 0.99/1.00、长发 0.98、鬼影 3/5px 全 PASS；`npm run verify` **115/115 tests** 全绿。
- 已知：4 张 `*-knee.png` 源图在 `.scratch/feiyu-gen/raw12/`（未进 git，重建必需）；衣柜图标未随裙长重建（后续小项）。

## 0.10.0 — 2026-11-02

「会眨眼的纸娃娃：B1-lite 脸部叠加动画（眨眼 / 口型 / 笑眼，双身形）」。

### 新特性

- **运行时脸部特效层（不改 manifest/schema/构建管线）**：8 个由 Seedream 生成的透明补丁（每身形 4 个：闭眼 / 笑眼 / 口型微开 / 口型张开）；`app.js` 在 `.figure` 内插到 hair 之下（z-index = hair−1，DOM 最后插入），与 v6 drawOrder 兼容；补丁裁剪矩形/偏移常量在 `wardrobe-core.FACE_PATCHES`。
- **行为**：随机眨眼 2–6s（闭眼 ~110ms）、气泡显示期间 ~130ms 口型循环、偶尔笑眼 20–40s（1.2s）；`prefers-reduced-motion` 默认关闭，`?facefx=0/1` 强制开关，`window.__feiyuFace` 供 QA；纯定时器切 class/opacity，无 rAF、不重建 DOM。
- **导出策略 B**：立绘卡固定睁眼/闭嘴静态帧（实测眨眼态与睁眼态导出卡 sha256 相同）。
- **素材/成本**：Seedream 8 张 = **$0.24 ≈ ¥1.7**（8/8 成功、0 重试、107.4s）；补丁合计 **99.0 KiB**（lossy q95，alpha 无损）；关键帧位移 **8/8 = 0.00px@675**（整像素对齐）。
- **QA**：14 组合×2 身形×4 姿态 = 56/56 项 diff 100% 落在补丁 DOM 矩形内（最大外溢 0.9px）→ 无接缝/重影/错位；深色底 2x 放大无白边；动画开 57.9fps / 关 59.0fps、长任务 0、3s 内 `#figure` DOM 变更 0；`npm run verify` 108 → **115 tests** 全绿。
- **文档**：`LAYER-MODEL.md` §4 补充运行时脸部特效层说明；`tests/face-animation.test.mjs` 新增 7 个测试。

> 本条为 B1-lite（脸部动效）；2.5D 全绑定（C）POC 进行中，后续版本再上。

## 0.9.1 — 2026-11-02

「水手服露肩修复：白底单件图配准从『浅色衬衫主体 ↔ look 白色区域』改为『领结锚点配准』」。

### 修复

- 用户反馈水手服合成时**脖子/肩部露出素体皮肤**（v0.9.0 缺陷）。根因：look 里的水手服是**连体式**（衬衫 + 白色下装连成一片白色），旧配准拿「浅色衬衫主体」去配 look 的整片白色区域，被连体衣下摆拉偏缩小——少女版整体缩 6%（0.99 × `extra_scale 0.95`）、衣领偏下；Q 版下移 12 源 px。
- 新增**领结锚点配准**：用 whiteout 的亮蓝色领结做 probe、look 的亮蓝领结做 target，做 scale + 平移的 IoU 搜索（深蓝领子只用于框定领结区域——look 里领子外翼被头发遮挡、形状不一致，不参与匹配）；配准失败自动回退到原整件形状配准并在构建报告标记。
- 重建 `chibi/girl` 水手服 `body` / `sleeve` 4 个图层；其余素材、manifest、schema、前端均未变。
- QA：领结质心误差 **5.07 → 0.13（girl）/ 0.86 → 0.18（chibi）** 目标 px；配准 IoU **0.851 → 0.912（girl）/ 0.719 → 0.907（chibi）**；肩颈露肤像素（look 是衬衫而合成是皮肤）**girl 101 → 0**；洋红空洞 0、头发鬼影/手在裙前/长发盖衣/卫衣蝴蝶结等专项 QA 不回退；14 组合目检通过；构建连跑两次 md5 一致；`npm run verify` 108/108。
- 已知遗留：girl 水手服 whiteout 丢失 look 内衬上的小鲸鱼印花（v0.9.0 已存在，非配准问题，记入 `LAYER-MODEL.md` §6）。

## 0.9.0 — 2026-11-02

「图层叠加层次重做：7 槽位纸娃娃分层 v2（技术选型 + manifest v6）」。用户反馈「图层叠加层次关系还是不对」后，
先做缺陷取证与技术选型，结论是**问题不在渲染引擎、在素材分层与遮挡数据模型**：
v0.8 的「5 槽位 + 全局 z」只能表达一条直线上的先后，而真实穿着是分层夹心的。

### 取证（v0.8 → 修复前）

- **P0 手/前臂消失**：手在 `base(z=0)` 里，`bottom`/`top` 任意一层都在其上——组合模式手部真值像素可见率仅 0–5.6%（girl）/0–0.6%（chibi），女仆装 0%；裙子层单独就盖住手部 2871–3804px。
- **P1 长发截断**：`overlay` 只取「与头部相连」的蓝发块，手臂挡断的下半段发丝（girl 20,801px / chibi 17,249px）不在叠层里，衣服层又正好挖了头发洞 → 腰线附近发丝消失。
- **P1 水手服连体**：look/whiteout 生成成了连体式（含白色下装），整件盖在裙外像白色连体衣。
- **P1 少女版卫衣丢橙色蝴蝶结**：whiteout 里没有蝴蝶结。
- **P1 袖口/手前后关系无法表达**：长袖应盖住手臂、手在袖口外，单一上装 z 装不下。

### 技术选型（docs/dress-up/LAYER-ARCHITECTURE.md）

对比 DOM+CSS 多槽位纸娃娃 / Canvas2D 合成 / WebGL 逐像素深度 / 2D 骨骼（Live2D·Inochi2D·Spine）/ 3D VRM 五种方案；
结论 **继续 DOM+CSS，但把「固定 z」升级为「7 槽位 drawOrder + 身体部件拆层 + 衣服袖·身拆分」**。
理由：换 Canvas/WebGL 而不改素材分层，手依旧会消失；方案 A 零运行时依赖、纯本地离线、保留 v0.8 全部性能优化，
且与未来配饰层 / 骨骼动画兼容。Canvas/WebGL/骨骼的触发条件写入选型文档。

### 实现

- **manifest v6**：`drawOrder = body → topUnder → bottom → topBody → arms → sleeve → hair`；
  `shapes[].layers`（body/arms/hair）+ `items[].layers[shape][slot]`；删除 v5 的 `base/overlay/layer/z` 字段。
- **身体部件层（新）**：`tools/build_masks.py` + `tools/masks/<shape>/{arms,hair}.png`（1152×2048，人工 QA）：
  arms = 完整手臂+手（含描边）；hair = 完整前发（含手臂下方长发丝，排除尾巴与后背中央那缕，剔除低饱和亮投影）。
  `--check` 支持逐字节回归。
- **素材重建（build_wardrobe.py v6）**：每身形输出 `body/arms/hair.webp`；每件上衣/连衣裙拆成
  `*-body.webp`（衣身）+ `*-sleeve.webp`（袖子 = 衣身 ∩ 膨胀手臂掩膜，并用 look 真值手部区域减掉手）；
  衣服不再挖头发洞；水手服主体映射到 `topUnder`（下摆塞进裙子）；少女版卫衣从 look 补回橙色蝴蝶结；
  下装单层 `bottom-*.webp`；QA 新增 14 组合拼图 + 手在裙前 / 长发盖衣 / 鬼影 / 蝴蝶结 / 接缝 / 洋红空洞专项图。
- **前端**：`resolveLayers` 改为按 `drawOrder` 返回槽位层；`.figure` 按 drawOrder 动态创建图层 `<img>`
  （不再写死 5 槽位）；立绘卡与悬浮鲸鱼小图按同一 drawOrder 合成；cache-bust 升 `?v=10`；保留 v0.8 的
  点击路径性能优化（不变图层不动、DOM 不重建、异步合成小图、decoding=async）。
- **文档**：新增 `docs/dress-up/LAYER-ARCHITECTURE.md`（选型）与 `LAYER-MODEL.md`（v6 契约/验收），
  `PROMPTS.md` / `README.md` 同步更新；新增 `tools/masks/README.md`。

### 修复结果（视觉回测）

- 手/前臂在所有组合里都在裙子前面；长袖袖口正确盖住手腕、手在袖口外。
- 手臂下方长发丝补回，衣服不再出现「头发洞」；白衣服上的淡蓝鬼影（头发投影污染）清除。
- 水手服下摆塞进裙子（不再是连体衣盖裙外）；少女版卫衣橙色蝴蝶结恢复（build patch，3680px）。
- 已知近似：`hair` 为最上层，个别长袖肩侧发缕在真值里本应在衣服后，现表现为衣服上的短发缕硬边；
  掩膜边界 1–2px 保守外扩。均记录在 LAYER-MODEL.md §6。

### 变更

- 图层：5 槽位 → 7 槽位；每身形素材文件 8 → 13（body/arms/hair + 上衣 2 片 + 下装 1 片）
- 素材体积：约 1.6MB → 1.7MB（`docs/dress-up/art`）；运行仍零依赖、纯本地离线
- 内容基调不变：套装只留经典女仆装、及膝长裙、保守台词

### 验证

- `npm run verify`：`tsc --checkJs` + 全量测试全绿
- 浏览器回测：双身形 × 14 组合截图、7 槽位顺序、立绘卡、悬浮小鲸鱼、真机 /feiyu/dress-up/ 页面
- 素材构建一键复现：`python3 tools/build_masks.py && python3 tools/build_wardrobe.py ...`（含 QA 拼图）

## 0.8.0 — 2026-11-02

「养女儿向内容收敛 + 换装性能修复」：内容更保守（套装只留经典女仆装、裙长改及膝、互动台词改成陪伴向），
并修掉换装卡顿（同步 `toDataURL` / 背景重复淡入 / 图层 pop 动画 / drop-shadow filter / DOM 重建）。

### 性能（用户反馈「切换衣服很卡」）

- 实测定位（CDP Profiler）：每次换装同步 `canvas.toDataURL('image/webp')` 约 **33ms**，15 次操作累计 498ms；
  另外背景每次换装都重新淡入、5 个图层各自跑 pop 动画、`.figure` 上持续重算 `drop-shadow` filter、衣柜 DOM 每次重建。
- 修复：
  - 悬浮鲸鱼小图合成**移出点击路径**（debounce + `requestIdleCallback` + `canvas.toBlob` 异步编码）
  - 背景只在**切换背景时**才淡入；特效粒子只在切换特效时重建
  - 换装弹入动画改为**单个容器动画**（不再 5 张大图同时动）
  - 去掉 `.figure` 上随待机动画持续重算的 `drop-shadow` filter（地面接触阴影保留）
  - 衣柜/身形按钮**只更新选中态**，不再重建整个 DOM；`layoutFigure` 只在身形/背景变化时重算
  - 图层图 `decoding=async`

### 内容（养女儿向 / 保守）

- **套装（连衣裙）只保留「经典女仆装」**，移除星空礼服 / 草莓蛋糕裙 / 黑金哥特 / 森系花仙 / 樱花茶会 5 套（素材同步删除）
- **下装改及膝长裙**：格纹 / 深蓝百褶裙按顶部锚定放大（chibi ×1.72 / girl ×1.40），不再是小短裙
- **互动台词全部重写为陪伴/日常向**：删掉「不许偷看裙底」等不保守台词，新增「今天也要好好吃饭呀」「你回来啦」等
- 文档补充内容基调：`docs/dress-up/DESIGN.md` 顶部写明「养女儿向、衣服保守、台词克制」为最高优先级

### 变更

- 物品：6 件（1 连衣裙 + 3 上衣 + 2 下装），图层 6/身形；素材体积进一步下降
- README / PROMPTS / DESIGN 同步更新；版本 0.8.0

### 验证

- `npm run verify`：`tsc --checkJs` + 全量测试全绿
- 浏览器实测：换装点击延迟与 long task 对比（CDP Profiler）、保守内容/台词语义检查、双身形、立绘卡、悬浮鲸鱼

## 0.7.0 — 2026-11-02

「真正的分层换装」：从「整套穿着立绘」升级为**纸娃娃分层系统**（素体 + 衣服图层 + 头发叠层），
组合数从预生成矩阵 O(N²) 变成运行时 O(N)，为后续「用户上传衣服 / 配饰层」打底。

### 重做

- **分层换装引擎**：每个身形 = **素体（base）+ 头发/尾巴叠层（overlay）+ 11 件衣服图层**；
  运行时按 z 序叠图：`base(0) → 下装(20) → 上装(30) → 头发叠层(100)`；套装（连衣裙）与上衣/下装互斥。
- **组合数 O(N)**：3 上衣 × 2 下装不再预生成 6 张组合图，任意上衣 + 下装即时合成；
  以后新增衣服只要加一张图层，不用重跑组合矩阵。
- **图层天然对齐**：所有单件 look 都穿在**同一张素体**上生成（构图/位置/比例由参考图继承），
  图层从 look 抠出即可，不需要手工锚点/配准：
  - 白色上衣：白底单件图（whiteout）+ 形状 IoU 配准（水手服额外用「浅色衬衫主体」做 probe）
  - 彩色下装：白底单件图配准 + 按衣服顶部中点锚定放大（保证上衣下摆下还能露出裙摆）
  - 彩色连衣裙：look 与素体的像素差主连通块 + 填洞 matte
- **新素体**：白色无肩带连体泳衣（bandeau），抹胸礼服/无袖上衣的肩线不再露出白色肩带。
- **头发叠层**：衣服图层在头发处留洞，最上层 overlay 用素体原画头发/尾巴补回，**头发永远在衣服前**。
- **前端**：5 个固定图层槽位渲染（只更新变化图层、preload 防闪烁、未变元素不重建、renderSeq 防连点竞态）；
  立绘卡按 z 序合成 900×1350；悬浮小鲸鱼改用离屏合成的 184×327 透明 WebP data URL。
- **manifest v5**：`shapes[].base/overlay/bounds` + 单品 `layer.{chibi,girl}` + `z`；
  删除旧整套立绘（24 张）与顶层 `bounds`，素材体积 4.1MB → 2.3MB。

### 工具

- `tools/build_wardrobe.py` 重写为 v5 分层构建：线稿灌水/像素差 matte、whiteout 形状配准、
  头发叠层提取（蓝发连通块 + 描边）、premultiplied 缩放（消除半透明灰边）、
  **原子写**（先 `.tmp` 再 rename，构建中打开游戏不会读到半截图）、manifest 重建 + QA 拼图。

### 验证

- `npm run verify`：`tsc --checkJs` + **99 tests** 全绿（wardrobe-core v5 解析规则 / 素材完整性 / 本地静态路由）
- 浏览器实测：组合 6 组 × 2 身形、6 连衣裙 × 2 身形、换装不缩放跳动、立绘卡、刷新恢复、窄屏、悬浮小鲸鱼数据
- 真机 DSH 验证（本机 profile 升级后）

## 0.6.0 — 2026-10-30

「换装间体验重做」：改成经典左右布局，右侧衣柜只放衣服，人物站进场景里，悬浮鲸鱼不再误触跳转。

### 变更

- **左右布局**：左边舞台（场景 + 人物），右边衣柜面板（身形切换 / 分类 / 衣服网格 / 操作按钮），不再用底部抽屉
- **右侧衣柜只放「衣服本身」**：新增 11 张纯衣服图标（连衣裙 / 上衣 / 下装），不再用「穿好衣服的人」当缩略图
- **人物站进场景**：每张背景声明地面线 `floor`，人物脚底对齐地面 + 接触阴影，配合暗角/环境光不再是「壁纸前贴一个人」
- **人物动起来**：待机浮空/呼吸/轻摆，点击会蹦跳 + 说话，换装时立绘弹入，鼠标移动带视差
- **悬浮小鲸鱼交互修正**（对齐 dsh-pet 习惯）：
  - 左键点击只做互动（蹦跳 + 说话），**不再跳转插件页**
  - 拖动移动并记忆位置
  - **右键菜单**：打开换装间 / 隐藏小鲸鱼
  - 插件面板底部新增「🐋 显示中 / 已隐藏」开关，可随时恢复
- 游戏页与插件面板共用 `feiyu:petHidden` 状态

### 验证

- `npm run verify`：tsc + 82 tests 全绿（素材测试改为校验「只有衣服」的图标 + 背景地面线）
- 真机 DSH 验证：左右布局、右侧纯衣服图标、人物站位、悬浮鲸鱼左键不跳转/右键菜单打开换装间

## 0.5.0 — 2026-10-30

「把衣服真正穿在身上」：换装间推倒重做——从「衣服图层贴图」改成 **整套穿着立绘**，并支持 **Q版 / 少女版双身形**。

### 重做

- **整套穿着立绘**：用 Seedream 图生图，以自建素体为参考，直接生成「同一角色、同一姿势、穿好整套衣服」的完整立绘；换装 = 换整套立绘，衣服永远是穿在身上的，不再有「图层浮空 / 盖不住」的问题
- **双身形切换**：Q版（三头身）/ 少女版（六头身），各有独立的 6 套连衣裙 + 上衣×下装组合立绘
- **混搭手感**：上衣 3（毛衣/卫衣/水手服）× 下装 2（格纹/百褶）= 6 组预生成组合立绘，选上衣/下装自动切到组合模式
- **素体重做**：白色连身打底裙（不是内衣）；保留呆毛卷环、鲸鱼耳鳍（修正为脸两侧的鳍而不是猫耳）、蓝色渐变长发、鲸鱼尾巴
- 默认穿搭 = 经典女仆装；背景 6 张 + 粒子特效 4 种可任意搭配
- **渲染前端重写**：单张立绘渲染 + bounds 自动缩放、身形切换按钮、随穿搭换装的悬浮小鲸鱼
- **核心逻辑抽成纯函数模块** `docs/dress-up/wardrobe-core.js`，Node 测试直接覆盖穿搭规则

### 工具

- 新增 `tools/build_wardrobe.py`：白底转透明（保持构图）、统一 675×1200 WebP、生成缩略图、量 bounds、重建 manifest
- 素材管线文档 `docs/dress-up/PROMPTS.md` 全面重写（素体提示词、整套立绘提示词、构建流程）

### 移除

- 删除 v0.4 的「分层衣服图层」素材（gown/coat/hat/base）与相关合成逻辑

### 验证

- `npm run verify`：tsc --checkJs + 换装核心 11 个用例 + 素材完整性 5 个用例 + 原有 53 个用例

## 0.4.0 — 2026-10-30

「真正的换装小游戏」：换装间从 6 张图轮播重做成**分层换装游戏**，立绘换成高清版本，并且离线可用。

### 新增

- **换装间 2.0**（`docs/dress-up/`）：分层渲染 + 衣柜抽屉
  - 衣柜分 5 类：**大裙子 8 / 外套 3 / 头饰 5 / 背景 6 / 特效 4**，组合随意混搭
  - 高清底座换成 YunYueSama 1024px Q 版大肥鱼立绘，显卡式清晰度（不再是 306px 放大）
  - 全新 AI 生成素材：2 条大裙子、2 件外套、4 个头饰、6 张场景背景；裙子图层带裙腰接触阴影，与身体贴合更自然
  - 舞台支持场景背景 + 飘雪 / 花瓣 / 星光粒子特效，点击角色会说随机台词
  - 随机换装、保存立绘卡（背景 + 分层立绘 + 文案，900×1350）、图鉴（26 件全收录）
  - 深链参数：`?gown=starry&coat=winter&hat=whale&bg=bg-snow&effect=snow`
- **悬浮小鲸鱼**（`shell.overlay`）：跟随当前穿搭换装的迷你立绘，可拖动、位置记忆，点一下打开换装间
- **本地静态路由**：换装间与全部素材由宿主 `lib/webserver.js` 在 `/feiyu/dress-up/` 提供，**离线可用**，不再依赖 GitHub Pages；仅 GET/HEAD、拒绝目录穿越、未知路径 404
- **图层管线工具**：`tools/compose_dress.py` 支持 base/gown/hat/full 子命令统一 900×1500 画布 → 720×1200 WebP；`tools/make_thumbs.py` 生成衣柜缩略图

### 变更

- 换装间素材目录从 `docs/dress-up/dresses/` 迁移到 `docs/dress-up/art/`（分层 + 缩略图）
- 侧边栏主面板 iframe 改指本地路由 `/feiyu/dress-up/?embed=1`
- 立绘版权说明更新：底座 YunYueSama（「大肥鱼项目署名许可 1.0」）、AI 图层 Moss、角色版权链仍为 上善无形「溟月」→ ZipZipPipe 女仆鲸鱼娘（CC BY-NC-SA 4.0，非官方，禁止商用）
- 测试：新增换装间静态路由 14 个用例 + 素材完整性用例（总数 53 → 70）

### 验证

- `npm run verify`：tsc --checkJs + 70 tests
- 插件内 UI 截图验证：侧边栏入口、分层换装、背景/特效、图鉴、悬浮小鲸鱼

## 0.3.0 — 2026-10-30

「换装小游戏」定位落地：插件装好后，**侧边栏出现 🎀 换装间入口**，点开即玩。

### 新增

- Web 客户端半区（`lib/client.js`）：`sidebar.panellist` 侧边栏入口 + `main` 主面板
- 主面板内嵌换装小游戏（经典二创女仆鲸鱼娘 + 6 套大裙子）
- 嵌入模式（`?embed=1`）：隐藏重复品牌/页脚，舞台自适应面板尺寸
- 游戏页仍托管在 GitHub Pages，后续可切到宿主本地静态路由（离线可用）

## 0.2.0 — 2026-10-30

「换装是视觉性的」：补齐出图能力，可直接发 QQ 群 / 评论区。

### 新增

- `/fish png [尺寸]`：渲染当前穿搭的 PNG（默认 768，可选 256–1600）
- `dsh-feiyu-report --png <path>` / `--size <像素>`：CLI 直接出图
- PNG 合成：360×360 场景 + 底部水印条（repo 地址 + 鱼名 + 饲养天数）
- 依赖 `@resvg/resvg-js`（预编译二进制，本地渲染，无浏览器/无网络）
- 新增 `screenshots.json`（插件市场 / awesome 列表详情页展示卡图）
- README 增加「接 QQ / 聊天机器人」章节

### 验证

- `npm run verify`：tsc --checkJs + 53 tests

## 0.1.0 — 2026-10-30

第一个公开版本：把 DSH 的 token 花销变成大肥鱼的衣柜。

### 新增

- `/fish` 命令：状态、衣柜、购买、换装、脱下、改名、生成报告卡
- 鱼粮经济：每次模型调用按 DeepSeek 官方峰谷价折 CNY，`1 CNY = 100` 鱼粮币（可配置）；出生礼 120 币
- 亲密度（0–100 六级）与心情（五档，表情随心情变化）、连续天数
- 21 件原创 SVG 单品：背景 4 / 身体 4 / 颈部 3 / 面部 3 / 手持 3 / 头部 4；稀有度普通 / 稀有 / 史诗
- 原创胖鲸形象（不打包任何画师二创素材）
- `dsh-feiyu-report` CLI：`--demo` / `--open` / `--out` / `--sheet`
- 1080×1440 饲养报告卡（自包含 HTML，无外部资源）
- 本地状态文件（原子写、schema 归一化、每日台账裁剪、会话列表上限）
- 49 个测试：定价、经济、状态迁移、渲染、命令、CLI

### 说明

- 纯本地：无额外模型调用、无网络请求、不保存聊天原文
- 社区插件，非 DeepSeek 官方项目
