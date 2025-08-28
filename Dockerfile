# Dockerfile – build estável e previsível
FROM node:20-alpine

# Cria diretório de trabalho
WORKDIR /app

# Copia manifests e instala dependências
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Copia o resto do projeto
COPY . .

# Variáveis de ambiente padrão (Render pode sobrescrever)
ENV NODE_ENV=production
ENV PORT=10000

# Porta exposta (Render ajusta o roteamento automaticamente)
EXPOSE 10000

# Sobe o seu servidor
CMD ["node", "server.js"]
