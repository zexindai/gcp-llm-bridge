# Codex / Codex CLI 直接接入

Codex 客户端和 Codex CLI 可以通过 Responses API 直接连接 Bridge，无需 CC Switch。开始前，先按 [部署说明](operations.md) 启动包含 `/v1/responses` 入口的 Bridge。

## 准备配置文件

默认配置目录如下；设置了 `CODEX_HOME` 时，使用该变量指定的目录。

| 系统 | 配置目录 |
| --- | --- |
| Windows | `%USERPROFILE%\.codex\` |
| Linux / macOS | `~/.codex/` |

将仓库中的两个文件放入配置目录：

- [config.toml.example](../config/codex/config.toml.example)：改名为 `config.toml`。
- [models.json](../config/codex/models.json)：保留文件名，与 `config.toml` 放在同一目录。

如果已有 `config.toml`，先备份，再合并下面的配置。顶层配置放在第一个 `[表名]` 之前；已有同名配置项或表时修改原项，避免重复。保留原有的插件、MCP、桌面客户端等设置。

## 编辑 config.toml

```toml
model = "google/gemini-4-argon"
model_provider = "gcp_bridge"
model_reasoning_effort = "low"
model_reasoning_summary = "none"
model_catalog_json = "models.json"
web_search = "live"

[features]
standalone_web_search = true

[model_providers.gcp_bridge]
name = "GCP LLM Bridge"
base_url = "https://api.example.com/v1"
experimental_bearer_token = "REPLACE_WITH_BRIDGE_API_KEY"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
supports_standalone_web_search = true
stream_idle_timeout_ms = 630000

[model_providers.gcp_bridge.capabilities]
remote_compaction = "unsupported"
external_web_access = true
```

需要修改的内容：

| 配置项 | 填写方式 |
| --- | --- |
| `base_url` | 填写客户端可访问的 Bridge 基础地址，以 `/v1` 结尾，例如 `https://api.example.com/v1` 或 `http://BRIDGE_HOST:4000/v1`；不要追加 `/responses` |
| `experimental_bearer_token` | 将占位内容替换为服务端 `.env` 中的 `BRIDGE_API_KEY`，保留引号；客户端不填写 Google Key |
| `model` | 默认模型，填写下面列表中的实际模型 ID |
| `model_reasoning_effort` | 默认思考等级；当前示例使用 `low`，其他等级按模型支持情况选择 |
| `model_catalog_json` | 本地模型能力目录；`models.json` 是相对于配置文件所在目录的路径 |

如果需要使用绝对路径，Windows 的 TOML 可以使用单引号，避免反斜杠转义：

```toml
model_catalog_json = 'C:\Users\YOUR_USER\.codex\models.json'
```

密钥直接写在 `config.toml` 中即可，无需额外设置 API Key 环境变量，也无需修改原有订阅登录的 `auth.json`。不要分享填入真实密钥后的配置文件。

## 选择模型

示例 `models.json` 包含三款模型，配置的上下文窗口均为 262144 tokens（256K）：

| 显示名称 | 模型 ID |
| --- | --- |
| Gemini 4 Argon | `google/gemini-4-argon` |
| Gemini 4 Hydrogen | `google/gemini-4-hydrogen` |
| Gemini 4 Carbon | `google/gemini-4-carbon` |

可修改 `model` 设置默认模型，或在重启后的模型菜单、CLI 的 `/model` 中选择。实际模型权限和能力取决于 Google 上游。

`models.json` 是 Codex 的模型能力目录，不能直接用 Bridge 的 `GET /v1/models` 响应替代。

## 联网搜索与上下文压缩

上面的配置已启用实时联网搜索。Codex 通过 Bridge 的 `/v1/alpha/search` 调用 GCP Google Search，支持关键词搜索和来源引用；不支持打开网页、点击链接、页面内查找、截图，以及精确域名、时效或位置筛选。

如需关闭搜索，将顶层配置改为：

```toml
web_search = "disabled"
```

`remote_compaction = "unsupported"` 表示不调用远程 compact 接口。上下文压缩由 Codex 在客户端组织，再通过普通生成请求完成；模型目录中的 `auto_compact_token_limit: null` 表示使用客户端默认阈值，不代表关闭压缩。

## 启动和验证

1. 确认客户端能访问 `http://BRIDGE_HOST:4000/healthz`，使用域名时替换为 `https://api.example.com/healthz`，正常返回 `{"status":"ok"}`。
2. 保存 `config.toml` 和 `models.json`。
3. 桌面客户端完全退出后重新启动；CLI 退出后重新执行 `codex`。如果使用共享 app-server，还需要重启对应后台；本机 CLI 0.169.0 的命令为 `codex app-server daemon restart`。
4. 新建对话，确认使用的是 `GCP LLM Bridge` 和目标 Gemini 模型。已有对话可能保留原来的供应商和模型。
5. 先测试短文本，再测试读取项目文件和联网搜索。

修改供应商或模型目录后，仅新建对话可能无法刷新模型菜单，需要重新加载客户端和对应后台。

## 常见问题

- **401**：检查 `experimental_bearer_token` 是否与服务端 `BRIDGE_API_KEY` 一致。
- **404**：确认 Bridge 版本提供 Responses 入口，且 `base_url` 以 `/v1` 结尾。
- **仍然显示 GPT 模型**：确认修改的是当前客户端使用的配置目录，`model_provider` 为 `gcp_bridge`，并重启客户端及对应 app-server。
- **模型目录加载失败**：确认 `models.json` 已复制到正确目录；必要时改用绝对路径。
- **搜索报不支持的参数**：使用普通关键词搜索，关闭缓存搜索及精确筛选。
- **更换密钥或模型后，旧对话工具调用失败**：新建对话再测试，旧工具历史可能绑定原来的密钥和模型。
