FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4
RUN apt-get update && apt-get install -y --no-install-recommends fonts-noto-cjk=1:20240730+repack1-1 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# 运行阶段只装运行时依赖，不带 devDependencies。
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY --from=build /app/dist ./dist
COPY src/server ./src/server
COPY migrations ./migrations
# 随镜像分发本项目许可与第三方许可声明，满足许可随附义务。
COPY LICENSE THIRD_PARTY_NOTICES.md ./
ENV NODE_ENV=production APP_HOST=0.0.0.0 PORT=18889 PUBLISHING_DATA_DIR=/data
CMD ["bun", "run", "src/server/index.ts"]
