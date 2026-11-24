#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

VAR_DIR="$ROOT_DIR/var"
PID_FILE="$VAR_DIR/multimodal-router.pid"
ENV_FILE="$VAR_DIR/multimodal-router.env"
LOG_FILE="$VAR_DIR/multimodal-router.log"
CACHE_DB="$VAR_DIR/route-cache.sqlite"
ENTRY_FILE="$ROOT_DIR/src/server.mjs"
PRECOMPUTE_FILE="$ROOT_DIR/scripts/precompute.mjs"

DEFAULT_HOST="${HOST:-0.0.0.0}"
DEFAULT_PORT="${PORT:-4180}"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"

ARG_HOST=""
ARG_PORT=""

mkdir -p "$VAR_DIR"

require_node() {
  if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
    echo "Error: node executable not found. Set NODE_BIN or add node to PATH." >&2
    exit 1
  fi
}

is_our_pid() {
  local pid="$1"
  if [[ -z "$pid" ]] || ! kill -0 "$pid" 2>/dev/null; then
    return 1
  fi
  local cmd
  cmd="$(ps -p "$pid" -o args= 2>/dev/null || true)"
  [[ "$cmd" == *"src/server.mjs"* ]]
}

read_pid() {
  if [[ -f "$PID_FILE" ]]; then
    local pid
    pid="$(tr -d '[:space:]' < "$PID_FILE" || true)"
    if is_our_pid "$pid"; then
      echo "$pid"
      return 0
    fi
    rm -f "$PID_FILE" "$ENV_FILE"
  fi
  return 1
}

load_saved_env() {
  SAVED_HOST=""
  SAVED_PORT=""
  if [[ -f "$ENV_FILE" ]]; then
    while IFS='=' read -r k v; do
      case "$k" in
        HOST) SAVED_HOST="$v" ;;
        PORT) SAVED_PORT="$v" ;;
      esac
    done < "$ENV_FILE"
  fi
}

resolve_target() {
  load_saved_env
  TARGET_HOST="${ARG_HOST:-${SAVED_HOST:-$DEFAULT_HOST}}"
  TARGET_PORT="${ARG_PORT:-${SAVED_PORT:-$DEFAULT_PORT}}"
}

check_health() {
  local host="$1"
  local port="$2"
  local check_host="$host"
  if [[ "$check_host" == "0.0.0.0" || "$check_host" == "::" ]]; then
    check_host="127.0.0.1"
  fi
  local url="http://${check_host}:${port}/health"

  if command -v curl >/dev/null 2>&1; then
    curl -fsS --max-time 2 "$url" >/dev/null 2>&1
    return $?
  fi

  "$NODE_BIN" -e "
    fetch('$url', { signal: AbortSignal.timeout(2000) })
      .then((r) => process.exit(r.ok ? 0 : 1))
      .catch(() => process.exit(1));
  " >/dev/null 2>&1
}

parse_common_args() {
  REMAINING_ARGS=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -H|--host)
        [[ $# -lt 2 ]] && { echo "Error: $1 requires a value" >&2; exit 1; }
        ARG_HOST="$2"
        shift 2
        ;;
      --host=*)
        ARG_HOST="${1#*=}"
        shift
        ;;
      -p|--port)
        [[ $# -lt 2 ]] && { echo "Error: $1 requires a value" >&2; exit 1; }
        ARG_PORT="$2"
        shift 2
        ;;
      --port=*)
        ARG_PORT="${1#*=}"
        shift
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        REMAINING_ARGS+=("$1")
        shift
        ;;
    esac
  done
}

cmd_start() {
  require_node
  parse_common_args "$@"

  if pid="$(read_pid)"; then
    resolve_target
    echo "multimodal-router is already running (PID $pid, http://${TARGET_HOST}:${TARGET_PORT})"
    return 0
  fi

  local host="${ARG_HOST:-$DEFAULT_HOST}"
  local port="${ARG_PORT:-$DEFAULT_PORT}"

  echo "Starting multimodal-router on http://${host}:${port} ..."
  (
    cd "$ROOT_DIR"
    export HOST="$host" PORT="$port"
    nohup "$NODE_BIN" "$ENTRY_FILE" >> "$LOG_FILE" 2>&1 < /dev/null &
    echo $! > "$PID_FILE"
  )
  printf 'HOST=%s\nPORT=%s\n' "$host" "$port" > "$ENV_FILE"

  local pid
  pid="$(tr -d '[:space:]' < "$PID_FILE")"

  for _ in $(seq 1 20); do
    if ! is_our_pid "$pid"; then
      echo "Error: multimodal-router exited unexpectedly. Recent logs:" >&2
      tail -n 30 "$LOG_FILE" >&2 || true
      rm -f "$PID_FILE" "$ENV_FILE"
      exit 1
    fi
    if check_health "$host" "$port"; then
      echo "multimodal-router started (PID $pid)"
      echo "URL: http://${host}:${port}"
      echo "Log: $LOG_FILE"
      return 0
    fi
    sleep 0.25
  done

  echo "multimodal-router process is running (PID $pid), but /health did not respond in time. Check $LOG_FILE." >&2
  return 1
}

