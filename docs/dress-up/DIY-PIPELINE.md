# DIY 流水线（S2 · agent 可调用宿主管线）

> 目标：用户给一张衣服图片，**DSH agent 自动把官方管线后半段跑完**：
> `plan → generate（Seedream look/flatout）→ split（宿主 Python 成层）→ bind（自动绑定增量 pack）→ qa → install`。
> 全程宿主侧（Node + Python，**无浏览器依赖**）；默认关闭（`config.diy.enabled=false`）、内容守卫/预算/缓存复用 M1。
> 相关：S1 绑定 spike 见 `.scratch/diy2/REPORT.md`；增量 pack 格式见 `.scratch/diy2/S2-S3-PACK-SPEC.md`；
> 下一步 S3 负责 runtime 动态加载这些 pack。

## 1. 快速开始

```bash
# 1) 预览（不花钱）：校验图片/品类/守卫/预算，创建 job
dsh-feiyu-diy plan --image ~/photos/shirt.jpg --name 白衬衫 --category top

# 2) 跑完整流水线（显式开启；会产生 2 张 Seedream 费用 ≈¥0.6）
dsh-feiyu-diy run --job <jobId> --enabled --verbose

# 3) 查看结果 / 已安装
dsh-feiyu-diy status --job <jobId>
dsh-feiyu-diy list

# 4) 删除
dsh-feiyu-diy remove --id <itemId> --dry-run
```

- `run` 完成自动 install（无需单独 install）；也可 `install --job <id> [--dry-run]` 重装/预演。
- **单行 JSON** 输出（stdout 恰好一行；进度日志走 stderr，需 `--verbose`）。
- `--home <dir>` 覆盖 DIY 数据目录（测试/多 profile）；`--state <state.json>` 覆盖 wardrobe 状态路径。
- 默认关闭：未启用 `diy.enabled` 时 `run/install` 返回 `diy_disabled`；`--enabled` 是显式开启（等价用户同意）。

## 2. 命令契约（所有输出单行 JSON）

| 命令 | 关键输出 |
|---|---|
| `plan --image <path> [--name][--category][--shape chibi][--description][--reroll 0-9]` | `{ok, job, itemId, category, shape, estimate:{images:2,costYuan,etaSec}, guard:{pass,action}, budget:{ok,snapshot}, warnings, hints}` |
| `run --job <id> [--stage generate\|split\|bind\|qa\|install\|all] [--force]` | `{ok, job, itemId, stages:{...}, qa:{pass,grade,fallback}, install:{itemId,animated,fallback,packDir,registry}}` |
| `status --job <id>` | `{ok, job, status, stages, stageData, qa:{pass,grade,fallback,checks,metrics,warnings}, install, artifacts, warnings}` |
| `install --job <id> [--dry-run]` | `{ok, itemId, animated, fallback, packDir, registry, static?}` |
| `list` | `{ok, home, registry, count, items:[{id,name,shape,category,animated,fallback,qa,packDir,...}]}` |
| `remove --id <itemId> [--dry-run]` | `{ok, id, removed, registry}` 或 `{ok, dryRun, wouldDelete}` |
| `version` / `help` | 基本信息 / usage |

错误输出：`{ok:false, code, message, details?, hints?}`；退出码 0 成功 / 1 失败 / 2 参数错误。

### 错误码 → 建议

`diy_disabled` 开启 DIY / `guard_rejected` 换图或描述 / `missing_api_key` 配置宿主 key /
`api_failed` 稍后重试 / `split_failed` 换白底挂拍图 / `bind_failed` 回退静态或报 bug /
`qa_failed` 看 qa.json 或回退静态 / `budget_exceeded`、`daily_image_limit`、`daily_budget_exceeded` 今日额度 /
`image_missing|image_too_small|image_too_large|image_unsupported` 输入问题 / `unsupported_category|unsupported_shape` 参数 /
`job_not_found|not_found` id 问题。

## 3. 阶段与产物

