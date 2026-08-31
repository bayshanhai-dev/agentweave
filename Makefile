.PHONY: help install up down restart logs doctor check test build typecheck lint clean bridge demo fresh

help:
	@printf '%s\n' \
	  'make install   Install dependencies' \
	  'make up        Build and start the Docker stack' \
	  'make bridge    Start the local Codex host bridge (only for provider=codex)' \
	  'make demo      Start the stack and create a deterministic demo workstream' \
	  'make fresh     Remove local Docker state after CONFIRM=YES' \
	  'make down      Stop the Docker stack' \
	  'make doctor    Check local prerequisites and service health' \
	  'make check     Run typecheck, tests, and build' \
	  'make logs      Follow application logs'

install:
	corepack enable
	pnpm install

up:
	docker compose up --build -d

bridge:
	@test -f .env || (echo 'Create .env first: cp .env.example .env'; exit 1)
	@set -a; . ./.env; set +a; pnpm --filter @agentweave/host-runtime-bridge dev

demo:
	AGENTWEAVE_PROVIDER=mock MOCK_PROVIDER_DELAY_MS=700 docker compose up --build -d
	docker compose exec -T control-api node /app/scripts/demo.mjs

down:
	docker compose down

restart:
	docker compose down
	docker compose up --build -d

logs:
	docker compose logs -f --tail=200

doctor:
	@command -v docker >/dev/null || (echo 'docker is required'; exit 1)
	@docker info >/dev/null || (echo 'Docker daemon is not available'; exit 1)
	@command -v node >/dev/null || (echo 'node is required'; exit 1)
	@node -e "if (Number(process.versions.node.split('.')[0]) < 22) process.exit(1)" || (echo 'Node.js 22+ is required'; exit 1)
	@curl -fsS http://localhost:3000/health >/dev/null || (echo 'Control API is not healthy'; exit 1)
	@curl -fsS http://localhost:5173/ >/dev/null || (echo 'Dashboard is not reachable'; exit 1)
	@echo 'AgentWeave prerequisites and local services look healthy.'

check: typecheck test build

typecheck:
	pnpm run typecheck

test:
	pnpm run test

build:
	pnpm run build

lint:
	pnpm run lint

clean:
	docker compose down --remove-orphans

fresh:
	@test "$(CONFIRM)" = "YES" || (echo 'Refusing to delete local state. Run: make fresh CONFIRM=YES'; exit 1)
	docker compose down --volumes --remove-orphans
