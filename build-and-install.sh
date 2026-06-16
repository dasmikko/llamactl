#!/bin/bash
set -e

if command -v llamactl >/dev/null 2>&1; then
  echo "Stopping running daemon..."
  llamactl daemon stop || true
fi

echo "Building llamactl..."
bun run build

echo "Installing binary to ~/.local/bin/llamactl..."
mkdir -p ~/.local/bin
cp llamactl ~/.local/bin/llamactl

echo "Verification:"
which llamactl
llamactl --version
