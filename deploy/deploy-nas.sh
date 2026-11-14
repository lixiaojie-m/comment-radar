#!/usr/bin/env bash
# 部署 comment-radar 到远端主机（docker 常驻容器）
#
# 用法:
#   DEST=user@host [REMOTE_DIR=/path/to/comment-radar] [PORT=8788] ./deploy/deploy-nas.sh
# 前提: 本机公钥已加入目标机器该账号的 ~/.ssh/authorized_keys
set -euo pipefail

DEST="${DEST:-${1:-}}"
if [ -z "$DEST" ]; then
  echo "用法: DEST=user@host [REMOTE_DIR=/path/to/comment-radar] [PORT=8788] $0" >&2
  exit 1
fi
REMOTE_DIR="${REMOTE_DIR:-${2:-/opt/comment-radar}}"
CONTAINER="comment-radar"
PORT="${PORT:-8788}"

cd "$(dirname "$0")/.."

echo "==> 同步代码到 $DEST:$REMOTE_DIR（保留远端 conf/ 与 data/）"
tar czf - \
  --exclude .git \
  --exclude data \
  --exclude conf \
  --exclude config.json \
  --exclude node_modules \
  src public package.json config.example.json Dockerfile .dockerignore README.md deploy \
  | ssh "$DEST" "mkdir -p $REMOTE_DIR/conf $REMOTE_DIR/data && tar xzf - -C $REMOTE_DIR"

echo "==> 构建镜像并(重)启容器"
ssh "$DEST" "cd $REMOTE_DIR \
  && mkdir -p conf data \
  && if [ -f config.json ] && [ ! -f conf/config.json ]; then mv config.json conf/config.json; fi \
  && docker build -q -t comment-radar:latest . \
  && (docker rm -f $CONTAINER 2>/dev/null || true) \
  && docker run -d --name $CONTAINER --restart unless-stopped \
       -p $PORT:8787 \
       -e CONFIG_FILE=/app/conf/config.json \
       -v $REMOTE_DIR/conf:/app/conf \
       -v $REMOTE_DIR/data:/app/data \
       -e TZ=Asia/Shanghai \
       comment-radar:latest >/dev/null \
  && sleep 2 \
  && docker ps --filter name=$CONTAINER --format '状态: {{.Status}}  端口: {{.Ports}}' \
  && docker logs --tail 5 $CONTAINER"

echo ""
echo "==> 完成，浏览器访问 http://<目标主机>:$PORT（密码见 $REMOTE_DIR/conf/config.json）"
