FROM node:24.22.3-bookworm-slim
ENV NODE_ENV=production
LABEL org.opencontainers.image.licenses="MIT"
WORKDIR /app
COPY --chown=node:node package.json LICENSE ./
COPY --chown=node:node src ./src
COPY --chown=node:node config/codex/models.json ./config/codex/models.json
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD ["node", "--input-type=module", "-e", "const r = await fetch('http://127.0.0.1:' + (process.env.PORT || '4000') + '/healthz', {signal: AbortSignal.timeout(4000)}); process.exit(r.ok ? 0 : 1)"]
CMD ["node", "src/server.mjs"]
