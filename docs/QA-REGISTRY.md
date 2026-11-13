# 已知缺陷登记表（QA Registry）

> 维护者：每次发版前更新；新增缺陷给唯一 ID，修完后回填「修复版本/证据」，**不得删除条目**（`wontfix` 也保留）。
> 关联文档：[`docs/VISUAL-QA.md`](VISUAL-QA.md)（1x/2x 视觉门禁清单与 baseline 流程）、[`CHANGELOG.md`](../CHANGELOG.md)（发布记录）。
> 严重级：**P0** = 崩溃/功能不可用/数据损坏；**P1** = 1x 常规显示下用户可见的明显缺陷；**P2** = 特定场景/2x/高 DPI 可见，或工程卫生与未验证风险；**P3** = 细节/4x 才可见/低影响。
> 状态：`open` = 已确认未修复；`fixing` = 修复中/已有部分缓解；`fixed` = 已验证修复（需填回归证据）；`wontfix` = 明确不修（需写理由）。

## 登记表

| ID | 标题 | 严重级 | 状态 | 发现版本 | 验收标准 | 回归方式 | 关联任务 |
|---|---|---|---|---|---|---|---|
| D-001 | 膝盖/踝关节接缝 + 双色（1x 可见） | P1 | **fixed（v2.6.0）** | v2.5.0 | 1x 600–900px 显示下膝/踝无肉眼可见接缝、无双色块；2x 允许 ≤1px AA 过渡，不允许 ≥2px 连续色带/断层 | `npm run visual:qa` 2x 局部 knee/ankle 与 baseline 对比；4x 抓帧人工复核；静置洋红洞 0 | v2.6 素体 B / 腿件重构；W0-c 视觉门禁 knee/ankle crop |
| D-002 | 服装件 1–2px 接缝白线（2x 可见） | P2 | open（v2.6/后续） | v2.5.0 | 2x 下服装拼缝（袖/衣身/裙头/领口）无 ≥2px 连续白线；允许 ≤1px AA；2 身形 × 5 造型组合均满足 | `npm run visual:qa` 2x 局部（肩/袖/腰/裙头/领）× 5 造型对比；4x 抓帧人工复核 | v2.6 / 后续服装拆件；W0-c 视觉门禁 |
| D-003 | 手部线稿粗糙（1x 可接受，4x 简） | P3 | fixing（v2.5 部分修复；v2.6 母版保留 v2.5 手细节，未再提升） | v2.2.0（cutout 沿用旧线稿） | 1x 手部无肉眼可见粗糙/断线；4x 五指轮廓与指缝连续、细节接近腿/脚件水平；若重绘，轮廓 IoU ≥0.98 且 alpha 不劣化 | `npm run visual:qa` 2x hand 局部 × 2 身形；4x 抓帧人工复核；如换新素材需补充 IoU 指标 | v2.5 T2（interior-only 细节精修，收益温和）/ v2.6 候选 |
| D-004 | tail 527px old-white-hair 垫层（静置被遮，尾摆可能露出） | P3 | open | v2.4.0（v2.5.0 tail 审计纠正） | 尾摆 ±25°/±40° 动作下白发像素不露出：洋红洞 0 且尾摆区无白发像素 diff；rest 合成与当前一致；删除后需记录 atlas 产物契约（drawables/尺寸/显存） | 尾摆洋红洞 QA + 4x 尾摆抓帧；`npm run visual:qa` 2x 尾摆 crop | v2.6 候选（HANDOFF §24 下一步 2） |
| D-005 | 高 DPI（DPR≥2）下 1x 素材发虚 | P2 | fixing（v2.6.1 部分修复：body/hair/face/tail 已 2x；服装仍 1x，待 P3） | v2.5.0（2x 手部实验无收益，全资产 2x 未做） | DPR≥2 下 2x 局部（膝/手/肩/脚/腹/发）肉眼无发虚/锯齿；锐度不劣于当前 baseline；显存/图集体积增量如实记录并评估可接受性 | `npm run visual:qa` 2x crop（DPR2 截图）与 baseline 对比；真机高 DPR 抽样 | **v2.6.1 hi tier（P2）**：DPR2 脸/发/膝/手/腹 Laplacian ×3.8–5.9、轮廓 IoU ≥0.997、孔洞 0、显存 26→65MiB 已记录；服装 1x 待 P3；**v3.2.0 lazy 后 hi 套装页仍 1x**；4.0 建议服装/配饰 2x 一并做（hi 显存预算预计 ~90–110MiB 需重估）；真机依赖 D-008 |
| D-006 | npm 包混入 dev HTML（与预览/打包清单不一致） | P2 | **fixed（v2.6.0）** | v2.4.0/v2.5.0（`npm pack` 含工作区 gitignored `docs/preview/*.html`） | `npm pack --dry-run --json` 清单不含 `docs/preview/*.html`、不含 `screenshots.json`、无重复 `files` 条目；`docs/preview` 仅 5 张正式 png | 发布 checklist：`npm pack --dry-run --json` 断言 + `scripts/release.mjs`（W0-c）打包检查 | W0-a task-6（package.json `files` 修正）/ W0-c |
| D-007 | README 失效 `.scratch` 路径与过期构建说明 | P2 | **fixed（v2.6.0）** | v2.0.0+ | `grep -n '\.scratch' README.md` 为空；README 内相对链接全部可解析；构建说明只引用仓库内现行文档（`tools/art/README.md` + `assets-src` 获取流程） | 发布 checklist 链接检查（`scripts/release.mjs`，W0-c）+ 手工 grep；Lead 合入前复核 | W0-b task-7 |
| D-008 | 真机性能/显存/稳定性未测 | P2 | open | v2.2.0 起（所有数字来自 headless SwANGLE） | ≥1 台真实移动设备按 P4 矩阵跑：进换装间 60s 无 crash/context lost；自动降级档下 FPS ≥30（记录实际值）；记录显存/内存峰值；页面 v21 / 资产 v17 | P4 真机矩阵（人工回传数据，见 HANDOFF §30.5）；headless 数据不作发布依据。v3.2.0 headless 已记录：chibi 首屏 0.96MiB / firstDraw 2881ms、girl 0.80MiB / 1330ms | P4 真机测试；影响 D-005 决策 |
| D-009 | 素体无露脐设计（产品要求变更中） | P2 | **fixed（v2.6.0）**（两件式露脐；仅 bare 状态可见） | v2.5.0 | 若产品要求生效：v2.6 素体 B / 短上衣造型下腰腹拆分件可见、肤色连续、无缺画/接缝，2x 腹部 crop 无露底；若不做则改 `wontfix` 并写明理由 | `npm run visual:qa` 2x 腹部 crop + 短上衣组合换装测试（2 身形） | v2.6 素体 B（规划） |
| D-011 | 女仆装等服装下出现「四只手」（每侧 2 只） | P1 | **fixed（v2.6.0）** | v2.2.0–v2.5.0（cutout 分件起） | 2 身形 × 6 套装手部 2x 特写每侧仅 1 只手；无错位鬼手/白斑 | 手部自动检测（garment-only skin CC=0）+ 1x/2x 目检；回归：`visual:qa` hand crop | v2.6.0 修复（arm/hand 网格按部件列裁剪 + prod/ref 鬼手 inpaint） |
| D-012 | 渲染器 alpha 管线错误 → 图集 tile 边界 1px 暗线 + 边缘暗晕 | P1 | **fixed（v2.6.0）** | v2.2.0–v2.5.0（历史） | canvas 行扫描无暗线（|dL|≤1）；DPR1/2 × mipmap on/off 四组一致；发丝/衣缘无暗晕 | 行扫描断言（hip y≈757 等）+ raw canvas PNG 对比；E2E 18/18 | v2.6.0 修复（预乘 alpha 上传/shader/mask 分支 3 处） |
| D-013 | 素体烘焙水平细线（腕 y654–658、踝 y1000–1004、手臂 y437 色阶） | P1 | **fixed（v2.6.0）** | v2.5.0 | 1x 素体行不连续度指标归零/无可见线；2x 局部目检通过 | `visual:qa` 2x 局部 + rig QA 行指标（63.5→47.5，0 残留） | v2.6.0（母版 v3.1 + 移除 arm/hand Lab 调色） |
| D-014 | 1x 资产高倍放大（>4x）时边缘像素噪点/发虚 | P2 | **fixed（v2.6.1）** | v2.5.0 起 | 8x 放大边缘无像素噪点（2x 资产）；DPR≥2 明显锐利；弱机回退 1x 不掉帧 | `visual:qa` DPR2 抓帧 + 用户确认；显存/首屏增量记录 | **v2.6.1 P2**：`art/2d5/{shape}-hi` 2x hi tier（AI 增强 + alpha 确定性上采样）；DPR2 lo-vs-hi 对比与指标 `.scratch/p8/2x/runtime/review/`；残余：服装仍 1x（记 D-005/P3） |
| D-015 | chibi 素体隐藏区黑色残留：头发/手臂摆动时体侧露出黑块（2x/mm 同步可见） | P1 | **fixed（v2.6.2）** | v2.6.0（母版 v3 全量重贴图） | 任意头发摆动/头部动作/手臂抬起帧下，chibi 体侧（体侧发间、腋下）不得出现 ≥2px 连续纯黑块；lo 与 hi tier 一致 | `tests/asset-build.test.mjs`「chibi 体表近黑像素上限」断言 + DPR2 动画抓帧目检；v2.6.2 修复后 body-head 近黑 px 8,774→4,818（≤ v2.5 基线 5,010）；lo 处理 6,214px（发色外扩，非白/黑回填） | v2.6.2 修复（builder 母版隐藏区近黑处理/发色外扩；非服装绑定、非 2x 资产引入） |
| D-017 | 白色高领毛衣高领不适配短脖子 chibi 角色（用户拍板整体下架） | P2 | **fixed（v2.7.0 下架）** | v2.2.0（cutout 起；用户 2026-11-10 反馈） | 衣柜不再出现毛衣上衣与 `sweater-plaid`/`sweater-pleated` 组合；旧存档/旧 v2.1 DIY pack 引用经兼容回退不报错、不裸上身/不光腿；production rig 不含毛衣 drawable/纹理/图标 | `npm test`（manifest v8 / runtime core / DIY 兼容断言）+ `grep -rn sweater`（仅迁移表旧键/历史文档）+ `npm run visual:qa` 新 baseline（hoodie-plaid 造型替换毛衣）PASS | v2.7.0 下架（高领与短脖子 chibi 冲突；资产 v21 / 页面 v24） |
| D-010 | 素体皮肤整体亮度较 v2.5 提高（脚/腿/手臂统一到母版肤色） | P2 | open（v2.6.0 已知，待用户确认是否回调） | v2.6.0 | 1x 600–900px 显示下皮肤不显「发白/发灰」；如回调，视觉门禁对比通过 | 视觉门禁 1x 全身 + 用户确认；Lab 系数见 v26-art 报告 | v2.6 用户确认 / v2.6.x |
| D-018 | 领口露出的「脖子」是服装上烘入的假脖子皮肤（头动时颈不随头；真素体颈不可见） | P1 | **fixed（v3.0.0）** | v2.2.0–v2.7.0（cutout 分件起） | 全部 8 套服装贴图（top/bottom）烘入皮肤像素=0；运行时头动 ±20° 下颈部随头动（owner=body-head）；领口内可见真实素体颈部与锁骨；`visual:qa` `neck-2x` 无假脖子边界/双色块 | `tests/garment-hygiene.test.mjs`（v3 dist 结构 + 贴图 SkinRule 像素=0 + alpha 孔洞）、`npm run visual:qa` neck-2x、runtime 颈部 owner 图检查 | v3.0.0 paper-doll 整层重构（Phase 0/1；8 套裁切重绘、假脖子清除） |
| D-019 | 露真实素体颈部后原画重阴影+肌腱亮条，用户反馈「太黑 / 两根肉须 / 没下巴 / 与脸色差」 | P1 | **fixed（v3.0.0）** | v3.0 开发期（G1 反馈） | 颈部无肌腱竖条/肉须/重阴影；下巴用**细线稿**定义（不加投影带；线沿原画下巴轮廓、两端渐隐）；颈肤色与脸连续（Lab ΔL≤6、Δa/Δb≤3）；完全无阴影档（w6）已否决（丢下巴）；lo/hi 双 tier 一致 | `visual:qa` `neck-2x` 基线与 compare；`tests/garment-hygiene.test.mjs`；素体资产补丁 `art/body-fix/{shape}/neck-overlay.png`（W8：AI 局部重绘 + 色相匹配脸 85%） | v3.0.0 素体颈部 overlay（Lead 选定 W8；seed 4502/4602） |
| D-020 | v3.2.0 lazy 图集拆分引入 UV 子像素重采样差异（与 v3.1.1 旧基线 compare 会超阈值） | P3 | fixing（v3.2.1 UV 1e-5→1e-7；旧基线 compare 仍非零，流程=重生成基线） | v3.2.0 | 若要求「旧基线 compare 直接通过」：UV 精度 1e-5→1e-7 后重跑旧基线 diff，阈值内（1x ≤0.020%、2x ≤0.10%）；否则接受当前差异并保持基线重生成流程 | 旧基线离线 diff（`git show v3.1.1:docs/qa-baseline` vs 当前 jpg）+ `npm run visual:qa -- --mode compare`（须 80/80）；纹理等价校验脚本（逐 drawable 从新旧图集裁切 0px 差异） | v3.2.0 图集 5 页拆分/UV 重映射；**v3.2.1 已把 UV 定点收紧到 1e-7**（采样位移 ≤0.013/0.014px；旧基线 JPEG diff 5973→4811px、-19%，仍非零：v3.1.1 基线自身带 1e-5 量化误差 + JPEG 放大；rig.json +63–66KB，rig.bin/首屏不变） |

