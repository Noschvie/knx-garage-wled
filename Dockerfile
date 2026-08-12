# syntax=docker/dockerfile:1
FROM node:26-alpine AS base
WORKDIR /app

# --- deps ---
FROM base AS deps
COPY package*.json ./
RUN npm ci --omit=dev

# --- runtime ---
FROM base AS runtime
# Run as non-root
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
COPY --from=deps /app/node_modules ./node_modules
COPY knx-garage-wled.js .

USER appuser

# Graceful shutdown: Docker sends SIGTERM, fallback SIGKILL after 10 s
STOPSIGNAL SIGTERM

CMD ["node", "knx-garage-wled.js"]
