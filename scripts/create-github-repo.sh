#!/usr/bin/env bash
set -euo pipefail

REPO_NAME="${1:-Hermes-IDE}"
DESCRIPTION="VS Code/Cursor extension to chat with Hermes Agent from an IDE panel, with selected code and pasted/dropped file support."

cd "$(dirname "$0")/.."

if ! command -v gh >/dev/null 2>&1; then
  echo "GitHub CLI (gh) is not installed. Install it first: https://cli.github.com/" >&2
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "You are not authenticated with GitHub. Run: gh auth login" >&2
  exit 1
fi

git branch -M main

gh repo create "$REPO_NAME" \
  --public \
  --description "$DESCRIPTION" \
  --source . \
  --remote origin \
  --push

gh repo edit "$REPO_NAME" \
  --enable-issues=true \
  --enable-wiki=false \
  --add-topic hermes-agent,vscode,cursor,ai-agent,developer-tools,typescript

echo "Repository created and pushed:"
gh repo view "$REPO_NAME" --web
