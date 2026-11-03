# DIY 上传（用户衣服 → 自动成层）· M1 契约与实现说明

> 状态：v0.11.0 候选（feature 分支 `feat/diy-upload`；**默认关闭、全部 opt-in**）。发布由 Lead 按发版纪律执行。
> 背景：M0 spike 已证明「garment ref + 素体 → Seedream look → 同姿势 flat-color-out → diff 成层」路线成立
> （`.scratch/m0-diy/REPORT.md`）。M1 补齐：宿主代理/预算/守卫/自动成层/本地衣柜/`.dshskin`/测试。
> 目标：用户上传一张衣服照片，得到能在换装间穿的分层图层；**不破坏纯离线路径**。

## 1. 定位与默认关闭

- 换装间「✨ DIY 上传」是 **opt-in**：宿主配置 `diy.enabled=false`（默认）时，路由只提供只读 status，
  **不发起任何网络调用**；打开面板也不会请求外部资源。
- 首次开启需要**显式同意**（费用/隐私说明），每次生成前还需**费用确认**；同意/开关状态存
  `localStorage`（`feiyu:diy:consent` / `feiyu:diy:enabled`，版本化 `diy-consent-1`，可撤销）。
- 纯离线能力（换装/背景/立绘卡/悬浮鲸鱼/报告卡）完全不依赖 DIY，关闭时行为与 v0.10.1 一致。

## 2. 架构

```
换装间页 (docs/dress-up/, 浏览器)
  │  POST /feiyu/diy/generate （同源、自定义头 x-feiyu-diy:1）
  ▼
DSH 宿主 (lib/diy.js 路由 + lib/diy-provider.js)
  │  内容守卫 → 预算/确认 → sha256 缓存 → Seedream ×2
  ▼
火山方舟 Ark（doubao-seedream-5-0-flash-260915，1152×2048）
  │  look（参考图1=素体 + 参考图2=用户衣服）→ flat-color-out #808080（参考图=look）
  ▼
浏览器本地 canvas 成层（docs/dress-up/diy-layers.js，675×1200）
  → 预览（look / 图层 / 合成）+ 自动 QA → IndexedDB 本地衣柜
  → diyRecordToItem() 注入 manifest.items → 现有 7 槽位渲染试穿
```

| 文件 | 作用 |
|---|---|
| `lib/diy.js` | prompt 包、预算台账、hash 缓存、成本日志、生成服务、HTTP 路由、mount |
| `lib/diy-provider.js` | Ark 客户端：key 只读宿主、重试 ≤2、错误脱敏、下载/校验图片 |
| `docs/dress-up/diy-guard.js` | 内容守卫纯函数（词表/降级/prompt 负向词；浏览器+宿主共用） |
| `docs/dress-up/diy-layers.js` | 浏览器 canvas 自动成层纯算法（diff/阈值/补头发/拆袖/QA） |
| `docs/dress-up/diy-store.js` | IndexedDB 本地衣柜、配额/LRU、开关/同意状态 |
| `docs/dress-up/diy-skin.js` | `.dshskin`（store-only ZIP）导入导出 + schema/sha256 校验 |
| `docs/dress-up/diy-ui.js` | 面板 UI 编排（上传/预览/入库/删除/导入导出/错误重试） |
| `docs/dress-up/art/diy/base-chibi.png` | 宿主生成 look 的参考图1（Q版素体，1152×2048，随包发布） |

## 3. 开启方式

宿主配置（`cordis.patch.yml` 的插件 config，改完重启 DSH）：

```yaml
- id: feiyu-wardrobe
  name: dsh-feiyu-wardrobe
  config:
    diy:
      enabled: true
      dailyImageLimit: 40    # 每日图片张数上限（默认 40）
      dailyBudgetYuan: 10    # 每日金额上限 ¥（默认 10）
      # model / size / retries / pricePerImageYuan / apiKeyFile / 路径类高级项见 config.js
```

API key：宿主环境 `ARK_API_KEY`，或 `~/.config/seedream/env`（`ARK_API_KEY=...`），可用 `diy.apiKeyFile`
覆盖。**key 只从宿主读取**，不进前端代码、路由响应、成本日志或错误消息。

## 4. 宿主代理（D1）

### 4.1 路由（prefix `/feiyu/diy`）

| 方法/路径 | 说明 |
|---|---|
| `GET/HEAD /feiyu/diy/status` | 开关/key 是否就绪、模型/尺寸、预估费用、今日额度/缓存/守卫/存储声明（**无 key**） |
| `POST /feiyu/diy/generate` | 生成 1 件（look + flatout）；JSON body：`{category, description, imageDataUrl, consent, confirmCost, reroll}` |

