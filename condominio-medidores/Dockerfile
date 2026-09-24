# Imagem para publicar o sistema em qualquer servidor com Docker.
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production TZ=America/Sao_Paulo DATA_DIR=/data DB_FILE=/data/medidores.db
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY . .
RUN mkdir -p /data && chown -R node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
