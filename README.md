# GCP LLM Bridge for CC Switch

为 CC Switch 提供轻量的 Google Cloud Agent Platform（原 Vertex AI）Chat Completions 认证代理。基于 Node.js 24，支持原始正文与 SSE 流式转发。

```text
Codex → CC Switch（协议转换）→ Bridge（认证转接）→ Google Cloud
```

当前使用的 CC Switch Codex Chat Completions 路由默认通过 `Authorization: Bearer <API Key>` 发送密钥，但本项目使用的 Google 静态 Key 需要放在 `x-goog-api-key` 中。CC Switch 将这些认证头列为受保护字段，自定义配置无法覆盖，因此需要 Bridge 完成认证头适配。

CC Switch 负责 Responses 与 Chat Completions 的协议转换。Bridge 校验客户端的 `BRIDGE_API_KEY`，移除客户端认证，使用服务端的 `GOOGLE_API_KEY` 设置 `x-goog-api-key`，再向 Agent Platform 转发请求。Bridge 按原始字节转发请求与响应正文，模型名、消息和工具参数保持不变。

## 快速开始

需要 Docker Compose 2.30.0 或更新版本。预构建镜像的部署方式见 [部署说明](docs/operations.md#使用预构建镜像)。

Windows 用户建议使用 Docker Desktop，启用 WSL 2 引擎并使用 Linux 容器模式。

1. 复制 `.env.example` 为 `.env`，将文件权限设为 `600`。填写 `GOOGLE_API_KEY` 和独立的 `BRIDGE_API_KEY`，将 `UPSTREAM_URL` 中的 `YOUR_PROJECT_ID` 替换为自己的项目 ID。默认仅发布在回环地址，局域网访问需将 `BIND_IP` 调整为宿主机的局域网 IP。
2. 拉取镜像并启动：

   ```bash
   docker compose up -d
   ```

3. 检查服务状态；修改过 `BIND_IP` 时替换下方地址：

   ```bash
   curl --fail http://127.0.0.1:4000/healthz
   ```

4. 参考 [CC Switch 接入](https://github.com/zexindai/gcp-llm-bridge/blob/master/docs/cc-switch.md) 完成配置。

默认拉取 `ghcr.io/zexindai/gcp-llm-bridge:latest`，可在 `.env` 中通过 `BRIDGE_IMAGE` 指定版本或其他镜像。需要从源码构建时，见 [本地构建](docs/operations.md#本地构建)。

## 接口与密钥

| 接口 | 认证 | 行为 |
| --- | --- | --- |
| `GET /healthz` | 无 | 本地健康检查 |
| `GET /v1/models` | Bridge Bearer Key | 返回配置的模型目录 |
| `POST /v1/chat/completions` | Bridge Bearer Key | 向固定 Google 上游转发 |

- 客户端填写 `BRIDGE_API_KEY`，须与服务端一致，至少 24 个字符。
- `GOOGLE_API_KEY` 仅供服务端访问 Google，须与 Bridge Key 不同。
- Bridge 提供 Chat Completions；Codex 的 Responses 协议由 CC Switch 转换。

## 模型目录

当前示例目录包含以下 19 个模型，实际可用性取决于 Google 项目权限和上游支持：

```text
google/gemini-4-argon
google/gemini-4-hydrogen
google/gemini-4-carbon
google/gemini-3.8-flash
google/gemini-3.7-flash
google/gemini-3.6-flash
google/gemini-3.5-flash
google/gemini-3.5-flash-lite
google/gemini-3.1-pro-preview
google/gemini-3.1-pro-preview-customtools
google/gemini-3.1-flash-lite
google/gemini-3-flash-preview
google/gemini-2.5-flash
xai/grok-4.20-reasoning
xai/grok-4.20-non-reasoning
deepseek-ai/deepseek-v4.1-flash-maas
zai-org/glm-5.2-maas
openai/gpt-oss-120b-maas
google/gemma-4-26b-a4b-it-maas
```

## 文档

- [配置说明](docs/configuration.md) · [部署与 Nginx](docs/operations.md) · [CC Switch 接入](docs/cc-switch.md)

## Sponsor

如果这个项目对你有帮助（更方便地花了GCP的300刀赠金），欢迎通过 [PayPal](https://www.paypal.com/paypalme/ZexinDai) 或下方微信赞赏码请我喝一杯咖啡，帮助项目持续维护和改进。感谢你的支持！

<img src="docs/assets/wechat-sponsor.png" alt="Zexin 的微信赞赏码" width="280" />

## 许可证

[MIT](LICENSE)
