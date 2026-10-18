# Pilot artifact only. Production configuration remains rejected by the app.
FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
RUN npm install --global npm@11.4.2
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund

FROM dependencies AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build

FROM dependencies AS runtime-dependencies
RUN npm prune --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ARG SOURCE_REVISION=local
LABEL org.opencontainers.image.title="TrueID backend pilot"
LABEL org.opencontainers.image.revision=$SOURCE_REVISION
ENV NODE_ENV=test
ENV TRUEID_PORT=4200
COPY --from=runtime-dependencies /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY migrations ./migrations
USER node
EXPOSE 4200
HEALTHCHECK --interval=10s --timeout=4s --start-period=10s --retries=3 \
  CMD node dist/scripts/smoke-runtime.js --liveness
CMD ["node", "dist/src/main.js"]