安全：只接受 `application/json` + 自定义头 `x-feiyu-diy: 1`；校验 `Origin`/`Host` 与 `Sec-Fetch-Site`
（同源），挡跨站 CSRF 触发付费；请求体上限 8MB；错误统一 `{ok:false, code, message, ...}`，5xx 只记脱敏后日志。

### 4.2 生成链路

1. 开关/`ARK_API_KEY` 检查 → 拒绝时 403/503；
2. `consent===true` 与 `confirmCost===true` 检查（否则 403/400 + 预估）；
3. 内容守卫（见 §5）：`reject` → 422、**不送 API**、只记 sha256 审计；`downgrade` → 用改写后描述继续；
4. 上传图解码（只收 png/jpeg/webp data URL，≤4MB）→ sha256；
5. cache key = sha256(上传图摘要 + model + size + prompt 版本 + look/flatout prompt + reroll)，
   命中直接返回（0 次 API、0 费用，写 `cache_hit` 成本日志）；
6. 预算护栏：每日图片数/金额上限（并发请求先占额度，防同时超支）；超限 → 429 `daily_image_limit`/
   `daily_budget_exceeded`；
7. Seedream：look（素体 + 用户衣服）→ flatout（look 改 #808080）；单张重试 ≤2（4xx 除 429 不重试）；
8. 成功写结构化成本日志；失败也记账（部分成功 = 已消耗张数）；返回图片 data URL（云端 URL 下载后丢弃）。

### 4.3 成本日志（JSONL，`<DSH home>/feiyu-wardrobe/diy/costs.jsonl`）

字段示例：`{ts, dayKey, event:'generate'|'generate_failed'|'cache_hit'|'guard_reject'|'budget_block',
requestId, category, guardAction, model, size, promptVersion, cacheKey(16), seed, images, costYuan,
latencyMs, attempts:{look,flatout}, code?, message?}`。
**不含**：API key、原图、原始用户描述（只有 `descriptionSha256` 前 16 位）、云端图片 URL。

## 5. 内容守卫（D4 · 硬拦截）

- 词表（`diy-guard.js`）：暴露/泳装/内衣/低胸/露肤、超短/热裤/紧身、性感向、**涉未成年人一票否决**；
  归一化（NFKC/全角/零宽/空格/大小写）防绕过。
- 决策：`reject`（不送 API，客户端+宿主双重）/ `downgrade`（短袖→长袖、短裙→及膝、紧身→宽松，
  UI 显式展示改写结果）/ `pass`。
- prompt 模板：固定角色锁定（外观/姿势/比例/纯白背景/平涂）+ 保守着装约束 + 负向词；衣物描述只来自
  守卫清洗后的文本。
- 实测（M1 QA）：3/3 不合规输入端到端拒绝（`content_rejected`），**0 次 API、¥0**；降级样例通过。
- **诚实边界**：这是文本层守卫，M0 实测 API 对暴露/超短输入 **2/2 不拦截**；图像分类器为后续项，
  不宣称完全防护（默认关闭 + 显式同意 + 费用确认 + 用户自担上传版权共同兜底）。

## 6. 本地自动成层（D2）

输入：look / flatout（1152×2048 → 675×1200）、现有 `art/chibi/{hair,arms}.webp` 的 alpha 掩膜。
输出：`bodyAlpha`（+ top/dress/coat/outfit 的 `sleeveAlpha`）、自动 QA 指标与分级。

1. **自适应阈值**：`|look−flatout|` 最大通道差；阈值 [40,30,22,16,12,9] 取「面积首次达 3% 画布」的
   最高阈值（浅色衣服自动降阈值）；衣服区域限制在角色 bbox、头部以下。
2. **闭运算/填洞/连通块**：补头发/描边细通道，去除零碎噪声（拓扑运算在 1/2 分辨率做，4× 提速）。
3. **fill-under-hair**：行级反投影——同一行在衣服 α 左右极值之间、被前发覆盖的像素补 α；
   再 fill-holes。隐藏区 α 只保证被头发遮住时不可见。
4. **拆袖**：`sleeve = α ∩ dilate(arms, 6px)`，减手部区域（手臂 bbox 下部几何 + look 露肤），羽化；
   bottom 不拆袖。
5. **全分辨率边缘精修**：α 上采样后用全分辨率 diff 收 1px 边 + 羽化（避免 1/2 分辨率阶梯）。
6. **自动 QA**：α 洞、缺衣/露底、背景残留、白边（深色衣不透明边界近白占比）、同姿势配准（look↔flatout
   剪影质心平移/IoU，阈值 2px）、衣柜颜色分类（白/浅色）、拆袖面积；输出 `pass/needs-fix/fail` 与缺陷列表。
