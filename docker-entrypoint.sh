#!/bin/sh
# Railway and Docker mount volumes owned by root, but the server runs as the
# unprivileged `node` user, so writing tokens.json into a fresh mount fails
# with EACCES. Take ownership while we still have root, then drop privileges
# so the server itself never runs as root.
set -e

TOKEN_DIR="${HOME:-/home/node}/.whoop-mcp"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$TOKEN_DIR"
  chown -R node:node "$TOKEN_DIR"
  exec su-exec node "$@"
fi

exec "$@"
