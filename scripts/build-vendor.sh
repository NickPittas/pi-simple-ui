#!/bin/sh
set -eu

# Build library dependencies and assets; the app runs the separately installed Pi CLI.
for package in chord tui telemetry codemode mcp; do
  npm --prefix "vendor/pi/packages/$package" run build
done
npm --prefix vendor/pi/packages/ai run build:offline
for package in durable agent protocol client server; do
  npm --prefix "vendor/pi/packages/$package" run build
done
npm --prefix vendor/pi/packages/coding-agent run build:unbundled
