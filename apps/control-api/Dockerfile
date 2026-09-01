FROM node:24-alpine AS build
WORKDIR /app
RUN corepack enable
RUN pnpm config set dangerouslyAllowAllBuilds true
COPY package.json pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps/control-api ./apps/control-api
COPY packages ./packages
COPY scripts ./scripts
COPY db ./db
RUN pnpm install --no-frozen-lockfile
RUN pnpm --filter @agentweave/control-api... build

FROM node:24-alpine
WORKDIR /app
RUN corepack enable
COPY --from=build /app /app
CMD ["pnpm", "--filter", "@agentweave/control-api", "start"]