## v2.6 发版前必查

1. **D-001 / D-002 / D-009**：随素体 B / 拆件重做一起验收，1x/2x 证据附在 v2.6 发布报告。
2. **D-006 / D-007**：W0 已修但**未发版**——v2.6.0 的 `npm pack` 与 README 按验收标准重新核对后，状态改 `fixed` 并记录发布版本。
3. **D-003 / D-004 / D-005 / D-008**：可在 v2.6 之后处理，但需保持本条登记不丢；D-008 真机数据回来前，发布说明必须保留「真机未测」。
4. 发版时把本表「状态 + 修复版本」同步到 CHANGELOG 的「已知限制」小节。

## v3.0.0 发版前必查

1. **D-018 / D-019**：`visual:qa` 新增 `neck-2x` 基线与 compare 全绿；`garment-hygiene` 断言 v3 dist 贴图烘入皮肤=0；G1 用户已选定 W8 颈部方案（AI 局部重绘 + 色相匹配脸 85%）+ 下巴细线稿（无投影）。
2. **D-005 / D-014 残留**：v3 服装整层仍走 1x lo（hi tier 只覆盖素体/头发/脸/尾等既有 2x 部件，服装为 lo 页 1x 上采样）——发布说明保留「服装仍 1x」。
3. **D-008**：真机数据仍未回，发布说明保留「真机未测」。
4. 发版时把本表「状态 + 修复版本」同步到 CHANGELOG 的「已知限制」小节。

