#!/bin/bash
set -e

cd /home/mjensen/repos/llamactl

echo "Building llamactl..."
bun run build

echo "Installing binary to ~/.local/bin/llamactl..."
mkdir -p ~/.local/bin
cp llamactl ~/.local/bin/llamactl

echo "Verification:"
which llamactl
llamactl --version
