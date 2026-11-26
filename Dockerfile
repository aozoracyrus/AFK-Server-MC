FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PORT=8080 \
    STATE_FILE=/data/state.json

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY index.js ./

RUN mkdir -p /data && chown -R node:node /app /data

USER node
EXPOSE 8080

CMD ["node", "--max-old-space-size=256", "index.js"]
