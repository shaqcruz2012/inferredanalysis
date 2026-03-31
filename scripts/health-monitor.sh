#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# Health Monitor — polls /health on each service every 30s
#
# Usage:
#   ./scripts/health-monitor.sh https://svc1.railway.app https://svc2.railway.app
#
# If no URLs are provided, uses sensible defaults for the monorepo services.
# Prints RED alerts if any service fails 3+ consecutive health checks.
# ──────────────────────────────────────────────────────────────
set -euo pipefail

# ── Colors ──────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BOLD='\033[1m'
NC='\033[0m' # No Color

# ── Defaults ─────────────────────────────────────────────────
DEFAULT_URLS=(
  "http://localhost:7402"   # x402 Gateway
  "http://localhost:9003"   # URL Summarizer
  "http://localhost:9402"   # x402 API
  "http://localhost:3000"   # Landing Page
  "http://localhost:8000"   # Invoice Parser
)

URLS=("${@:-${DEFAULT_URLS[@]}}")
INTERVAL=30
MAX_FAILURES=3

# Associative arrays for tracking
declare -A fail_count
declare -A total_checks
declare -A total_ok
declare -A total_fail
declare -A last_status

for url in "${URLS[@]}"; do
  fail_count["$url"]=0
  total_checks["$url"]=0
  total_ok["$url"]=0
  total_fail["$url"]=0
  last_status["$url"]="unknown"
done

# ── Helpers ──────────────────────────────────────────────────
timestamp() {
  date -u "+%Y-%m-%dT%H:%M:%SZ"
}

print_status_table() {
  echo ""
  echo "╔══════════════════════════════════════════════════════════════════════╗"
  echo "║  HEALTH STATUS  $(timestamp)                            ║"
  echo "╠══════════════════════════════════════════════════════════════════════╣"
  printf "║ %-40s %6s %4s %4s %8s ║\n" "SERVICE" "CHECKS" "OK" "FAIL" "STATUS"
  echo "╠══════════════════════════════════════════════════════════════════════╣"
  for url in "${URLS[@]}"; do
    status="${last_status[$url]}"
    consec="${fail_count[$url]}"
    if (( consec >= MAX_FAILURES )); then
      color="${RED}"
      status_label="CRITICAL"
    elif [[ "$status" == "FAIL" ]]; then
      color="${YELLOW}"
      status_label="WARN"
    elif [[ "$status" == "OK" ]]; then
      color="${GREEN}"
      status_label="OK"
    else
      color="${NC}"
      status_label="UNKNOWN"
    fi
    printf "║ %-40s %6d %4d %4d ${color}%8s${NC} ║\n" \
      "${url:0:40}" \
      "${total_checks[$url]}" \
      "${total_ok[$url]}" \
      "${total_fail[$url]}" \
      "$status_label"
  done
  echo "╚══════════════════════════════════════════════════════════════════════╝"
  echo ""
}

cleanup() {
  print_status_table
  exit 0
}
trap cleanup SIGINT SIGTERM

# ── Main loop ────────────────────────────────────────────────
echo "[$(timestamp)] Health monitor starting for ${#URLS[@]} service(s)"
echo "[$(timestamp)] Polling interval: ${INTERVAL}s | Alert threshold: ${MAX_FAILURES} consecutive failures"
echo ""

while true; do
  for url in "${URLS[@]}"; do
    health_url="${url%/}/health"
    total_checks["$url"]=$(( total_checks["$url"] + 1 ))

    http_code=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 5 --max-time 10 "$health_url" 2>/dev/null || echo "000")

    if [[ "$http_code" == "200" ]]; then
      fail_count["$url"]=0
      total_ok["$url"]=$(( total_ok["$url"] + 1 ))
      last_status["$url"]="OK"
      echo -e "[$(timestamp)] ${GREEN}OK${NC}   $health_url (${http_code})"
    else
      fail_count["$url"]=$(( fail_count["$url"] + 1 ))
      total_fail["$url"]=$(( total_fail["$url"] + 1 ))
      last_status["$url"]="FAIL"

      if (( fail_count["$url"] >= MAX_FAILURES )); then
        echo ""
        echo -e "${RED}${BOLD}!!! CRITICAL: $url has failed ${fail_count[$url]} consecutive health checks !!!${NC}"
        echo -e "${RED}[$(timestamp)] ALERT $health_url (${http_code}) — consecutive failures: ${fail_count[$url]}${NC}"
        echo ""
      else
        echo -e "[$(timestamp)] ${YELLOW}FAIL${NC} $health_url (${http_code}) — consecutive failures: ${fail_count[$url]}/${MAX_FAILURES}"
      fi
    fi
  done

  # Print status table every 5 minutes (every 10 iterations at 30s)
  if (( total_checks["${URLS[0]}"] % 10 == 0 )); then
    print_status_table
  fi

  sleep "$INTERVAL"
done
