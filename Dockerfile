FROM node:22-bookworm
WORKDIR /app
ENV NODE_ENV=production
COPY package.json config.example.json ./
COPY src ./src
COPY public ./public
EXPOSE 8787
CMD ["node", "src/server.js"]
