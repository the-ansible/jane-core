#!/usr/bin/env bash
# =============================================================================
# jane-system-health.sh — Jane Stack Smoke Test
# =============================================================================
# Runs a fast sanity check across all core services.
# Use after container resets, large changes, or restore validation.
#
# HOW TO UPDATE WHEN SERVICES CHANGE:
#   - Add new HTTP services to the SERVICES array (name|url)
#   - Add new PM2 process names to the PM2_PROCS array
#   - Add new DB schemas to the SCHEMAS array
#   - Add new critical files to the CRITICAL_FILES array
#   - Bump the VERSION line below
#
# VERSION: 1.0.0
# =============================================================================

set -euo pipefail

VERSION="1.0.0"

# ── Color palette (colorblind-safe: blue/yellow/red, no green) ──────────────
BLUE="\033[38;2;88;166;255m"   # #58a6ff — OK
YELLOW="\033[38;2;210;153;34m" # #d29922 — warning
RED="\033[38;2;248;81;73m"     # #f85149 — error
BOLD="\033[1m"
RESET="\033[0m"

ok()   { echo -e "  ${BLUE}✔${RESET}  $1"; PASS=$((PASS+1)); }
warn() { echo -e "  ${YELLOW}⚠${RESET}  $1"; WARN=$((WARN+1)); }
fail() { echo -e "  ${RED}✘${RESET}  $1"; FAIL=$((FAIL+1)); }

PASS=0; WARN=0; FAIL=0

echo -e "\n${BOLD}Jane System Health Check — v${VERSION}${RESET}"
echo -e "$(date '+%Y-%m-%d %H:%M:%S %Z')\n"

# =============================================================================
# 1. PM2 Processes
# =============================================================================
echo -e "${BOLD}── PM2 Processes ──────────────────────────────────────────${RESET}"

PM2_PROCS=(
  "kanban-api"
  "canvas-api"
  "canvas-web"
  "stimulation-server"
  "event-drainer"
  "good-morning-scheduler"
)

if ! command -v pm2 &>/dev/null; then
  warn "pm2 not found in PATH — skipping process checks"
else
  PM2_STATUS=$(PM2_HOME=/tmp/.pm2 pm2 jlist 2>/dev/null || echo "[]")
  for proc in "${PM2_PROCS[@]}"; do
    status=$(echo "$PM2_STATUS" | python3 -c "
import json, sys
procs = json.load(sys.stdin)
match = next((p for p in procs if p.get('name') == '$proc'), None)
if match:
    print(match.get('pm2_env', {}).get('status', 'unknown'))
else:
    print('missing')
" 2>/dev/null || echo "error")
    case "$status" in
      online)   ok "$proc (online)" ;;
      stopped)  warn "$proc (stopped)" ;;
      missing)  fail "$proc (not registered)" ;;
      *)        fail "$proc (status: $status)" ;;
    esac
  done
fi

# =============================================================================
# 2. HTTP Health Endpoints
# =============================================================================
echo -e "\n${BOLD}── HTTP Health Endpoints ──────────────────────────────────${RESET}"

# Format: "display-name|url"
# Note: Kanban API has no /health — use /api/boards as liveness probe
SERVICES=(
  "Kanban API|http://localhost:3000/api/boards"
  "Canvas API|http://localhost:3001/health"
  "Stimulation Server|http://localhost:3102/health"
  "Brain Server|http://localhost:3103/health"
)

for entry in "${SERVICES[@]}"; do
  name="${entry%%|*}"
  url="${entry##*|}"
  http_code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "$url" 2>/dev/null || echo "000")
  if [[ "$http_code" == "200" ]]; then
    ok "$name ($url)"
  elif [[ "$http_code" == "000" ]]; then
    fail "$name — no response ($url)"
  else
    warn "$name — HTTP $http_code ($url)"
  fi
done

# =============================================================================
# 3. PostgreSQL
# =============================================================================
echo -e "\n${BOLD}── PostgreSQL ─────────────────────────────────────────────${RESET}"

