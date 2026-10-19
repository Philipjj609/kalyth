# The hosted demo (ADR 0019): `pnpm demo:serve` with production dependencies only. No secret is
# built in: the Nebius key and the judge code come from the platform at run time, and .env files
# are excluded by .dockerignore.

FROM node:24-slim AS build
WORKDIR /app
RUN npm install --global pnpm@11.6.0
COPY . .
# Build the UI with every dependency, then keep only what the demo server needs at run time.
RUN pnpm install --frozen-lockfile \
  && pnpm build \
  && rm -rf node_modules apps/*/node_modules packages/*/node_modules \
  && pnpm install --frozen-lockfile --prod --filter "@kalyth/server..."

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app /app
RUN mkdir -p /data && chown node:node /data
USER node
ENV KALYTH_PORT=8080 KALYTH_DEMO_DATA=/data
EXPOSE 8080
CMD ["node", "apps/server/src/demo/main.ts"]
