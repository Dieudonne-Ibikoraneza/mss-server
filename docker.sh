#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SERVICE=backend
SERVICES=(backend redis)
ENV_VARIABLE=BACKEND_ENV_FILE
ENV_FILE="$SCRIPT_DIR/.env.docker"
ACTION=up
ACTION_SET=false
BUILD=true
NO_CACHE=false
FOREGROUND=false
WAIT=true
WAIT_TIMEOUT=120
FOLLOW=false
TAIL=100
MIGRATE=false
PROJECT_NAME=""

fail() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<EOF
Usage: ./docker.sh [action] [options]

Actions (choose one; default: --up):
  -u, --up           Build and start $SERVICE and its dependencies
  -b, --build        Build the application image only
  -d, --down         Remove this project's containers; preserve data volumes
      --stop         Stop this project's containers
      --restart      Restart this project's containers (does not rebuild)
  -l, --logs         Show this project's logs
  -s, --status       Show this project's containers and health
  -c, --config       Validate Compose without printing environment values
      --init-env     Copy .env.docker.example if the target does not exist
      --migrate-only Apply committed database migrations and exit
      --migrate      Apply migrations before --up (explicit opt-in)
Options:
      --env-file PATH    Use this env file for this Compose project
                         Relative paths resolve from the caller's directory
      --project-name NAME  Override the Compose project name
      --no-build         Use existing images without building
      --no-cache         Build without cached layers
      --foreground       Run --up attached instead of detached
      --no-wait          Do not wait for container health with detached --up
      --wait-timeout N   Health wait timeout in seconds (default: 120)
      --tail N           Log lines per container (default: 100)
  -f, --follow           Follow --logs continuously
  -h, --help             Show this help

Examples:
  ./docker.sh --init-env
  ./docker.sh --up
  ./docker.sh --up --no-build
  ./docker.sh --logs --follow
EOF
}

set_action() {
  "$ACTION_SET" && fail "Choose only one action."
  ACTION="$1"
  ACTION_SET=true
}

value_required() {
  [[ $# -ge 2 && -n "$2" && "$2" != -* ]] || fail "$1 requires a value."
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -u|--up) set_action up ;;
    -b|--build) set_action build ;;
    -d|--down) set_action down ;;
    --stop) set_action stop ;;
    --restart) set_action restart ;;
    -l|--logs) set_action logs ;;
    -s|--status) set_action status ;;
    -c|--config) set_action config ;;
    --init-env) set_action init-env ;;
    --migrate)
      [[ "$SERVICE" == backend ]] || fail "--migrate is only supported by server/docker.sh."
      MIGRATE=true ;;
    --migrate-only)
      [[ "$SERVICE" == backend ]] || fail "--migrate-only is only supported by server/docker.sh."
      set_action migrate ;;
    --env-file) value_required "$@"; ENV_FILE="$2"; shift ;;
    --project-name) value_required "$@"; PROJECT_NAME="$2"; shift ;;
    --no-build) BUILD=false ;;
    --no-cache) NO_CACHE=true ;;
    --foreground) FOREGROUND=true ;;
    --no-wait) WAIT=false ;;
    --wait-timeout)
      value_required "$@"
      [[ "$2" =~ ^[1-9][0-9]*$ ]] || fail "--wait-timeout must be a positive integer."
      WAIT_TIMEOUT="$2"; shift ;;
    --tail)
      value_required "$@"
      [[ "$2" =~ ^[0-9]+$ ]] || fail "--tail must be a non-negative integer."
      TAIL="$2"; shift ;;
    -f|--follow) FOLLOW=true ;;
    -h|--help) usage; exit 0 ;;
    *) fail "Unknown option: $1. Use --help for supported flags." ;;
  esac
  shift
done

if "$MIGRATE" && [[ "$ACTION" != up ]]; then
  fail "Use --migrate with --up, or --migrate-only as its own action."
