# 配置说明

在项目根目录创建并编辑 `.env`。Docker Compose 以 raw 格式将配置注入容器。

下文命令使用默认的镜像拉取配置；使用 `compose.build.yaml` 本地构建时，在 `docker compose` 后加上 `-f compose.build.yaml`。

## 创建配置

首次配置时，复制示例并设置文件权限；已有 `.env` 时直接编辑现有文件：

```bash
cp .env.example .env
chmod 600 .env
```

填写两把密钥，将 `UPSTREAM_URL` 中的 `YOUR_PROJECT_ID` 替换为自己的 Google Cloud 项目 ID，再按需调整端口、发布地址和模型目录。

## 两把密钥

| 变量 | 用途 |
| --- | --- |
| `BRIDGE_API_KEY` | 客户端发给 Bridge 的 Bearer Key，至少 24 字符，与服务端完全一致（可自定义） |
| `GOOGLE_API_KEY` | 用于 Agent Platform（原 Vertex AI） 入口的 Google 静态 Key，仅放入 `x-goog-api-key` |

将 `BRIDGE_API_KEY` 设置为独立的随机字符串，并在客户端填写相同值。两把密钥必须不同。Bridge 校验客户端认证后，仅向 Google 发送服务端配置的 Key。

## 环境变量

| 变量 | 默认值或含义 |
| --- | --- |
| `BRIDGE_IMAGE` | 默认 `ghcr.io/zexindai/gcp-llm-bridge:latest`，可指定发布版本；仅用于默认 Compose 的镜像选择 |
| `PORT` | `4000`，容器和宿主机使用相同端口 |
| `BIND_IP` | Compose 默认为 `127.0.0.1`；仅控制宿主机端口发布地址 |
| `UPSTREAM_URL` | 必填；自己的 Google v1/global OpenAI Chat Completions 完整 URL，无默认项目 |
| `AVAILABLE_MODELS` | 逗号分隔的 `publisher/model` 展示列表；未设置时只展示 Argon |
| `CONNECT_TIMEOUT_MS` | `10000`，包含 DNS 和 TLS 连接建立 |
| `IDLE_TIMEOUT_MS` | `600000`，上游空闲时限，不是整次生成的总时限 |

容器内监听 `0.0.0.0`。`BIND_IP` 仅控制 Compose 向宿主机发布端口的地址：本机访问使用 `127.0.0.1`，局域网访问填写宿主机的局域网 IP。

## 自定义端口

修改 `.env` 中的 `PORT`，例如将默认的 `4000` 改为 `5000`：

```dotenv
PORT=5000
```

重新创建容器使配置生效：

```bash
docker compose up -d --force-recreate
```

当前 Compose 会同时将宿主机端口和容器端口改为 `5000`，无需编辑 `compose.yaml`。健康检查地址也改为 `http://BRIDGE_HOST:5000/healthz`，其中 `BRIDGE_HOST` 为客户端可访问的宿主机地址。

- **CC Switch 直连 Bridge**：将完整请求地址改为 `http://BRIDGE_HOST:5000/v1/chat/completions`。
- **Responses 客户端**：将 base URL 改为 `http://BRIDGE_HOST:5000/v1`；完整接口地址为 `http://BRIDGE_HOST:5000/v1/responses`。
- **通过 Nginx 域名连接**：将 Nginx 配置中的 `proxy_pass` 端口改为 `5000`，按 [部署与 Nginx](operations.md#nginx-域名配置) 安装更新后的配置、检查并重新加载；CC Switch 的域名请求地址保持不变。

## 上游地址

`UPSTREAM_URL` 为必填项：

```text
UPSTREAM_URL=https://aiplatform.googleapis.com/v1/projects/YOUR_PROJECT_ID/locations/global/endpoints/openapi/chat/completions
```

将 `YOUR_PROJECT_ID` 替换为实际项目 ID。URL 必须满足以下条件：

- HTTPS，主机为 `aiplatform.googleapis.com`，不带额外端口、用户名、密码、查询参数或片段。
- 路径为 `/v1/projects/<project>/locations/global/endpoints/openapi/chat/completions`。

空密钥、示例占位密钥、相同的两把密钥、非法 URL 或非法数值会导致启动失败。

## 模型目录

[docs/models.txt](models.txt) 和 `.env.example` 提供模型目录示例。实际展示列表由 `.env` 中的 `AVAILABLE_MODELS` 决定，多个模型 ID 用逗号分隔，例如：

```dotenv
AVAILABLE_MODELS=google/gemini-4-argon,google/gemini-3.8-flash
```

修改 `docs/models.txt` 不会自动更新运行配置。

`GET /v1/models` 从 `AVAILABLE_MODELS` 生成 OpenAI models 格式，`owned_by` 使用 publisher 前缀。这个目录：

- 不实时查询 Google 权限。
- 不限制 `/v1/chat/completions` 或 `/v1/responses` 正文使用其他模型 ID。

`GET /v1/codex/models` 是额外的 Codex 能力目录接口，返回内置的 Argon、Hydrogen、Carbon 定义与 AVAILABLE_MODELS 的交集。它与 `/v1/models` 的格式和用途不同，客户端配置参考 [config.toml.example](../config/codex/config.toml.example)。

## 应用修改

修改 `.env` 后，需重新创建容器；普通 restart 不会重新注入环境变量：

```bash
docker compose up -d --force-recreate
```

修改 Bridge Key 后，还需同步客户端保存的 Key。
