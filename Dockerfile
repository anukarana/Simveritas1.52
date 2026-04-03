# Stage 1: Build the Vite frontend
FROM node:20-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

# Stage 2: Run the production server
FROM node:20-slim AS runner
WORKDIR /app
ENV NODE_ENV=production

# Copy package files and install ALL deps (tsx needed at runtime)
COPY package*.json ./
RUN npm install --omit=dev && npm install tsx

# Copy built frontend from builder stage
COPY --from=builder /app/dist ./dist

# Copy only the files the server needs at runtime
COPY server.ts ./server.ts
COPY vite.config.ts ./vite.config.ts
COPY tsconfig.json ./tsconfig.json

# Create writable data files
RUN echo "[]" > custom_scenarios.json && echo "[]" > saved_reports.json

EXPOSE 8080
CMD ["./node_modules/.bin/tsx", "server.ts"]
