# Datchi x402 API — Dockerfile
#
# Environment variables:
#   WALLET_ADDRESS   — Base wallet address to receive USDC payments
#   FACILITATOR_URL  — x402 facilitator endpoint (default: https://x402.org/facilitator)
#   PORT             — Server port (default: 9402)

FROM node:22-alpine

WORKDIR /app

# Install curl for health checks
RUN apk add --no-cache curl

# Copy dependency manifest first for layer caching
COPY package.json package-lock.json* ./

# Install production dependencies only
RUN npm ci --production

# Copy application code
COPY . .

# Non-root user for security
RUN addgroup -S appgroup && adduser -S appuser -G appgroup \
    && chown -R appuser:appgroup /app
USER appuser

ENV PORT=9402
EXPOSE 9402

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:9402/health || exit 1

CMD ["node", "server.js"]
