# Chore Quest backend — Node 24 slim, no native build dependencies
# (node:sqlite is built into Node; express/googleapis are pure JS).
FROM node:24-slim

WORKDIR /app

# Install production dependencies only.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# App source only (docs, .env, local data stay out — see .dockerignore).
COPY src ./src

# Run as the non-root node user.
USER node

ENV NODE_ENV=production
EXPOSE 8080

CMD ["node", "src/index.js"]
