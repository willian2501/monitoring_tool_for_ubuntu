#!/bin/sh
set -eu

node /app/src/server.js &
node_pid=$!

term_handler() {
	kill -TERM "$node_pid" 2>/dev/null || true
	wait "$node_pid" 2>/dev/null || true
}

trap term_handler INT TERM

nginx -g 'daemon off;' &
nginx_pid=$!

wait "$nginx_pid"
status=$?

kill -TERM "$node_pid" 2>/dev/null || true
wait "$node_pid" 2>/dev/null || true

exit "$status"