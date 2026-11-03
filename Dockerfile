# ==============================================================================
# Multi-stage Dockerfile for Pesa (Option B: Cloud-hosted WhatsApp Linked Device)
# Combines:
# 1. whatsmeow Go WhatsApp bridge binary
# 2. Node.js 20 agent runtime with ffmpeg and sqlite3
# ==============================================================================

# --- Stage 1: Build the Go WhatsApp Bridge ---
FROM golang:bookworm AS bridge-builder
WORKDIR /build
ENV GOTOOLCHAIN=auto

# Install CGO build dependencies for go-sqlite3
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    libc6-dev \
    git \
    && rm -rf /var/lib/apt/lists/*

COPY bridge/go.mod bridge/go.sum ./
RUN go mod download

COPY bridge/ ./
RUN CGO_ENABLED=1 GOOS=linux go build -ldflags="-s -w" -o whatsapp-bridge main.go

# --- Stage 2: Runtime Image ---
FROM node:20-bookworm-slim
WORKDIR /app

# Install runtime utilities: ffmpeg (audio), sqlite3 (db query), ca-certificates, curl
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    sqlite3 \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Copy compiled WhatsApp bridge binary from Stage 1
COPY --from=bridge-builder /build/whatsapp-bridge /app/whatsapp-bridge
RUN chmod +x /app/whatsapp-bridge

# Copy package files and install production dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application source code and scripts
COPY src/ ./src/
COPY scripts/ ./scripts/
COPY .env.example ./

# Create persistent store directory for SQLite databases (whatsapp.db & messages.db)
RUN mkdir -p /app/store

# Expose Pesa webhook port (3000) and internal bridge port (8080)
EXPOSE 3000 8080

ENV NODE_ENV=production
ENV STORE_DIR=/app/store
ENV WHATSAPP_BRIDGE_URL=http://localhost:8080
ENV WHATSAPP_BRIDGE_DB_PATH=/app/store/messages.db
ENV PORT=3000

# Make startup script executable and run
RUN chmod +x /app/scripts/start-container.sh
CMD ["/app/scripts/start-container.sh"]

