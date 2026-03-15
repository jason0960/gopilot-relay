FROM node:18-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --production=false

COPY esbuild.js tsconfig.json ./
COPY src/ src/

RUN node esbuild.js --production

# ─── Production image ─────────────────────────────────

FROM node:18-alpine

WORKDIR /app

COPY --from=builder /app/dist/index.js ./index.js

ENV PORT=4800
ENV ROOM_TTL_MS=14400000
ENV MAX_ROOMS=10000
ENV NODE_ENV=production

EXPOSE 4800

# Run as non-root
RUN addgroup -g 1001 -S relay && adduser -S relay -u 1001
USER relay

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:4800/health || exit 1

CMD ["node", "index.js"]
