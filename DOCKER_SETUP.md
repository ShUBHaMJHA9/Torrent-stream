# Docker Setup Guide for Torrent Stream Server

## Quick Start

### Option 1: Using Docker Compose (Recommended)

```bash
# Start the server
docker-compose up -d

# View logs
docker-compose logs -f

# Stop the server
docker-compose down
```

### Option 2: Using Docker CLI

```bash
# Build the image
docker build -t torrent-stream:latest .

# Run the container
docker run -d \
  --name torrent-stream \
  -p 3000:3000 \
  -v $(pwd)/streams:/tmp/streams \
  -e NODE_ENV=production \
  torrent-stream:latest

# View logs
docker logs -f torrent-stream

# Stop the container
docker stop torrent-stream
docker rm torrent-stream
```

---

## Docker Compose Configuration

### What It Includes

- **Service**: Torrent Stream Server v2.0
- **Port**: 3000 (configurable)
- **Volumes**:
  - `./streams` → `/tmp/streams` (persistent stream storage)
  - `./logs` → `/app/logs` (optional logging)
- **Resources**:
  - CPU limit: 2 cores
  - Memory limit: 2GB
  - Reserved: 1 core, 1GB RAM
- **Restart Policy**: Unless stopped
- **Health Check**: Enabled (30s intervals)
- **Logging**: JSON format with rotation

### Environment Variables

```yaml
NODE_ENV: production        # Production mode
PORT: 3000                  # Server port
NODE_OPTIONS: --max-old-space-size=2048  # Memory allocation
```

---

## Dockerfile Overview

### Multi-Stage Build

**Stage 1: Builder**
- Uses Node 22 Alpine
- Installs build dependencies
- Compiles native modules

**Stage 2: Production**
- Lightweight Alpine image
- Includes FFmpeg and FFprobe
- Includes yt-dlp for YouTube streaming
- Only copies necessary files

### Base Image: `node:22-alpine`

**Why Alpine?**
- ✅ Small size (~150MB)
- ✅ Fast startup
- ✅ Secure and lightweight
- ✅ Perfect for Docker

### Installed Tools

```dockerfile
FFmpeg        → HLS conversion
FFprobe       → Media analysis
yt-dlp        → YouTube streaming
Python3       → yt-dlp dependency
curl          → Health checks
```

---

## Building & Running

### Build the Docker Image

```bash
# Build with default tag
docker build -t torrent-stream:latest .

# Build with specific version
docker build -t torrent-stream:v2.0 .

# Build with buildkit (faster)
DOCKER_BUILDKIT=1 docker build -t torrent-stream:latest .
```

### Run the Container

```bash
# Basic run
docker run -p 3000:3000 torrent-stream:latest

# With volume mounts
docker run -d \
  --name torrent-stream \
  -p 3000:3000 \
  -v streams:/tmp/streams \
  torrent-stream:latest

# With environment variables
docker run -d \
  --name torrent-stream \
  -p 3000:3000 \
  -e NODE_ENV=production \
  -e PORT=3000 \
  torrent-stream:latest

# With resource limits
docker run -d \
  --name torrent-stream \
  -p 3000:3000 \
  --cpus 2 \
  --memory 2g \
  torrent-stream:latest

# Full example with all options
docker run -d \
  --name torrent-stream \
  --restart unless-stopped \
  -p 3000:3000 \
  -v $(pwd)/streams:/tmp/streams \
  -v $(pwd)/logs:/app/logs \
  -e NODE_ENV=production \
  -e PORT=3000 \
  --cpus 2 \
  --memory 2g \
  torrent-stream:latest
```

---

## Volume Mounts

### Streams Directory

```bash
# Persistent stream storage
-v ./streams:/tmp/streams
```

**Purpose:**
- Keep downloaded streams after container restart
- Access stream files from host
- Manage disk space

**Directory structure:**
```
streams/
├── stream_id_1/
│   ├── playlist.m3u8
│   ├── segment_000.ts
│   ├── segment_001.ts
│   └── video.mp4
├── stream_id_2/
│   └── ...
```

### Logs Directory (Optional)

```bash
# Application logs
-v ./logs:/app/logs
```

**Purpose:**
- Persistent application logs
- Debugging and monitoring
- Access logs from host

---

## Networking

### Port Mapping

```bash
# Map port 3000 to host port 3000
-p 3000:3000

# Map port 3000 to host port 8080
-p 8080:3000

# Use host network (not recommended)
--network host
```

### Custom Network

```bash
# Create network
docker network create torrent-stream-net

# Run container on network
docker run --network torrent-stream-net ...

# Access from other containers
http://torrent-stream:3000
```

---

## Health Check

### Built-in Health Check

```dockerfile
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1
```

### Check Container Health

```bash
# View health status
docker inspect --format='{{.State.Health.Status}}' torrent-stream

# View health details
docker inspect torrent-stream | grep -A 5 '"Health"'
```

### Manual Health Check

```bash
# Inside container
docker exec torrent-stream curl http://localhost:3000/health

# From host
curl http://localhost:3000/health
```

---

## Resource Management

### CPU Limits

```yaml
# docker-compose.yml
deploy:
  resources:
    limits:
      cpus: '2'           # Max 2 cores
    reservations:
      cpus: '1'           # Reserved 1 core
```

### Memory Limits

```yaml
# docker-compose.yml
deploy:
  resources:
    limits:
      memory: 2G          # Max 2GB
    reservations:
      memory: 1G          # Reserved 1GB
```

### CLI equivalent

```bash
docker run \
  --cpus 2 \
  --memory 2g \
  --memory-reservation 1g \
  torrent-stream:latest
```

---

## Logging

### Docker Compose Logging

