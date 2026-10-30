# Apple Demo

The stock OID4VC demo ([`../demo`](../demo), taken from `main`) reduced to
**SD-JWT VC issuance**. Same issuer image, auth server and plugins; only the
frontend differs:

- **Issuance only.** The page opens on Issue Credential, the only page. No
  presentation, Credential Info or Reset Demo, and no progress log: the issue
  page shows the offer QR code with an **Open in wallet** deep link (the same
  `openid-credential-offer://` URI) below it, then "Credential Issued!".
- **SD-JWT VC only.** No JWT VC or mDL issuance, no mDL signing key and no
  credential refresh or Update Status page. Issued credentials still carry a
  status list entry.
- **Branded "Ontario Wallet Sandbox"** in place of the ACA-Py OpenID4VC Plugin
  and OpenID4VCI titles. The ID card has a card face,
  `frontend/card-art/id-card.jpg`, embedded in the issuer metadata as a
  `data:` URI. To change it, edit `card-art/id-card.html` and render it at
  1012x638, saved as a 760x479 JPEG.
- **Sign-in.** HTTP Basic for the whole frontend except `/webhook`, on when
  `DEMO_PORTAL_PASSWORD` is set.
- **New tenant per start.** Each frontend start creates a new issuer tenant: a
  new ACA-Py wallet, auth server tenant and signing DID. Credentials issued
  before stay in the wallet and stay valid; they belong to the previous tenant.
  Old tenants are not deleted.
- **Persistent data.** The issuer keeps its wallets in Postgres (as on
  OpenShift), and Postgres has a volume, so wallets, status lists and auth
  server data survive restarts.
- `entrypoint.sh` keeps an `AUTHSERVER_NGROK_URL` that is already set and only
  asks ngrok when it is empty, so the frontend runs without ngrok.

## Running locally

Build the issuer image as for [`../demo`](../demo), then:

```bash
cd oid4vc/apple_demo
cp .env.example .env   # fill in the tokens; set DEMO_PORTAL_PASSWORD to turn on sign-in
docker compose up --build
```

Open http://localhost:3002. ngrok is still used locally, with
[`../demo/ngrok.yml`](../demo/ngrok.yml). `docker compose down -v` also
removes the Postgres volume.

### Frontend settings

| Variable | Purpose |
|---|---|
| `DEMO_PORTAL_PASSWORD` | Turns on sign-in. Off when empty. |
| `DEMO_PORTAL_USER` | Sign-in user name; default `demo` |
| `AUTHSERVER_NGROK_URL` | Public URL of the auth server tenant API (port 9001). Set it when there is no ngrok. |
| `ADMIN_MANAGE_AUTH_TOKEN` | Auth server admin token |
| `TENANT_SECRET` | Client secret the issuer uses at the auth server. At least 32 characters. |
| `API_BASE_URL` | Issuer admin API; default `http://localhost:3001` |

## OpenShift (`qa-sandbox`)

Build from GitHub with the `ecp-issuing-service` template, as in
[`../openshift-changes/openshift-developer-guide.md`](../openshift-changes/openshift-developer-guide.md),
with the frontend build's context directory set to `oid4vc/apple_demo/frontend`.

The frontend calls the auth server at `http://auth-server:9000` (admin) and
`http://auth-server:9001` (tenant), so the auth server Service must be named
`auth-server`. The issuer sends webhooks to the URL in
`docker/default_openshift.yml` (`http://frontend:3002/webhook`); check it
matches the frontend Service.

**Environment.** There is no ngrok, so set the public URLs from the routes:

| Pod | Variable | Value |
|---|---|---|
| issuer | `OID4VCI_ENDPOINT` | `https://<issuer route>` |
| issuer | `STATUS_LIST_PUBLIC_URI` | `https://<issuer route>/tenant/{tenant_id}/status/{list_number}` |
| auth server | `TENANT_ISSUER_BASE_URL` | `https://<auth server route>` |
| frontend | `AUTHSERVER_NGROK_URL` | `https://<auth server route>` |
| frontend | `API_BASE_URL` | `http://<issuer service>:3001` |

**Secrets.** Create them in the namespace and load them with
`oc set env --from=secret/...`; never as plain env values:

```bash
oc -n qa-sandbox create secret generic frontend-portal-auth --from-literal=PASSWORD=...
oc -n qa-sandbox set env deploy/frontend --from=secret/frontend-portal-auth --prefix=DEMO_PORTAL_
```

Use new values for `ADMIN_MANAGE_AUTH_TOKEN`, `ADMIN_INTERNAL_AUTH_TOKEN`,
`TENANT_INTERNAL_AUTH_TOKEN` (same as the internal token) and `TENANT_SECRET`.

**Routes.** Edge TLS routes only for the frontend (3000), the issuer's OID4VCI
port (8082) and the auth server tenant port (9001). No routes for the issuer
admin port (3001, insecure mode) or the auth server admin port (9000).

**Volume.** Give Postgres a PersistentVolumeClaim mounted at
`/var/lib/postgresql/data`.
