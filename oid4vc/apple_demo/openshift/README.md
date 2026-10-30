# Deploying to OpenShift

[`apple-demo-template.json`](apple-demo-template.json) and
[`deploy.sh`](deploy.sh) set up the Ontario Wallet Sandbox in one namespace, as
running in `qa-sandbox`. The template is the shared `ecp-issuing-service`
template with these changes:

| Change | Why |
|---|---|
| Builds take local uploads (`oc start-build --from-dir`), with no triggers | Images are built from this checkout; a push to GitHub never redeploys the demo |
| The issuer runs `aca-py start --arg-file /usr/src/app/default_openshift.yml` from its image | The shared template clones a Git branch at every pod start |
| No routes for the issuer admin API (3001) or the auth server admin API (9000) | The issuer admin API runs in insecure mode; only the frontend, the issuer's OID4VCI port and the auth server tenant port are public |
| Tokens and the portal password come from Secrets (`apple-demo-tokens`, `frontend-portal-auth`), not ConfigMaps | New random values per namespace |
| Postgres keeps its data on a 1Gi volume claim (`postgres-data`, `managed-premium`) | Wallets, tenants and status lists survive restarts |
| The frontend route's timeout is 10 minutes | The issue page keeps an event stream open while the wallet scans |
| The frontend build's context is `oid4vc/apple_demo/frontend` | This demo, not the stock one |

## Deploy

```bash
oc login --token=... --server=https://api.xkh544cb.canadacentral.aroapp.io:6443
cd oid4vc/apple_demo/openshift
./deploy.sh qa-sandbox
```

`deploy.sh <namespace> [frontend-host]`:

1. creates the two Secrets with new random values (only when they don't exist yet)
2. applies the template; the route hosts are:
   - frontend: `<frontend-host>`, default `<namespace>.apps.xkh544cb.canadacentral.aroapp.io`
   - issuer: `sandbox-issuer-oid4vc-<namespace>.<apps domain>`
   - auth server: `sandbox-authserver-tenant-<namespace>.<apps domain>`
3. uploads the issuer, auth server and frontend sources from this checkout and builds them on the cluster
4. waits for the rollouts and prints the URLs

Set `APPS_DOMAIN` for another cluster. Run the script again to apply changes
and rebuild.

The images come from the **working tree**, uncommitted changes included. The
issuer image also installs the ACA-Py fork set in
`docker/Dockerfile.oid4vc.openshift` (`ACAPY_REPO` / `ACAPY_REF`).

To rebuild only the frontend after a change:

```bash
oc -n qa-sandbox start-build frontend-build --from-dir=oid4vc/apple_demo/frontend --wait
```

## Sign-in password

```bash
oc -n qa-sandbox extract secret/frontend-portal-auth --keys=DEMO_PORTAL_PASSWORD --to=-
```

To change it, edit the Secret, then `oc -n qa-sandbox rollout restart deploy/frontend`.

## Notes

- Each frontend start creates a new issuer tenant. Credentials issued before
  stay valid; old tenants are not deleted.
- Postgres is only reachable inside the namespace and uses the template's
  `postgres` password, as the local compose file does.
- To remove the demo (the volume claim too, so all data is lost):

  ```bash
  oc process -f apple-demo-template.json -p FRONTEND_HOST=x -p ISSUER_HOST=x -p AUTH_SERVER_HOST=x -o name \
    | xargs oc -n qa-sandbox delete
  oc -n qa-sandbox delete secret apple-demo-tokens frontend-portal-auth
  ```
