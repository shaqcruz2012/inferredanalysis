FROM node:22-alpine

LABEL maintainer="datchi"

RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

COPY server.js start.js index.html ./
COPY static/ ./static/

RUN chown -R appuser:appgroup /app

USER appuser

ENV PORT=3000
ENV LANDING_PORT=3000
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --spider -q http://localhost:3000/health || exit 1

CMD ["node", "server.js"]
