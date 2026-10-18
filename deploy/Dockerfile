# Supply an approved Node 22+ base by digest; no default image or tag is chosen.
# The build stage needs the native compiler prerequisites for better-sqlite3.
ARG BASE_IMAGE
FROM ${BASE_IMAGE} AS dependencies
ARG BASE_IMAGE
USER 0:0
WORKDIR /srv/bb-soc
COPY package.json package-lock.json ./
RUN node -e 'if (!/@sha256:[a-f0-9]{64}$/.test(process.env.BASE_IMAGE || "")) process.exit(1)' && npm ci --omit=dev && npm cache clean --force

FROM ${BASE_IMAGE}
WORKDIR /srv/bb-soc
COPY --from=dependencies /srv/bb-soc/node_modules ./node_modules
COPY package.json ./package.json
COPY tools ./tools
COPY server ./server
COPY public ./public
USER 10001:10001
ENV NODE_ENV=production
ENTRYPOINT ["node", "/srv/bb-soc/tools/deployment/worker.js"]
# At runtime provide --manifest with a private mounted pack and --loop/--once.
# Read-only root, durable storage and private mounts belong to generated manifests.
