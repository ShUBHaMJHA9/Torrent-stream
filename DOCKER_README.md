# 🐳 Docker Deployment Guide

## Quick Start (30 seconds)

```bash
# 1. Build the Docker image
docker build -t torrent-stream:latest .

# 2. Run the container
docker run -d \
  --name torrent-stream \
  -p 3000:3000 \
  -v streams:/tmp/streams \
  torrent-stream:latest

# 3. Test the server
curl http://localhost:3000/health
```

**Done!** Your server is running at `http://localhost:3000`

---

## Using Docker Compose (Recommended)

### Start Server

```bash
# Start
docker-compose up -d

# View logs
docker-compose logs -f

# Stop
docker-compose down
```

### What's Included

✅ Automatic health checks
✅ Resource limits (2 cores, 2GB RAM)
✅ Volume mounts for persistent storage
✅ Logging configuration
✅ Automatic restart on failure

---

## Docker Image Details

| Property | Value |
|----------|-------|
| Base Image | node:22-alpine |
| Size | ~325 MB |
| Build Time | ~15 seconds |
| Startup Time | ~2 seconds |
| Tools | FFmpeg, FFprobe, Node.js 22 |

---

## File Structure

```
project/
├── Dockerfile              # Multi-stage Docker build
├── docker-compose.yml      # Docker Compose configuration
├── .dockerignore          # Files to exclude from image
├── .env.example           # Configuration template
├── docker-quickstart.sh   # Quick start script
├── DOCKER_SETUP.md        # Detailed Docker guide
├── server.js              # Main application
├── package.json           # Dependencies
└── streams/               # Persistent stream storage (created)
```

---

## One-Command Setup

### Linux/Mac

```bash
chmod +x docker-quickstart.sh && ./docker-quickstart.sh
```

### Windows (PowerShell)

```powershell
docker-compose up -d
```

---

## Configuration

### Environment Variables

Create `.env` file:

```
NODE_ENV=production
PORT=3000
NODE_OPTIONS=--max-old-space-size=2048
```

### Resource Limits

Edit `docker-compose.yml`:

```yaml
deploy:
  resources:
    limits:
      cpus: '2'        # 2 CPU cores max
      memory: 2G       # 2GB RAM max
```

---

## Common Commands

### View Logs

```bash
# Real-time logs
docker-compose logs -f

# Last 100 lines
docker-compose logs --tail 100

# Specific service
docker-compose logs torrent-stream
```

### Execute Commands

```bash
# Run command in container
docker-compose exec torrent-stream curl http://localhost:3000/health

# Access shell
docker-compose exec torrent-stream sh
```

### Check Status

```bash
# Container status
docker-compose ps

# Resource usage
docker stats

# Health status
docker inspect torrent-stream | grep -i health
```

### Stop/Start

```bash
# Start
docker-compose up -d

# Stop
docker-compose stop

# Restart
docker-compose restart

# Remove
docker-compose down
```

---

## API Usage from Docker

### Create Stream

```bash
curl -X POST http://localhost:3000/stream \
  -H "Content-Type: application/json" \
  -d '{"magnet":"magnet:?xt=urn:btih:..."}'
```

### Get Subtitles

```bash
curl http://localhost:3000/subtitles-list/stream_id
```

### Seek

```bash
curl -X POST http://localhost:3000/seek/stream_id \
  -H "Content-Type: application/json" \
  -d '{"time":120}'
```

### Health Check

```bash
curl http://localhost:3000/health
```

---

## Troubleshooting

### Container Won't Start

```bash
# Check logs
docker-compose logs torrent-stream

# Check specific error
docker-compose logs torrent-stream | grep -i error

# Rebuild
docker-compose down
docker-compose build --no-cache
docker-compose up -d
```

### Port Already in Use

```bash
# Find what's using port 3000
lsof -i :3000

# Use different port
docker run -p 8080:3000 torrent-stream:latest
```

### Permission Denied

```bash
# Add user to docker group (Linux)
sudo usermod -aG docker $USER
newgrp docker

# Or use sudo
sudo docker-compose up -d
```

### Out of Disk Space

