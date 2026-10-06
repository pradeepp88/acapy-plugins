# X.509 SD-JWT VC - end-to-end API flow

Concrete request/response walkthrough for issuing an SD-JWT VC signed with an
`x5c` certificate chain, where the key lives in the ACA-Py wallet and the
certificate is issued by an external CA.

Design rationale and the PR breakdown are in [x.509-support.md](x.509-support.md).

Each step is marked **exists** or **proposed**. Proposed endpoints are part of
the PRs described in the design note.

**The multikey REST API shape below is provisional** and depends on Ivan's
design for the certificate operations. Paths and payloads may change; the flow
and the data they carry should not.

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

The CSR is signed with the private key it describes, which is how the requestor
proves control of that key. Here that signature is produced through
`wallet.sign_message`, so the key never leaves the wallet.

`common_name` should match the host of the `iss` URI you intend to use. The SAN
is what a verifier checks, and the CA sets it when issuing the certificate.

---

## Step 3 - Obtain a certificate from the CA

A CSR is a request for a CA to issue a certificate. The CA does not sign the
CSR itself: it validates the request, then issues a **new certificate**
containing the requestor's public key, signed by the CA's key.

This step is always outside ACA-Py, and outside the holder's control by
definition.

Submit the CSR to your CA. The SAN must cover the issuer URI.

The commands below stand in for the CA, for local testing only.

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

The example is an Ontario **Private Security Guard Licence**, issued under the
*Private Security and Investigative Services Act, 2005*, with a holder photo and
bilingual (English / French) display.

