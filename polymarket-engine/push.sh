#!/bin/bash
# Push Polymarket Engine to https://github.com/tufantoktar/learning_git
#
# Default (safest): pushes to a new branch 'polymarket-engine'
# Your existing master/feature/cloudchamp branches are untouched.
#
# Usage:
#   ./push.sh              # SSH push to polymarket-engine branch (RECOMMENDED)
#   ./push.sh https        # HTTPS push (will ask for username + PAT)
#   ./push.sh ssh master   # SSH push and force-overwrite master (DANGEROUS)

set -e

USERNAME="tufantoktar"
REPO="learning_git"

# Parse args
PROTO="${1:-ssh}"
BRANCH="${2:-polymarket-engine}"

if [ "$PROTO" = "ssh" ]; then
  REMOTE_URL="git@github.com:$USERNAME/$REPO.git"
  AUTH_HINT="(uses your existing SSH key — no password needed)"
else
  REMOTE_URL="https://github.com/$USERNAME/$REPO.git"
  AUTH_HINT="(username=$USERNAME, password=your PAT with 'repo' scope)"
fi

echo "=== Polymarket Engine → GitHub ==="
echo "Target : $REMOTE_URL"
echo "Branch : $BRANCH"
echo "Auth   : $AUTH_HINT"
echo ""

# Warn on dangerous force-push to existing branches
if [ "$BRANCH" = "master" ] || [ "$BRANCH" = "main" ] || [ "$BRANCH" = "feature" ] || [ "$BRANCH" = "cloudchamp" ]; then
  echo "⚠️  WARNING: '$BRANCH' is an existing branch in your repo."
  echo "   This script will force-push and OVERWRITE it."
  echo "   Recommended: rerun without the branch arg to push to 'polymarket-engine' instead."
  echo ""
  read -p "Force-overwrite '$BRANCH'? (y/N) " confirm
  if [ "$confirm" != "y" ] && [ "$confirm" != "Y" ]; then
    echo "Cancelled."; exit 0
  fi
  FORCE="-f"
else
  FORCE=""
fi

# Ensure git identity is set
git config user.name  > /dev/null 2>&1 || git config user.name  "$USERNAME"
git config user.email > /dev/null 2>&1 || git config user.email "$USERNAME@users.noreply.github.com"

# Point remote
git remote remove origin 2>/dev/null || true
git remote add origin "$REMOTE_URL"

# Local branch to push from = current HEAD (main), push to $BRANCH on remote
echo "Pushing..."
git push -u $FORCE origin "HEAD:$BRANCH"

echo ""
echo "=== Done ==="
echo "View: https://github.com/$USERNAME/$REPO/tree/$BRANCH"
