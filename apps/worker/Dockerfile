FROM node:24-alpine AS build
WORKDIR /app
RUN corepack enable
RUN pnpm config set dangerouslyAllowAllBuilds true
COPY package.json pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps/worker ./apps/worker
COPY packages ./packages
RUN pnpm install --no-frozen-lockfile
RUN pnpm --filter @agentweave/worker... build

FROM node:24-alpine
WORKDIR /app
RUN corepack enable
COPY --from=build /app /app
CMD ["pnpm", "--filter", "@agentweave/worker", "start"]
