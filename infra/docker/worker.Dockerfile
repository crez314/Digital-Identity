# crez-worker (BullMQ) — FFmpeg 6 LGPL 빌드를 포함한다 (§7.3)
FROM node:20-slim AS base
ENV PNPM_HOME=/pnpm PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
COPY packages ./packages
COPY apps/worker/package.json ./apps/worker/
RUN pnpm install --frozen-lockfile=false

FROM deps AS build
COPY . .
RUN pnpm --filter @crez/db exec prisma generate \
 && pnpm --filter @crez/worker build

FROM base AS runtime
# Debian의 ffmpeg 패키지는 x264/x265를 포함할 수 있으므로, 운영 이미지는
# LGPL 구성으로 빌드한 바이너리를 주입하거나 --disable-gpl 빌드를 사용한다(§7.3).
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg openssl curl && rm -rf /var/lib/apt/lists/*
COPY --from=build /app /app
ENV NODE_ENV=production
CMD ["node", "apps/worker/dist/main.js"]
