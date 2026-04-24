#!/bin/bash
# One-time push of the committed Cloakify removal (commit 11fb806)
# Run from Replit Shell: bash push-now.sh

echo "Pushing to stephenharris6442-beep/replit-final (Railway)..."
git remote set-url origin https://x-access-token:${STEPHENHARRIS_GITHUB_PERSONAL_ACCESS_TOKEN}@github.com/stephenharris6442-beep/replit-final.git
git push origin main
git remote set-url origin https://github.com/stephenharris6442-beep/replit-final.git

echo ""
echo "Pushing to edsindustries1/replit-readyzip (backup)..."
git remote set-url backup https://x-access-token:${GITHUB_TOKEN}@github.com/edsindustries1/replit-readyzip.git 2>/dev/null || \
git remote add backup https://x-access-token:${GITHUB_TOKEN}@github.com/edsindustries1/replit-readyzip.git
git push backup main
git remote set-url backup https://github.com/edsindustries1/replit-readyzip.git 2>/dev/null

echo ""
echo "Done! Railway will auto-deploy the Cloakify-free version."
