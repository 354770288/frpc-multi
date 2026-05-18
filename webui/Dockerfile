FROM node:24-bookworm-slim AS frontend

WORKDIR /src/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM python:3.14-slim AS runtime

ARG DOCKER_VERSION=27.5.1
ARG COMPOSE_VERSION=2.32.4

WORKDIR /app
ENV PYTHONUNBUFFERED=1

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl; \
    arch="$(uname -m)"; \
    curl -fsSL "https://download.docker.com/linux/static/stable/${arch}/docker-${DOCKER_VERSION}.tgz" -o /tmp/docker.tgz; \
    tar -xzf /tmp/docker.tgz -C /tmp; \
    mv /tmp/docker/docker /usr/local/bin/docker; \
    rm -rf /tmp/docker /tmp/docker.tgz; \
    mkdir -p /usr/libexec/docker/cli-plugins; \
    curl -fsSL "https://github.com/docker/compose/releases/download/v${COMPOSE_VERSION}/docker-compose-linux-${arch}" \
         -o /usr/libexec/docker/cli-plugins/docker-compose; \
    chmod +x /usr/libexec/docker/cli-plugins/docker-compose; \
    apt-get purge -y --auto-remove curl; \
    rm -rf /var/lib/apt/lists/*

COPY backend/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY backend/ ./
COPY --from=frontend /src/backend/static ./static

EXPOSE 8081
CMD ["python", "run.py"]
