FROM node:20-slim

# Install ffmpeg and fonts
RUN apt-get update && apt-get install -y \
    ffmpeg \
    fonts-dejavu-core \
    fonts-liberation \
    wget \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files
COPY package.json ./

# Install dependencies
RUN npm install --production

# Copy app files
COPY server.js ./

# Create temp directory
RUN mkdir -p /tmp/yfit-videos

EXPOSE 3001

CMD ["node", "server.js"]
