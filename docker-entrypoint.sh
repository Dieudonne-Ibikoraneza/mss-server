#!/bin/sh
set -eu

if [ "$#" -eq 0 ]; then
  set -- node dist/main.js
fi

# Allow Node flags while preserving explicit commands such as sh or the migration CLI.
case "$1" in
  -*) set -- node "$@" ;;
esac

if [ "$1" = node ] && [ "${2:-}" = dist/main.js ]; then
  [ -f dist/main.js ] || {
    printf 'Backend build is missing; rebuild the Docker image.\n' >&2
    exit 1
  }
  export NODE_ENV="${NODE_ENV:-production}"
  export PORT="${PORT:-4000}"
fi

# Replace the shell so the application receives shutdown signals directly.
exec "$@"