cmd_stop() {
  parse_common_args "$@"
  local pid
  if ! pid="$(read_pid)"; then
    echo "multimodal-router is not running."
    return 0
  fi

  echo "Stopping multimodal-router (PID $pid) ..."
  kill -TERM "$pid" 2>/dev/null || true

  for _ in $(seq 1 40); do
    if ! kill -0 "$pid" 2>/dev/null; then
      rm -f "$PID_FILE" "$ENV_FILE"
      echo "multimodal-router stopped."
      return 0
    fi
    sleep 0.25
  done

  echo "Process did not exit after SIGTERM, sending SIGKILL ..." >&2
  kill -KILL "$pid" 2>/dev/null || true
  rm -f "$PID_FILE" "$ENV_FILE"
  echo "multimodal-router killed."
}

cmd_restart() {
  parse_common_args "$@"
  load_saved_env
  local next_host="${ARG_HOST:-${SAVED_HOST:-$DEFAULT_HOST}}"
  local next_port="${ARG_PORT:-${SAVED_PORT:-$DEFAULT_PORT}}"
  cmd_stop
  ARG_HOST="$next_host"
  ARG_PORT="$next_port"
  cmd_start
}

cmd_rebuild() {
  require_node
  parse_common_args "$@"
  load_saved_env
  local next_host="${ARG_HOST:-${SAVED_HOST:-$DEFAULT_HOST}}"
  local next_port="${ARG_PORT:-${SAVED_PORT:-$DEFAULT_PORT}}"

  cmd_stop

  echo "Clearing SQLite route cache ($CACHE_DB*) ..."
  rm -f "$CACHE_DB" "${CACHE_DB}-wal" "${CACHE_DB}-shm"

  echo "Running precompute ($PRECOMPUTE_FILE) ..."
  (
    cd "$ROOT_DIR"
    "$NODE_BIN" "$PRECOMPUTE_FILE"
  )

  ARG_HOST="$next_host"
  ARG_PORT="$next_port"
  cmd_start
}

cmd_status() {
  parse_common_args "$@"
  local pid
  if pid="$(read_pid)"; then
    resolve_target
    local health="unreachable"
    if check_health "$TARGET_HOST" "$TARGET_PORT"; then
      health="healthy"
    fi
    echo "multimodal-router is running (PID $pid, http://${TARGET_HOST}:${TARGET_PORT}, health: ${health})"
    echo "Log: $LOG_FILE"
    return 0
  else
    echo "multimodal-router is stopped."
    return 1
  fi
}

cmd_logs() {
  local arg="${1:-50}"
  if [[ ! -f "$LOG_FILE" ]]; then
    echo "No log file yet at $LOG_FILE"
    return 0
  fi
  if [[ "$arg" == "-f" || "$arg" == "--follow" ]]; then
    tail -n 50 -f "$LOG_FILE"
  else
    tail -n "$arg" "$LOG_FILE"
  fi
}

usage() {
  cat <<EOF
Usage: $(basename "$0") <start|stop|restart|rebuild|status|logs> [options]

Commands:
  start           Start service in background (nohup + PID file)
  stop            Stop running service gracefully
  restart         Restart service (preserves previous host/port unless overridden)
  rebuild         Stop service, clear SQLite cache, re-run precompute, and start
  status          Show process and /health status
  logs [N|-f]     Show last N log lines (default 50) or follow with -f

Options (for start / restart / rebuild / status):
  -H, --host <ip>     Bind address (default: 0.0.0.0)
  -p, --port <port>   Listen port (default: 4180)

Environment variables:
  HOST            Default bind address if --host is omitted (default: 0.0.0.0)
  PORT            Default listen port if --port is omitted (default: 4180)
  NODE_BIN        Path to node binary (default: auto-detected from PATH)
EOF
}

main() {
  local cmd="${1:-}"
  shift || true
  case "$cmd" in
    start)   cmd_start "$@" ;;
    stop)    cmd_stop "$@" ;;
    restart) cmd_restart "$@" ;;
    rebuild) cmd_rebuild "$@" ;;
    status)  cmd_status "$@" ;;
    logs)    cmd_logs "$@" ;;
    -h|--help|"") usage; [[ -n "$cmd" ]] && exit 0 || exit 1 ;;
    *)
      echo "Unknown command: $cmd" >&2
      usage >&2
      exit 1
      ;;
  esac
}

main "$@"
