# =========================================================================
# Flow Force Enterprise SKU & Purchase Request Automation Portal
# Production-ready Node.js Docker Container
# =========================================================================
FROM node:20-alpine

# Set working directory
WORKDIR /app

# Environment configuration
ENV NODE_ENV=production
ENV PORT=3000

# Install production dependencies only
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

# Copy application source files
COPY . .

# Ensure storage directory exists
RUN mkdir -p /app/storage

# Expose application port
EXPOSE 3000

# Start Flow Force application with Node.js
CMD ["node", "server/index.js"]
