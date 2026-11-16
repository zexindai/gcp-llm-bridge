# CC Switch / Codex 接入

CC Switch 将 Codex 的 Responses 请求转换为 Chat Completions，再发送给 Bridge。配置和使用期间需要保持 CC Switch 的本地路由运行。

## 客户端配置

在 CC Switch 的 Codex 页面添加自定义供应商。将 `BRIDGE_HOST` 替换为客户端可访问的 Bridge 宿主机地址，端口与 `.env` 中的 `PORT` 保持一致。

| CC Switch 字段 | 设置 |
| --- | --- |
| Name | `GCP LLM Bridge`（或者你喜欢的） |
| API Key | 服务端 `.env` 的 `BRIDGE_API_KEY`，不是 Google Key |
| API Request URL | `http://BRIDGE_HOST:4000/v1/chat/completions` |
| Upstream Format | `OpenAI Chat Completions`（需要协议转换） |
| Full URL | 开启 |
| Supports Reasoning Effort | 模型支持思考等级时开启 |
| Supports Thinking Mode | 按上游模型能力配置（建议开启） |
| Header / Body overrides | 初次配置留空 |
| Actual Request Model | 例如 `google/gemini-4-argon` |
| Menu Display Name | 可自行设置，例如 `gemini-4-argon` |

如果修改了 Bridge 的端口，将请求地址中的 `4000` 替换为对应端口，例如 `http://BRIDGE_HOST:5000/v1/chat/completions`。操作步骤见 [自定义端口](configuration.md#自定义端口)。

Bridge Key 必须完全一致；缺失或错误返回本地 401。服务端更新 Key 并重新创建容器后，客户端也必须同步。

使用域名时，先按 [部署与 Nginx](operations.md) 完成反向代理，再把完整请求地址改成 `https://api.example.com/v1/chat/completions`，替换为自己的域名。API Key 仍使用 `BRIDGE_API_KEY`。

## 验证顺序

1. 确认客户端可访问 Bridge 的 `/healthz`。
2. 保存供应商配置，在 Codex 页面启用路由并选择该供应商，按客户端提示重启 Codex。
3. 新开对话测试短文本；再测试流式显示、无副作用工具往返和其他厂商的模型参数。
4. 更新模型目录后重新 Fetch Model。返回列表由服务端环境变量生成，不是 Google 的实时权限列表。

Bridge 对 `model`、`reasoning_effort`、消息和工具字段不做改写。每个上游型号允许的思考等级和参数并不相同，不能将某个型号的测试结果直接套到所有模型上。

## 常见问题

- 无法连接：检查 Bridge 是否运行、`BIND_IP` 是否允许客户端访问，以及端口和反向代理配置。
- Bridge 返回 401：检查客户端 Key 是否与服务端 `BRIDGE_API_KEY` 完全一致。
- 接口返回 404/405：核对完整 URL、上游格式和本地路由是否开启。
- 模型列表未更新：修改 `AVAILABLE_MODELS` 后重新创建容器，再获取模型列表并保存配置。
- 思考等级未生效：检查模型能力开关和上游支持的参数。
