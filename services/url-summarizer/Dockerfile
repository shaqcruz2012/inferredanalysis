# ── Builder stage ────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src/ src/

RUN npx esbuild src/server.ts --bundle --platform=node --outfile=dist/server.js --format=esm --packages=external

# ── Production stage ─────────────────────────────────────────────────
FROM node:22-alpine

RUN apk add --no-cache curl

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts

COPY --from=builder /app/dist/server.js dist/server.js

RUN addgroup -S app && adduser -S app -G app
USER app

ENV PORT=9003
EXPOSE 9003

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:9003/health || exit 1

CMD ["node", "dist/server.js"]
