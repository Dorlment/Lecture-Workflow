# Lecture Workflow

Lecture Workflow 是一个面向课堂学习场景的 Obsidian 桌面端插件，用于把课堂文字、截图和时间线整理为结构化学习笔记。

核心流程：

```text
创建课堂笔记
→ 开始课堂监听
→ 课堂截图 / 实时转写
→ AI 整理当前课堂笔记
→ 预览并写回 Obsidian
```

## V0.1 核心能力

- 创建标准课堂笔记，开始或停止课堂监听。
- 在监听期间检测新复制到系统剪贴板的截图，保存到 Vault 并加入课堂时间线。
- 在 Windows 上配合可选的 Windows Audio Companion 捕获默认系统输出音频。
- 使用 Qwen Realtime ASR 进行课堂实时转写；识别定稿会自动追加到当前课堂笔记的「原始文字稿」。
- 支持纯文字 AI 整理，也支持课堂截图 + transcript 联合整理。
- Qwen Vision 只负责理解课堂截图并生成视觉辅助上下文；Text Provider 负责生成最终结构化 Markdown。
- 保留截图 placeholder，并在最终结果中恢复原始图片引用。
- 使用 `timelineContext` 保留 transcript 与截图的课堂时序。
- AI 写入前检查笔记和附件冲突，防止覆盖预览期间的外部修改。

## 安装

Lecture Workflow V0.1 是桌面端插件，最低支持 Obsidian 1.7.2。通过 Community Plugins 安装时，Obsidian 会安装 `main.js`、`manifest.json` 和 `styles.css`。

Windows 系统音频需要额外的 Windows Audio Companion。该 Helper 不属于 Community Plugin 自动安装内容，请按下方说明手动安装。普通文字整理和图片整理不依赖 Helper。

## 首次使用配置

### 1. 文字 AI 整理

在 Lecture Workflow 设置中配置 DeepSeek API Key，用于完整文字稿的最终结构化整理。

### 2. 图片参与整理

如需课堂截图参与 AI 整理，启用「图片参与整理」并配置 Qwen。

```text
Qwen Vision
→ 理解课堂截图
→ 生成视觉辅助上下文

Text Provider
→ 接收完整 transcript + timelineContext + visual evidence
→ 生成最终结构化 Markdown
```

Qwen Vision 不负责最终完整笔记的生成。

### 3. Realtime ASR

如需将课堂语音实时转成文字，需要完成 Qwen Realtime ASR 配置。实时识别的定稿会自动追加到当前课堂笔记的「原始文字稿」，插件不保存录音。

完成 Provider 配置后，可使用对应的「测试连接」确认配置有效。如果只使用文字 AI 整理，无需配置图片理解和实时转写。

> [!WARNING]
> API Key 保存在本地插件配置 `data.json` 中，当前未加密；请勿分享或提交至 Git。

## 课堂截图

启动课堂监听后，可以切换到网课或其他学习页面，使用你习惯的截图工具进行截图。请确保截图结果会复制到系统剪贴板，Lecture Workflow 会自动检测监听期间新复制的图片并加入当前课堂时间线。

插件只读取监听期间新复制的图片，不读取剪贴板文字，也不会自动上传图片。截图快捷键由你使用的截图工具或操作系统设置决定。只有在你主动发起图片 AI 整理并确认图片后，选中的截图才会发送给配置的第三方 Provider。

## Windows Audio Companion

Windows Audio Companion 是 Windows 用户在需要直接获取系统音频时使用的可选组件。V0.1 不会自动下载、安装、解压或更新 Helper。

