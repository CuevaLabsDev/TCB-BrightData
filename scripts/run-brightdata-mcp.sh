#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT/.env.local"

if [[ -f "$ENV_FILE" ]]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue
    if [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
      export "${BASH_REMATCH[1]}=${BASH_REMATCH[2]}"
    fi
  done < "$ENV_FILE"
fi

: "${BRIGHT_DATA_API_KEY:?Set BRIGHT_DATA_API_KEY in .env.local}"

export API_TOKEN="$BRIGHT_DATA_API_KEY"
export WEB_UNLOCKER_ZONE="${BRIGHT_DATA_MCP_UNLOCKER_ZONE:-${BRIGHT_DATA_UNLOCKER_ZONE:-mcp_unlocker}}"

if [[ "${BRIGHT_DATA_MCP_PRO_MODE:-true}" == "true" ]]; then
  export PRO_MODE="true"
fi

if [[ -n "${BRIGHT_DATA_MCP_GROUPS:-}" ]]; then
  export GROUPS="$BRIGHT_DATA_MCP_GROUPS"
  unset PRO_MODE
fi

exec npx -y @brightdata/mcp
