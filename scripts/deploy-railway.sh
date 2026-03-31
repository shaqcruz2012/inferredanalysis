#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# Railway Deployment Helper
#
# Deploys all monorepo services to Railway, or a single service
# when --service <name> is specified.
#
# Usage:
#   ./scripts/deploy-railway.sh                  # deploy all
#   ./scripts/deploy-railway.sh --service x402   # deploy one
# ──────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"

# ── Service registry ─────────────────────────────────────────
declare -A SERVICE_DIRS
SERVICE_DIRS=(
  [gateway]="src/gateway"
  [url-summarizer]="services/url-summarizer"
  [x402-api]="services/x402-api"
  [landing-page]="services/landing-page"
  [invoice-parser]="app"
)

declare -A SERVICE_PORTS
SERVICE_PORTS=(
  [gateway]=7402
  [url-summarizer]=9003
  [x402-api]=9402
  [landing-page]=3000
  [invoice-parser]=8000
)

# ── Parse args ───────────────────────────────────────────────
TARGET_SERVICE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --service|-s)
      TARGET_SERVICE="$2"
      shift 2
      ;;
    --help|-h)
      echo "Usage: $0 [--service <name>]"
      echo ""
      echo "Services: ${!SERVICE_DIRS[*]}"
      exit 0
      ;;
    *)
      echo "Unknown argument: $1"
      exit 1
      ;;
  esac
done

# ── Preflight checks ────────────────────────────────────────
if ! command -v railway &>/dev/null; then
  echo "ERROR: 'railway' CLI not found."
  echo ""
  echo "Install it:"
  echo "  npm install -g @railway/cli"
  echo "  # or"
  echo "  brew install railway"
  echo "  # or"
  echo "  curl -fsSL https://railway.app/install.sh | sh"
  echo ""
  echo "Then authenticate:"
  echo "  railway login"
  exit 1
fi

if ! railway whoami &>/dev/null 2>&1; then
  echo "ERROR: Not logged in to Railway. Run: railway login"
  exit 1
fi

# ── Validate target service ─────────────────────────────────
if [[ -n "$TARGET_SERVICE" ]] && [[ -z "${SERVICE_DIRS[$TARGET_SERVICE]+x}" ]]; then
  echo "ERROR: Unknown service '$TARGET_SERVICE'"
  echo "Available services: ${!SERVICE_DIRS[*]}"
  exit 1
fi

# ── Build service list ──────────────────────────────────────
if [[ -n "$TARGET_SERVICE" ]]; then
  SERVICES=("$TARGET_SERVICE")
else
  SERVICES=("${!SERVICE_DIRS[@]}")
fi

# ── Deploy ──────────────────────────────────────────────────
declare -A RESULTS
FAILED=0

timestamp() {
  date -u "+%Y-%m-%dT%H:%M:%SZ"
}

echo "╔══════════════════════════════════════════════════════════╗"
echo "║  Railway Deployment — $(timestamp)            ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

for svc in "${SERVICES[@]}"; do
  dir="${REPO_ROOT}/${SERVICE_DIRS[$svc]}"
  port="${SERVICE_PORTS[$svc]}"

  echo "── Deploying: $svc (port $port) ──────────────────────"
  echo "   Directory: $dir"

  if [[ ! -d "$dir" ]]; then
    echo "   ERROR: Directory not found: $dir"
    RESULTS["$svc"]="MISSING"
    FAILED=$((FAILED + 1))
    continue
  fi

  if (cd "$dir" && railway up --detach 2>&1); then
    RESULTS["$svc"]="OK"
    echo "   Deployed successfully."
  else
    RESULTS["$svc"]="FAILED"
    FAILED=$((FAILED + 1))
    echo "   Deployment FAILED."
  fi
  echo ""
done

# ── Summary ─────────────────────────────────────────────────
echo "╔══════════════════════════════════════════════════════════╗"
echo "║  DEPLOYMENT SUMMARY                                     ║"
echo "╠══════════════════════════════════════════════════════════╣"
printf "║  %-20s %-8s %-25s  ║\n" "SERVICE" "PORT" "STATUS"
echo "╠══════════════════════════════════════════════════════════╣"
for svc in "${SERVICES[@]}"; do
  status="${RESULTS[$svc]:-UNKNOWN}"
  port="${SERVICE_PORTS[$svc]}"
  printf "║  %-20s %-8s %-25s  ║\n" "$svc" "$port" "$status"
done
echo "╚══════════════════════════════════════════════════════════╝"

if (( FAILED > 0 )); then
  echo ""
  echo "WARNING: $FAILED service(s) failed to deploy."
  exit 1
fi

echo ""
echo "All services deployed successfully."
exit 0
