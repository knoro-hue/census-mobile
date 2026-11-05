#!/usr/bin/env bash
# 作成したデータをmainへコミットする（変更が無ければ何もしない）
set -euo pipefail
git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git add -A data build-cache 2>/dev/null || true
if git diff --cached --quiet; then
  echo "変更なし"
  exit 0
fi
git commit -q -m "$1"
for i in 1 2 3; do
  if git push -q origin HEAD:main; then exit 0; fi
  git pull -q --rebase origin main || true
  sleep 5
done
echo "pushに失敗しました" >&2
exit 1
