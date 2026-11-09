FROM node:lts-alpine

RUN apk add --no-cache tini

ENV NODE_ENV=production

# node:lts-alpine 已移除 corepack，改用 npm 安装 pnpm
RUN npm install -g pnpm@10

WORKDIR /app

RUN chown node:node /app

COPY --chown=node:node package.json pnpm-lock.yaml ./

USER node

RUN pnpm install --prod --frozen-lockfile

COPY --chown=node:node . ./

EXPOSE 3000

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "app.js"]
