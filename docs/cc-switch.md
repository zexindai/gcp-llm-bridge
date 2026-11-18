# CC Switch 接入

下面说明通过 CC Switch 将 Codex 请求发送给 Bridge 的两种配置方式。Chat Completions 方式需要通过路由或聚合模式使用；Responses 原生方式可使用直连、路由或聚合模式。

Bridge 提供 Chat Completions 和 Responses 两种入口。
客户端也可直接接入 Responses 入口，见 [Codex / Codex CLI 直接接入](codex_config.md)。

## 客户端配置（Completions）

在 CC Switch 的 Codex 页面添加自定义供应商。在高级设置里选择 `Chat Completions`。

将 `BRIDGE_HOST` 替换为客户端可访问的 Bridge 宿主机地址，端口与 `.env` 中的 `PORT` 保持一致。

此方式由 CC Switch 将 Codex 的 Responses 请求转换为 Chat Completions，再交给 Bridge 原样转发。

| CC Switch 字段 | 设置 |
| --- | --- |
| Name | `GCP LLM Bridge`（或者你喜欢的） |
| API Key | 服务端 `.env` 的 `BRIDGE_API_KEY`，不是 Google Key |
| API Request URL | `http://BRIDGE_HOST:4000/v1/chat/completions` |
| Actual Request Model | 例如 `google/gemini-4-argon` |
| Menu Display Name | 可自行设置，例如 `Gemini 4 Argon` |
| Upstream Format | `OpenAI Chat Completions`（需要协议转换） |
| Full URL | 开启 |
| Supports Reasoning Effort | 模型支持思考等级时开启 |
| Supports Thinking Mode | 按上游模型能力配置（建议开启） |
| Actual Request Model | 例如 `google/gemini-4-argon` |
| Menu Display Name | 可自行设置，例如 `gemini-4-argon` |

将 `BRIDGE_HOST` 或示例域名替换为客户端可访问的 Bridge 地址。修改端口时同步替换 URL 中的 `4000`。操作步骤见 [自定义端口](configuration.md#自定义端口)。

API Key 始终使用对应服务端的 `BRIDGE_API_KEY`；填写后，CC Switch 会自动填入下方的认证配置。

Bridge Key 必须完全一致；缺失或错误返回本地 401。服务端更新 Key 并重新创建容器后，客户端也必须同步。

使用域名时，先按 [部署与 Nginx](operations.md) 完成反向代理，再把完整请求地址改成 `https://api.example.com/v1/chat/completions`，替换为自己的域名。API Key 仍使用 `BRIDGE_API_KEY`。

## 客户端配置（Responses）

在 CC Switch 的 Codex 页面添加自定义供应商，在高级设置里选择 `Responses (native)`。

此方式由 Bridge 完成与 GCP 上游之间的协议转换，CC Switch 无需转换请求格式。

| CC Switch 字段 | 设置 |
| --- | --- |
| Name | `GCP LLM Bridge`（或者你喜欢的） |
| API Key | 服务端 `.env` 的 `BRIDGE_API_KEY`，不是 Google Key |
| API Request URL | `http://BRIDGE_HOST:4000/v1` |
| Actual Request Model | 例如 `google/gemini-4-argon` |
| Menu Display Name | 可自行设置，例如 `Gemini 4 Argon` |
| Upstream Format | `Responses (native)` |
| Keep official Fast tier | 关闭 |
| Full URL | 关闭 |

将 `BRIDGE_HOST` 或示例域名替换为客户端可访问的 Bridge 地址。修改端口时同步替换 URL 中的 `4000`。操作步骤见 [自定义端口](configuration.md#自定义端口)。

API Key 始终使用对应服务端的 `BRIDGE_API_KEY`；填写后，CC Switch 会自动填入下方的认证配置。

这里填写的是以 `/v1` 结尾的基础地址，客户端会追加 `/responses`。如果在路由或聚合模式下使用完整地址 `http://BRIDGE_HOST:4000/v1/responses`，需要同时开启 `Full URL`，不要混用两种填法。

手动添加模型时，实际模型 ID 使用 `google/gemini-4-argon`、`google/gemini-4-hydrogen` 等上游名称。

## 验证顺序

1. 确认客户端可访问 Bridge 的 `/healthz`。
2. 保存供应商配置并启用。
3. 重启 Codex。
4. 先测试短文本和流式显示，再测试读取项目文件等无副作用工具；开启搜索后，再测试联网搜索和来源引用。
5. 修改服务端模型列表后，重新 `Fetch Models` 并保存。返回列表由服务端环境变量生成，不是 Google 的实时权限列表。

Chat Completions 入口原样转发 `model`、`reasoning_effort`、消息和工具字段；Responses 入口会转换请求、响应和 SSE 事件，模型 ID 保持客户端填写的值。

## 常见问题

- **无法连接**：检查 Bridge 是否运行、`BIND_IP` 是否允许客户端访问，以及端口和反向代理配置。
- **Bridge 返回 401**：检查客户端 Key 是否与服务端 `BRIDGE_API_KEY` 完全一致。
- **接口返回 404/405**：核对 URL、上游格式和 `Full URL` 是否匹配；使用路由或聚合模式时检查本地路由是否运行。
- **模型列表未更新**：修改 `AVAILABLE_MODELS` 后重新创建容器，再获取模型列表并保存配置。
- **思考等级未生效**：检查模型能力开关和上游支持的参数。
- **`GCP search supports live web access only`**：在 Codex 中将搜索模式从缓存搜索切换为实时搜索（Live）。
