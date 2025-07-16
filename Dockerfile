# Build stage
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
COPY . .
RUN npm ci

# Production stage
FROM node:22-alpine AS production
RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production --ignore-scripts && npm cache clean --force
COPY --from=builder /app/dist ./dist
RUN chown -R nodejs:nodejs /app
USER nodejs
EXPOSE 3000
CMD ["node", "dist/index.js", "brokebank", "--http"]
