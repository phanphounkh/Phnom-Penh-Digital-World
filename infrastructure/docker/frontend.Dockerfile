# Phnom Penh Digital World web app (SvelteKit, adapter-node). Build context: ./frontend
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npx svelte-kit sync && npm run build && npm prune --omit=dev

FROM node:22-slim
WORKDIR /app
# BODY_SIZE_LIMIT: product photos (4 MB) and verification documents (5 MB) pass through.
ENV NODE_ENV=production PORT=3000 BODY_SIZE_LIMIT=6M
COPY --from=build /app/build ./build
COPY --from=build /app/node_modules ./node_modules
COPY package.json server.js ./
USER node
EXPOSE 3000
# server.js = SvelteKit handler + WebSocket pass-through to the API for /api/v1/world/ws.
CMD ["node", "server.js"]
