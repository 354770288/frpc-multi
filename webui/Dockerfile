FROM node:24-bookworm-slim AS frontend

WORKDIR /src/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM python:3.14-slim AS runtime

ARG DOCKER_VERSION=27.5.1
ARG COMPOSE_VERSION=2.32.4
ARG FRP_VERSION=0.68.1
# 镜像内烙上构建版本（git 短 sha），agent 上报供面板核对节点 agent 版本
ARG AGENT_VERSION=dev

WORKDIR /app
ENV PYTHONUNBUFFERED=1     AGENT_VERSION=${AGENT_VERSION}

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
    case "${arch}" in \
        x86_64) frp_arch=amd64 ;; \
        aarch64) frp_arch=arm64 ;; \
        *) echo "unsupported arch: ${arch}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/frp_${FRP_VERSION}_linux_${frp_arch}.tar.gz" -o /tmp/frp.tgz; \
    tar -xzf /tmp/frp.tgz -C /tmp; \
    mv "/tmp/frp_${FRP_VERSION}_linux_${frp_arch}/frpc" /usr/local/bin/frpc; \
    chmod +x /usr/local/bin/frpc; \
    rm -rf /tmp/frp*; \
    apt-get purge -y --auto-remove curl; \
    rm -rf /var/lib/apt/lists/*

COPY backend/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY backend/ ./
COPY --from=frontend /src/backend/static ./static

EXPOSE 8081
CMD ["python", "run.py"]
