.PHONY: help up down logs build seed test bench-dry-run lint

help: ## Show this help message
	@echo "FelCloud Operations & Development"
	@echo "Usage: make [target]"
	@echo ""
	@echo "Targets:"
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-16s %s\n", $$1, $$2}'

up: ## Start control plane and dashboard in mock mode
	docker compose up -d

down: ## Stop all running FelCloud containers
	docker compose down

logs: ## Follow logs from running containers
	docker compose logs -f

build: ## Build container images
	docker compose build

seed: ## Seed demo sandboxes and routes in mock mode
	docker compose --profile seed run --rm seed

test: ## Run Go and Dashboard unit test suites
	cd controlplane && go test -v ./...
	cd dashboard && npm test

bench-dry-run: ## Execute benchmark suite dry-run via container
	docker compose --profile bench run --rm bench

lint: ## Lint Dockerfile, Compose specifications, and verify documentation claims
	python3 scripts/check-claims.py
	docker compose config -q
	@if [ -e /var/run/docker.sock ]; then docker run --rm -i hadolint/hadolint < Dockerfile; else echo "Skipping hadolint (docker socket unavailable)"; fi
