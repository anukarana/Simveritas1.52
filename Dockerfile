# ── Stage 1: Build the Vite frontend ────────────────────────────────────────
FROM node:20-slim AS builder

WORKDIR /app

# Copy package files first for better layer caching
COPY package.json package-lock.json ./

# Install ALL deps (including devDependencies needed for build)
RUN npm ci

# Copy source files
COPY . .

# Rename vite_config.ts → vite.config.ts so Vite finds it
RUN cp vite_config.ts vite.config.ts

# Build the React frontend into dist/
RUN npm run build

# ── Stage 2: Production runtime ─────────────────────────────────────────────
FROM node:20-slim AS runner

WORKDIR /app

# Copy package files
COPY package.json package-lock.json ./

# Install only production deps + tsx (needed to run server.ts)
RUN npm ci --omit=dev && npm install tsx

# Copy built frontend
COPY --from=builder /app/dist ./dist

# Copy server and supporting files
COPY server.ts ./
COPY custom_scenarios.json ./
COPY firebase-applet-config.json ./

# Cloud Run provides PORT env var; default 8080
ENV PORT=8080
ENV NODE_ENV=production

EXPOSE 8080

# Use tsx to run TypeScript server directly
CMD ["node_modules/.bin/tsx", "server.ts"]
