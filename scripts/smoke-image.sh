#!/usr/bin/env bash
#
# Copyright 2026 IOG.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
#
# Proves that an image of the service runs as a deployment would. It
# starts the image with a throwaway configuration against a stand-in
# provider that lists no UTxOs at the sponsor address, and expects the
# health route to answer 200 within thirty seconds, as the nonroot user
# under tini. It then starts the image against a provider nothing
# listens at, and expects the service to stop with its own startup error,
# which is what a deployment with a wrong provider address sees. Last it
# checks that the working tree's .env and data never entered the image.
# The account script hash is read off the blueprint the image ships, by
# the image's own copy of the library, so the smoke follows the contract
# build without carrying its hash; the mnemonic is the test suite's,
# which holds nothing on any network.
#
# Usage: scripts/smoke-image.sh IMAGE

set -euo pipefail

image="${1:?usage: scripts/smoke-image.sh IMAGE}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
run="sponsor-smoke-$$"
network="${run}-network"
provider="${run}-provider"
service="${run}-service"
stub_image="node:22-bookworm-slim"

cleanup() {
  docker rm --force "$provider" "$service" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
}
trap cleanup EXIT

fail() {
  echo "smoke: $*" >&2
  docker logs "$service" >&2 2>&1 || true
  exit 1
}

mnemonic="$(sed -n "s/^export const TEST_MNEMONIC = '\(.*\)';$/\1/p" "$root/test/support/service.ts")"
[ -n "$mnemonic" ] || fail "the test mnemonic was not found in test/support/service.ts"

account_script_hash="$(docker run --rm --interactive --entrypoint node "$image" - <<'HASH'
const { readFileSync } = require('node:fs');
const Cometa = require('@biglup/cometa');
Cometa.ready().then(() => {
  const { validators } = JSON.parse(readFileSync('contract/plutus.json', 'utf8'));
  const account = validators.find((validator) => validator.title.startsWith('account.account.'));
  console.log(Cometa.computeScriptHash({ type: Cometa.ScriptType.Plutus, bytes: account.compiledCode, version: Cometa.PlutusLanguageVersion.V3 }));
});
HASH
)"
[[ "$account_script_hash" =~ ^[0-9a-f]{56}$ ]] || fail "the image did not hash its blueprint: $account_script_hash"
echo "smoke: the shipped blueprint's account proxy hashes to $account_script_hash"

# Starts the service with the throwaway configuration, reading the chain
# through the provider at the given URL, on a host port of docker's choice.
start_service() {
  docker run --detach --name "$service" --network "$network" --publish "127.0.0.1::8787" \
    --env BLOCKFROST_PREPROD_PROJECT_ID=smoke \
    --env SPONSOR_MNEMONIC="$mnemonic" \
    --env ACCOUNT_SCRIPT_HASH="$account_script_hash" \
    --env ADMIN_API_KEY=smoke \
    --env PROVIDER_BASE_URL="$1" \
    "$image" >/dev/null
}

docker network create "$network" >/dev/null
docker run --detach --name "$provider" --network "$network" "$stub_image" \
  node -e "require('node:http').createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end('[]'); }).listen(8080)" >/dev/null
start_service "http://${provider}:8080"

status=""
body=""
for _ in $(seq 1 30); do
  address="$(docker port "$service" 8787 2>/dev/null | head -n 1 || true)"
  if [ -n "$address" ]; then
    body="$(curl --silent --show-error --output /dev/stdout --write-out '\n%{http_code}' "http://${address}/health" 2>/dev/null || true)"
    status="${body##*$'\n'}"
    body="${body%$'\n'*}"
    [ "$status" = 200 ] && break
  fi
  sleep 1
done
[ "$status" = 200 ] || fail "GET /health answered ${status:-nothing} within thirty seconds"
case "$body" in
  *'"ok":true'*) ;;
  *) fail "GET /health answered 200 without ok: $body" ;;
esac
echo "smoke: GET /health answered $status $body"

uid="$(docker exec "$service" id -u)"
[ "$uid" = 60000 ] || fail "the service runs as uid $uid, not as nonroot"
init="$(docker exec "$service" sh -c "tr '\\0' ' ' < /proc/1/cmdline")"
case "$init" in
  *tini*) ;;
  *) fail "process 1 is not tini: $init" ;;
esac
echo "smoke: the service runs as uid $uid under $init"
docker rm --force "$service" >/dev/null

start_service "http://127.0.0.1:9"
for _ in $(seq 1 30); do
  [ "$(docker inspect --format '{{.State.Status}}' "$service")" = exited ] && break
  sleep 1
done
[ "$(docker inspect --format '{{.State.Status}}' "$service")" = exited ] || fail "the service kept running without a reachable provider"
code="$(docker inspect --format '{{.State.ExitCode}}' "$service")"
[ "$code" = 1 ] || fail "the service stopped with exit code $code, not 1, without a reachable provider"
logs="$(docker logs "$service" 2>&1)"
case "$logs" in
  *'Fee sponsor service failed to start'*) ;;
  *) fail "the service stopped without its startup error: $logs" ;;
esac
echo "smoke: without a reachable provider the service stopped with exit code $code: $logs"
docker rm --force "$service" >/dev/null

docker run --rm --entrypoint sh "$image" -c 'test ! -e /app/.env && test ! -e /app/data' || fail "the image carries the working tree's .env or data"
echo "smoke: the image carries no .env and no data directory"
