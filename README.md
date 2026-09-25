# zcode-suite — ZCode 桌面版统一插件

**model-hub（模型拉取）+ zcode+（提示词增强）整合为一个插件：一键安装、一次备份、一个自愈触发器。**

把 `zcode-model-hub`（为 ZCode 桌面版拉取自定义供应商模型列表）与
`zcode+ 提示词增强`（输入框旁 ✨ 一键改写提示词）整合成单个脚本插件。
两套功能共享同一套手术式 asar 引擎、同一条官方备份链、同一个更新自愈
触发器；注入互不干扰的 `modelhub:*` / `zcodeplus:*` 命名空间。

```
一键安装 = 注入「⚡️ 拉取模型」+ ✨ 提示词增强（同一份 app.asar，一次原子替换）
         + 部署用户空间技能（更新免疫的 CLI 层）
         + 注册自动修复触发器（ZCode 更新后自动重装）
```

## 目录结构

```
zcode-suite/
├── package.json                  # 包定义（zcode-suite，bin 入口）
├── README.md                     # 本文件
├── bin/
│   └── zcode-suite.mjs           # 统一 CLI：install/restore/remove/status/
│                                 #   doctor/ensure/sync/watch/unwatch
├── src/
│   ├── core/                     # ★ 两特性共享的底层（去重核心）
│   │   ├── platform.mjs          #   ZCode 发现/进程检测/路径（唯一来源）
│   │   ├── surgical-asar.mjs     #   手术式 asar 读写（数据区逐字节保留）
│   │   ├── verify.mjs            #   哈希/原子写/重包校验
│   │   ├── manifest.mjs          #   统一 manifest + 单一备份链 + 旧版迁移
│   │   └── features.mjs          #   特性注册表（哨兵/载荷/命名空间清单）
│   ├── features/                 # ★ 两特性的注入载荷（互不重叠的命名空间）
│   │   ├── payloads.mjs          #   载荷解析（源码树 / 内嵌双通道）
│   │   ├── payloads.embedded.mjs #   内嵌桩（单文件构建预留，保持为空）
│   │   ├── modelhub/             #   main-handlers.js + preload-bridge.cjs
│   │   │   └── ui/zcode-model-hub.js
│   │   └── zcodeplus/            #   main-handlers.js + preload-bridge.cjs
│   │       ├── inject.js         #     CDP 版注入源（安装时适配为 asar 载荷）
│   │       └── adapt.mjs         #     锚点适配器（锚点不匹配即硬失败）
│   ├── patch/
│   │   ├── discover-targets.mjs  #   asar 内目标发现（按路径形态，歧义即失败）
│   │   └── apply.mjs             #   统一 install/restore/remove/inspect
│   ├── repair/
│   │   ├── ensure.mjs            #   自愈状态机（一次 ensure 恢复两特性）
│   │   └── triggers.mjs          #   macOS LaunchAgent / Win 计划任务 /
│   │                             #   Linux systemd path（+ 旧触发器清理）
│   ├── config.mjs                #   provider_config.json 读写与合并（层1）
│   ├── providers/index.mjs       #   OpenAI/Anthropic/Gemini 三方言拉取（层1）
│   ├── deploy-skill.mjs          #   部署技能/命令到 ~/.zcode/
│   └── templates/                #   技能与命令模板（旧仓库缺失，本次补齐）
├── scripts/
│   ├── install.sh / install.ps1  # 一键安装包装（Node 环境自检）
│   ├── uninstall.sh / uninstall.ps1
│   ├── check-syntax.mjs          # 全模块 + 载荷语法门禁
│   ├── verify-smart-config.mjs   # 智能配置三层一致性验证
│   └── build.mjs                 # 构建单文件 dist/zcode-suite.mjs
├── test/                         # 夹具测试（合成 asar，不碰真实安装）
└── dist/
    └── zcode-suite.mjs           # 构建产物：单文件自解压安装器
```

## 安装

前置条件：ZCode 桌面版；Node.js ≥ 18（零第三方依赖）。

方式一（源码目录）：

```bash
./scripts/install.sh                        # macOS / Linux
powershell -File scripts\install.ps1        # Windows
# 等价：node bin/zcode-suite.mjs install
```

方式二（单文件产物，构建后拷走即可用）：

```bash
node dist/zcode-suite.mjs install
```

