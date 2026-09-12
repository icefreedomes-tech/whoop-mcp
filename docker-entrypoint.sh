#!/bin/sh
# Railway and Docker mount volumes owned by root, but the server runs as the
# unprivileged `node` user, so writing tokens.json into a fresh mount fails
# with EACCES. Take ownership while we still have root, then drop privileges
# so the server itself never runs as root.
set -e

# Pin HOME to the node user rather than inheriting root's /root: the token
# volume is mounted under /home/node, and os.homedir() in the server has to
# resolve to the same directory this script takes ownership of.
export HOME=/home/node
TOKEN_DIR="$HOME/.whoop-mcp"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$TOKEN_DIR"
  chown -R node:node "$TOKEN_DIR"
  echo "entrypoint: dropping root, running as node, tokens at $TOKEN_DIR" >&2
  exec su-exec node "$@"
fi

echo "entrypoint: already unprivileged (uid $(id -u)), tokens at $TOKEN_DIR" >&2
exec "$@"