## v2.6.1 发版前必查

1. **D-005 / D-014**：hi tier 证据（DPR2 lo-vs-hi 截图 + 指标）已附；D-014 改 `fixed`，D-005 改 `fixing`（服装 1x 属 P3 残留），发布说明保留「服装仍 1x」。
2. **D-008**：真机数据仍未回，发布说明必须保留「真机未测；hi 启用依赖 DPR/内存/核数/纹理上限自动判定」。
3. **D-010 / D-011**：D-010 皮肤亮度仍待用户确认；D-011 袖口 inpaint 白雾 2x 下仍可能轻微可见——两者均保留在 CHANGELOG「已知限制」。
4. 视觉门禁 baseline 随页面 v23 / 资产 v19 更新（lo 像素应与 v2.6.0 一致），`--mode compare` 必须 PASS 后再发版。

## v3.1.0–v3.2.1 发版前必查（2026-11-12 / 11-13）

1. **视觉门禁**：资产/页面版本变更必须 `--mode baseline` 重生成后 `--mode compare` 80/80 PASS
   （v3.1.1 资产 v24/页面 v27；v3.2.0 资产 v25/页面 v28）；新增/变更区域要同步 `docs/qa-baseline/manifest.json`。
2. **构建确定性**：`verify:full` 必须校验 lo 双跑 + 官方 dist 逐字节一致（v3.2.0 起含 `rig.json`/`rig.bin`/全部 5 页 atlas）；
   hi 双跑 md5 一致（`FEIYU_ASSET_VERIFY_HI=1`）；`.br` 用语义校验（解压 == `rig.bin`），不要跨 Node 版本比字节。
