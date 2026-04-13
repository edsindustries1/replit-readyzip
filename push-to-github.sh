#!/bin/bash
# Push latest changes to both GitHub repos
# Run from Replit Shell: bash push-to-github.sh

if [ -z "$STEPHENHARRIS_GITHUB_PERSONAL_ACCESS_TOKEN" ] && [ -z "$GITHUB_TOKEN" ]; then
  echo "ERROR: No GitHub token secrets found."
  exit 1
fi

git add -A
git commit -m "Update: $(date '+%Y-%m-%d %H:%M')" 2>/dev/null || echo "Nothing new to commit"

# ── Push to Railway repo (stephenharris6442-beep/replit-final) ──
echo ""
echo "Pushing to stephenharris6442-beep/replit-final (Railway)..."
git remote set-url origin https://x-access-token:${STEPHENHARRIS_GITHUB_PERSONAL_ACCESS_TOKEN}@github.com/stephenharris6442-beep/replit-final.git
git push origin main
git remote set-url origin https://github.com/stephenharris6442-beep/replit-final.git

# ── Push to backup repo (edsindustries1/replit-readyzip) ──
echo ""
echo "Pushing to edsindustries1/replit-readyzip (backup)..."
git remote set-url backup https://x-access-token:${GITHUB_TOKEN}@github.com/edsindustries1/replit-readyzip.git 2>/dev/null || \
git remote add backup https://x-access-token:${GITHUB_TOKEN}@github.com/edsindustries1/replit-readyzip.git
git push backup main
git remote set-url backup https://github.com/edsindustries1/replit-readyzip.git 2>/dev/null

echo ""
echo "Done! Both repos updated. Railway will auto-deploy now."
