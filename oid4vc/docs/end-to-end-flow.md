# X.509 SD-JWT VC - end-to-end API flow

Concrete request/response walkthrough for issuing an SD-JWT VC signed with an
`x5c` certificate chain, where the key lives in the ACA-Py wallet and the
certificate is issued by an external CA.

Design rationale and the PR breakdown are in [x.509-support.md](x.509-support.md).

Each step is marked **exists** or **proposed**. Proposed endpoints are part of
the PRs described in the design note.

Base URLs used below:

| name | value |
| --- | --- |
| admin API | `http://localhost:3001` |
| public OID4VCI | `https://issuer.example.gov.on.ca` |
| tenant subpath | `/tenant/{wallet_id}` when multitenant, empty otherwise |

---

## Step 1 - Create the signing key (exists)

No DID is created. The key is identified by its multikey.

```http
POST /wallet/keys
Content-Type: application/json

{
  "alg": "p256",
  "kid": "issuer-signing-2026"
}
```

```json
{
  "multikey": "zDnaeaqzTWBtkgYZFwMCAJQwR7rDVxJmbUJtNhnDD3YG3ysTb",
  "kid": "issuer-signing-2026"
}
```

`alg: p256` is required for `ES256`, which is what SD-JWT VC verifiers expect in
practice. The private key is generated inside the wallet and never leaves it.

Record the multikey - every later step refers to it.

---

## Step 2 - Produce a CSR (proposed)

```http
POST /wallet/keys/zDnaeaqzTWBtkgYZFwMCAJQwR7rDVxJmbUJtNhnDD3YG3ysTb/csr
Content-Type: application/json

{
  "subject": {
    "country": "CA",
    "state": "Ontario",
    "locality": "Toronto",
    "organization": "Example Issuing Authority",
    "organizational_unit": "Digital Credentials",
    "common_name": "issuer.example.gov.on.ca"
  }
}
```

```json
{
  "csr_pem": "-----BEGIN CERTIFICATE REQUEST-----\nMIIBXTCB...\n-----END CERTIFICATE REQUEST-----\n"
}
```

The CSR is self-signed through `wallet.sign_message`, which proves possession of
the private key without exporting it.

`common_name` should match the host of the `iss` URI you intend to use. The SAN
is what a verifier checks, and it is added by the CA in the next step.

---

## Step 3 - Sign the CSR externally (outside ACA-Py)

Submit the CSR to your CA. The SAN must cover the issuer URI.

```bash
cat > leaf.ext <<'EOF'
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature
extendedKeyUsage = clientAuth
subjectAltName = DNS:issuer.example.gov.on.ca
crlDistributionPoints = URI:https://pki.example.gov.on.ca/crl/issuer.crl
authorityInfoAccess = OCSP;URI:http://ocsp.pki.example.gov.on.ca
EOF

openssl x509 -req \
  -in issuer.csr \
  -CA root-ca.crt -CAkey root-ca.key -CAcreateserial \
  -out issuer-leaf.crt -days 825 -sha256 \
  -extfile leaf.ext
```

Assemble the chain, **leaf first**, then intermediates. Do not include the root.

```bash
cat issuer-leaf.crt intermediate-ca.crt > chain.pem
```

---

## Step 4 - Import the certificate onto the key (proposed)

```http
POST /wallet/keys/zDnaeaqzTWBtkgYZFwMCAJQwR7rDVxJmbUJtNhnDD3YG3ysTb/certificate
Content-Type: application/json

{
  "certificate_pem": "-----BEGIN CERTIFICATE-----\nMIICyDCC...\n-----END CERTIFICATE-----\n-----BEGIN CERTIFICATE-----\nMIICuTCC...\n-----END CERTIFICATE-----\n"
}
```

```json
{
  "multikey": "zDnaeaqzTWBtkgYZFwMCAJQwR7rDVxJmbUJtNhnDD3YG3ysTb",
  "certificate_pem": "-----BEGIN CERTIFICATE-----\nMIICyDCC...",
  "x5c": ["MIICyDCCAnGgAwIBAgIUJ...", "MIICuTCCAmGgAwIBAgIUK..."]
}
```