| 阶段 | 实现 | 产物（`<diy-home>/jobs/<job>/`） |
|---|---|---|
| generate | lib/diy-provider（Seedream 2 张；预算/缓存/重试/脱敏） | `gen/look.png`、`gen/flatout.png` |
| split | `tools/diy/split_layers.py`（M1 浏览器算法 Python 移植；diff 自适应阈值/fill-under-hair/拆袖/羽化/QA；`.scratch/diy-m1` 8 件回归 IoU≥0.9996） | `layers/body.png`、`layers/sleeve.png`、`layers/split.json` |
| bind | `tools/diy/bind_layers.py`（官方 rig 同口径网格/权重/裙链；**增量 pack，不复制 base rig**） | `pack/diy-pack.json`、`pack/tex/*.webp`、`pack/bind-report.json` |
| qa | 宿主结构 QA（格式/网格/UV/权重/纹理/覆盖率/成层分级） | `qa/qa.json`（未过 → `fallback=static`，不阻塞安装） |
| install | 复制到 `<diy-home>/packs/<itemId>/` + 原子写 registry | `<diy-home>/registry.json`、`jobs/<job>/install.json` |

数据布局（默认 `~/.dsh/feiyu/diy/`）：

```
registry.json           # 已安装索引（页面/S3 消费；v1 见 PACK-SPEC §3）
packs/<itemId>/         # 增量 pack + tex/ (+ static/ 回退贴片)
jobs/<job>/             # 中间产物（可清理）
```

## 4. agent 用法（命令 or CLI）

- **DSH 命令**：`/diy plan --image /abs/path ...`、`/diy run --job <id>` …（与 CLI 同一流水线，返回 JSON 文本块）。
- **CLI**：agent 通过 bash 调 `dsh-feiyu-diy ...`（推荐长任务：`run` 会等 2 张图生成，约 40–90s）。
- 约定：图片只传**本地路径**，不把 base64/大图塞进上下文；API key 永不出现在 stdout/日志（错误已脱敏）。
- 长任务建议：`plan` 拿到 job 后后台 `run`，再用 `status` 轮询（job 目录内状态文件）。

## 5. 安全 / 预算 / 默认关闭

- 默认关闭：`diy.enabled=false` 时 `run/install` 直接拒绝；plan 只读校验也可用于预览。
- 内容守卫：plan 阶段对描述执行 `diy-guard`（硬拦截拒绝且**不送 API**；downgrade 自动收敛描述并 warning）。
- 预算：沿用 M1 `createDiyLedger`（`dailyImageLimit=40`、`dailyBudgetYuan=10`、单价 `pricePerImageYuan=0.3`），
  generate 前检查、成功逐张记账（成本 JSONL 不含 key/原图/原始描述）。
- 缓存：`createDiyCache`（sha256(图+prompt 包+模型/尺寸/版本)），命中零费用。
- 失败零污染：任何阶段失败只写 job 状态，不动 registry/已安装 pack；`--force` 可重跑。

## 6. 自动 QA 口径（S2 宿主侧）

必过项（任一失败 → `fallback=static`，安装为静态贴片而不是可动套装）：

| 检查 | 阈值 |
|---|---|
| split 分级 | `grade != fail`（M1 同口径：α洞/缺衣/背景残留/白边/配准） |
| pack 格式/版本 | `feiyu-diy-pack` v1 |
| drawables | 1–2 个（衣身 + 可选袖子） |
| skeleton 同构 | `base.skeletonBones == 59` |
| 网格 | positions/uvs/bones/weights/indices 完整；UV∈[0,1]；index 合法；≤4 骨；Σw≈1 |
| 纹理 | 文件存在、≥512B、texSize 与图片一致 |
| 覆盖率 | `alphaCovered ≥ 0.97`、`coverageIoU ≥ 0.75`、α 面积 0.4%–32% |
| outfit | 存在 `diy-<id>` 且引用自身 drawable |

S1 spike 的视觉 QA（静置合成帧 diff/posed 光流/4x/发丝压衣/换装回归）在 `.scratch/diy2` 证据中；
S3 会把它接入 runtime 级 QA（渲染真帧后复测）。**真机未测。**

## 7. 已知限制（S2）

1. 仅 `chibi` 身形（girl 绑定后续 1–2 天）。
2. QA 宿主结构级（尚未跑 runtime 渲染帧；S3 接 runtime 后补视觉 QA）。
3. 增量 pack 尚未被页面消费（S3：runtime `addDiyPack`/registry 路由/IndexedDB/.dshskin）。
4. 品类自动识别未做：`--category auto` 默认 top + warning；建议 agent/用户显式传品类。
5. 失败回退静态贴片的页面渲染路径沿用 M1（S3 统一）。
6. 长任务建议放后台；`run` 为同步等待（2 张 API ≈20–70s）。