fi
if ! "$BUILD" && [[ "$ACTION" != up && "$ACTION" != migrate ]]; then
  fail "--no-build is only supported with --up or --migrate-only."
fi
if "$NO_CACHE" && { ! "$BUILD" || [[ "$ACTION" != up && "$ACTION" != build && "$ACTION" != migrate ]]; }; then
  fail "--no-cache requires an action that builds images."
fi
if "$FOREGROUND" && [[ "$ACTION" != up ]]; then
  fail "--foreground is only supported with --up."
fi
if ! "$WAIT" && [[ "$ACTION" != up ]]; then
  fail "--no-wait is only supported with --up."
fi
if "$FOLLOW" && [[ "$ACTION" != logs ]]; then
  fail "--follow is only supported with --logs."
fi

# Resolve before changing directory so custom paths work from anywhere.
[[ "$ENV_FILE" == /* ]] || ENV_FILE="$PWD/$ENV_FILE"

if [[ "$ACTION" == init-env ]]; then
  [[ ! -e "$ENV_FILE" ]] || fail "$ENV_FILE already exists; it was not overwritten."
  # noclobber also prevents a concurrent invocation from overwriting credentials.
  (set -o noclobber; umask 077; cat "$SCRIPT_DIR/.env.docker.example" > "$ENV_FILE")
  printf 'Created %s. Fill its deployment values before running --up.\n' "$ENV_FILE"
  exit 0
fi

[[ -f "$ENV_FILE" ]] || fail "Missing $ENV_FILE. Run --init-env, then fill the deployment values."
command -v docker >/dev/null 2>&1 || fail "Docker is not installed."
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required."
export "$ENV_VARIABLE=$ENV_FILE"
cd "$SCRIPT_DIR"

COMPOSE=(docker compose --env-file "$ENV_FILE" -f "$SCRIPT_DIR/compose.production.yaml")
[[ -z "$PROJECT_NAME" ]] || COMPOSE+=(--project-name "$PROJECT_NAME")

compose() {
  "${COMPOSE[@]}" "$@"
}

compose config --quiet
if [[ "$ACTION" == config ]]; then
  printf 'Production Compose configuration is valid.\n'
  exit 0
fi
docker info >/dev/null 2>&1 || fail "Cannot access the Docker daemon. Start Docker and check your permissions."

ensure_network() {
  if [[ "$SERVICE" == backend ]]; then
    local network_name
    # Compose parses dotenv safely; never execute an env file as shell code.
    network_name="$(compose config --environment | sed -n 's/^BACKEND_NETWORK=//p')"
    sh "$SCRIPT_DIR/scripts/create-docker-network.sh" "${network_name:-magnificat-backend}"
  fi
}

build_image() {
  local options=()
  "$NO_CACHE" && options+=(--no-cache)
  compose build "${options[@]}" "$1"
}

migrate() {
  "$BUILD" && build_image migrations
  compose --profile tools run --rm --no-deps migrations
}

case "$ACTION" in
  build) build_image "$SERVICE" ;;
  up)
    ensure_network
    "$BUILD" && build_image "$SERVICE"
    "$MIGRATE" && migrate
    if "$FOREGROUND"; then
      exec "${COMPOSE[@]}" up --no-build "${SERVICES[@]}"
    elif "$WAIT"; then
      compose up --no-build --detach --wait --wait-timeout "$WAIT_TIMEOUT" "${SERVICES[@]}"
    else
      compose up --no-build --detach "${SERVICES[@]}"
    fi
    compose ps ;;
  migrate) ensure_network; migrate ;;
  down) compose down ;;
  stop) compose stop "${SERVICES[@]}" ;;
  restart) compose restart "${SERVICES[@]}" ;;
  logs)
    options=(--tail "$TAIL")
    "$FOLLOW" && options+=(--follow)
    exec "${COMPOSE[@]}" logs "${options[@]}" "${SERVICES[@]}" ;;
  status) compose ps ;;
esac
