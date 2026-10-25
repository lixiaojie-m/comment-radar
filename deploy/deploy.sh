#!/usr/bin/env bash
# 部署 comment-radar：同步代码 + 安装/重启 systemd 服务
# 用法: ./deploy/deploy.sh user@host
set -euo pipefail

DEST="${1:?用法: ./deploy/deploy.sh user@host}"
REMOTE_DIR="/opt/comment-radar"

cd "$(dirname "$0")/.."

echo "==> 同步代码到 $DEST:$REMOTE_DIR（保留远端 data/ 与 config.json）"
tar czf - \
  --exclude node_modules \
  --exclude .git \
  src public package.json config.example.json README.md deploy \
  | ssh "$DEST" "mkdir -p $REMOTE_DIR && tar xzf - -C $REMOTE_DIR"

echo "==> 安装 systemd 服务"
ssh "$DEST" "cp $REMOTE_DIR/deploy/comment-radar.service /etc/systemd/system/ && systemctl daemon-reload && if systemctl is-active --quiet comment-radar; then systemctl restart comment-radar && echo restarted; else echo 'not running yet'; fi"

echo ""
echo "==> 完成。首次部署还需在服务器上："
echo "  1. ssh $DEST"
echo "  2. cd $REMOTE_DIR && cp -n config.example.json config.json"
echo "  3. 编辑 config.json：改 password、填 llm.apiKey"
echo "  4. systemctl enable --now comment-radar"
echo "  5. 浏览器打开 http://<服务器IP>:8787"
