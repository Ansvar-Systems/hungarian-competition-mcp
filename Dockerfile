# ─────────────────────────────────────────────────────────────────────────────
# hungarian-competition-mcp — multi-stage Dockerfile
# ─────────────────────────────────────────────────────────────────────────────
# Build:  docker build -t hungarian-competition-mcp .
# Run:    docker run --rm -p 3000:3000 hungarian-competition-mcp
#
# The image expects a pre-built database at /app/data/gvh.db.
# Override with GVH_DB_PATH for a custom location.
# ─────────────────────────────────────────────────────────────────────────────

# --- Stage 1: Build TypeScript + native bindings ---
FROM node:20-alpine AS builder

WORKDIR /app

# Build toolchain for native modules (better-sqlite3)
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json* ./
RUN npm ci
RUN npm rebuild better-sqlite3

COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

# --- Stage 2: Production ---
FROM node:20-alpine AS production

WORKDIR /app
ENV NODE_ENV=production
ENV GVH_DB_PATH=/app/data/gvh.db

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./
COPY data/database.db data/gvh.db

# Non-root user for security
RUN addgroup -S -g 1001 mcp && \
    adduser -S -u 1001 -G mcp mcp && \
    chown -R mcp:mcp /app
USER mcp

# Health check: verify HTTP server responds
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health',r=>{process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1))"

CMD ["node", "dist/src/http-server.js"]
