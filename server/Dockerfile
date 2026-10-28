FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi
COPY tsconfig.json drizzle.config.ts ./
COPY src ./src
RUN npm run build
# which build is running, shown by the diagnostics overview (lib/runtime.ts)
ARG SOURCE_COMMIT=""
RUN node -e "require('fs').writeFileSync('dist/build-info.json', JSON.stringify({commit: process.env.SOURCE_COMMIT || null, builtAt: new Date().toISOString()}))"

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi
COPY --from=build /app/dist ./dist
COPY drizzle ./drizzle
USER node
CMD ["node", "dist/index.js"]
