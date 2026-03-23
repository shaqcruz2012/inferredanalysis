#!/usr/bin/env bash
# Smoke test: validate all revenue-critical endpoints are responding
# Usage: bash scripts/smoke-test-services.sh [base_url]
#
# Exit codes:
#   0 = all endpoints healthy
#   1 = one or more endpoints failed

set -euo pipefail

BASE="${1:-http://127.0.0.1}"
FAILED=0
TOTAL=0

check() {
  local name="$1" url="$2" expected_status="${3:-200}"
  TOTAL=$((TOTAL + 1))
  local status
  status=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 5 --max-time 10 "$url" 2>/dev/null || echo "000")
  if [ "$status" = "$expected_status" ] || [ "$status" = "402" ]; then
    printf "  ✓ %-30s %s → %s\n" "$name" "$url" "$status"
  else
    printf "  ✗ %-30s %s → %s (expected %s)\n" "$name" "$url" "$status" "$expected_status"
    FAILED=$((FAILED + 1))
  fi
}

echo "Revenue Service Health Check"
echo "============================"
echo ""

# Core revenue services
echo "── Revenue APIs ──"
check "Text Analysis API"     "${BASE}:9000/health"
check "Data Processing API"   "${BASE}:9001/health"
check "TrustCheck API"        "${BASE}:9002/health"
check "URL Summarizer Pro"    "${BASE}:9003/health"
check "Payment Validator"     "${BASE}:6000/status"

echo ""
echo "── Gateway ──"
check "x402 Gateway"          "${BASE}:7402/health"
check "Gateway Pricing"       "${BASE}:7402/pricing"

echo ""
echo "── Landing / Web ──"
check "Landing Page"          "${BASE}:3000/"

echo ""
echo "============================"
if [ "$FAILED" -eq 0 ]; then
  echo "Result: $TOTAL/$TOTAL endpoints healthy ✓"
  exit 0
else
  echo "Result: $((TOTAL - FAILED))/$TOTAL healthy, $FAILED FAILED ✗"
  exit 1
fi