正式发布后，请从 [Lecture Workflow 官方 GitHub Release](https://github.com/Dorlment/Lecture-Workflow/releases) 手动下载与插件版本一致的：

```text
lecture-workflow-windows-helper-win-x64-v0.1.0.zip
```

安装前完全退出 Obsidian，然后将 ZIP 中的内容解压到：

```text
<Vault>/.obsidian/plugins/lecture-workflow/
```

最终 EXE 必须直接位于：

```text
<Vault>/.obsidian/plugins/lecture-workflow/companion/windows/LectureWorkflow.AudioCompanion.Windows.exe
```

正确目录结构：

```text
lecture-workflow/
├── main.js
├── manifest.json
├── styles.css
└── companion/
    └── windows/
        ├── LectureWorkflow.AudioCompanion.Windows.exe
        └── 其他 Helper 运行文件
```

不要形成重复的双层目录，例如：

```text
companion/windows/lecture-workflow-windows-helper-win-x64-v0.1.0/LectureWorkflow.AudioCompanion.Windows.exe
```

当前 Helper 为 framework-dependent 构建，运行时同时需要兼容的 `Microsoft.NETCore.App 10.0` 和 `Microsoft.AspNetCore.App 10.0` x64 shared framework。仅安装「.NET 10 Desktop Runtime」不足以表达这一实际依赖。

安装完成后：

1. 重新启动 Obsidian 或重新加载 Lecture Workflow。
2. 开始课堂监听；插件会在课堂会话建立后尝试启动 Helper。
3. 打开课堂工作台，确认「系统音频助手」状态。
4. 如果之前启动失败，可在工作台中重新启动系统音频。

Helper ZIP 应保留正式 `dotnet publish` 输出的全部必需运行依赖，不只限于 resolver 检查的最小文件清单。PDB、源码、日志和测试产物不应进入正式 ZIP。

## 日常使用

1. 在 Obsidian 中打开或创建课堂笔记。
2. 从左侧 Lecture Workflow 菜单选择「开始课堂监听」。
3. 使用你习惯的工具截图，或在 Windows Helper 已安装且 Qwen ASR 已配置时使用实时转写。
4. 打开课堂工作台查看运行状态。
5. 课堂结束后停止监听，然后选择「AI 整理当前课堂笔记」。
6. 检查预览，确认结果完整且没有冲突后再写入。

## 数据与隐私

- API Key 仅保存在当前 Vault 的插件配置 `data.json` 中，当前未加密。
- 后台截图监听不读取剪贴板文字，不自动上传截图。
- 启用图片 AI 整理后，经用户确认的图片会发送给所选第三方 Vision Provider。
- 启用 Realtime ASR 后，实时 PCM 会发送给配置的 Qwen Realtime ASR 服务；插件不保存录音。
- AI 整理会将用户确认的文字和图片上下文发送给所配置的第三方 Provider。
- Lecture Workflow V0.1 不包含客户端遥测，不保存录音，不会自动安装 Helper。

## V0.1 能力边界

- Text Provider 结构化输出上限：8192 tokens。
- Qwen Vision 视觉证据输出上限：2048 tokens。
- 单次最多选择 10 张图片，设置范围为 1–10。
- 默认 Provider 请求超时：150 秒。
- 正常生成后如果结构校验失败，最多进行一次格式 repair，不会无限重试。
- `finishReason=length` 不会自动 repair；预览保留可复制结果，但不允许写入不完整内容。用户可主动重新生成。
- Provider 返回 `context-limit` 时，插件不会静默截断 transcript。

实际可处理的文字稿长度还受到模型上下文窗口、输出长度和第三方 API 状态影响。对于超长课程，建议先检查预览结果是否完整。更详细的已验证边界见 [`docs/v0.1-capability-boundaries.md`](docs/v0.1-capability-boundaries.md)。

## Troubleshooting

### 未检测到 Windows Audio Companion

- 确认 Helper 版本与插件版本一致。
- 确认 EXE 直接位于 `companion/windows/`，没有多一层 ZIP 目录。
- 确认当前 framework-dependent Helper 所需的 .NET 10 与 ASP.NET Core 10 x64 shared framework 已安装。
- 重新加载插件后再开始课堂监听，并在课堂工作台检查状态。

### 截图未加入时间线

确认课堂监听已启动，并确认截图工具会把图片复制到系统剪贴板。

### 实时转写未启动

先在 Lecture Workflow 设置中完成 Qwen Realtime ASR 配置，使用「测试连接」确认配置，然后重新开始课堂。

### AI 结果不完整

检查预览中的完整性提示。如果结果因 `finishReason=length`、超时或 `context-limit` 失败，请根据提示主动重新生成或缩短文字稿。

## 开发与协议

- Windows Audio Companion 的普通用户安装与开发说明：[`companion/windows/README.md`](companion/windows/README.md)
- Audio Companion wire protocol：[`docs/audio-companion-protocol.md`](docs/audio-companion-protocol.md)
- V0.1 能力边界：[`docs/v0.1-capability-boundaries.md`](docs/v0.1-capability-boundaries.md)
