# ── Stage 1: Build ─────────────────────────────────────────────────────────
FROM node:24-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc --project tsconfig.json

# ── Stage 2: Production image ────────────────────────────────────────────────
FROM node:24-alpine AS runner

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev
# dotenvx 已含於 production dependencies，直接使用 node_modules/.bin/dotenvx

COPY --from=builder /app/dist ./dist

RUN mkdir -p data

# Railway: 環境變數由平台直接注入，無需 dotenvx
# 本地 docker-compose: 覆寫為 dotenvx run -- node dist/index.js（見 docker-compose.yml）
CMD ["node", "dist/index.js"]
