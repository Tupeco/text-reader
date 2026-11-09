# Production image: builds the app and serves dist/ with nginx on port 8080 (non-root).
# Meant to sit behind a reverse proxy that terminates HTTPS (the camera and service worker need it).
# Usage: docker compose up -d --build   (see compose.yaml and .env.example)

FROM node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS build
WORKDIR /app

# Dependencies and the ~230 MB of models first, so source edits don't re-download them.
# The Piper phonemizer comes from phonemizer/dist/ if it is in the build context, else from the
# GitHub release; either way it is checked against phonemizer/release.json.
COPY package.json package-lock.json models.json ./
COPY scripts/fetch-assets.mjs scripts/
COPY phonemizer/ phonemizer/
COPY licenses/ licenses/
RUN npm ci && npm run assets

COPY . .
# Sub-path deploys (e.g. a proxy serving the app at /cards/) set BASE_PATH=/cards/.
ARG BASE_PATH=/
RUN BASE_PATH="$BASE_PATH" npm run build

FROM nginxinc/nginx-unprivileged:1.28-alpine@sha256:7377697a821c131a924a7105fafbe7414db4e9fcc77a6f08f776f33f141ec3f8
# Drop the stock welcome page (it would still answer at / for a sub-path build).
USER root
RUN rm -rf /usr/share/nginx/html/*
USER nginx
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY deploy/headers.conf /etc/nginx/card-reader-headers.conf
ARG BASE_PATH=/
COPY --from=build /app/dist /usr/share/nginx/html${BASE_PATH}
EXPOSE 8080
ENV BASE_PATH=${BASE_PATH}
HEALTHCHECK --interval=30s --timeout=3s CMD wget -q --spider "http://127.0.0.1:8080${BASE_PATH}" || exit 1
