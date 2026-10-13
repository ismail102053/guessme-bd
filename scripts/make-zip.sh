#!/bin/sh
# ব্যবহার: npm run make:zip  →  ../guessme-bd.zip তৈরি হয় (node_modules, ডাটাবেস, .env, স্ক্রিনশট বাদ)
set -e
cd "$(dirname "$0")/.."
OUT="../guessme-bd.zip"
rm -f "$OUT"
zip -r "$OUT" . -x "node_modules/*" "data/*" ".env" "*.db" "*.db-wal" "*.db-shm" "e2e-shots/*" ".git/*" "*.log" ".DS_Store" > /dev/null
echo "✅ তৈরি হয়েছে: $(cd .. && pwd)/guessme-bd.zip"
