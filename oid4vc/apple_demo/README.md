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

See [`openshift/README.md`](openshift/README.md): a template and a
`deploy.sh` that set up the demo in a namespace and build the images from this
checkout.

```bash
oc login ...
./openshift/deploy.sh qa-sandbox
```
