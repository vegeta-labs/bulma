# One image for every command (`migrate`, `serve`, `maintain`, `audit`, `init-secrets`). Non-root, read-only root file system at run time (compose).
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# no install scripts: argon2 loads its bundled prebuilt binary at run time
RUN npm ci --ignore-scripts
COPY tsconfig.json vite.config.ts ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY src ./src
COPY packs ./packs
COPY assets ./assets
# a named volume starts with this folder's owner and mode; open to any user, as compose runs as the host's
RUN mkdir -p /var/lib/bulma/files && chmod 777 /var/lib/bulma/files
USER 10001:10001
EXPOSE 8080
ENTRYPOINT ["node", "--experimental-strip-types", "--no-warnings", "src/main.ts"]
CMD ["serve"]
