#!/bin/bash
set -e

echo "=================================================="
echo "🚀 Starting Pesa WhatsApp Finance Agent (Option B)"
echo "=================================================="

# Ensure persistent store directory exists
mkdir -p "${STORE_DIR:-/app/store}"

# 1. Check if user provided pre-authenticated WhatsApp session via base64 env var
if [ -n "$WHATSAPP_SESSION_B64" ] && [ ! -f "${STORE_DIR:-/app/store}/whatsapp.db" ]; then
  echo "🔑 Restoring WhatsApp session from WHATSAPP_SESSION_B64..."
  echo "$WHATSAPP_SESSION_B64" | base64 -d > "${STORE_DIR:-/app/store}/whatsapp.db"
  chmod 600 "${STORE_DIR:-/app/store}/whatsapp.db"
  echo "✅ WhatsApp session restored."
fi

# 2. Check if user provided Google service account JSON via base64
if [ -n "$GOOGLE_SERVICE_ACCOUNT_B64" ] && [ -z "$GOOGLE_SERVICE_ACCOUNT_JSON" ]; then
  export GOOGLE_SERVICE_ACCOUNT_JSON=$(echo "$GOOGLE_SERVICE_ACCOUNT_B64" | base64 -d)
fi

# 3. Start the Go whatsmeow WhatsApp bridge in background
echo "📱 Launching Go WhatsApp Bridge on port ${BRIDGE_PORT:-8080}..."
export STORE_DIR="${STORE_DIR:-/app/store}"
export BRIDGE_PORT="${BRIDGE_PORT:-8080}"

/app/whatsapp-bridge &
BRIDGE_PID=$!

# Trap signals to shut down both processes gracefully
cleanup() {
  echo "🛑 Shutting down Pesa and WhatsApp Bridge..."
  kill -TERM "$BRIDGE_PID" 2>/dev/null || true
  wait "$BRIDGE_PID" 2>/dev/null || true
  exit 0
}
trap cleanup SIGTERM SIGINT

# 4. Wait for bridge to come online
echo "⏳ Waiting for WhatsApp Bridge to initialize..."
for i in $(seq 1 30); do
  if curl -s "http://localhost:${BRIDGE_PORT:-8080}/health" >/dev/null 2>&1 || [ -f "${STORE_DIR:-/app/store}/messages.db" ]; then
    echo "✅ WhatsApp Bridge is running."
    break
  fi
  sleep 1
done

# 5. Start Pesa Node.js agent
echo "💬 Starting Pesa agent server on port ${PORT:-3000}..."
export WHATSAPP_BRIDGE_URL="http://localhost:${BRIDGE_PORT:-8080}"
export WHATSAPP_BRIDGE_DB_PATH="${STORE_DIR:-/app/store}/messages.db"

# Execute node in background and wait so cleanup trap works
node src/index.js &
NODE_PID=$!

wait -n "$BRIDGE_PID" "$NODE_PID"