3. **lazy 页契约**（v3.2.0）：5 页页序/文件名固定（base=`atlas.webp`，套装页 `atlas-2..5.webp`）；每个 drawable 恰好一页；
   hi base 页 = 2x 主体/发/脸/tail + 常驻 1x `seam-fill`；`rig.atlases`/`m3.multiAtlas`/`product.pages` 一致。
4. **首屏预算**：`tests/dressup-2d5-assets.test.mjs` 断言 首屏（rig 传输 + base 页 + 默认套装页）≤1.0MiB；
   v3.2.0 实测 chibi 0.96MiB / girl 0.80MiB。
5. **D-005 / D-008 / D-010**：服装仍 1x（hi 套装页 1x）、真机未测、皮肤亮度待用户确认——发布说明必须保留三项。
6. **UV 定点**（v3.2.1）：`PRECISION['uvs']=7`；重建 dist 后 `rig.json` 会变长（+63–66KB），`rig.bin`/首屏不变；
   UV 精度断言在 `tests/dressup-2d5-assets.test.mjs`（≤7 位）。
7. 发版流程用 `scripts/release.mjs`（8 步，rc→promote latest；deferred 重启会打断当前会话，重启后按 HANDOFF §30.3 取 token 复测）。
8. **CI**（v3.2.1 暂缓，随 3.2.2）：`.github/workflows/verify.yml` 已就绪（本地模拟 329 pass/0 fail/5 skip），
   但 GitHub OAuth App token 缺 `workflow` scope 无法推送；`gh auth refresh -h github.com -s workflow` 后补提交。
   发版前本地仍必须 `verify:full`（构建确定性/官方 dist）+ visual:qa + qa:load。

