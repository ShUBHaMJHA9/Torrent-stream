#!/bin/bash

# Torrent Stream Server Docker Quick Start Script

set -e

PROJECT_NAME="torrent-stream"
IMAGE_NAME="torrent-stream:latest"
CONTAINER_NAME="torrent-stream-server"
PORT=3000

echo "╔════════════════════════════════════════════════════════════╗"
echo "║     Torrent Stream Server - Docker Quick Start             ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""

# Function to check if Docker is installed
check_docker() {
    if ! command -v docker &> /dev/null; then
        echo "❌ Docker is not installed. Please install Docker first."
        echo "   Visit: https://docs.docker.com/get-docker/"
        exit 1
    fi
    echo "✅ Docker found: $(docker --version)"
}

# Function to check if docker-compose is installed
check_compose() {
    if ! command -v docker-compose &> /dev/null; then
        echo "❌ docker-compose is not installed."
        echo "   Visit: https://docs.docker.com/compose/install/"
        exit 1
    fi
    echo "✅ Docker Compose found: $(docker-compose --version)"
}

# Function to build image
build_image() {
    echo ""
    echo "🔨 Building Docker image..."
    docker build -t $IMAGE_NAME .
    echo "✅ Image built successfully"
}

# Function to start with docker-compose
start_compose() {
    echo ""
    echo "🚀 Starting server with docker-compose..."
    docker-compose up -d
    echo "✅ Server started"
}

# Function to start with docker run
start_docker() {
    echo ""
    echo "🚀 Starting server with Docker..."
    
    # Check if container already exists
    if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
        echo "Container exists, removing it..."
        docker rm -f $CONTAINER_NAME
    fi
    
    docker run -d \
        --name $CONTAINER_NAME \
        --restart unless-stopped \
        -p $PORT:3000 \
        -v torrent-streams:/tmp/streams \
        -e NODE_ENV=production \
        -e PORT=3000 \
        $IMAGE_NAME
    
    echo "✅ Server started"
}

# Function to show server info
show_info() {
    echo ""
    echo "════════════════════════════════════════════════════════════"
    echo "📊 Server Information"
    echo "════════════════════════════════════════════════════════════"
    echo ""
    echo "🌐 Server URL: http://localhost:$PORT"
    echo "📊 Health Check: http://localhost:$PORT/health"
    echo "📚 API Docs: http://localhost:$PORT/api-docs"
    echo "🧪 Test Endpoint: curl http://localhost:$PORT/health"
    echo ""
    echo "════════════════════════════════════════════════════════════"
}

# Function to show usage
show_usage() {
    echo ""
    echo "📖 Usage Examples:"
    echo ""
    echo "1. View logs:"
    if [ -f "docker-compose.yml" ]; then
        echo "   docker-compose logs -f"
    else
        echo "   docker logs -f $CONTAINER_NAME"
    fi
    echo ""
    echo "2. Stop server:"
    if [ -f "docker-compose.yml" ]; then
        echo "   docker-compose down"
    else
        echo "   docker stop $CONTAINER_NAME"
    fi
    echo ""
    echo "3. Access shell:"
    if [ -f "docker-compose.yml" ]; then
        echo "   docker-compose exec torrent-stream sh"
    else
        echo "   docker exec -it $CONTAINER_NAME sh"
    fi
    echo ""
    echo "4. Check status:"
    if [ -f "docker-compose.yml" ]; then
        echo "   docker-compose ps"
    else
        echo "   docker ps | grep $CONTAINER_NAME"
    fi
    echo ""
}

# Main menu
show_menu() {
    echo ""
    echo "Select startup method:"
    echo "1. Docker Compose (recommended)"
    echo "2. Docker CLI"
    echo "3. Exit"
    echo ""
}

# Main script
main() {
    check_docker
    
    # Check if docker-compose.yml exists
    if [ -f "docker-compose.yml" ]; then
        check_compose
        echo ""
        read -p "🤔 docker-compose.yml found. Start with docker-compose? (y/n): " -n 1 -r
        echo ""
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            build_image
            start_compose
        else
            build_image
            start_docker
        fi
    else
        echo "⚠️  docker-compose.yml not found in current directory"
        echo ""
        build_image
        start_docker
    fi
    
    # Wait for container to be ready
    echo ""
    echo "⏳ Waiting for server to start..."
    sleep 3
    
    # Check if server is running
    if [ -f "docker-compose.yml" ]; then
        if docker-compose ps | grep -q "torrent-stream"; then
            echo "✅ Server is running"
        else
            echo "❌ Server failed to start. Checking logs..."
            docker-compose logs torrent-stream
            exit 1
        fi
    else
        if docker ps | grep -q "$CONTAINER_NAME"; then
            echo "✅ Server is running"
        else
            echo "❌ Server failed to start. Checking logs..."
            docker logs $CONTAINER_NAME
            exit 1
        fi
    fi
    
    show_info
    show_usage
    
    echo "✨ Setup complete! Server is ready to use."
    echo ""
}

# Run main function
main
