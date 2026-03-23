#!/usr/bin/env bash
#
# Start the full x402 gateway stack:
#   1. Text Analysis API (port 9000)
#   2. URL Summarizer (port 9003)
#   3. x402 Gateway (port 7402) — payment verification + proxy
#
# Prerequisites:
#   - ANTHROPIC_API_KEY set in environment
#   - Wallet at ~/.automaton/wallet.json (run: npx tsx scripts/generate-wallet.ts)
#
# Usage: bash scripts/start-gateway.sh
#
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PIDS=()

cleanup() {
  echo ""
  echo "[startup] Shutting down..."
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null
  echo "[startup] Done."
}
trap cleanup EXIT INT TERM

# ── Preflight checks ──────────────────────────────────────────────
if [ -z "$ANTHROPIC_API_KEY" ]; then
  echo "[startup] ERROR: ANTHROPIC_API_KEY is not set."
  echo "  export ANTHROPIC_API_KEY=sk-ant-..."
  exit 1
fi

WALLET_PATH="${WALLET_PATH:-$HOME/.automaton/wallet.json}"
if [ ! -f "$WALLET_PATH" ]; then
  echo "[startup] No wallet found at $WALLET_PATH"
  echo "[startup] Generating a new wallet..."
  cd "$ROOT" && npx tsx scripts/generate-wallet.ts
  echo ""
fi

# ── Start backends ────────────────────────────────────────────────
echo "[startup] Starting Text Analysis API on port 9000..."
cd "$ROOT" && npx tsx services/text-analysis/src/server.ts &
PIDS+=($!)

echo "[startup] Starting URL Summarizer on port 9003..."
cd "$ROOT" && LLM_API_KEY="$ANTHROPIC_API_KEY" npx tsx services/url-summarizer/src/server.ts &
PIDS+=($!)

# Give backends a moment to bind
sleep 2

# ── Start gateway ─────────────────────────────────────────────────
echo "[startup] Starting x402 Gateway on port 7402..."
cd "$ROOT" && npx tsx src/gateway/index.ts &
PIDS+=($!)

sleep 1

echo ""
echo "══════════════════════════════════════════════════════════"
echo "  x402 Gateway Stack Running"
echo "══════════════════════════════════════════════════════════"
echo "  Gateway:        http://localhost:7402"
echo "  Health:         http://localhost:7402/health"
echo "  Pricing:        http://localhost:7402/pricing"
echo "  Info:           http://localhost:7402/info"
echo ""
echo "  Text Analysis:  http://localhost:9000/health"
echo "  URL Summarizer: http://localhost:9003/health"
echo ""
echo "  Endpoints:"
echo "    POST /summarize      \$0.25  (high-volume)"
echo "    POST /brief          \$2.50  (structured brief)"
echo "    POST /brief-premium  \$15.00 (deep dive)"
echo "    POST /analyze        \$0.01  (text analysis)"
echo "    POST /summarize-url  \$0.01  (URL summary)"
echo "    POST /trustcheck     \$0.05  (trust check)"
echo ""
echo "  Press Ctrl+C to stop all services."
echo "══════════════════════════════════════════════════════════"

# Wait for any child to exit
wait -n 2>/dev/null || wait