## 与视觉门禁的关系

- [`docs/VISUAL-QA.md`](VISUAL-QA.md) 定义 **1x 全身 + 2x 关键局部**的截图 baseline 与像素对比阈值；本表每条可回归的缺陷都应在该门禁中有对应区域（knee/ankle、hand、尾摆、腹部等）。
- `npm run visual:qa -- --mode compare` 超阈值即失败：这只能证明「与 baseline 相比没有回归」，**不能证明 baseline 本身没有缺陷**。已知缺陷的关闭仍需人工 4x 复核 + 本表验收标准逐条确认。
- 新缺陷进入本表的条件：用户可见 或 发布报告「已知限制」/HANDOFF 明确记录 或 真机/高 DPI 场景复现；修复关闭需附证据路径（抓帧/指标/测试名）。

## 变更记录

- 2026-11-05（W0）：建表，首批登记 D-001 ~ D-009（来源：HANDOFF §17–§24 已知限制、v2.5.0 发布记录、用户反馈）。
- 2026-11-06（v2.6.1）：D-014 改 `fixed`（hi 2x tier）；D-005 改 `fixing`（body/hair/face/tail 2x，服装 1x 待 P3）。
- 2026-11-06（v2.6.2）：D-015 新增并改 `fixed`（chibi 母版隐藏区黑色残留，动画露黑块；用户 2026-11-06 反馈）。
- 2026-11-10（v2.7.0）：D-017 新增并改 `fixed`（白色高领毛衣高领不适配短脖子 chibi，用户拍板整体下架；旧存档/旧 v2.1 DIY pack 引用迁移到 hoodie-plaid 部件，视觉基线换 hoodie-plaid 造型）。

- 2026-11-11（v3.0.0）：D-018/D-019 新增并改 `fixed`（paper-doll 整层服装清假脖子；W8 颈部 overlay + 下巴细线稿）；视觉门禁新增 neck 区域（80 张）。
- 2026-11-12（v3.1.0）：D-019 复开并再修（overlay 收窄到真实颈轮廓 + girl 提亮/下颌线软化）；新增服装手心残留修复（8 套 16 层，纳入 garment 检查）；D-015/D-018 保持 fixed。
- 2026-11-12（v3.1.1）：无新增缺陷；图集打包 MaxRects-BSSF（利用率 92%、lo 显存 -36%），视觉 compare 0 变更图。
- 2026-11-13（v3.2.0）：新增 **D-020**（lazy 5 页图集拆分引入 UV 子像素重采样差异；P3，open，已文档化；纹理逐 drawable 0px 等价）；D-005 关联备注 4.0 服装/配饰 2x 一并决策；D-008 真机仍未测。
- 2026-11-13（v3.2.1）：D-020 改 **fixing**——UV 定点 1e-5→1e-7（采样位移 ≤0.013/0.014px；旧基线 JPEG diff 5973→4811px、-19%，仍非零；流程=版本变更后重生成基线）；首屏 base 页解码与 rig 并行（像素零变化；createImageBitmap 方案因预乘舍入差异被否决）；性能门禁进 CI。