FROM node:24-alpine AS build
WORKDIR /app
# The lock file, and `npm ci` rather than `npm install`: CI verifies the tree the
# lock pins, so resolving dependencies again here is how the image ends up
# running something no test ever ran. tsconfig.build.json too — it is what
# `npm run build` points tsc at, and the file that excludes the tests from dist.
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
RUN npm ci
COPY src ./src
RUN npm run build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# Nothing here writes to disk or binds a privileged port, so there is nothing
# root buys — and this process exists to parse bytes chosen by a model.
USER node
EXPOSE 3000
# exec form: node is PID 1 so SIGTERM reaches it on a rolling deploy
CMD ["node", "dist/server.js"]
