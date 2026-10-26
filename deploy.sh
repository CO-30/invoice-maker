#!/bin/sh
# 使い方: ./deploy.sh 1.5.0 "変更内容"
set -e
cd "$(dirname "$0")"
sed -i "s/const APP_VERSION=\"[^\"]*\"/const APP_VERSION=\"$1\"/" index.html
echo "$1" > version.txt
git add -A && git commit -m "v$1 $2" && git push
