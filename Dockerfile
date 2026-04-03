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
COPY package*.json ./
RUN npm install
COPY --from=builder /app/dist ./dist
COPY server.ts ./server.ts
COPY vite_config.ts ./vite.config.ts
RUN echo "[]" > custom_scenarios.json && echo "[]" > saved_reports.json
EXPOSE 8080
CMD ["npx", "tsx", "server.ts"]
