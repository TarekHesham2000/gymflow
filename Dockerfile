FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
ENV NODE_ENV=production
# Mount a persistent volume at /data so members and visits survive restarts
ENV DATA_DIR=/data
EXPOSE 3000
CMD ["node", "--no-warnings", "src/server.js"]
