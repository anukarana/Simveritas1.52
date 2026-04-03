# ── Stage 1: Build ──────────────────────────────────────────────────────────
FROM node:20-slim AS builder

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci

# Copy all source files
COPY . .

# Build the Vite frontend (output → /app/dist)
RUN npm run build

# ── Stage 2: Production image ────────────────────────────────────────────────
FROM node:20-slim AS runner

WORKDIR /app

ENV NODE_ENV=production

# Only install production dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy built frontend and server source
COPY --from=builder /app/dist ./dist
COPY server.ts ./server.ts
COPY custom_scenarios.json ./custom_scenarios.json

# Cloud Run sets PORT automatically (default 8080).
# server.ts reads process.env.PORT — no hardcoded port needed.
EXPOSE 8080

# Use tsx to run the TypeScript server directly (already in prod deps via tsx)
CMD ["npx", "tsx", "server.ts"]