SCHEMAS=("kanban" "canvas" "brain")
DB_URL="${JANE_DATABASE_URL:-postgresql://postgres:postgres@life-system-db:5432/jane}"

if ! command -v psql &>/dev/null; then
  # Try via docker if psql not available locally
  warn "psql not in PATH — attempting via pg_isready"
  if pg_isready -d "$DB_URL" -q 2>/dev/null; then
    ok "PostgreSQL reachable"
  else
    fail "PostgreSQL unreachable"
  fi
else
  if psql "$DB_URL" -c "SELECT 1" -q &>/dev/null 2>&1; then
    ok "PostgreSQL connection"
    for schema in "${SCHEMAS[@]}"; do
      exists=$(psql "$DB_URL" -tAc "SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name='$schema'" 2>/dev/null || echo "0")
      if [[ "$exists" == "1" ]]; then
        ok "Schema: $schema"
      else
        fail "Schema missing: $schema"
      fi
    done
  else
    fail "PostgreSQL connection failed"
  fi
fi

# =============================================================================
# 4. NATS
# =============================================================================
echo -e "\n${BOLD}── NATS ───────────────────────────────────────────────────${RESET}"

# Use NATS HTTP monitoring endpoint (nc not available in container)
nats_status=$(curl -s --max-time 5 http://life-system-nats:8222/healthz 2>/dev/null || echo "")
if echo "$nats_status" | grep -q '"ok"'; then
  ok "NATS reachable (life-system-nats:8222/healthz)"
else
  fail "NATS unreachable (life-system-nats:8222/healthz)"
fi

# =============================================================================
# 5. Critical Files & Directories
# =============================================================================
echo -e "\n${BOLD}── Critical Files ─────────────────────────────────────────${RESET}"

CRITICAL_FILES=(
  "/agent/INNER_VOICE.md"
  "/agent/CLAUDE.md"
  "/agent/data/vault"
  "/agent/data/sessions"
  "/agent/operations/lessons-learned.md"
  "/home/node/.claude/projects/-agent/memory/MEMORY.md"
)

for path in "${CRITICAL_FILES[@]}"; do
  if [[ -e "$path" ]]; then
    ok "$path"
  else
    fail "Missing: $path"
  fi
done

# =============================================================================
# 6. Scheduler Jobs
# =============================================================================
echo -e "\n${BOLD}── Scheduler Jobs ─────────────────────────────────────────${RESET}"

SCHEDULER_INDEX="/agent/apps/good-morning-scheduler/index.js"
if [[ -f "$SCHEDULER_INDEX" ]]; then
  job_count=$(grep -c "schedule:" "$SCHEDULER_INDEX" 2>/dev/null || echo "?")
  ok "Scheduler config present (~${job_count} jobs in index.js)"
else
  SCHEDULER_INDEX="/agent/projects/good-morning-scheduler/index.js"
  if [[ -f "$SCHEDULER_INDEX" ]]; then
    warn "Using dev scheduler index (apps not found)"
  else
    fail "Scheduler index.js not found"
  fi
fi

# =============================================================================
# Summary
# =============================================================================
TOTAL=$((PASS + WARN + FAIL))
echo -e "\n${BOLD}── Summary ────────────────────────────────────────────────${RESET}"
echo -e "  Total checks : $TOTAL"
echo -e "  ${BLUE}Passed${RESET}       : $PASS"
[[ $WARN -gt 0 ]] && echo -e "  ${YELLOW}Warnings${RESET}     : $WARN"
[[ $FAIL -gt 0 ]] && echo -e "  ${RED}Failed${RESET}       : $FAIL"

echo ""
if [[ $FAIL -eq 0 && $WARN -eq 0 ]]; then
  echo -e "${BLUE}${BOLD}All checks passed. Jane looks healthy.${RESET}"
  exit 0
elif [[ $FAIL -eq 0 ]]; then
  echo -e "${YELLOW}${BOLD}Warnings present — review above.${RESET}"
  exit 0
else
  echo -e "${RED}${BOLD}${FAIL} check(s) failed — stack needs attention.${RESET}"
  exit 1
fi
