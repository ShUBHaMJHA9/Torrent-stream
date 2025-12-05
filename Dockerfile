# Multi-stage build for optimized image size
FROM node:22-alpine AS builder

# Install build dependencies required for npm native modules
# `build-base` provides gcc, g++, make and libc-dev; `git` is useful for some packages
RUN apk add --no-cache python3 build-base git

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies (use npm install so a missing package-lock won't fail builds on Koyeb)
RUN npm install --production --no-audit --no-fund

# Production stage
FROM node:22-alpine

# Install runtime dependencies
# FFmpeg for HLS conversion
RUN apk add --no-cache \
    ffmpeg \
    curl \
    dumb-init

WORKDIR /app

# Copy installed dependencies from builder
COPY --from=builder /app/node_modules ./node_modules

# Copy application files
COPY package*.json ./
COPY server.js .

# Create temp directory for streams and ensure correct ownership
RUN mkdir -p /tmp/streams /app/logs && \
    chown -R node:node /tmp/streams /app /app/node_modules

# Use non-root user for improved security
USER node

# Ensure working directory and permissions for node user
WORKDIR /app

# Set environment variables
ENV NODE_ENV=production
ENV PORT=3000

# Expose port
EXPOSE 3000

# Health check — give app more time to start on smaller instances
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1

# Use dumb-init as PID 1 to handle signals correctly on Koyeb
# apk's dumb-init installs to /usr/bin/dumb-init on Alpine
ENTRYPOINT ["/usr/bin/dumb-init", "--"]
# Use npm start so Koyeb and standard workflows run the app via package.json
CMD ["npm", "start"]
