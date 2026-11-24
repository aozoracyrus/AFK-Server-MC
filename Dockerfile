FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PORT=8080 \
    MC_PROFILES_FOLDER=/data/profiles

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY src ./src
COPY scripts ./scripts

RUN mkdir -p /data/profiles && chown -R node:node /app /data

USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--max-old-space-size=256", "src/index.js"]
