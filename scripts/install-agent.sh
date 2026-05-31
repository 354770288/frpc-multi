#!/usr/bin/env bash
# frpc-multi Agent 一键安装脚本（反转模型）。
#
# Agent 出站连回主控 Console，因此本机无需公网、无需开放任何入站端口。
# 通常由 Console「新建节点」页生成的命令调用，已注入下列环境变量：
#   AGENT_SERVER  主控可达地址 host:port（例如 frpc.example.com:8081）
#   AGENT_UUID    节点身份（Console 生成）
#   AGENT_SECRET  出站鉴权密钥（Console 生成）
#   AGENT_TLS     主控在 TLS 反代后时为 true（使用 wss），否则 false
# 可选：
#   AGENT_IMAGE       Agent 镜像，默认 ghcr.io/354770288/frpc-multi:latest
#   AGENT_DATA_DIR    Agent 持久化目录，默认 /opt/frpc-multi
#   AGENT_CONTAINER   容器名，默认 frpc-agent
#
# 用法：
#   AGENT_SERVER=... AGENT_UUID=... AGENT_SECRET=... AGENT_TLS=false bash install-agent.sh

set -euo pipefail

AGENT_IMAGE="${AGENT_IMAGE:-ghcr.io/354770288/frpc-multi:latest}"
AGENT_DATA_DIR="${AGENT_DATA_DIR:-/opt/frpc-multi}"
AGENT_CONTAINER="${AGENT_CONTAINER:-frpc-agent}"
AGENT_TLS="${AGENT_TLS:-false}"

require() {
  if [ -z "${!1:-}" ]; then
    echo "ERROR: 缺少环境变量 $1。请使用 Console 生成的一键安装命令。" >&2
    exit 1
  fi
}

require AGENT_SERVER
require AGENT_UUID
require AGENT_SECRET

if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: 未检测到 docker。请先安装 Docker（可用 scripts/install-docker-debian-ubuntu.sh）。" >&2
  exit 1
fi

echo "==> 准备 Agent 数据目录：${AGENT_DATA_DIR}"
mkdir -p "${AGENT_DATA_DIR}/instances"

echo "==> 拉取镜像：${AGENT_IMAGE}"
docker pull "${AGENT_IMAGE}"

if docker ps -a --format '{{.Names}}' | grep -qx "${AGENT_CONTAINER}"; then
  echo "==> 发现已存在的容器 ${AGENT_CONTAINER}，先移除以便用新配置重建"
  docker rm -f "${AGENT_CONTAINER}" >/dev/null
fi

echo "==> 启动 Agent 容器：${AGENT_CONTAINER}"
# 关键：Agent 在容器内经宿主 docker.sock 创建 frpc 容器（docker-out-of-docker），
# frpc 的配置 bind mount 由【宿主机】文件系统解析。因此数据目录必须"宿主路径 = 容器路径"，
# 并让 PROJECT_DIR 指向同一路径，否则宿主 docker 找不到 instances/<name>/frpc.toml，
# 会建空目录导致 frpc 报 "is a directory"。
docker run -d \
  --name "${AGENT_CONTAINER}" \
  --restart unless-stopped \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "${AGENT_DATA_DIR}:${AGENT_DATA_DIR}" \
  -e FRPC_MULTI_ROLE=agent \
  -e PROJECT_DIR="${AGENT_DATA_DIR}" \
  -e AGENT_SERVER="${AGENT_SERVER}" \
  -e AGENT_UUID="${AGENT_UUID}" \
  -e AGENT_SECRET="${AGENT_SECRET}" \
  -e AGENT_TLS="${AGENT_TLS}" \
  "${AGENT_IMAGE}"

echo ""
echo "==> Agent 已启动。它会主动连回主控 ${AGENT_SERVER}。"
echo "    查看日志：docker logs -f ${AGENT_CONTAINER}"
echo "    几秒后在 Console 节点页应看到该节点变为在线。"