The endpoint must reject a certificate whose SubjectPublicKeyInfo does not match
the key. Expected failure:

```json
{ "message": "certificate SubjectPublicKeyInfo does not match the key" }
```

Verify the stored state:

```http
GET /wallet/keys/zDnaeaqzTWBtkgYZFwMCAJQwR7rDVxJmbUJtNhnDD3YG3ysTb
```

```json
{
  "multikey": "zDnaeaqzTWBtkgYZFwMCAJQwR7rDVxJmbUJtNhnDD3YG3ysTb",
  "kid": "issuer-signing-2026",
  "metadata": {
    "certificate_pem": "-----BEGIN CERTIFICATE-----\nMIICyDCC..."
  }
}
```

Returning `metadata` is the part of `GET /wallet/keys/{multikey}` that does not
exist today.

---

## Step 5 - Create the credential metadata (exists, plus one new field)

This defines the credential type: its `vct`, which claims are selectively
disclosable, how wallets should display it, and - new - which key signs it.

```http
POST /oid4vci/credential-supported/create/sd-jwt
Content-Type: application/json

{
  "format": "vc+sd-jwt",
  "identifier": "ExampleIDCard",
  "vct": "https://issuer.example.gov.on.ca/credentials/id-card/v1",

  "signing_multikey": "zDnaeaqzTWBtkgYZFwMCAJQwR7rDVxJmbUJtNhnDD3YG3ysTb",
  "iss": "https://issuer.example.gov.on.ca",

  "cryptographic_binding_methods_supported": ["jwk"],
  "credential_signing_alg_values_supported": ["ES256"],
  "proof_types_supported": {
    "jwt": { "proof_signing_alg_values_supported": ["ES256"] }
  },

  "sd_list": [
    "/given_name",
    "/family_name",
    "/birth_date",
    "/age_is_over_18",
    "/age_is_over_21"
  ],

  "credential_metadata": {
    "display": [
      {
        "name": "Example ID Card",
        "locale": "en-CA",
        "background_color": "#12107c",
        "text_color": "#FFFFFF"
      }
    ],
    "claims": [
      { "path": ["given_name"],
        "display": [{ "name": "Given Name", "locale": "en-CA" }] },
      { "path": ["family_name"],
        "display": [{ "name": "Family Name", "locale": "en-CA" }] },
      { "path": ["birth_date"],
        "display": [{ "name": "Date of Birth", "locale": "en-CA" }] },
      { "path": ["age_is_over_18"],
        "display": [{ "name": "Age 18 or Over", "locale": "en-CA" }] },
      { "path": ["age_is_over_21"],
        "display": [{ "name": "Age 21 or Over", "locale": "en-CA" }] }
    ]
  }
}
```

```json
{ "supported_cred_id": "da50e244-a11f-49e4-855d-6f8b2f24ee94" }
```

Notes on the fields that matter for X.509:

| field | why |
| --- | --- |
| `signing_multikey` | **new.** Resolves the key *and* its certificate. Replaces the current `vc_additional_data.x5c_cert_chain` lookup. |
| `iss` | **new.** Issuer identity. Must be a URI whose host matches the SAN in the leaf certificate. |
| `credential_signing_alg_values_supported` | must match the key algorithm - `ES256` for `p256` |
| `sd_list` | JSON pointers to claims that become selectively disclosable |
| `vct` | credential type identifier; a URL is conventional but any string is legal |

`cryptographic_binding_methods_supported: ["jwk"]` refers to the **holder** key
binding, not the issuer. It is unrelated to `x5c`.

### Issuer metadata (exists)

Only needed when using an external authorization server:

```http
PUT /oid4vci/issuer/configuration
Content-Type: application/json

{
  "authorization_servers": [
    {
      "public_url": "https://auth.example.gov.on.ca/tenants/{wallet_id}",
      "private_url": "http://auth-server:9001/tenants/{wallet_id}",
      "auth_type": "client_secret_basic",
      "client_credentials": {
        "client_id": "client1",
        "client_secret": "<at least 32 characters>"
      }
    }
  ]
}
```

---