```http
POST /oid4vci/credential-supported/create/sd-jwt
Content-Type: application/json

{
  "format": "vc+sd-jwt",
  "identifier": "SecurityGuardLicence",
  "vct": "https://issuer.example.gov.on.ca/credentials/security-guard-licence/v1",

  "signing_key": "zDnaeaqzTWBtkgYZFwMCAJQwR7rDVxJmbUJtNhnDD3YG3ysTb",
  "iss": "https://issuer.example.gov.on.ca",

  "cryptographic_binding_methods_supported": ["jwk"],
  "credential_signing_alg_values_supported": ["ES256"],
  "proof_types_supported": {
    "jwt": { "proof_signing_alg_values_supported": ["ES256"] }
  },

  "sd_list": [
    "/given_name",
    "/family_name",
    "/licence_number",
    "/licence_class",
    "/expiry_date",
    "/portrait"
  ],

  "credential_metadata": {
    "display": [
      {
        "name": "Security Guard Licence",
        "locale": "en-CA",
        "background_color": "#1A1A1A",
        "text_color": "#FFFFFF",
        "background_image": {
          "uri": "https://issuer.example.gov.on.ca/assets/licence-bg-en.png",
          "alt_text": "Security guard licence background"
        }
      },
      {
        "name": "Permis d'agent de securite",
        "locale": "fr-CA",
        "background_color": "#1A1A1A",
        "text_color": "#FFFFFF",
        "background_image": {
          "uri": "https://issuer.example.gov.on.ca/assets/licence-bg-fr.png",
          "alt_text": "Arriere-plan du permis d'agent de securite"
        }
      }
    ],
    "claims": [
      {
        "path": ["given_name"],
        "display": [
          { "name": "Given Name", "locale": "en-CA" },
          { "name": "Prenom", "locale": "fr-CA" }
        ]
      },
      {
        "path": ["family_name"],
        "display": [
          { "name": "Family Name", "locale": "en-CA" },
          { "name": "Nom", "locale": "fr-CA" }
        ]
      },
      {
        "path": ["licence_class"],
        "display": [
          { "name": "Class", "locale": "en-CA" },
          { "name": "Categorie", "locale": "fr-CA" }
        ]
      },
      {
        "path": ["licence_number"],
        "display": [
          { "name": "Licence Number", "locale": "en-CA" },
          { "name": "Numero de permis", "locale": "fr-CA" }
        ]
      },
      {
        "path": ["expiry_date"],
        "display": [
          { "name": "Expires", "locale": "en-CA" },
          { "name": "Date d'expiration", "locale": "fr-CA" }
        ]
      },
      {
        "path": ["portrait"],
        "display": [
          { "name": "Photo", "locale": "en-CA" },
          { "name": "Photo", "locale": "fr-CA" }
        ]
      }
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
| `signing_key` | **new.** Multikey of the signing key. Resolves the key *and* its certificate. Replaces the current `vc_additional_data.x5c_cert_chain` lookup. |
| `iss` | **new.** Issuer identity. Must be a URI whose host matches the SAN in the leaf certificate. |
| `credential_signing_alg_values_supported` | must match the key algorithm - `ES256` for `p256` |
| `sd_list` | JSON pointers to claims that become selectively disclosable |
| `vct` | credential type identifier; a URL is conventional but any string is legal |

`cryptographic_binding_methods_supported: ["jwk"]` refers to the **holder** key
binding, not the issuer. It is unrelated to `x5c`.

### Branding

The `background_image` carries the card artwork, including any issuer logo, so a
separate `logo` entry is not used. Supply one image per locale when the artwork
contains text.

### Open question - issuer identification as a claim

An `issuing_authority` claim is deliberately **not** included. The issuer is
already identified cryptographically by `iss` and the certificate chain, so
restating it as a claim risks two sources of truth that can disagree.

Whether the authority should appear as a claim at all - and if so whether it
belongs in the credential, in governance, or in policy - needs discussion before
it is added.

### Language handling

Each entry in `display` and in `claims[].display` is selected by `locale`. A
wallet picks the entry matching the user's locale and falls back to the first
entry when there is no match, so **list the preferred default first**.

Two things to decide deliberately:

- `vct` is a type identifier, not display text. It stays a single value and is
  never localised.
- Claim **names** (`given_name`, `licence_class`) are identifiers and stay in
  English. Only the `display[].name` labels are translated. Translating claim
  keys breaks selective disclosure, because `sd_list` pointers and verifier
  queries both address claims by key.

Claim **values** that are themselves language-dependent - `licence_class` is
"Individual Security Guard" in English and "Agent de securite individuel" in
French - cannot be localised through `display`. Either pick a canonical code
such as `INDIVIDUAL_SECURITY_GUARD` and let the wallet render it, or carry both
values as separate claims. The first is preferable.

### Photo

`portrait` carries a base64-encoded JPEG. Keep it small: it is embedded in the
credential and, as a selectively disclosable claim, it also inflates the
disclosure array.

A 200x250 portrait at moderate JPEG quality is roughly 15-25 KB, which becomes
about 20-34 KB once base64-encoded. That is already the largest part of the
credential, and QR-code offers have practical size limits - another reason the
offer carries only a `credential_offer_uri` reference rather than the credential
itself.

Making `portrait` selectively disclosable matters: a licence check needs the
photo, while proving "I hold a valid licence" to an online service does not.

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
    "given_name": "Nicholas",
    "family_name": "Claus",
    "licence_number": "11548728",
    "licence_class": "INDIVIDUAL_SECURITY_GUARD",
    "expiry_date": "2028-09-18",
    "portrait": "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/..."
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

`expiry_date` is the licence expiry shown to the holder. It is a claim, not the
credential's own `exp` - those are independent and can legitimately differ.

`portrait` is raw base64 JPEG with no `data:` prefix. Strip any prefix before
submitting.

With `signing_key` on the supported credential, `did` and
`verification_method` are no longer required here. They remain accepted for the
`kid` flow.

Add `"pin": "1234"` for a transaction code.

### 6.2 Get the credential offer (admin API)

```http
GET /oid4vci/credential-offer?exchange_id=9b2f1c74-0f3a-4a9e-9d1c-2a7f6b5e8c10&user_pin_required=false
```

```json
{
  "credential_offer": "openid-credential-offer://?credential_offer=%7B%22credential_issuer%22%3A%22https%3A%2F%2Fissuer.example.gov.on.ca%2Ftenant%2F...%22%2C%22credential_configuration_ids%22%3A%5B%22SecurityGuardLicence%22%5D%2C%22grants%22%3A%7B%22urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Apre-authorized_code%22%3A%7B%22pre-authorized_code%22%3A%22...%22%7D%7D%7D"
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
  "credential_identifier": "SecurityGuardLicence",
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
  "vct": "https://issuer.example.gov.on.ca/credentials/security-guard-licence/v1",
  "iss": "https://issuer.example.gov.on.ca",
  "iat": 1790704634,
  "exp": 1853776634,
  "cnf": { "jwk": { "kty": "EC", "crv": "P-256", "x": "...", "y": "..." } }
}
```

`iss` is now an HTTPS URI matching the certificate SAN, not a DID.

Every claim in `sd_list` has been replaced by a digest in `_sd`. The disclosures
follow the JWT, separated by `~`:

```
<issuer-signed-jwt>~<disclosure-given_name>~<disclosure-family_name>~...
```

Each disclosure is base64url of `[salt, claim_name, claim_value]`. The
`portrait` disclosure is by far the largest.

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

## Out of scope - verification

Verification is **not part of this flow**. The steps above cover issuance only:
producing a key, obtaining a certificate for it, and issuing credentials whose
`x5c` header carries that certificate.

How verification is handled - trust anchor distribution, chain validation, and
whether the plugin acts as a verifier at all - is still to be determined. It is
discussed in section 5 of the design note, but no design is settled and nothing
here should be read as committing to one.

Worth knowing while that is open: `x5c` verification today extracts the public
key from the presented certificate without validating the chain, so a
self-signed certificate is accepted. That affects anyone relying on the plugin
to verify, not this issuance flow.

---

## Quick reference

| Step | Method | Path | Status |
| --- | --- | --- | --- |
| 1 | POST | `/wallet/keys` | exists |
| 2 | POST | `/wallet/keys/{multikey}/csr` | proposed |
| 3 | - | external CA | - |
| 4 | POST | `/wallet/keys/{multikey}/certificate` | proposed |
| 4 | GET | `/wallet/keys/{multikey}` | exists, extend with metadata |
| 5 | POST | `/oid4vci/credential-supported/create/sd-jwt` | exists, add `signing_key` + `iss` |
| 5 | PUT | `/oid4vci/issuer/configuration` | exists |
| 6.1 | POST | `/oid4vci/exchange/create` | exists |
| 6.2 | GET | `/oid4vci/credential-offer` | exists |
| 6.3 | GET | `/.well-known/openid-credential-issuer{subpath}` | exists |
| 6.4 | POST | `{subpath}/token` | exists |
| 6.5 | POST | `{subpath}/nonce` | exists |
| 6.6 | POST | `{subpath}/credential` | exists |

---

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `certificate SubjectPublicKeyInfo does not match the key` | chain imported onto the wrong multikey |
| Header still carries `kid` | `signing_key` not set on the supported credential, or no certificate imported |
| Verifier rejects the issuer | `iss` host does not match the certificate SAN |
| `Unable to determine JWT signing alg` | key algorithm is not `p256` or `ed25519` |
| Wallet rejects the chain | root not installed as a trust anchor, or intermediates omitted |
| Chain order errors | leaf must come first; the root must not be included |
