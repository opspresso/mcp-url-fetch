FROM node:22-alpine AS build
WORKDIR /app
# tsconfig.build.json too: it is what `npm run build` points tsc at, and it is
# the file that excludes the tests from dist.
COPY package.json tsconfig.json tsconfig.build.json ./
RUN npm install
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
EXPOSE 3000
# exec form: node is PID 1 so SIGTERM reaches it on a rolling deploy
CMD ["node", "dist/server.js"]
