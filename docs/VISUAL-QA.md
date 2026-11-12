# 视觉门禁（2.5D 换装间 · 1x/2x 像素回归）

> 范围：`docs/dress-up` 换装间在 headless Chrome + SwANGLE（无 GPU）下的**静态像素回归**。
> 执行器：`scripts/visual-qa.mjs`；基线：`docs/qa-baseline/`；报告默认 `<repo>/.visual-qa/reports/`（可用 `--out` 指定；本仓库开发时的门禁报告在 `.scratch/p7/visual/reports/`，不入仓）。
> 它只回答「画面有没有变 / 变在哪」，**不代表真机 FPS、显存、GPU 行为**；行为回归仍由 E2E（`npm run verify` + `.scratch/p5/runtime/reg-e2e.mjs`）覆盖。

## 快速开始

```sh
cd <repo>

# 门禁（默认 compare；版本/基线异常 exit 2，像素超阈值 exit 1）
npm run visual:qa
# 等价：node scripts/visual-qa.mjs --mode compare

# 生成/更新基线（必须人工 review 后再提交，见下文「基线更新流程」）
npm run visual:qa -- --mode baseline
# 等价：node scripts/visual-qa.mjs --mode baseline

# 指定报告目录（默认 <repo>/.visual-qa/reports）
node scripts/visual-qa.mjs --mode compare --out /tmp/feiyu-visual-qa-reports
```

环境变量（一般不用设，默认值即本机环境）：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `FEIYU_PLAYWRIGHT` | `/tmp/extract/node_modules/playwright-core/index.mjs` | 不新增 npm 依赖，复用本机 playwright-core |
| `FEIYU_CHROME` | `/usr/bin/google-chrome` | headless Chrome 可执行文件 |
| `FEIYU_VISUAL_OUT` | `<repo>/.visual-qa/reports` | 报告输出根（`--out` 优先） |

单进程串行：本机内存 3.6GB，脚本一次只开一个浏览器、一个页面；**运行前确认没有其他 agent 在抓帧**（脚本会在检测到已有 Chrome 进程时打印警告），跑完自动关闭浏览器并回报进程数。

## 覆盖矩阵（80 张）

| 维度 | 取值 |
|---|---|
| 身形 | `chibi`、`girl` |
| 造型 | `base`（素体 cutout）、`maid`、`hoodie-plaid`、`hoodie-pleated`、`sailor-plaid` |
| 1x 全身 | 画布区 675×1200（DPR1），JPEG **q82**，合成背景 `#808a99` |
| 2x 关键局部 | 膝 / 手 / 肩 / 脚 / 腹 / 发 / **颈**，DPR2 画布裁切（2x 设计像素），JPEG **q85** |

