# Multi-stage Dockerfile for Telegram Ledger Bot (API + Bot + Dashboard + OCR)

FROM node:20-bullseye-slim AS builder

# Build deps for native modules (e.g., sharp) during npm install
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install server deps first
COPY package.json package-lock.json* ./
RUN npm install

# Copy the rest of the repo
COPY . .

# Build dashboard SPA (if present)
RUN if [ -f "dashboard-app/package.json" ]; then \
      cd dashboard-app && npm install && npm run build; \
    else \
      echo "No dashboard-app found, skipping build"; \
    fi

FROM node:20-bullseye-slim AS runner

LABEL org.opencontainers.image.source="https://example.com/telegram-ledger-bot" \
      org.opencontainers.image.description="Telegram Ledger Bot (API + Dashboard + Bot)"

# Install Tesseract OCR (optional but recommended for receipts pipeline)
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       tesseract-ocr \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production

# Copy node_modules built in builder stage and sources
COPY --from=builder /app/node_modules /app/node_modules
COPY --from=builder /app /app

# Persist database and artifacts on a mounted volume
VOLUME ["/app/data"]

# API and Webhook ports
EXPOSE 8090 8080

# Default: start the API + bot
CMD ["node", "src/index.js"]