```yaml
logging:
  driver: "json-file"
  options:
    max-size: "10m"      # Max 10MB per log
    max-file: "3"        # Keep 3 log files
```

### View Logs

```bash
# Last 100 lines
docker-compose logs --tail 100

# Follow logs in real-time
docker-compose logs -f

# View specific service logs
docker-compose logs torrent-stream

# View logs from last hour
docker-compose logs --since 1h
```

### Save Logs to File

```bash
docker-compose logs > app.log
```

---

## Environment Variables

### Production Settings

```bash
NODE_ENV=production     # Enable production optimizations
PORT=3000              # Server port
NODE_OPTIONS=--max-old-space-size=2048  # Memory allocation
```

### Set in docker-compose.yml

```yaml
environment:
  - NODE_ENV=production
  - PORT=3000
  - NODE_OPTIONS=--max-old-space-size=2048
```

### Set with Docker CLI

```bash
docker run -e NODE_ENV=production \
           -e PORT=3000 \
           torrent-stream:latest
```

### Set with .env file

```bash
# Create .env file
NODE_ENV=production
PORT=3000

# Use with docker-compose
docker-compose --env-file .env up
```

---

## Common Commands

### Start/Stop

```bash
# Start with compose
docker-compose up -d
docker-compose down

# Start with CLI
docker start torrent-stream
docker stop torrent-stream

# Restart
docker-compose restart
docker restart torrent-stream
```

### Logs

```bash
docker-compose logs -f
docker logs -f torrent-stream
```

### Execute Commands

```bash
# Run command in container
docker-compose exec torrent-stream curl http://localhost:3000/health

# Access shell
docker-compose exec torrent-stream sh
docker exec -it torrent-stream sh
```

### Clean Up

```bash
# Stop and remove containers
docker-compose down

# Remove image
docker rmi torrent-stream:latest

# Remove all unused images
docker image prune -a

# Remove dangling volumes
docker volume prune
```

---

## Troubleshooting

### Container Exits Immediately

```bash
# Check logs
docker logs torrent-stream

# Run with interactive terminal
docker run -it torrent-stream:latest

# Check health
docker inspect torrent-stream | grep -A 10 '"Health"'
```

### Port Already in Use

```bash
# Check what's using port 3000
lsof -i :3000
netstat -tlnp | grep 3000

# Use different port
docker run -p 8080:3000 torrent-stream:latest
```

### Memory Issues

```bash
# Check memory usage
docker stats torrent-stream

# Increase memory limit
docker run --memory 3g torrent-stream:latest

# Check available memory
free -h
```

### Build Fails

```bash
# Clear build cache and rebuild
docker build --no-cache -t torrent-stream:latest .

# Check build output
docker build -t torrent-stream:latest . 2>&1

# Verify Dockerfile
docker build --dry-run -t torrent-stream:latest .
```

---

## Performance Tips

### 1. Multi-Stage Build
- ✅ Reduces final image size
- ✅ Faster build times
- ✅ Smaller memory footprint

### 2. Alpine Base Image
- ✅ ~150MB image size
- ✅ Faster startup
- ✅ Lower resource usage

### 3. Volume Mounts
- ✅ Use named volumes for production
- ✅ Use bind mounts for development
- ✅ Avoid `-v /path:/path` on Windows

### 4. Resource Limits
- ✅ Prevent resource exhaustion
- ✅ Fair CPU/memory allocation
- ✅ Predictable performance

### 5. Health Checks
- ✅ Auto-restart unhealthy containers
- ✅ Monitor service availability
- ✅ Detect hung processes

---

## Docker Hub (Optional)

### Push to Docker Hub

```bash
# Tag image
docker tag torrent-stream:latest username/torrent-stream:latest

# Login
docker login

# Push
docker push username/torrent-stream:latest

# Pull
docker pull username/torrent-stream:latest
```

---

## Production Deployment

### Docker Swarm

```bash
# Initialize swarm
docker swarm init

# Deploy service
docker service create \
  --name torrent-stream \
  -p 3000:3000 \
  --replicas 1 \
  --limit-cpu 2 \
  --limit-memory 2g \
  torrent-stream:latest
```

### Kubernetes

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: torrent-stream
spec:
  replicas: 1
  selector:
    matchLabels:
      app: torrent-stream
  template:
    metadata:
      labels:
        app: torrent-stream
    spec:
      containers:
      - name: torrent-stream
        image: torrent-stream:latest
        ports:
        - containerPort: 3000
        resources:
          limits:
            cpu: "2"
            memory: "2Gi"
          requests:
            cpu: "1"
            memory: "1Gi"
        livenessProbe:
          httpGet:
            path: /health
            port: 3000
          initialDelaySeconds: 10
          periodSeconds: 30
        volumeMounts:
        - name: streams
          mountPath: /tmp/streams
      volumes:
      - name: streams
        emptyDir: {}
```

---

## Testing

### Test Container Build

```bash
# Build image
docker build -t torrent-stream:test .

# Run tests
docker run --rm torrent-stream:test node -v
docker run --rm torrent-stream:test npm -v
docker run --rm torrent-stream:test ffmpeg -version
```

### Test Running Container

```bash
# Start container
docker run -d -p 3000:3000 --name test-server torrent-stream:latest

# Wait for startup
sleep 5

# Test health endpoint
curl http://localhost:3000/health

# Stop container
docker stop test-server
docker rm test-server
```

---

## Summary

✅ **Dockerfile**: Multi-stage, optimized, ~350MB image
✅ **docker-compose.yml**: Complete production setup
✅ **Health checks**: Automatic monitoring
✅ **Resource limits**: CPU and memory management
✅ **Volumes**: Persistent data storage
✅ **Logging**: Structured JSON logging
✅ **Security**: Non-root user ready (future)

**Ready to deploy! 🐳**
