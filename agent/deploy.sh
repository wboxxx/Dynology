#!/bin/sh
# Dynogy Deployment Script
# Usage: deploy.sh <service-name> <repo-path> <services-dir> <log-file>

set -e

# Configuration variables (passed as arguments or use defaults)
SERVICE_NAME="${1:-unknown-service}"
REPO_DIR="${2:-}"
SERVICES_DIR="${3:-/volume1/docker/dynogy/services}"
LOG_FILE="${4:-/dev/stdout}"

# Colors for output (optional, may not work in all environments)
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

log_error() {
    echo "${RED}[ERROR]${NC} $1" | tee -a "$LOG_FILE"
}

log_success() {
    echo "${GREEN}[SUCCESS]${NC} $1" | tee -a "$LOG_FILE"
}

log_warn() {
    echo "${YELLOW}[WARN]${NC} $1" | tee -a "$LOG_FILE"
}

# Validate arguments
if [ -z "$REPO_DIR" ]; then
    log_error "Repository path not provided"
    exit 1
fi

log "=== Starting deployment for service: $SERVICE_NAME ==="
log "Repository path: $REPO_DIR"
log "Services directory: $SERVICES_DIR"

# Ensure services directory exists
if [ ! -d "$SERVICES_DIR" ]; then
    log_warn "Services directory does not exist, creating: $SERVICES_DIR"
    mkdir -p "$SERVICES_DIR" || {
        log_error "Failed to create services directory"
        exit 1
    }
fi

# Check if repository directory exists
if [ ! -d "$REPO_DIR" ]; then
    log_warn "Repository directory does not exist: $REPO_DIR"
    log "This script expects the repository to already exist."
    log "You may need to clone it manually first or enhance this script to handle cloning."
    exit 1
fi

# Navigate to repository directory
cd "$REPO_DIR" || {
    log_error "Failed to change to repository directory: $REPO_DIR"
    exit 1
}

log "Changed to directory: $(pwd)"

# Check if it's a git repository
if [ ! -d ".git" ]; then
    log_error "Not a git repository: $REPO_DIR"
    exit 1
fi

# Check if docker-compose.yml exists
COMPOSE_FILE="docker-compose.yml"
if [ ! -f "$COMPOSE_FILE" ]; then
    log_error "docker-compose.yml not found in $REPO_DIR"
    exit 1
fi

log "Found docker-compose.yml"

# Step 1: Git pull
log "Step 1: Pulling latest changes from git..."
if git pull 2>&1 | tee -a "$LOG_FILE"; then
    log_success "Git pull completed"
else
    log_error "Git pull failed"
    exit 1
fi

# Step 2: Docker Compose build
log "Step 2: Building Docker images..."
if docker compose build 2>&1 | tee -a "$LOG_FILE"; then
    log_success "Docker build completed"
else
    log_error "Docker build failed"
    exit 1
fi

# Step 3: Docker Compose up
log "Step 3: Starting/updating containers..."
if docker compose up -d 2>&1 | tee -a "$LOG_FILE"; then
    log_success "Docker containers started/updated"
else
    log_error "Docker compose up failed"
    exit 1
fi

# Optional: Show container status
log "Step 4: Checking container status..."
docker compose ps 2>&1 | tee -a "$LOG_FILE"

log "=== Deployment completed successfully for service: $SERVICE_NAME ==="
exit 0

