FROM node:18-alpine

# Install git and docker-compose
RUN apk add --no-cache \
    git \
    docker \
    docker-compose \
    bash

# Create app directory
WORKDIR /app

# Copy package files
COPY agent/package*.json ./

# Install dependencies
RUN npm install --omit=dev

# Copy application files
COPY agent/ ./

# Make deploy script executable
RUN chmod +x deploy.sh

# Expose port
EXPOSE 4000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:4000/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Start server
CMD ["node", "server.js"]

