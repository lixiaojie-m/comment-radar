#!/usr/bin/env bash
# 部署 comment-radar 到 NAS（nas-host，docker 常驻容器）
# 前提：本机公钥已加入 NAS 账号 user 的 authorized_keys
# 用法: ./deploy/deploy-nas.sh
set -euo pipefail

DEST="user@host"
REMOTE_DIR="/opt/comment-radar"
CONTAINER="comment-radar"
PORT="${PORT:-8787}"

cd "$(dirname "$0")/.."

echo "==> 同步代码到 $DEST:$REMOTE_DIR（保留远端 data/ 与 config.json）"
tar czf - \
  --exclude .git \
  --exclude data \
  --exclude config.json \
  --exclude node_modules \
  src public package.json config.example.json Dockerfile .dockerignore README.md \
  | ssh "$DEST" "mkdir -p $REMOTE_DIR/data && tar xzf - -C $REMOTE_DIR"

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
echo "==> 访问: http://nas-host:$PORT（密码见 $REMOTE_DIR/conf/config.json）"
