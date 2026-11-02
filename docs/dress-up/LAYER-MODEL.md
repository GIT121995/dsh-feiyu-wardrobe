# 换装分层模型 v6（纸娃娃分层 v2）· 设计契约

> 状态：v0.9.0 实施中。本文是 **素材构建 / manifest / 前端渲染** 三方的唯一契约。
> 背景：v0.8 的「5 槽位 + 全局 z」表达不了三层以上遮挡（手/前发/袖口/裙腰），
> 用户反馈「图层叠加层次关系还是不对」。v6 把画布拆成 **7 个深度 strata（槽位）**，
> 用「身体部件层 + 衣服按手臂掩膜拆袖/身」表达正确的遮挡。

## 1. 槽位（drawOrder，从下到上）

| # | slot | 内容 | 来源 |
|---|------|------|------|
| 0 | `body` | 素体（含手臂、前发、尾巴的原始画，作为底） | 每身形 1 张 |
| 1 | `topUnder` | 塞进裙子里的上衣主体（水手服这种「下摆应被裙子盖住」的） | 单品可选 |
| 2 | `bottom` | 下装（裙子，盖住腿；手臂层在它之上 → 手在裙前） | 每下装 1 张 |
| 3 | `topBody` | 上衣/连衣裙主体（下摆盖在裙子外） | 每上衣/连衣裙 1 张 |
| 4 | `arms` | 手臂+手（在衣服之上；长袖的袖口由 `sleeve` 再盖回来） | 每身形 1 张 |
| 5 | `sleeve` | 袖子 = 衣服 ∩ 手臂掩膜（盖在手臂上，解决「手消失 / 袖子被手盖」） | 每上衣/连衣裙 1 张 |
| 6 | `hair` | 完整前发（含手臂下方那段长发丝；最上层，永远在衣服前） | 每身形 1 张 |

- `topUnder` / `bottom` / `topBody` 互斥关系由穿搭状态决定：套装（连衣裙）走 `topBody+sleeve`；上衣+下装走 `top*(+sleeve) + bottom`。
- 水手服默认用 `topUnder`（下摆塞进裙子），毛衣/卫衣/女仆装用 `topBody`。
- 每件单品可以在 manifest 里给不同身形分别指定槽位文件；没给的槽位 = 不渲染。

## 2. manifest v6 契约

```json
{
  "version": 6,
  "drawOrder": ["body", "topUnder", "bottom", "topBody", "arms", "sleeve", "hair"],
  "shapes": [
    {
      "id": "chibi", "name": "Q版", "desc": "...",
      "bounds": { "top": 0.04, "bottom": 0.9725 },
      "layers": {
        "body": "art/chibi/body.webp",
        "arms": "art/chibi/arms.webp",
        "hair": "art/chibi/hair.webp"
      }
    }
  ],
  "categories": [ ... 与 v5 相同 ... ],
  "items": {
    "outfits": [
      { "id": "none", "name": "不穿套装", "emoji": "🚫", "desc": "..." },
      { "id": "maid", "name": "经典女仆装", "desc": "...", "icon": "art/icons/maid.webp",
        "layers": {
          "chibi": { "topBody": "art/chibi/layers/dress-maid-body.webp", "sleeve": "art/chibi/layers/dress-maid-sleeve.webp" },
          "girl":  { "topBody": "art/girl/layers/dress-maid-body.webp",  "sleeve": "art/girl/layers/dress-maid-sleeve.webp" }
        } }
    ],
    "tops": [
      { "id": "sweater", "name": "白色高领毛衣", "desc": "...", "icon": "art/icons/sweater.webp",
        "layers": { "chibi": { "topBody": "...", "sleeve": "..." }, "girl": { ... } } }
    ],
    "bottoms": [
      { "id": "plaid", "name": "格纹百褶裙", "desc": "...", "icon": "art/icons/plaid.webp",
        "layers": { "chibi": { "bottom": "art/chibi/layers/bottom-plaid.webp" }, "girl": { ... } } }
    ],
    "backgrounds": [ ... 与 v5 相同 ... ],
    "effects": [ ... 与 v5 相同 ... ]
  },
  "defaults": { ... 与 v5 相同 ... },
  "bubbles": [ ... 与 v5 相同 ... ]
}
```

- 删除 v5 的 `shapes[].base/overlay`、`items[].layer`、`items[].z`，统一为 `shapes[].layers` / `items[].layers`（按身形嵌套）。
- `versions < 6` 不再兼容（插件包内自洽，不存在旧 manifest 混用）。

## 3. 素材构建（tools/build_wardrobe.py v6）

输入新增掩膜（源分辨率 1152×2048，`tools/masks/<shape>/`）：

- `arms.png`：手臂+手（含手臂轮廓描边，略保守）。由肤色分割 + 上肢连通块 + 侧向阈值半自动生成，人工 QA。
- `hair.png`：**前发**（含手臂下方那段长发丝、呆毛），**不含尾巴**，也**不含「后背中央那缕头发」**。
  注意（Lead 实测）：素体上有一缕长发从裆部往下垂在两腿之间（girl 约 46×188px @x564-608/y1216-1402；
  chibi 约 42×144px @x546-586/y1475-1618），那缕在基础画里是「后面的头发」，真值 look 里裙子/围裙都把它盖住，
  所以必须留在 `body` 里（被衣服遮住），不能进 `hair` 最上层——否则会在裙面/围裙上出现一道深色竖线。
  判定规则：连通块质心 x 在身体中心 ±4.5% 身宽内 且 bbox 顶部在身体上缘 +55% 身高以下 → 排除。

