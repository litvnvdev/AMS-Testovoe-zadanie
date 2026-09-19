# --- сборка: TypeScript-сервер + React-панель ---
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
# если package-lock.json закоммичен - воспроизводимая установка, иначе обычная
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi
COPY . .
RUN npm run build && npm prune --omit=dev

# --- рантайм: только собранное и prod-зависимости ---
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/web/dist ./web/dist
COPY config ./config
COPY package.json ./
RUN mkdir -p data && chown -R node:node data
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
