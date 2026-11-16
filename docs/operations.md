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

## 发布镜像

[GitHub Actions 工作流](../.github/workflows/docker.yml) 在推送 `main`、`master` 或提交 PR 时构建镜像。推送版本标签时，构建成功后自动发布 `linux/amd64` 和 `linux/arm64` 镜像到 `ghcr.io/<账号>/<仓库>`，生成版本标签和 `latest`。

1. 将项目推送到自己的 GitHub 仓库，并确认 Actions 已启用。
2. 将 `package.json` 的 `version` 设为待发布版本并提交，例如 `0.1.0`。
3. 推送对应标签，版本必须与 `package.json` 一致：

   ```bash
   git tag v0.1.0
   git push origin v0.1.0
   ```

4. 在仓库的 Actions 页面确认发布成功。首次发布后，在账号的 Packages 中将该镜像的可见性设为 Public，其他人即可匿名拉取。公开仓库不代表新建镜像包会自动公开。

工作流使用 GitHub 自动提供的 `GITHUB_TOKEN` 登录 GHCR，无需配置个人令牌、Google Key 或 Bridge Key。每个版本标签均发布一个稳定版本，例如 `v0.1.0` 对应镜像标签 `0.1.0`；每次成功发布同时更新 `latest`。

参考：[GitHub 镜像发布](https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images)、[GHCR 权限与可见性](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)。

## Nginx 域名配置

项目根目录提供 Nginx 配置模板：

- [gcp-llm-bridge.conf.example](../gcp-llm-bridge.conf.example)：使用占位域名、证书路径和上游 IP 的可复用模板。

首次部署时，将模板复制为 `gcp-llm-bridge.conf`，把 `api.example.com`、证书路径和上游 IP 替换为自己的参数；如果已有该文件，直接核对并编辑现有配置。

模板中的 `proxy_pass` 默认使用端口 `4000`。如果按 [自定义端口](configuration.md#自定义端口) 将 Bridge 改为 `5000`，这里也需改为 `5000`；对外的 HTTPS 端口和 CC Switch 的域名请求地址保持不变。

模板包含 HTTPS、HTTP 重定向、SSE 所需的关闭缓冲设置和 600 秒读取空闲超时。`Authorization` 使用客户端提供的值，由 Bridge 验证。`proxy_pass` 不附加 URI，保留 `/v1/...` 路径。

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

普通日志仅记录请求 ID、已知路由、状态、耗时和固定故障代码。

请求与响应正文通过流式管道转发，支持背压和 gzip 字节/编码头配对。上游错误状态与 `Retry-After` 透传；不跟随重定向，不自动重试 POST。客户端断开时取消上游。

连接/空闲超时在响应头前返回 504，其他网络故障返回 502。

## 上游网络

本服务通过 Node.js HTTPS 直接访问 Google，如果环境需要出口代理，需另行实现并验证。