## Step 6 - Issue the credential (exists)

Six exchanges. The first two are driven by your application; the remaining four
are performed by the wallet against the public OID4VCI endpoints.

### 6.1 Create the exchange record (admin API)

Holds the subject claims for one specific credential.

```http
POST /oid4vci/exchange/create
Content-Type: application/json

{
  "supported_cred_id": "da50e244-a11f-49e4-855d-6f8b2f24ee94",
  "credential_subject": {
    "given_name": "Sally",
    "family_name": "Sparrow",
    "birth_date": "1990-04-13",
    "age_is_over_18": true,
    "age_is_over_21": true
  }
}
```

```json
{
  "exchange_id": "9b2f1c74-0f3a-4a9e-9d1c-2a7f6b5e8c10",
  "state": "created",
  "supported_cred_id": "da50e244-a11f-49e4-855d-6f8b2f24ee94"
}
```

With `signing_multikey` on the supported credential, `did` and
`verification_method` are no longer required here. They remain accepted for the
`kid` flow.

Add `"pin": "1234"` for a transaction code.

### 6.2 Get the credential offer (admin API)

```http
GET /oid4vci/credential-offer?exchange_id=9b2f1c74-0f3a-4a9e-9d1c-2a7f6b5e8c10&user_pin_required=false
```

```json
{
  "credential_offer": "openid-credential-offer://?credential_offer=%7B%22credential_issuer%22%3A%22https%3A%2F%2Fissuer.example.gov.on.ca%2Ftenant%2F...%22%2C%22credential_configuration_ids%22%3A%5B%22ExampleIDCard%22%5D%2C%22grants%22%3A%7B%22urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Apre-authorized_code%22%3A%7B%22pre-authorized_code%22%3A%22...%22%7D%7D%7D"
}
```

Large offers are returned as `credential_offer_uri` instead, which the wallet
dereferences. Handle both:

```js
const qr = offer.credential_offer ?? offer.credential_offer_uri;
```

Render it as a QR code.

### 6.3 Wallet fetches issuer metadata (public)

```http
GET /.well-known/openid-credential-issuer/tenant/{wallet_id}
```

Returns `credential_issuer`, `credential_endpoint`, `nonce_endpoint`,
`credential_configurations_supported` (built from step 5), and the authorization
server list.

### 6.4 Wallet exchanges the pre-authorized code for a token

Against the external authorization server when configured, otherwise the
issuer's own `/token`:

```http
POST /tenant/{wallet_id}/token
Content-Type: application/x-www-form-urlencoded

grant_type=urn:ietf:params:oauth:grant-type:pre-authorized_code
&pre-authorized_code=...
```

```json
{ "access_token": "...", "token_type": "Bearer", "expires_in": 300 }
```

`token_type` is `DPoP` when DPoP is enabled. With DPoP disabled, OID4VCI 13.10
caps bearer token lifetime at 5 minutes.

### 6.5 Wallet requests a nonce

```http
POST /tenant/{wallet_id}/nonce
```

```json
{ "c_nonce": "a1b2c3...", "c_nonce_expires_in": 300 }
```

The wallet signs this nonce with its **holder** key to produce the proof.

### 6.6 Wallet requests the credential

```http
POST /tenant/{wallet_id}/credential
Authorization: Bearer <access_token>
Content-Type: application/json

{
  "credential_identifier": "ExampleIDCard",
  "proof": { "proof_type": "jwt", "jwt": "eyJ0eXAiOiJvcGVuaWQ0dmNpLXByb29mK2p3dCI..." }
}
```

```json
{ "credential": "eyJ0eXAiOiAidmMrc2Qtand0IiwgIng1YyI6IFsiTUlJQ3lEQ0NBbkdnQXdJQkFnSVVKLi4uIl0sICJhbGciOiAiRVMyNTYifQ.eyJfc2QiOiBbIjh..." }
```

This is the point where the X.509 work shows up. Decoded header:

```json
{
  "typ": "vc+sd-jwt",
  "alg": "ES256",
  "x5c": [
    "MIICyDCCAnGgAwIBAgIUJ...",
    "MIICuTCCAmGgAwIBAgIUK..."
  ]
}
```

