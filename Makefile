.PHONY: help install up down restart logs doctor check test build typecheck lint clean

help:
	@printf '%s\n' \
	  'make install   Install dependencies' \
	  'make up        Build and start the Docker stack' \
	  'make down      Stop the Docker stack' \
	  'make doctor    Check local prerequisites and service health' \
	  'make check     Run typecheck, tests, and build' \
	  'make logs      Follow application logs'

install:
	corepack enable
	pnpm install

up:
	docker compose up --build -d

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
