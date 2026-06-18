# Echoes Remembered — backend image.
# Single stage: installs deps, generates the Prisma client at build time, and
# runs the app with tsx (the Prisma 7 `prisma-client` generator emits TypeScript,
# so we run from source rather than a separate compiled bundle).
FROM node:24-bookworm-slim

# OpenSSL + CA certs are required by the Prisma engines.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install ALL dependencies (incl. tsx + prisma CLI, which the app needs at
# runtime). NODE_ENV is intentionally not pinned here so devDeps are installed;
# the runtime NODE_ENV is provided by docker-compose.
COPY package.json package-lock.json ./
RUN npm ci --include=dev

# Copy the source and generate the Prisma client (downloads engines into the image).
COPY . .
RUN npx prisma generate

EXPOSE 4000

# Default command runs the API; the worker service overrides this in compose.
CMD ["npm", "run", "serve"]
