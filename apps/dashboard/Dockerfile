FROM node:24-alpine
WORKDIR /app
RUN corepack enable
RUN pnpm config set dangerouslyAllowAllBuilds true
COPY package.json pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps/dashboard ./apps/dashboard
RUN pnpm install --no-frozen-lockfile
CMD ["pnpm", "--filter", "@agentweave/dashboard", "dev"]
