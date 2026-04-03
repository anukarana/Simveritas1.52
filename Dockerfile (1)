# ── Stage 1: Build frontend ──────────────────────────────────────────────────
FROM node:20-slim AS builder

WORKDIR /app

# Install ALL deps (including devDeps needed for vite build)
COPY package*.json ./
RUN npm install

# Copy source and build the Vite SPA → dist/
COPY . .
RUN npm run build

# ── Stage 2: Production runtime ───────────────────────────────────────────────
FROM node:20-slim AS runner

WORKDIR /app

# Production env — server.ts serves dist/ statically, skips vite dev server
ENV NODE_ENV=production

# Install ALL deps (tsx is a runtime dep, vite import is conditional on NODE_ENV)
COPY package*.json ./
RUN npm install

# Copy built frontend from builder stage
COPY --from=builder /app/dist ./dist

# Copy server and data files
COPY server.ts ./server.ts
COPY vite_config.ts ./vite.config.ts

# Create writable data files for runtime persistence
RUN echo "[]" > custom_scenarios.json && echo "[]" > saved_reports.json

# Cloud Run sets PORT env var (default 8080) — server.ts reads process.env.PORT
EXPOSE 8080

# tsx runs TypeScript server directly
CMD ["npx", "tsx", "server.ts"]
