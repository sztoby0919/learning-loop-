#!/usr/bin/env bash
# Preserve the original project layout through the shared Node packager.
set -euo pipefail
TASK_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$TASK_ROOT"
exec node scripts/package.mjs "$@"
