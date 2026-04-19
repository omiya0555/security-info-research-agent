FROM --platform=linux/arm64 public.ecr.aws/docker/library/node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm install
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build
COPY src/skills/ ./dist/skills/
EXPOSE 8080
CMD ["npm", "start"]