# One image definition, three targets: commerce-api | experience-api | workers | admin.
# UNVERIFIED: not built in the authoring environment (low-memory machine). First CI run is the proof.
FROM node:22-alpine AS base
RUN npm install --global pnpm@11.20.0
WORKDIR /repo
COPY backend/package.json backend/pnpm-lock.yaml backend/pnpm-workspace.yaml ./backend/
COPY backend/packages ./backend/packages
COPY backend/apps ./backend/apps
COPY backend/scripts ./backend/scripts
COPY contracts ./contracts
COPY db ./db
WORKDIR /repo/backend
RUN pnpm install --frozen-lockfile

FROM base AS commerce-api
ENV NODE_ENV=production PORT=4000
USER node
EXPOSE 4000
CMD ["pnpm", "--filter", "@jw/commerce-api", "start"]

FROM base AS experience-api
ENV NODE_ENV=production PORT=4001
USER node
EXPOSE 4001
CMD ["pnpm", "--filter", "@jw/experience-api", "start"]

FROM base AS workers
ENV NODE_ENV=production
USER node
CMD ["pnpm", "--filter", "@jw/workers", "start"]

FROM base AS admin-build
RUN pnpm --filter @jw/admin build
FROM admin-build AS admin
ENV NODE_ENV=production PORT=3100
USER node
EXPOSE 3100
CMD ["pnpm", "--filter", "@jw/admin", "start"]