- 2x 区域**不是写死坐标**：由各身形 `rig.json` 的骨骼关节（shin/shoulder/foot/hips/head/**neck**）与部件 rect（hand-L/R、body-torso、hair-front-bangs）推导，记录在 `docs/qa-baseline/manifest.json` 的 `regions`；rig 布局变了而资产版本没升会直接 fail。
- `neck` 区域（v3.0 新增）：以 `neck` 骨为基准，覆盖「下巴淡影 → 领口露颈 → 锁骨上缘」；用于回归 v3.0 露颈相关的假脖子/烘入皮肤/肌腱亮条/颈脸色差（见 `QA-REGISTRY` D-018/D-019）。
- 抓帧统一走 runtime 的「静态 QA 模式」：`freeze(true)` + `setAuto(false)` + `setQuality('high')` + `setMipmaps(false)` + `setStatic(true)`（物理回 rest）+ `setFaceOverride({eye:'open',mouth:'closed'})` + 90 tick 衰减 boot 残留的眨眼/笑眼/tap/head-follow 计时器。**不要随意改动这段顺序**，否则帧间不可复现（历史教训：boot 里随机眨眼会把「半眨眼」抓进基线，compare 出现数千像素伪差异）。
- 基线体积硬上限 **3MiB**（v3.0.0 基线 80 张，新增 10 张 neck 2x 局部）；超限 `--mode baseline` 直接失败。
- 当前基线版本：**页面 v27 / 资产 v24**（v3.0.0 paper-doll 整层资产；v2.7.0 起 `sweater-plaid` 造型由 `hoodie-plaid` 替代）。

## 版本门禁（cache-bust）

两种模式都会检查，异常 exit 2：

1. `docs/dress-up/**/*.{html,js,css,json}` 内所有 `?v=<n>` 必须**只有一个值**（页面模块版本）；`app.js` 的 `RUNTIME_2D5_ASSET_VERSION` 必须存在（资产版本）。
2. 实际浏览器请求里的 `?v=` 必须与源码一致：`art/2d5/**` 用资产版本，其余页面模块用页面版本；缺带版本号的 `rig.json`/`atlas.webp`/`runtime-2d5*.js` 请求也 fail。
3. compare 额外要求：当前资产/页面版本 **以及** `art/2d5/{chibi,girl}/rig.json`、`atlas.webp` 的 sha256 与基线 manifest 完全一致。**改了资产没升资产版本（或漏改页面 `?v=`）一律 fail** —— 这类错误会让线上用户吃到旧缓存，必须显式修版本号再重生成基线。

## 判定口径与退出码

- 「变更像素」= 当前图与基线图解码后**单通道最大差 > 10/255** 的像素。
- 允许上限：1x 全身 ≤ **0.02%** 画布像素；2x 局部 ≤ **0.10%**。超限即失败，并输出差异像素数、最大色差、差异 bbox，以及红标差异图（`report.html` 可点开逐图对照）。
- 退出码：`0` 通过；`1` 像素超阈值 / pageerror（页面报错 0 容忍）；`2` 版本或基线前置条件失败（版本不一致、基线缺失/损坏、rig 区域变化、体积超限等）。
- 报告目录（每次运行新建，`latest` 指向最近一次 compare）：`report.json`（机器读）、`report.html`（人看，含当前/基线/差异图链接）、`fresh/`、`baseline/`、`diff/`。

## 验收清单（人眼 + 数字）

每轮视觉相关改动（资产/渲染/runtime）在 `npm run visual:qa` 通过之外，按下列清单人工复检报告中的图：

### 1x 全身（5 造型 × 2 身形）

- [ ] **无肉眼可见接缝**：头发分束、身体/断肢切口、躯干与腿/尾的接缝处没有亮线/暗线/错位。
- [ ] **无双色/叠色**：透明切口边缘没有色边（尤其深色发丝切在浅色皮肤/衣服上），补画区颜色与周围连续。
- [ ] **无白线**：套装（女仆/卫衣/水手服）袖口、领口、裙腰、裙摆与身体交界处没有 1–2px 白描边。
- [ ] **腹部/肚脐自然**：素体腹部无横切接缝、肚脐形状/位置正常；服装下腹部无破面。
- [ ] **发层遮挡正确**：前发/后发/侧发遮住应遮的身体区域，没有发片浮在衣服前或衣服盖住头发。

### 2x 关键局部（膝/手/肩/脚/腹/发/颈）

- [ ] **接缝 ≤1px AA**：相邻部件（腿-膝、手-腕、袖-肩、脚-踝、发-发）接缝处只有 ≤1px 抗锯齿过渡，没有双描边/错位台阶。
- [ ] **色差 ≤12/255**：接缝两侧相邻像素 RGB 最大通道差 ≤12（报告里 diff 阈值 10/255 的标记可作近似定位；人工量色用 4x 放大图或原图取样）。
- [ ] **手部**：腕缝连续、手指轮廓无重影/双描边（对应 `QA-REGISTRY` 的「手部线稿粗糙」）。
- [ ] **头发**：发束分层边缘无白色硬边、无「发色垫层」露出（对应 tail/后发相关缺陷）。
- [ ] **领口露颈（v3.0 新增门禁）**：领口内看到的是**真实素体颈部**（不是服装上烘入的假脖子；头动时颈部随头动）；颈部无两条竖肌腱亮条/「肉须」、无重阴影；下巴下方有**极淡下巴影**保证下巴可辨（不能完全无阴影导致「没下巴」）；颈部肤色与脸/胸口连续（Lab ΔL ≤6、Δa/Δb ≤3；左右对称部位无明显色差带）。对应 `*/{all}/neck-2x` 与 `QA-REGISTRY` D-018/D-019。

### 隐藏区（姿态变化不露底 / 不穿帮）

- [ ] 头转 / 歪头 **±25°**：肩侧发丝随头动，颈/肩无背景洞、无蓝紫补画块。
- [ ] 尾摆 **±25°**（或等效尾链摆动）：尾鳍/发层不露底、不出现洋红/背景色空洞（洋红洞像素 = 0）。

> 说明：隐藏区检查是**姿态相关**的，本门禁的 baseline 只抓 rest 静态帧，因此不在 70 张内自动覆盖。
> 回归方式：静态部分看 1x/2x（本门禁）；±25° 与洋红洞用开发机上的临时抓帧/洋红洞分析脚本（`.scratch/p5/runtime/capture-runtime.mjs`、`.scratch/p5/rig/qa/`，**均未入仓**）执行，结论登记到 `docs/QA-REGISTRY.md`。2.6 起如需自动化，可把姿态抓帧作为 `visual-qa` 的第三个模式扩展（新增基线会增大体积，需要另行评审 3MiB 预算）。

## 基线更新流程（重要纪律）

`docs/qa-baseline/` 是**受审的视觉契约**，不是调试缓存：

1. **什么时候更新**：
   - 资产版本或页面模块版本变化（`RUNTIME_2D5_ASSET_VERSION` / `?v=`）且视觉差异**符合预期**；
   - 有意的视觉改动（新造型、修接缝、调色）已在 `docs/QA-REGISTRY.md` / CHANGELOG 记录。
2. **步骤**：
   1. 在 worktree 里先跑 `node scripts/visual-qa.mjs --mode compare`，确认失败项与本次改动预期一致（防止把无关回归混进新基线）；
   2. `node scripts/visual-qa.mjs --mode baseline`（报告在 `--out` 指定目录；当前基线 70 张 ≈2.28MiB，上限 3MiB）；
   3. **逐张人工 review** 新基线（尤其本次改动涉及的 1x/2x 图），用 `git diff --stat docs/qa-baseline` 确认只有预期图片变化、无无关文件增删；
   4. 在**同一次提交**中：资产/渲染改动 + 版本号（资产版本 & 页面 `?v=`）+ `docs/qa-baseline/**` + CHANGELOG 条目，一起提交；禁止仅提交基线而不提交对应视觉改动（或反之）；
   5. 提交前再跑一次 `node scripts/visual-qa.mjs --mode compare`，必须 **0 变更图**（证明基线与当前代码自洽、可复现）；
   6. 版本一致性：`scripts/release.mjs` 会校验 package.json/CHANGELOG/README 的版本与页面/资产版本探测值。
3. **不要做**：为了让 compare 通过而在没 review 的情况下直接重生成基线；不要把 `--mode baseline` 当成修复手段——先定位差异来源。

## 与缺陷登记表（docs/QA-REGISTRY.md）的关系

- `QA-REGISTRY.md` 记录**已知、未修或已修待验**的视觉缺陷；本门禁是这些缺陷的「回归探测器」：缺陷修复后，对应 1x/2x 图必须呈现修复后的画面，并把基线更新到修复态。
- 对照关系（门禁图 → 覆盖的登记项）：

| 登记项（示例 ID） | 覆盖图 | 备注 |
|---|---|---|
| 膝盖接缝 / 双色 | `*/base/knee-2x`（全部 5 造型也有） | 1x 全身同时目检 |
| 服装 1–2px 白线 | `*/{maid,hoodie-plaid,hoodie-pleated,sailor-plaid}/shoulder-2x` 等 | 袖口/领口在肩部特写内 |
| 手部线稿粗糙 | `*/{all}/hand-2x` | 腕缝在肩/手特写之间交叉看 |
| 腹部/肚脐 | `*/base/abdomen-2x`（服装下腹用 1x） | |
| 后发/发束分层 | `*/{all}/hair-2x` + 1x | |
| tail 白须垫层（527px） | 1x 全身（rest 静置被遮，可能不可见） | **rest 帧覆盖不到姿态暴露**；需 ±25° 尾摆抓帧，见 `QA-REGISTRY` 回归方式 |
| 高 DPI 发虚 / 真机未测 | 不覆盖 | 属真机项，不在 headless 像素门禁内 |
| 露颈假脖子 / 烘入皮肤 / 肉须 / 颈脸色差（D-018/D-019） | `*/{all}/neck-2x` | v3.0 起；同时由 `tests/garment-hygiene.test.mjs` 的「服装贴图烘入皮肤=0」断言兜底 |

- 新增缺陷时，请在 `QA-REGISTRY.md` 的「回归方式」列写明「`npm run visual:qa` 的哪张图 / 是否需姿态抓帧」；本文件不再重复登记。

## 已知限制

- headless SwANGLE 无 GPU：渲染路径与真机 GPU 不同（AA/滤波细节可能有差异），**本门禁只能证明像素没退化**，不能证明真机观感。
- 基线依赖 Chrome/SwiftShader 版本：Chrome apt 大版本升级后可能出现非预期伪差异（AA 变化）。处理：先人工对比确认无真实回归，再重生成基线并在 PR/CHANGELOG 记录 Chrome 版本。
- 只覆盖 rest 静态帧 + 页面初始化（首个造型前有 600ms 落定等待）；物理摆动中的动态帧不在门禁内。
- `base`（素体）造型在页面 UI 里没有入口（页面默认只有 maid + 上衣/下装组合），门禁通过 runtime 公开 API `setLook({outfit})` 直接切到 rig 里的 5 个 cutout 造型；造型是否正确挂载由脚本内的部件断言保证（不允许静默 fallback）。
