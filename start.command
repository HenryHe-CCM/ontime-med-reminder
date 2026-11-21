#!/bin/zsh
set -e
cd "$(dirname "$0")"

PORT="${PORT:-4173}"
LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)"
if [ -z "$LAN_IP" ]; then
  LAN_IP="127.0.0.1"
fi

echo ""
echo "按时 · 每日服药提醒"
echo "------------------------------------------------------------"
echo "这台电脑打开：  http://127.0.0.1:${PORT}"
echo "同一 Wi-Fi 手机：http://${LAN_IP}:${PORT}"
echo ""
echo "提示：手机通过局域网 http 打开时可以正常记录和导出日历；"
echo "      如果要安装到主屏幕或使用浏览器通知，需要 HTTPS 访问。"
echo "按 Ctrl+C 停止服务。"
echo "------------------------------------------------------------"
echo ""

python3 -m http.server "${PORT}" --bind 0.0.0.0
