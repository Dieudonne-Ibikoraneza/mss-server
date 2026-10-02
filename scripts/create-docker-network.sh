#!/bin/sh
set -eu

network_name="${1:-${BACKEND_NETWORK:-magnificat-backend}}"
if docker network inspect "$network_name" >/dev/null 2>&1; then
  printf 'Network %s already exists.\n' "$network_name"
else
  docker network create --driver bridge "$network_name"
fi