构建步骤：

1. `body.webp`：与 v0.8 的 `base.webp` 相同（保留整张素体，含手臂/头发/尾巴，作为最底层）。
2. `arms.webp`：`body RGB` + `alpha = arms_mask × foreground_alpha`，premultiplied 缩放到 675×1200。
3. `hair.webp`：`body RGB` + `alpha = hair_mask × foreground_alpha`，premultiplied 缩放。
4. 每件衣服（沿用 v0.8 的 whiteout 配准 / diff matte 得到整件 alpha）：
   - **主体层**（`<cat>-<id>-body.webp`）：整件衣服 alpha **不挖洞**（头发洞由 `hair` 最上层盖回；手臂由 `sleeve` 盖回）。
     manifest 里再按单品映射到 `topBody` 或 `topUnder` 槽位（水手服 → `topUnder`）。
   - **袖子层**（`<cat>-<id>-sleeve.webp`）：`alpha = garment_alpha × dilate(arms_mask_target, 6px)`，羽化 1px；
     再用 look 真值的袖口/手部区域减掉手部，防止配准误差让袖口盖住手。
     这样长袖会盖住手臂、短袖只盖住上臂、无袖没有袖子层；两层 RGB 完全相同，重叠处无接缝。
   - 下装只有一张（`bottom-<id>.webp`），放 `bottom` 槽位。
   - 已知补丁：少女版卫衣白色单件图丢了橙色蝴蝶结 → 构建时从 look 的橙色像素补回 body 层（QA 有断言）。
5. manifest v6 + `pet-default.webp`（按 drawOrder 合成默认穿搭）+ QA 拼图。
6. 旧 v5 素材（`base.webp/overlay.webp`、无 `-body/-sleeve` 后缀的旧图层）清理。

## 4. 前端渲染（docs/dress-up/）

- `resolveLayers(manifest, state)`：返回 `[{ slot, file, z }]`，`z = drawOrder.indexOf(slot)`，按 z 升序。
  - 恒含形状层 `body/arms/hair`（无文件则跳过）；
  - 套装非 none → 套装层的槽位；否则下装层 + 上衣层；
  - 找不到文件/槽位非法 → 跳过，不抛错。
- `app.js`：按 `manifest.drawOrder` **动态创建** `.figure-layer` img（不再写死 5 个槽位），
  `renderFigure` 按 slot 取元素；未用到的槽位 `hidden`。导出立绘卡 / 悬浮鲸鱼小图都按 resolveLayers 顺序合成。
- `index.html`：`.figure` 里不再放 5 个固定 img；缓存版本号升 `?v=10`。
- 约束：点击路径里仍禁止同步 `toDataURL`；图层数从 5 增到最多 7（实际 7 槽位里通常只用到 5–6 个），
  仍然只更新变化图层，不能每帧重绘。

## 5. 验收标准（v0.9.0 回测）

1. 手/手臂不再消失：所有上衣×下装组合（2 身形 × 3×2）手都在裙子前面；长袖袖口正确盖住手腕、手在袖口外。
2. 完整前发：手臂下方那段长发丝在所有穿搭里都可见、在衣服前（不再在腰线附近突然消失）。
3. 衣服不再有「未补的头发洞」：叠在纯洋红背景上合成时，人物内部不得出现洋红空洞。
4. 无皮肤色块盖在衣服上（胸口/领口/肩部）；无袖子/衣身接缝亮线（2x 放大检查）。
5. 水手服下摆塞进裙子（不再是「白色连体衣盖在裙外」）；女仆装、毛衣、卫衣下摆正常盖在裙子外。
6. `npm run verify` 全绿（tsc --checkJs + 全部测试，含新 v6 断言）。
7. 真机页面：:3080 顶替后 `/feiyu/dress-up/` 实测 14 种组合 + 双身形 + 立绘卡 + 悬浮小鲸鱼。
8. 性能不回退：换装点击延迟 < 100ms、long task = 0（沿用 v0.8 的 CDP 测法）。

## 6. 已知遗留（不在 v0.9.0 范围）

- **水手服素材本身是连体**：`raw12` 的 `girl/chibi-only-top-sailor.png` 生成成了连体式（含白色下装），
  v6 用「topUnder 塞进裙子」规避视觉问题；彻底修复需重新生成该 look/whiteout（下一轮）。
- **少女版卫衣丢了橙色蝴蝶结**：look 有、whiteout 无。v6 先用「从 look 补橙色像素」的 build patch，
  若补不干净下一轮重新生成 whiteout。
- 头发与手臂的真实前后关系（个别发丝在手臂后）用「hair 最上层」近似；如出现发丝压手，可再拆 `hairBack` 槽位。
  实测副作用：长袖毛衣/卫衣的肩侧发缕会以 1–2px 深色发丝盖在衣服上（真值 look 里个别本应在衣服后），非洞、可接受。
- 掩膜由 CV+人工 QA 生成，边界 1–2px 误差；build 里 `arms` 略保守、`sleeve` 膨胀 6px 兜底。
