# dsh-model-picker

把 DSH / DSH NEXT 的模型下拉改成「精选置顶 + 免费自动收录 + 其余兜底」的分组视图，每行带角标、质量、速度与能力标签。**只改显示层**：选中时提交的仍是原来的 `provider/model`，账号渠道、`settings.json`、模型路由和 OpenAI 网关都不动。

## 它解决什么

DSH 官方下拉**严格按 provider 分组**（`@deepseek-ai/dsh-client-ui-model-selection` 里没有自定义分组字段），`modelRank` / `modelBadges` 只作用于 `our-free-model` 自己的两个 route，管不了 workbuddy / buddy / cline / qoder 这些账号渠道。所以跨 provider 的自定义分组只能在渲染层做。

更重要的是：手工维护一份「白名单」很容易在渠道同步、目录更新、插件升级之后让免费模型凭空消失。这个插件把未精选的模型**自动收录**，所以免费渠道模型不会再「不见了」。

分组：

| 组 | 来源 |
| --- | --- |
| 1 日常首选 | `config.json` 手工置顶 |
| 2 按场景换 | `config.json` 手工置顶 |
| 3 其他免费可用 | 自动识别名称里的「免费 / x0.00 / x0.0」 |
| 4 其余模型 | 额度用尽 / 未实测 / 地区受限 / 官方账号模型 |

自动收录时排除的名称关键词也可配置，坏档模型会落到第 4 组并带警示角标。`-vision` 识图版默认全部保留并标 `◉识图版`。

## 安装

需要 Node ≥ 22，且 DSH 的 `resources/app` 是**已解包**状态（如果还是密封的 `app.asar`，先解包）。

### 方式 A：作为 DSH 插件安装（推荐）

```bash
git clone https://github.com/<OWNER>/dsh-model-picker.git
cd dsh-model-picker
npm test                 # 可选：自检，不需要 DSH
node bin/dsh-model-picker.mjs check
```

然后把整个目录作为 bundle 装进 profile（用 DSH 的插件安装能力 / `plugin_manager install_bundle`，target 传这个目录的绝对路径）。插件的 Host 半身会在每次 DSH 启动时自动做幂等注入，宿主更新覆盖 `resources/app` 后重启即自动修复。

也可以只装 bundle、不开自动应用，改用 CLI 手动控制：把 `cordis.patch.yml` 里的 `autoApply` 改成 `false`。

### 方式 B：只当命令行工具用（不装 bundle）

```bash
node bin/dsh-model-picker.mjs apply     # 注入
node bin/dsh-model-picker.mjs revert    # 还原
```

这种方式不会随 DSH 启动自动运行，适合想完全手动控制的场景。

装完 **重启 DSH NEXT**（或刷新渲染进程）才会看到新下拉 —— 渲染进程启动时才读取 `client.js`。

## 命令

```bash
node bin/dsh-model-picker.mjs status    # 宿主路径、版本、是否已打补丁
node bin/dsh-model-picker.mjs check     # 只做兼容性检查，不写任何文件
node bin/dsh-model-picker.mjs apply     # 幂等注入；重复运行不会产生变化
node bin/dsh-model-picker.mjs revert    # 还原到打补丁前
node bin/dsh-model-picker.mjs import-original <pristine-client.js>
node bin/dsh-model-picker.mjs config    # 打印可编辑配置路径
```

通用选项：`--client <绝对路径>`、`--home <DSH home>`、`--json`。
找不到渲染文件时设置 `DSH_MODEL_PICKER_CLIENT` 环境变量。

## 配置

首次运行会在 `$DSH_HOME/dsh-model-picker/config.json` 生成一份默认配置（内容等同 `lib/defaults.json`）。改完直接 `apply` 即可，插件会只更新注入的配置块。

| 字段 | 作用 |
| --- | --- |
| `groups` / `models` | 置顶分组与精选模型；`id` 必须是 `provider/model` 全名 |
| `showMeta` | 是否显示第二行「质量 / 速度 / 标签」 |
| `hideUnlisted` | 设 `true` 回到「只显示精选」的严格模式 |
| `autoGroups.enabled` | 关闭自动收录 |
| `autoGroups.freeNameHints` | 判定「免费」的名称关键词 |
| `autoGroups.badNameHints` | 判定「不可用」的名称关键词 |
| `autoGroups.dedupeVision` | 设 `true` 折叠 `-vision` 孪生项 |
| `autoGroups.free.enabled` / `other.enabled` | 隐藏某一组（例如只留前 3 组） |

配置文件里有中文分组标题和角标文案，用 UTF-8 编辑。

## 安全性与回退

- 写入前逐项校验锚点：**任何一个不匹配就整体拒绝写入**，不会留下半个补丁。这是为了在宿主版本不同时不破坏 UI。
- 写入前备份当前 `client.js`（`$DSH_HOME/dsh-model-picker/backups/`，保留最近 3 份）。
- 写完后用 Node 做语法检查；失败会自动恢复原文件。
- 首次全新安装会保存一份 pristine `client.orig.js`，`revert` 用它精确还原。
- 如果接管的是一个**已经被手工打过补丁**的渲染文件，插件会记录每一处改动的原文，`revert` 按记录逆序还原；想做到 100% 精确，先跑一次 `import-original <原始 client.js>`。
- 插件不联网、不改账号、不改网关、不改 `settings-legacy.yaml`。

## 兼容性

在 DSH NEXT `@deepseek-ai/dsh-client-ui-model-selection@0.2.1-rc.4` 上开发并验证。其他版本只要锚点一致也能用 —— 先跑 `check`，通过再 `apply`。宿主大版本升级后如果结构变了，`check` 会明确报出哪一步不兼容，此时不要强行应用，提 issue 附上 `check` 的输出即可。

## 已知限制

- 下拉只有约 420px 宽 / 360px 高，因此做成紧凑双行列表，没有做卡片边框、速度进度条和复制按钮；悬停可看到完整模型 ID。
- 默认模型本身不会改变，「默认·已选中」只是角标文案。
- 自动收录按**名称关键词**判断免费，不是实时探测；刻意标了「免费」但已失效的模型仍会出现在第 3 组。实测档位以 `config.json` 里的精选项为准。

## License

MIT
