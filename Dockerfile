# syntax=docker/dockerfile:1
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# The journal and audit log live on a volume at /data. A new named volume copies
# this directory's ownership, so the node user can write there.
RUN mkdir -p /data/journal /data/audit && chown -R node:node /data
USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]
