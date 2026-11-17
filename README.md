# GCP LLM Bridge for Codex

轻量的 Google Cloud Agent Platform（原 Vertex AI）认证代理，基于 Node.js 24。
提供 Chat Completions 原始转发（适配CC Switch），以及兼容 Responses API 的协议转换入口（替换Codex配置文件）。
支持以下三种路由：
```text
Codex → Bridge /v1/responses（协议转换、认证转接）→ Google Cloud
Codex → CC Switch（协议转换）→ Bridge /v1/chat/completions（认证转接）→ Google Cloud
Codex → CC Switch（聚合转发）→ Bridge /v1/responses（协议转换、认证转接）→ Google Cloud
```

当前使用的 CC Switch Codex Chat Completions 路由默认通过 `Authorization: Bearer <API Key>` 发送密钥，但本项目使用的 Google 静态 Key 需要放在 `x-goog-api-key` 中。CC Switch 将这些认证头列为受保护字段，自定义配置无法覆盖，因此需要 Bridge 完成认证头适配。

Bridge 校验客户端的 `BRIDGE_API_KEY`，移除客户端认证，使用服务端的 `GOOGLE_API_KEY` 设置 `x-goog-api-key`，再向 Agent Platform 转发请求。`/v1/chat/completions` 按原始字节转发正文；`/v1/responses` 在 Bridge 内转换请求、响应和 SSE 事件。使用 CC Switch 的 Chat Completions 路由时，仍由 CC Switch 转换协议。

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

4. 根据使用方式，参考 [Codex / Codex CLI 直接接入](docs/codex_config.md) 或 [CC Switch 接入](docs/cc-switch.md) 完成配置。
5. 配置 [Nginx 反向代理](docs/operations.md#nginx-域名配置)（可选）。

默认拉取 `ghcr.io/zexindai/gcp-llm-bridge:latest`，可在 `.env` 中通过 `BRIDGE_IMAGE` 指定版本或其他镜像。需要从源码构建时，见 [本地构建](docs/operations.md#本地构建)。

## 接口与密钥

| 接口 | 认证 | 行为 |
| --- | --- | --- |
| `GET /healthz` | 无 | 本地健康检查 |
| `GET /v1/models` | Bridge Bearer Key | 返回配置的模型目录 |
| `GET /v1/codex/models` | Bridge Bearer Key | 返回三款 Gemini 4 的 Codex 能力目录，供 model_catalog_url 使用 |
| `POST /v1/chat/completions` | Bridge Bearer Key | 向固定 Google 上游转发 |
| `POST /v1/responses` | Bridge Bearer Key | 转换为 Chat Completions 请求，返回 Responses JSON 或 SSE |
| `POST /v1/alpha/search` | Bridge Bearer Key | Codex 独立搜索，使用 GCP Google Search，返回摘要和来源 |

- 客户端填写 `BRIDGE_API_KEY`，须与服务端一致，至少 24 个字符。
- `GOOGLE_API_KEY` 仅供服务端访问 Google，须与 Bridge Key 不同。
- Responses 入口支持文本、图片、函数工具、`apply_patch`、推理文本及流式事件，采用完整历史回传的无状态方式；Codex 和 Codex CLI 的配置见 [直接接入指南](docs/codex_config.md)。

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

- [配置说明](docs/configuration.md) · [部署与 Nginx](docs/operations.md) · [CC Switch 接入](docs/cc-switch.md) · [Codex / Codex CLI 直接接入](docs/codex_config.md)

## Sponsor

如果这个项目对你有帮助（比如更方便地花了GCP的300刀赠金），欢迎通过 [PayPal](https://www.paypal.com/paypalme/ZexinDai) 或下方微信赞赏码请我喝一杯咖啡，帮助项目持续维护和改进。感谢你的支持！

<img src="docs/assets/wechat-sponsor.png" alt="Zexin 的微信赞赏码" width="280" />

## 许可证

[MIT](LICENSE)
