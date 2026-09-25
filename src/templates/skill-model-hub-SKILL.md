---
name: model-hub
description: 为 ZCode 桌面版拉取自定义供应商的模型列表（OpenAI / Anthropic / Gemini 三种 API 方言自动适配）。当用户要求"拉取模型""同步模型列表""把某个供应商的模型加进来"时使用。
---

# model-hub 模型拉取

帮用户把第三方供应商的模型列表拉取进 ZCode。所有操作通过本机 CLI 完成，
不修改 ZCode 安装目录（CLI 层更新免疫）。

## 步骤

1. 先列出已配置的自定义供应商：

```bash
{{CLI_PATH}} sync --list
```

2. 根据用户指定的供应商（支持 id / 名称 / baseURL 模糊匹配）执行拉取：

```bash
{{CLI_PATH}} sync --provider <供应商id或名称>
```

   全部供应商：`{{CLI_PATH}} sync --all`
   指定方言：加 `--dialect openai|anthropic|gemini`（默认自动探测）

3. 完成后告诉用户：打开 ZCode 模型选择器即可看到新模型（外部写入实时生效）。

## 注意

- 需要供应商配置了 `config.api.baseUrl`；没有 baseURL 的供应商无法同步。
- 被用户删除过（墓碑记录）的模型不会在自动同步时被强制加回。
- 拉取失败时把 CLI 输出的错误原文转述给用户（API key 已自动脱敏）。
