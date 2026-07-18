#!/usr/bin/env bash
set -uo pipefail

mkdir -p /logs/verifier
if bun test /tests/verify.ts; then
  printf '1\n' > /logs/verifier/reward.txt
  exit 0
fi
printf '0\n' > /logs/verifier/reward.txt
exit 1