单文件运行时把内嵌文件树解压到 `~/.zcode/zcode-suite/app`（可用
`ZCODE_SUITE_APP_DIR` 改址），之后以原参数调用统一 CLI——产物即一个
可直接安装的脚本插件。

安装过程会：一次解析基线并备份官方 app.asar（仅此一份）→ 一次手术式
重打包写入两特性 → 部署技能/命令 → 注册自愈触发器。**完成后完全退出并
重启 ZCode**：设置 → 模型供应商页出现「⚡️ 拉取模型」，输入框旁出现 ✨。

可选：

```bash
node bin/zcode-suite.mjs install --only zcodeplus   # 只装一个特性（保留已在位的另一个）
node bin/zcode-suite.mjs remove --only modelhub     # 卸载单个特性，保留另一个
node bin/zcode-suite.mjs restore                    # 还原官方原版（两特性一并移除）
node bin/zcode-suite.mjs sync --list                # 纯 CLI 拉模型（不碰 app.asar）
node bin/zcode-suite.mjs status / doctor            # 状态与体检
```

## 整合解决的三类问题

### 1) 资源去重与共享

| 旧做法（两个独立插件） | 统一后 |
|---|---|
| 两份 asar 手术引擎/校验/原子写（zcode+ 直接 import 对方的） | `src/core/` 一份 |
| 两份 ZCode 发现/进程检测，`zcodeProviderConfigPath` 定义两次 | `src/core/platform.mjs` 唯一来源 |
| 两份 manifest + 两份 `backups/<hash>/app.asar` 冷备份 | 一条备份链；`ensureBackup` 按哈希去重，**整个安装过程仅备份一次** |
| 两次 asar 重打包、两次原子替换、两次读回校验 | 同一 patchMap 一次重打包、一次替换、一次校验 |
| 两个 sentinel 探测/异补丁检测实现 | `features.mjs` 注册表 + `discover-targets` 按特性探测 |
| 触发器只护 model-hub，zcode+ 更新后要手动重跑 | 一个触发器 `ensure` 同时恢复两特性 |
| `templates/` 缺失导致默认 install 崩溃（存量缺陷） | 模板补齐于 `src/templates/` |

### 2) 兼容性处理（冲突与命名空间）

两特性载荷本就互不重叠，整合时逐项审计并固定为注册表约束：

| 层 | model-hub | zcode+ | 冲突 |
|---|---|---|---|
| main 守卫 / IPC | `__ZCODE_MODEL_HUB_V1_MAIN__`，`modelhub:*`（7 通道） | `__ZCODE_PLUS_V1_MAIN__`，`zcodeplus:request` | 无 |
| preload 暴露 | `window.zcodeModelHub` | `window.zcodePlus` | 无 |
| 渲染层脚本 | `zcode-model-hub.js` | `zcode-plus.js`（独立 asar 条目） | 无 |
| UI 状态 | `window.__ZCODE_MODEL_HUB_V1_UI__` | `__zcodePlusEnhanceRuntime` + `wb-enhance-*` DOM 前缀 | 无 |
| localStorage | 无键 | `zcodePlusEnhance.settings.v1` | 无 |
| 状态目录 | `~/.zcode/model-hub/` | `~/.zcode/zcode-plus/` | **统一为 `~/.zcode/zcode-suite/`** |
| 文件同名 | `main-handlers.js` / `preload-bridge.cjs` 同名同语义不同物 | 同左 | **分目录 `src/features/<id>/`** |
| 临时文件名 | `*.model-hub-tmp` / `app.asar.model-hub-new` | `*.zcode-plus-tmp` | 统一 `*.zcode-suite-tmp` / `app.asar.zcode-suite-new` |

修复的交叉干扰：旧方案里「model-hub restore 会还原到 zcode+-已注入态、
zcode+ restore 会抹掉 model-hub」——现在 restore 语义唯一（回到基线，
通常即官方原版），单特性卸载用 `remove --only`；两个旧状态目录、旧触发器
（`ZCodeModelHubRepair` / `com.zcode-model-hub.repair` /
`zcode-model-hub-repair.*`）在迁移与注册时自动清理或接管。

### 3) 从旧插件升级（自动迁移）

直接对已装旧插件的机器执行一次 `install` 即可：

