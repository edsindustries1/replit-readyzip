#!/bin/bash
# Push latest changes to GitHub using GITHUB_TOKEN secret
# Run this from Replit Shell: bash push-to-github.sh

if [ -z "$GITHUB_TOKEN" ]; then
  echo "ERROR: GITHUB_TOKEN secret not set in Replit Secrets."
  exit 1
fi

git remote set-url origin https://x-access-token:${GITHUB_TOKEN}@github.com/edsindustries1/replit-readyzip.git

git add -A
git commit -m "Update: $(date '+%Y-%m-%d %H:%M')" 2>/dev/null || echo "Nothing new to commit"
git push origin main

# Remove token from remote URL after push (security)
git remote set-url origin https://github.com/edsindustries1/replit-readyzip.git

echo ""
echo "Done! Changes pushed to GitHub. Railway will auto-deploy now."
