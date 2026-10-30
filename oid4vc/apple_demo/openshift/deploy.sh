#!/bin/bash
# Deploys the Ontario Wallet Sandbox (oid4vc/apple_demo) to an OpenShift
# namespace, building all three images from this checkout. Run it again to
# apply changes and rebuild. Needs `oc login` first.
#
#   ./deploy.sh <namespace> [frontend-host]
#
# frontend-host defaults to <namespace>.<apps domain>.
set -euo pipefail

NS=${1:?usage: deploy.sh <namespace> [frontend-host]}
APPS_DOMAIN=${APPS_DOMAIN:-apps.xkh544cb.canadacentral.aroapp.io}
FRONTEND_HOST=${2:-$NS.$APPS_DOMAIN}
ISSUER_HOST=sandbox-issuer-oid4vc-$NS.$APPS_DOMAIN
AUTH_SERVER_HOST=sandbox-authserver-tenant-$NS.$APPS_DOMAIN

HERE=$(cd "$(dirname "$0")" && pwd)
OID4VC=$(cd "$HERE/../.." && pwd)

oc get project "$NS" -o name >/dev/null

# Secrets: new random values, created once and kept on later runs.
if ! oc -n "$NS" get secret apple-demo-tokens >/dev/null 2>&1; then
  internal=$(openssl rand -hex 24)
  oc -n "$NS" create secret generic apple-demo-tokens \
    --from-literal=ADMIN_MANAGE_AUTH_TOKEN="$(openssl rand -hex 24)" \
    --from-literal=ADMIN_INTERNAL_AUTH_TOKEN="$internal" \
    --from-literal=TENANT_INTERNAL_AUTH_TOKEN="$internal" \
    --from-literal=TENANT_SECRET="$(openssl rand -hex 24)"
fi
if ! oc -n "$NS" get secret frontend-portal-auth >/dev/null 2>&1; then
  oc -n "$NS" create secret generic frontend-portal-auth \
    --from-literal=DEMO_PORTAL_USER=demo \
    --from-literal=DEMO_PORTAL_PASSWORD="$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-16)"
fi

oc process -f "$HERE/apple-demo-template.json" \
  -p FRONTEND_HOST="$FRONTEND_HOST" -p ISSUER_HOST="$ISSUER_HOST" -p AUTH_SERVER_HOST="$AUTH_SERVER_HOST" \
  | oc -n "$NS" apply -f -

# Build contexts: only what each Dockerfile copies, never .env files or caches.
CTX=$(mktemp -d)
trap 'rm -rf "$CTX"' EXIT
EXCLUDES=(--exclude __pycache__ --exclude .venv --exclude .env --exclude '*.pyc' --exclude .pytest_cache)
mkdir -p "$CTX/issuer/docker" "$CTX/auth-server" "$CTX/frontend"
(cd "$OID4VC" && rsync -a "${EXCLUDES[@]}" jwt_vc_json mso_mdoc sd_jwt_vc oid4vc pyproject.toml poetry.lock README.md "$CTX/issuer/")
cp "$OID4VC/docker/Dockerfile.oid4vc.openshift" "$OID4VC/docker/default_openshift.yml" "$CTX/issuer/docker/"
rsync -a "${EXCLUDES[@]}" --exclude tests "$OID4VC/auth_server/" "$CTX/auth-server/"
rsync -a "${EXCLUDES[@]}" "$OID4VC/apple_demo/frontend/" "$CTX/frontend/"

# Each build rolls out its deployment when it finishes (image triggers).
oc -n "$NS" start-build issuing-service-build --from-dir="$CTX/issuer" --wait &
oc -n "$NS" start-build auth-server-build --from-dir="$CTX/auth-server" --wait &
oc -n "$NS" start-build frontend-build --from-dir="$CTX/frontend" --wait &
wait

for d in postgres-db auth-server issuing-service frontend; do
  oc -n "$NS" rollout status "deploy/$d" --timeout=300s
done

echo
echo "Demo:        https://$FRONTEND_HOST  (user demo)"
echo "Password:    oc -n $NS extract secret/frontend-portal-auth --keys=DEMO_PORTAL_PASSWORD --to=-"
echo "Issuer:      https://$ISSUER_HOST"
echo "Auth server: https://$AUTH_SERVER_HOST"