| 旧状态 | 统一安装的行为 |
|---|---|
| 装过 model-hub（有 manifest + 备份） | 取两方中 **installedAt 更早** 的备份作为基线（那才是真官方版），并入统一备份链；两个特性一次重装 |
| 装过 zcode+（同上） | 同上 |
| 两个都装过 | 早者为准，备份去重后仍只有一份 |
| 哨兵在位但 manifest 丢失 | 采用当前 asar 为基线（`baseline.clean=false`），只补缺失特性，绝不重复追加；此时 `restore` 回到的是该基线（其中的旧注入保留），`remove --only` 会被拒绝并提示先取得干净原版 |
| 旧墓碑状态 `~/.zcode/model-hub/state.json` | install 时并入 `~/.zcode/zcode-suite/state.json`；**只在安装流程迁移**——读配置永不回读旧目录，避免已删模型复活 |
| 旧触发器 | 注册统一触发器时删除 |

旧目录迁移后保留原样（不删除），确认无虞后可手动清理
`~/.zcode/model-hub/` 与 `~/.zcode/zcode-plus/`。

## 构建

```bash
node scripts/build.mjs        # 产出 dist/zcode-suite.mjs（单文件自解压安装器）
node scripts/check-syntax.mjs # 全模块 + 载荷语法门禁
node --test test/             # 12 个夹具测试：统一安装/迁移/去重备份/
                              # remove/adopted 基线/ensure 自愈/inject 适配
node scripts/verify-smart-config.mjs   # 智能配置 CLI/渲染层/主进程三层一致性
```

build.mjs 自带三重门禁：产物语法检查、`--version` 冒烟、临时目录解压 +
CLI 链路冒烟；产物哈希打印在构建输出末尾。

## 命令速查

| 命令 | 作用 |
|---|---|
| `install [--only id] [--no-watch] [--no-skill] [--force-close] [--resources dir]` | 一键安装（默认两特性 + 技能 + 触发器） |
| `restore [--force]` | 还原基线（通常即官方原版） |
| `remove --only <modelhub\|zcodeplus>` | 卸载单特性，保留另一个 |
| `status [--json]` | 三层状态（CLI 层 / 两特性注入态 / 触发器） |
| `doctor` | 只读体检，异常时生成 `doctor-report.json` |
| `ensure [--quiet] [--check-only]` | 一次性自愈（触发器内部调用，快路径一次 stat） |
| `sync --list / --provider <id> / --all / --dialect` | 用户空间模型同步（更新免疫） |
| `watch` / `unwatch` | 注册/卸载自愈触发器 |

## 安全模型（继承并统一）

- ZCode 运行中一律拒绝写入（`--force-close` 才写，自动模式一律延迟）；
- 上游两项目的异构补丁标记在位时拒绝叠加；
- macOS 检测 `ElectronAsarIntegrity`，启用时明确拒绝注入（CLI 层不受影响）；
- 手术式重打包：原数据区逐字节保留、`app.asar.unpacked` 不动、临时文件 +
  fsync + 尺寸/哈希读回校验 + 原子改名，任何一步失败原文件分毫未动；
- 备份按哈希冷存、只增不覆盖、保留最近 2 个版本；
- API key 只进用户自己的配置，不写日志、不进 manifest、错误自动脱敏；
- AppImage 只读镜像不支持注入（CLI 层可用）。

## 已知限制

- zcode+ 旧版「CDP 常驻控制器 + 调试端口」模式未纳入本项目：asar 注入版是其
  官方推荐替代（无常驻进程、无调试端口）；本仓库只包含 zcode-suite，
  旧独立控制器不在版本库中（历史上游快照可查）。
- ZCode 若未来启用 asar 完整性 fuse 或大幅调整 out/ 布局，注入层失效
  （doctor 会明确报告），CLI/技能层不受影响。
- `install --only` 单特性安装后，`ensure` 只恢复该特性（以 manifest 记录
  为准）；未装过的特性不会被自动补装。

## License

MIT。上游致谢：model-hub 融合
[HHQ-666/zcode-model-puller](https://github.com/HHQ-666/zcode-model-puller) 与
[CSSZYF/zcode-modelhub-patch](https://github.com/CSSZYF/zcode-modelhub-patch)；
zcode+ 提示词增强为 WorkBuddy 功能的社区移植，页面图标改编自
[Lucide](https://lucide.dev)（ISC）。
