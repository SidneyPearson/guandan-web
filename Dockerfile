FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && mkdir /data && chown node:node /data
COPY index.html sw.js ./
COPY js ./js
COPY css ./css
COPY audio ./audio
COPY mobile ./mobile
COPY server ./server
ENV NODE_ENV=production PORT=8080 ONLINE_MODES=public DATA_DIR=/data
USER node
EXPOSE 8080
CMD ["node", "server/index.cjs"]