No `kid` - `x5c` and `kid` are mutually exclusive per RFC 7515 4.1.

Decoded payload:

```json
{
  "_sd": ["8NaEOlLFfJ57NfJJF0nH6zHyylW5al93s6AqNGdEL40", "..."],
  "_sd_alg": "sha-256",
  "vct": "https://issuer.example.gov.on.ca/credentials/id-card/v1",
  "iss": "https://issuer.example.gov.on.ca",
  "iat": 1790704634,
  "exp": 1822240634,
  "cnf": { "jwk": { "kty": "EC", "crv": "P-256", "x": "...", "y": "..." } }
}
```

`iss` is now an HTTPS URI matching the certificate SAN, not a DID. The
disclosures follow the JWT, separated by `~`.

### 6.7 Webhooks (optional)

If `--webhook-url` is configured, `topic/oid4vci` fires on state change. The
terminal state is:

```json
{ "exchange_id": "9b2f1c74-...", "state": "issued" }
```

### 6.8 Verify what was issued

```http
GET /oid4vci/exchange/records?exchange_id=9b2f1c74-0f3a-4a9e-9d1c-2a7f6b5e8c10
```

Decode the header to confirm `x5c` is present and `kid` is absent:

```bash
echo "$SD_JWT" | cut -d. -f1 | base64 -d | jq
```

Confirm the embedded certificate matches the one you imported:

```bash
echo "$SD_JWT" | cut -d. -f1 | base64 -d \
  | jq -r '.x5c[0]' | base64 -d \
  | openssl x509 -inform DER -noout -subject -issuer -ext subjectAltName
```

Confirm the chain validates to your root:

```bash
openssl verify -CAfile root-ca.crt -untrusted intermediate-ca.crt issuer-leaf.crt
```

---

## Step 7 - Register trust anchors on verifiers (proposed)

```http
POST /oid4vc/trust-anchors
Content-Type: application/json

{
  "certificate_pem": "-----BEGIN CERTIFICATE-----\nMIIDxTCC...\n-----END CERTIFICATE-----\n",
  "purpose": "issuer_ca",
  "label": "Example Issuing Authority Root CA"
}
```

```json
{ "trust_anchor_id": "7f3e...", "purpose": "issuer_ca" }
```

Until this exists, `x5c` verification extracts the public key from the presented
certificate without validating the chain, which means any self-signed
certificate is accepted. See section 5 of the design note.

---

## Quick reference

| Step | Method | Path | Status |
| --- | --- | --- | --- |
| 1 | POST | `/wallet/keys` | exists |
| 2 | POST | `/wallet/keys/{multikey}/csr` | proposed |
| 3 | - | external CA | - |
| 4 | POST | `/wallet/keys/{multikey}/certificate` | proposed |
| 4 | GET | `/wallet/keys/{multikey}` | exists, extend with metadata |
| 5 | POST | `/oid4vci/credential-supported/create/sd-jwt` | exists, add `signing_multikey` + `iss` |
| 5 | PUT | `/oid4vci/issuer/configuration` | exists |
| 6.1 | POST | `/oid4vci/exchange/create` | exists |
| 6.2 | GET | `/oid4vci/credential-offer` | exists |
| 6.3 | GET | `/.well-known/openid-credential-issuer{subpath}` | exists |
| 6.4 | POST | `{subpath}/token` | exists |
| 6.5 | POST | `{subpath}/nonce` | exists |
| 6.6 | POST | `{subpath}/credential` | exists |
| 7 | POST | `/oid4vc/trust-anchors` | proposed |

---

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `certificate SubjectPublicKeyInfo does not match the key` | chain imported onto the wrong multikey |
| Header still carries `kid` | `signing_multikey` not set on the supported credential, or no certificate imported |
| Verifier rejects the issuer | `iss` host does not match the certificate SAN |
| `Unable to determine JWT signing alg` | key algorithm is not `p256` or `ed25519` |
| Wallet rejects the chain | root not installed as a trust anchor, or intermediates omitted |
| Chain order errors | leaf must come first; the root must not be included |
