#!/bin/sh
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
clang++ -std=c++17 -O2 -Wall -Wextra \
  -o native/host-macos native/host_mac.cpp \
  -framework ApplicationServices -framework Carbon
echo "Built: $ROOT/native/host-macos"
