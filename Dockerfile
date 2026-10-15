FROM node:22.23.2-bookworm-slim AS build
WORKDIR /workspace
RUN npm install --global pnpm@11.25.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps ./apps
COPY packages ./packages
COPY tsconfig.base.json ./
RUN pnpm install --frozen-lockfile
RUN pnpm build
FROM build AS api
ENV NODE_ENV=production
USER node
CMD ["node", "apps/api/dist/main.js"]
FROM build AS worker
ENV NODE_ENV=production
USER node
CMD ["node", "apps/worker/dist/main.js"]
FROM nginx:1.28.2-alpine AS web
COPY deploy/web.conf /etc/nginx/conf.d/default.conf
COPY --from=build /workspace/apps/web/dist /usr/share/nginx/html
