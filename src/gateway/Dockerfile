# ── Builder stage ────────────────────────────────────────────────────
FROM node:22-alpine AS builder

RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src/gateway/ src/gateway/

RUN npx esbuild src/gateway/server.ts --bundle --platform=node --outfile=dist/server.js --format=esm --packages=external

# ── Production stage ─────────────────────────────────────────────────
FROM node:22-alpine

RUN apk add --no-cache curl

WORKDIR /app

COPY package.json package-lock.json* ./
RUN apk add --no-cache python3 make g++ \
    && npm ci --omit=dev \
    && apk del python3 make g++

COPY --from=builder /app/dist/server.js dist/server.js

RUN addgroup -S app && adduser -S app -G app
USER app

ENV PORT=7402
EXPOSE 7402

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:7402/health || exit 1

CMD ["node", "dist/server.js"]
