# 🐋 大肥鱼衣橱 · dsh-feiyu-wardrobe

[![npm](https://img.shields.io/npm/v/dsh-feiyu-wardrobe.svg)](https://www.npmjs.com/package/dsh-feiyu-wardrobe)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![dsh](https://img.shields.io/badge/DSH-plugin-5BE7F0.svg)](https://github.com/deepseek-ai/deepseek-harness)

> 把 DSH 的 token 账单，变成一条鱼的衣柜。

当前版本：`0.2.0`

**🆕 在线换装间（免安装试玩）**：https://git121995.github.io/dsh-feiyu-wardrobe/dress-up/

![换装间 demo](https://raw.githubusercontent.com/GIT121995/dsh-feiyu-wardrobe/main/docs/preview/dressup.png)

DeepSeek Harness 插件：agent 每花掉一次 token，你的大肥鱼就**吃一顿饭**；一顿顿饭攒成**鱼粮币**，鱼粮币解锁 **21 件原创 SVG 穿搭**；`/fish report` 生成一张 **1080×1440 的饲养报告卡**，可以直接发小红书 / QQ 群。

- 🍚 **真实账本**：按 DeepSeek 官方峰谷价把每次模型调用折成人民币，再按 1 元 = 100 鱼粮币发币
- 🎨 **原创形象**：胖鲸 + 21 件手绘 SVG 单品（帽子 / 面部 / 颈部 / 身体 / 手持 / 背景），不打包任何画师二创素材
- 🔒 **纯本地**：零额外模型调用、零网络请求、不存聊天原文，只存聚合数字
- 📸 **可晒卡**：饲养天数、投喂金额、吃掉 token、亲密度、心情、近 7 天伙食、今日穿搭
- 🖼️ **可视化出图**：`/fish png` 或 `dsh-feiyu-report --png` 直接渲染 PNG（默认 768，带 repo 水印），无需浏览器，可直接发 QQ 群 / B站评论区 / 小红书

![饲养报告示例](https://raw.githubusercontent.com/GIT121995/dsh-feiyu-wardrobe/main/docs/preview/card.png)

![衣柜目录](https://raw.githubusercontent.com/GIT121995/dsh-feiyu-wardrobe/main/docs/preview/wardrobe.png)

![出图示例](https://raw.githubusercontent.com/GIT121995/dsh-feiyu-wardrobe/main/docs/preview/fish-demo.png)

> 名字与形象都是原创，属于社区玩梗项目，**不是 DeepSeek 官方产品**；「大肥鱼」一词来自社区对 DeepSeek 蓝色鲸鱼标识的可爱误认。

---

## 安装

需要 Node.js `>= 22.5` 和可用的 DeepSeek Harness（本版在 DSH `0.2.1-rc.2` 上实测）。

```sh
# 装进你正在用的 profile（web / tui / headless 按需替换）
dsh plugin --profile web add dsh-feiyu-wardrobe

# 重启后生效
dsh --profile web
```

重启后随便让 agent 干点活，然后：

```text
/fish
```

## 命令

| 命令 | 说明 |
| --- | --- |
| `/fish` | 看鱼今天的状态（投喂金额、token、亲密度、心情、穿搭） |
| `/fish list` | 逛衣柜：按部位列出全部单品、价格与拥有状态 |
| `/fish buy <名字\|id>` | 用鱼粮币买下并自动穿上 |
| `/fish wear <名字\|id>` | 换上已拥有的单品 |
| `/fish takeoff <部位>` | 脱掉某个部位（`bg` / `body` / `neck` / `face` / `hand` / `hat`） |
| `/fish rename <名字>` | 给鱼改名 |
| `/fish png [尺寸]` | 渲染当前穿搭的 PNG（默认 768；可直接发群） |
| `/fish report` | 生成饲养报告卡（HTML，1080×1440） |
| `/fish help` | 帮助 |

不占单独模型调用，命令本身不烧 token。

## 怎么玩

1. **喂食**：每次模型调用按官方峰谷价折成 CNY，`1 CNY = 100 鱼粮币`（可配置）。新鱼出生送 120 币 + 小叶子一顶。
2. **干饭 / 互动 / 连续天数** 一起涨 **亲密度**（0–100：陌生鱼 → 点头之交 → 饭搭子 → 老饭友 → 家人 → 过命交情）。
3. **心情** 由「今天吃了几顿 + 聊了几句 + 距上一顿多久 + 连续天数」决定：饿晕了 / 有点饿 / 悠哉 / 满足 / 撑到翻肚。表情会跟着变。
4. **衣柜** 21 件单品、三个稀有度：普通 / 稀有 / 史诗（王冠 600 币，慢慢攒）。
5. **晒卡**：`/fish report` 或 `dsh-feiyu-report` 生成竖版卡片，浏览器打开直接截图。

## 换装间（在线 demo）

`docs/dress-up/` 是一个纯前端互动换装页，免安装、可直接在手机/浏览器里玩：

- **经典二创女仆鲸鱼娘**做底座（脸/头发/身体固定），AI 只生成裙子图层再合成——换 6 套大裙子（经典原装 / 星空 / 草莓蛋糕 / 黑金哥特 / 森系花仙 / 赛博霓虹）
- 点击裙子即时换装，支持左右键/滑动切换、随机换装、导出立绘卡
- 素材配方见 [`docs/dress-up/PROMPTS.md`](docs/dress-up/PROMPTS.md)；新增裙子：AI 出裙子图层 → `tools/compose_dress.py` 合成到经典底座 → 更新 `manifest.json`

形象版权链：上善无形「溟月」→ ZipZipPipe 女仆鲸鱼娘；底图来自 [1190fasheqi/dafeiyu-pet](https://github.com/1190fasheqi/dafeiyu-pet)。素材按 CC BY-NC-SA 4.0 免费开源（署名、非商业、相同方式共享）。

## 报告卡 CLI

```sh
dsh-feiyu-report                    # 用本机 state 生成 HTML 卡片
dsh-feiyu-report --png fish.png     # 直接出 PNG（QQ 群 / 评论区可用）
dsh-feiyu-report --png fish.png --size 1024
dsh-feiyu-report --demo --png demo.png
dsh-feiyu-report --open             # 生成后用默认浏览器打开
dsh-feiyu-report --out card.html    # 自定义 HTML 输出路径
dsh-feiyu-report --sheet            # 渲染整个衣柜目录页
```

出图是纯本地 SVG → PNG（`@resvg/resvg-js`，预编译二进制），不调用浏览器、不联网。

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖（都是可选项）：

```yaml
- id: feiyu-wardrobe
  name: dsh-feiyu-wardrobe
  config:
    fishName: 大肥鱼            # 初始鱼名，之后也能 /fish rename
    statePath: ""               # 默认 <DSH_HOME>/feiyu-wardrobe/state.json
    timezoneOffsetMinutes: 480  # 北京时间
    coinPerCNY: 100             # 1 元 token 花费 = 多少鱼粮币
    birthGiftCoins: 120         # 出生礼
    dailyRetentionDays: 120     # 每日台账保留天数
    holidays: []                # 法定节假日（峰谷价用），YYYY-MM-DD
```

## 隐私与版权

- **只存聚合数字**：金额、token 数、次数、日期、穿搭状态；不存任何聊天原文、模型输出、工具参数。
- **不联网**：插件和报告卡都不发请求；卡片是自包含 HTML，没有远程字体/图片/脚本。
- **原创美术**：默认胖鲸与全部 21 件单品均为本项目手绘 SVG；**不包含**画师「溟月」等社区二创素材，也不冒充官方形象。
- **非官方**：本项目是社区插件，不属于 DeepSeek 官方项目；「大肥鱼」相关梗的归属属于社区。
- 后续开放「皮肤包」格式时，同样只支持**本地加载**用户自己的素材，不代分发未授权作品。

## 接 QQ / 聊天机器人（出图能力）

「换装」是视觉性的，所以核心能力是**出图**而不是出文字：

- 任何能执行命令的 QQ 机器人（LangBot、DSH + QQ 适配器等）都可以在 `wear` 之后调一次
  `dsh-feiyu-report --png /tmp/fish.png`，把 PNG 直接发到群里；
- DSH 内也可以用 `/fish png` 生成文件，再由机器人发送；
- 图片带仓库水印，别人转发一次就是一次曝光。

> 注意：本项目只负责「渲染并给出 PNG 文件」，QQ 平台的接入、账号风控由你选用的机器人框架负责。

## 兼容性与测试

- DSH `>= 0.1.0`（本版在 `0.2.1-rc.2` 实测）
- Node.js `>= 22.5`，零运行时依赖
- `npm run verify` = `tsc --checkJs` 类型检查 + 53 个单元/集成测试（定价、经济、状态迁移、渲染、PNG、命令、CLI）

```sh
npm run verify
```

## 路线图

- **v0.3**：DSH Web 面板（页内衣橱 UI）、皮肤包格式（`.dshskin`，本地加载）、心情联动穿搭
- **v0.3**：多鱼塘（多会话鱼）、每日小任务、社区衣服交换码
- 更远：把 `dsh-memory-gate` 的记忆做成「鱼记得你说过什么」，但依然只读聚合摘要

## 开发

```sh
git clone https://github.com/GIT121995/dsh-feiyu-wardrobe && cd dsh-feiyu-wardrobe
npm install
npm test            # node --test
npm run typecheck   # tsc --checkJs
node bin/feiyu-report.mjs --demo --out card.html   # 预览报告卡
```

结构：

```text
lib/catalog.js   21 件原创 SVG 单品 + 稀有度/价格
lib/render.js    360×360 场景与 1080×1440 报告卡
lib/economy.js   鱼粮币 / 亲密度 / 心情 / 连续天数
lib/pricing.js   DeepSeek 官方峰谷价计费
lib/runtime.js   会话事件 → 经济系统，买/穿/改名
lib/commands.js  /fish 命令
bin/             dsh-feiyu-report CLI
```

## License

MIT。见 [LICENSE](LICENSE)。
