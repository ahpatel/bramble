# The self-hosted mailbox server (see README.md). Built from the repository root, because the server
# shares the sync protocol with the apps (packages/core):
#
#   docker build -f services/mailbox/Dockerfile -t bramble-mailbox .
#   docker run -p 7401:7401 -v bramble-mailbox:/data bramble-mailbox    # http://localhost:7401
#
# Configured like `pnpm start`, through the variables in README.md. DATA_DIR is /data.

FROM node:24-trixie-slim AS deps
WORKDIR /app
RUN corepack enable
# The lockfile and only the two manifests the server needs, so this layer stays cached until a
# dependency changes. Production dependencies of the server alone; zod also goes in
# /app/node_modules, where the protocol file shared with packages/core finds it. No install
# scripts run: better-sqlite3 loads the binary it ships for this platform.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/
COPY services/mailbox/package.json services/mailbox/
RUN pnpm install --frozen-lockfile --prod --ignore-scripts --filter bramble-mailbox-server \
		--config.public-hoist-pattern=zod \
	&& rm -rf /root/.cache /root/.local/share/pnpm

FROM node:24-trixie-slim
ENV NODE_ENV=production DATA_DIR=/data
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY --from=deps /app/services/mailbox/node_modules services/mailbox/node_modules
COPY packages/core/package.json packages/core/
COPY packages/core/src/sync/mailbox/protocol.ts packages/core/src/sync/mailbox/
COPY services/mailbox/package.json services/mailbox/
COPY services/mailbox/drizzle services/mailbox/drizzle
COPY services/mailbox/src services/mailbox/src
RUN mkdir /data && chown node:node /data
USER node
VOLUME /data

# GET /health answers ok. The image has no curl or wget, so Node asks.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
	CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT || 7401}/health`).then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

EXPOSE 7401
# Node runs the TypeScript directly, and closes the server on SIGTERM as PID 1.
CMD ["node", "services/mailbox/src/node/bin.ts"]
