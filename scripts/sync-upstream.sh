#!/usr/bin/env bash
set -e

echo "🔄 Fetching latest updates from upstream/lovable..."
git fetch upstream lovable

CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$CURRENT_BRANCH" != "main" ]; then
  echo "Switching to main branch..."
  git checkout main
fi

echo "🔀 Merging upstream/lovable into main..."
if git merge upstream/lovable -m "chore(sync): auto-merge updates from lovable" --no-edit; then
  echo "✅ Merge completed cleanly!"
else
  echo "⚠️ Merging produced conflicts. Automatically preserving iOS standalone configurations..."
  # Always preserve standalone iOS files
  git checkout HEAD -- src/App.tsx capacitor.config.ts package.json .github/ ios/ 2>/dev/null || true
  git add .
  git commit -m "chore(sync): merge updates from lovable, preserving iOS standalone configs" || true
fi

echo "🚀 Pushing synced main to origin..."
git push origin main

echo "🎉 Done! Standalone Agent Ops repo is 100% up to date with lovable."