7. **性能**（675×1200 单件，含 QA）：安静窗口 warm 中位 **126–166ms**；共享 2 vCPU 高负载窗口 wall 会抖动
   （如实记录），单测以 CPU 时间 gate `<200ms`；首次冷启动 ~0.5–1s，UI 在等待云端 API 时预热算法。

## 7. manifest v7 + 本地衣柜（D3）

- `manifest.version=7` 仅新增 `diy` 声明（见 `LAYER-MODEL.md` §7），v6 数据语义不变；运行时 DIY 单品
  `{id:'diy-…', layers:{chibi:{topBody|bottom: blobURL, ...}}}` 注入 `items[category]`，`resolveLayers` 零改动。
- IndexedDB（`feiyu-diy/items`）记录：`{id, name, category, shape:'chibi', layers:{body Blob, sleeve?},
  source:{type,license}, contentPolicyTag, createdAt, lastUsedAt, bytes, guardVersion?, promptVersion?}`；
  `id` 由上传图 sha256 派生（同图重复入库去重）。
- 配额：24 件 / 24MB；超限按 LRU（lastUsedAt/createdAt）淘汰，刚保存的 keepId 受保护；支持删除/统计/失败重试。
- 生成预览：look / 图层（棋盘格）/ 试穿合成（按 v6 drawOrder 本地叠图）+ QA 数字；`fail` 不可入库，
  可重抽（换 seed → 换 cache key，真正重新生成）或换图。

## 8. `.dshskin` v1（本地分享）

store-only ZIP（无压缩、无外部依赖）：

```
manifest.json      schema：format=dshskin/version=1/app/item/layers[{slot,file,bytes,sha256}]/contentPolicy/license
layers/body.webp   衣身层（必需，≤2MB）
layers/sleeve.webp 袖子层（可选；bottom 不允许）
LICENSE.txt        garments 版权归上传者/分享者；代码 MIT
ATTRIBUTION.txt    来源、内容策略、仅本地个人使用提示
```

导入校验：ZIP 结构/EOCD/条目名（拒绝对路径、目录穿越、反斜杠、重复）、method 必须 store、
单文件 ≤2MB、总大小 ≤12MB、manifest schema/版本/品类/内容策略标签、图层文件存在 + `sha256` 一致；
任何一项不过 → **整包拒绝、不落盘**。导出文件名做危险字符清洗。全程本地文件，不经服务器。

## 9. 隐私与数据流

- 上传图只在生成时以 data URL 发给**本机宿主**，宿主再发云端 API；不写服务器磁盘、不落日志。
- 云端返回图片下载后立即转 data URL 返回浏览器，URL 丢弃；生成结果与记录只存浏览器 IndexedDB。
- 无遥测、无新增外链；成本日志只含元数据与 sha256 摘要。
- 用户可随时关闭开关、删除单件、清空 IndexedDB；撤销同意（清除 consent key）后开关自动失效。

## 10. M1 真实验收（2026-11-03，Seedream 实调）

- 测试集：M0 6 件（白衬衫/米色 henley/格纹裙/玫瑰连衣裙/泰迪外套/人物照）+ 2 件新 Pexels 照片（白T恤/灰衬衫）。
- 结果：**API 8/8 成功、成层 8/8 pass**（α 洞 0、缺衣 0、背景残留 0、配准 0.03–0.65px、拆袖符合品类）；
  16 张图 **¥4.8**（单件 ¥0.60）；端到端 API 时延 **21–35s/件**；0 失败/0 重试；缓存命中验证（¥0）、
  守卫 3/3 拒绝（¥0）。证据：`.scratch/diy-m1/qa/QA-MATRIX.md` / `api-run.json` / `layers/*/preview.png`。
- UI 端到端（Playwright + mock provider，真实页面/真实路由）：26/26 检查通过——默认关闭→同意→守卫拒绝 UX→
  生成→预览→入库→blob 图层试穿→刷新持久化→删除→导出/导入 `.dshskin`→无外链/无 key 泄露。

## 11. 已知限制 / 后续项

1. 仅 **Q版（chibi）**；少女版需补素体参考图与回归（预计 1–2 人天）。
2. 内容守卫为文本词表，**图像分类器未做**；API 不拦暴露/超短（M0 2/2），不能宣称完全防护。
3. 白/浅色衣服依赖 flat-color-out；人物照会整块成层（配饰/多件套不拆，M0 已知）；成层质量受照片清晰度影响。
4. 本地成层冷启动受 JIT/负载影响（已在等待 API 时预热）；共享 VM 上 wall 抖动，单测用 CPU 时间 gate。
5. 未做：云端失败自动换 seed、批量导入、跨设备同步（明确不做服务器存储）、皮肤包社区码。
