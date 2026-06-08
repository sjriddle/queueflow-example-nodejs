# One-command runbook for the QueueFlow × Express example.
#
#   make demo     # bring up Postgres + server + SDK, run the smoke test, all in one
#   make up       # just start Postgres + the QueueFlow server (background)
#   make app      # run the Express app in the foreground (needs `make up` first)
#   make smoke    # run the SDK end-to-end smoke test
#   make logs     # tail the server log
#   make down     # stop the app/server and remove the Postgres container
#
# Ports are overridable, e.g. if 5432/8000 are taken on your machine:
#   make demo PG_PORT=5440 API_PORT=8055 METRICS_PORT=9077

SHELL := /bin/bash
.DEFAULT_GOAL := help

# --- knobs -----------------------------------------------------------------
PG_PORT      ?= 5432
API_PORT     ?= 8000
METRICS_PORT ?= 9090
PORT         ?= 3000
TOKEN        ?= dev
PG_CONTAINER ?= qf-pg
PG_IMAGE     ?= quay.io/tembo/pg16-pgmq:latest

QUEUEFLOW_URL ?= http://localhost:$(API_PORT)
DATABASE_URL  ?= postgres://postgres:postgres@localhost:$(PG_PORT)/postgres

# The SDK is vendored into this repo. The QueueFlow engine (Rust) lives in its
# own repo — point CORE_DIR at a local checkout of queueflow-core, or skip
# the `up`/`server-up` targets and run the engine yourself.
CORE_DIR ?= ../queueflow-core
SDK_DIR  ?= ./vendor/queueflow-sdk-nodejs

SERVER_PID := .server.pid
SERVER_LOG := .server.log

export QUEUEFLOW_URL
export QUEUEFLOW_TOKEN = $(TOKEN)
export PORT

# --- composite targets -----------------------------------------------------

.PHONY: help
help: ## Show this help
	@awk 'BEGIN {FS = ":.*?## "} /^[a-zA-Z_-]+:.*?## / {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

.PHONY: demo
demo: up sdk install smoke ## Full automated demo: stack up + SDK build + smoke test
	@echo ""
	@echo "✓ demo passed. The stack is still up:"
	@echo "    QueueFlow API : $(QUEUEFLOW_URL)"
	@echo "    run the app   : make app   (then curl localhost:$(PORT)/signup ...)"
	@echo "    tear it down  : make down"

.PHONY: up
up: pg-up server-up ## Start Postgres + the QueueFlow server (background)

# --- Postgres --------------------------------------------------------------

.PHONY: pg-up
pg-up: ## Start the PGMQ Postgres container
	@if [ -n "$$(docker ps -q -f name=^/$(PG_CONTAINER)$$)" ]; then \
		echo "==> Postgres '$(PG_CONTAINER)' already running"; \
	else \
		docker rm -f $(PG_CONTAINER) >/dev/null 2>&1 || true; \
		echo "==> Starting Postgres '$(PG_CONTAINER)' on :$(PG_PORT)"; \
		docker run -d --name $(PG_CONTAINER) -p $(PG_PORT):5432 \
			-e POSTGRES_PASSWORD=postgres $(PG_IMAGE) >/dev/null; \
	fi
	@printf "==> Waiting for Postgres"; \
	for i in $$(seq 1 60); do \
		if docker exec $(PG_CONTAINER) pg_isready -U postgres >/dev/null 2>&1; then \
			echo " ready"; exit 0; \
		fi; \
		printf "."; sleep 1; \
	done; \
	echo " timed out"; exit 1

# --- QueueFlow server ------------------------------------------------------

.PHONY: server-up
server-up: ## Build & start the QueueFlow server in the background
	@if curl -fsS $(QUEUEFLOW_URL)/health >/dev/null 2>&1; then \
		echo "==> QueueFlow already healthy at $(QUEUEFLOW_URL)"; \
	else \
		echo "==> Building queueflow-server"; \
		( cd $(CORE_DIR) && cargo build -q -p queueflow-server ); \
		echo "==> Starting server (mode=all) -> log: $(SERVER_LOG)"; \
		DATABASE_URL="$(DATABASE_URL)" $(CORE_DIR)/target/debug/queueflow serve \
			--mode all --workers 5 --api-port $(API_PORT) --metrics-port $(METRICS_PORT) \
			>$(SERVER_LOG) 2>&1 & echo $$! >$(SERVER_PID); \
		printf "==> Waiting for the API"; \
		for i in $$(seq 1 60); do \
			if curl -fsS $(QUEUEFLOW_URL)/health >/dev/null 2>&1; then break; fi; \
			printf "."; sleep 1; \
		done; \
		if curl -fsS $(QUEUEFLOW_URL)/health >/dev/null 2>&1; then \
			echo " up at $(QUEUEFLOW_URL)"; \
		else \
			echo " timed out — see $(SERVER_LOG)"; exit 1; \
		fi; \
	fi

.PHONY: logs
logs: ## Tail the QueueFlow server log
	@tail -f $(SERVER_LOG)

# --- SDK + app -------------------------------------------------------------

.PHONY: sdk
sdk: ## Build the @queueflow/sdk this example depends on
	@echo "==> Building @queueflow/sdk"
	@cd $(SDK_DIR) && npm install --silent && npm run build --silent

.PHONY: install
install: ## Install this example's dependencies
	@echo "==> Installing example dependencies"
	@npm install --silent

.PHONY: smoke
smoke: ## Run the SDK end-to-end smoke test
	@npm run smoke

.PHONY: app
app: ## Run the Express app in the foreground
	@npm run dev

# --- teardown --------------------------------------------------------------

.PHONY: down
down: ## Stop the app/server and remove the Postgres container
	@if [ -f $(SERVER_PID) ]; then \
		kill $$(cat $(SERVER_PID)) 2>/dev/null || true; \
		rm -f $(SERVER_PID); \
		echo "==> Stopped QueueFlow server"; \
	fi
	@docker rm -f $(PG_CONTAINER) >/dev/null 2>&1 && echo "==> Removed Postgres '$(PG_CONTAINER)'" || true
	@rm -f $(SERVER_LOG)
