# 部署与运维

## Docker

```bash
# 首次部署或更新镜像
docker compose up -d

# 查看运行状态和近期日志
docker compose ps
docker compose logs --tail=50

# 只重启，不重新读取 .env
docker compose restart

# 修改环境变量后重新创建
docker compose up -d --force-recreate

# 停止并删除本项目容器与 Compose 网络，保留本地文件
docker compose down
```

镜像基于 `node:24.22.3-bookworm-slim`，以非 root 用户运行，文件系统只读，移除 capabilities，启用 no-new-privileges。Docker 日志按 3 个文件、每个 10 MB 轮转。

容器内监听 `0.0.0.0`；宿主机发布地址由 `BIND_IP` 控制。直接执行 `npm start` 时，`BIND_IP` 不会限制 Node.js 的监听接口。

`restart: unless-stopped` 控制容器自动重启。Docker daemon 是否随系统启动需在宿主机单独配置；手动停止的容器不会因为宿主机重启而自动恢复。

## 使用预构建镜像

默认 `compose.yaml` 从 GHCR 拉取镜像，无需本地构建。先按 [配置说明](configuration.md) 填写 `.env`。默认镜像为 `ghcr.io/zexindai/gcp-llm-bridge:latest`，需要固定版本时修改：

```dotenv
BRIDGE_IMAGE=ghcr.io/zexindai/gcp-llm-bridge:0.1.0
```

拉取并启动：

```bash
docker compose up -d
```

配置使用 `pull_policy: always`，每次执行 `up` 都会拉取指定标签。更新版本时修改 `.env` 中的镜像标签，再执行上述命令。使用自己发布的镜像时，将 `BRIDGE_IMAGE` 替换为对应的小写 GHCR 地址。

## 本地构建

需要使用本地源码，或镜像尚未发布时，使用 `compose.build.yaml`：

```bash
docker compose -f compose.build.yaml up -d --build
```

本地构建模式下，后续查看日志、重新创建或停止服务时，也需带上 `-f compose.build.yaml`。修改配置后执行：

```bash
docker compose -f compose.build.yaml up -d --force-recreate
```

## Nginx 域名配置

`config/nginx/` 目录提供 Nginx 配置模板：

- [gcp-llm-bridge.conf.example](../config/nginx/gcp-llm-bridge.conf.example)：使用占位域名、证书路径和上游 IP 的可复用模板。

首次部署时，在项目根目录执行 `cp config/nginx/gcp-llm-bridge.conf.example gcp-llm-bridge.conf`，把 `api.example.com`、证书路径和上游 IP 替换为自己的参数；如果已有该文件，直接核对并编辑现有配置。

模板中 `upstream gcp_bridge_backend` 的 `server` 默认使用端口 `4000`。如果按 [自定义端口](configuration.md#自定义端口) 将 Bridge 改为 `5000`，这里也需改为 `5000`；对外的 HTTPS 端口和 CC Switch 的域名请求地址保持不变。模板包含 `log_format` 和 `upstream`，需从 Nginx 的 `http` 上下文加载；Ubuntu 默认的 `/etc/nginx/conf.d/*.conf` 符合这一要求。

模板包含 HTTPS、HTTP 重定向、SSE 所需的关闭缓冲设置和 600 秒读取空闲超时。`Authorization` 使用客户端提供的值，由 Bridge 验证。`proxy_pass` 不附加 URI，保留 `/v1/...` 路径。

`keepalive 16` 为每个 Nginx worker 缓存最多 16 条空闲的 Bridge 连接，不限制活跃请求并发数。空闲缓存时间设为 4 秒，以配合当前 Node HTTP 服务默认 5 秒的 keep-alive 空闲时间。

HTTPS 请求的专用 JSON 日志写入 `/var/log/nginx/gcp-bridge-access.log`，包含总耗时、Nginx 到 Bridge 的建连/响应头/完整响应耗时，以及 Bridge 返回的 `x-request-id`。这些上游计时针对 Bridge，不直接代表 GCP 耗时；可通过 `bridge_request_id` 与 Bridge 的阶段日志关联。日志使用 `$uri`，不记录查询参数、认证头或正文。

编辑完成后，管理员可在项目根目录手动执行：

```bash
sudo install -m 644 gcp-llm-bridge.conf /etc/nginx/conf.d/gcp-llm-bridge.conf
sudo nginx -t
```

检查通过后再执行：

```bash
sudo systemctl reload nginx
```

## 日志和传输行为

普通日志记录请求 ID、已知路由、配置内的模型名（Responses/Search）、状态、总耗时、固定故障代码及受限的错误字段路径，不记录正文或认证信息。中断日志在取消处理后结算，保留原有故障原因。

`timings_ms` 中各值是从 Bridge 收到请求头开始计算的累计毫秒数，不是各阶段独立耗时；尚未发生的阶段不输出：

| 字段 | 记录时刻 |
| --- | --- |
| `request_body` | 客户端请求体接收完毕 |
| `upstream_request` | 创建上游请求之前，Responses 的解析、校验与转换已完成 |
| `upstream_connected` | 上游连接就绪，包含新建 TCP/TLS 连接或复用连接 |
| `upstream_sent` | 上游请求写出，不代表 GCP 已确认接收 |
| `upstream_headers` | 收到上游响应头 |
| `upstream_first_chunk` | 收到首个上游正文分片 |
| `first_text` | Responses 解析出首个输出文字；非流式响应需等待完整正文 |

例如 `upstream_request - request_body` 表示 Responses 的本地转发准备耗时；等待响应头的时间还包含网络和上游排队。HTTP 200 的流式响应仍可能失败，需要结合 `fault`、`interrupted` 和 SSE 终止事件判断。

诊断模式额外按阶段输出关联同一请求 ID 的 `stage_timing` 事件，可在请求尚未结束时观察进度；默认关闭，向服务进程发送 `SIGUSR2` 临时切换，10 分钟后自动关闭。诊断同样不记录正文和密钥。

`/v1/chat/completions` 的请求与响应正文通过流式管道转发，支持背压和 gzip 字节/编码头配对。`/v1/responses` 解析 JSON、转换协议和 SSE 事件，只接受未压缩请求，Codex 配置见 [直接接入指南](codex_config.md)。两种入口均处理背压，不跟随重定向，不自动重试 POST，客户端断开时取消上游。

上游错误状态与 `Retry-After` 保留。连接/空闲超时在响应头前返回 504，其他网络故障返回 502。Responses 流开始后的异常以 `response.failed` 事件终止。

## 上游网络

本服务通过 Node.js HTTPS 直接访问 Google，如果环境需要出口代理，需另行实现并验证。
