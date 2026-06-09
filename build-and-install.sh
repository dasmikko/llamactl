#!/bin/bash
set -e

cd /home/mjensen/repos/llamactl

echo "Building llamactl..."
bun build --compile --outfile llamactl src/index.ts

echo "Installing binary to ~/.local/bin/llamactl..."
mkdir -p ~/.local/bin
cp llamactl ~/.local/bin/llamactl

echo "Verification:"
which llamactl
llamactl --version
