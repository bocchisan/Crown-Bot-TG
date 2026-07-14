#!/usr/bin/env bash
# B2 headless verification (docs/build-plan.md B2): deploys the subscription
# canister on a local replica (from its own repository, path convention of
# the platform) and drives the mini app's flow code with file keypairs
# against devnet. The browser-wallet half of the checklist stays manual —
# see scripts/b2-checklist.md.
#
# Usage: scripts/b2-devnet.sh
set -euo pipefail
cd "$(dirname "$0")/.."

GAME=${GAME:-../Crown-Games/Subscription}

echo "== deploy the subscription canister on a local replica"
(cd "$GAME" && dfx stop >/dev/null 2>&1 || true)
(cd "$GAME" && dfx start --clean --background)
trap '(cd "$GAME" && dfx stop >/dev/null 2>&1) || true' EXIT
(cd "$GAME" && dfx deploy subscription)
SUB=$(cd "$GAME" && dfx canister id subscription)
PORT=$(cd "$GAME" && dfx info webserver-port)

SUBSCRIPTION_CANISTER="$SUB" IC_HOST="http://127.0.0.1:$PORT" \
    npx tsx scripts/b2-headless.ts