```bash
# Clean up Docker system
docker system prune -a

# Remove old images
docker image prune -a

# Remove dangling volumes
docker volume prune
```

---

## Networking

### Local Access

```bash
# Inside container
curl http://localhost:3000/health

# From host
curl http://localhost:3000/health
```

### From Other Machines

```bash
# Replace localhost with machine IP
curl http://192.168.1.100:3000/health

# Or use hostname
curl http://myserver.local:3000/health
```

### Docker Network

```bash
# Create custom network
docker network create torrent-stream-net

# Run on network
docker run --network torrent-stream-net ...

# Access by container name
curl http://torrent-stream:3000/health
```

---

## Performance Tuning

### Memory

```yaml
# Increase memory limit
deploy:
  resources:
    limits:
      memory: 4G       # 4GB
```

### CPU

```yaml
# More CPU cores
deploy:
  resources:
    limits:
      cpus: '4'        # 4 cores
```

### Disk Cache

```bash
# Use tmpfs for faster I/O
docker run --tmpfs /tmp:rw,size=1g torrent-stream:latest
```

---

## Production Deployment

### Nginx Reverse Proxy

```nginx
server {
    listen 80;
    server_name example.com;
    
    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

### SSL/TLS

```bash
docker run -p 443:3000 -v /etc/ssl:/etc/ssl torrent-stream:latest
```

### Docker Swarm

```bash
docker service create \
  --name torrent-stream \
  -p 3000:3000 \
  torrent-stream:latest
```

---

## Data Persistence

### Volumes

```bash
# Named volume (recommended)
docker run -v streams:/tmp/streams torrent-stream:latest

# Bind mount
docker run -v $(pwd)/streams:/tmp/streams torrent-stream:latest
```

### Backup

```bash
# Create backup
docker run --rm -v streams:/data -v $(pwd):/backup \
  alpine tar czf /backup/streams.tar.gz -C /data .

# Restore backup
docker run --rm -v streams:/data -v $(pwd):/backup \
  alpine tar xzf /backup/streams.tar.gz -C /data
```

---

## Monitoring

### Container Logs

```bash
# All logs
docker-compose logs

# Real-time
docker-compose logs -f

# Time range
docker-compose logs --since 1h
```

### Resource Usage

```bash
# Monitor resources
docker stats torrent-stream

# CPU only
docker stats --no-stream torrent-stream
```

### Health Checks

```bash
# Check health
docker inspect torrent-stream | grep -A 10 '"Health"'

# Manual health check
curl http://localhost:3000/health | python3 -m json.tool
```

---

## Updating

### Update Code

```bash
# Pull latest code
git pull

# Rebuild image
docker-compose build --no-cache

# Restart
docker-compose down
docker-compose up -d
```

### Update Docker Image

```bash
# Stop current
docker-compose down

# Remove old image
docker rmi torrent-stream:latest

# Rebuild
docker-compose build

# Start
docker-compose up -d
```

---

## Security

### Non-Root User (Future)

```dockerfile
RUN addgroup -g 1001 -S nodejs
RUN adduser -S nodejs -u 1001
USER nodejs
```

### Secrets

```bash
# Use Docker secrets
echo "secret_value" | docker secret create my_secret -

# Reference in compose
secrets:
  - my_secret
```

### Network Security

```yaml
# Isolate network
networks:
  private:
    internal: true
```

---

## FAQ

**Q: How much disk space do I need?**
A: At least 2GB for the image + 5GB per stream (depends on video size)

**Q: Can I run multiple servers?**
A: Yes, use different ports: `-p 3001:3000`, `-p 3002:3000`, etc.

**Q: How do I backup streams?**
A: Docker volume backup or tar the streams folder

**Q: Does it work on Windows/Mac?**
A: Yes, with Docker Desktop

**Q: Can I access from outside localhost?**
A: Yes, use your machine's IP address or hostname

---

## Support

For issues, check:
- Server logs: `docker-compose logs`
- Health endpoint: `curl http://localhost:3000/health`
- API docs: `curl http://localhost:3000/api-docs`

---

**Docker deployment ready! 🚀**

Questions? Check DOCKER_SETUP.md for detailed information.
