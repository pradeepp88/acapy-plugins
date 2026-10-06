# X.509 support for SD-JWT VC

Design note for signing SD-JWT VCs with an `x5c` certificate chain, where the
private key is generated and held in the ACA-Py wallet and the certificate is
issued by a CA outside ACA-Py.

**Status: proposal.** Sections marked *exists* are present in the codebase
today; sections marked *to build* are not.

The certificate is attached to a wallet key via its **multikey** identifier.
No DID is involved.

---

## 1. Goal

- Key pair generated inside the ACA-Py wallet. The private key never leaves it.
- Public key exported in a CSR, signed by a root/intermediate CA operated
  outside ACA-Py.
- Resulting chain embedded in the issued SD-JWT as the `x5c` JOSE header
  instead of `kid`.
- Verifiers validate the chain against a trust anchor they already hold.

No HSM involved. The wallet is the key store.

---

## 2. Why the certificate lives on the key

The certificate is attached to a **wallet key**, identified by its multikey. No
DID is involved at any point.

A certificate is a property of a key, not of a DID. Binding it to a DID would
mean minting a `did:jwk` purely as a container for a key that is then identified
by its certificate - incoherent when the point of `x5c` is to *not* use DIDs for
issuer identity.

This also keeps `iss` and key lookup independent from the start. The issuer
identity is a URI set on the supported credential; the signing key is found by
multikey. Nothing needs to be disentangled.

The same mechanism serves both sd-jwt and mdoc.

**Scope note: this covers issuance only.** Verification is unsafe today and is
unaffected by the work below. See section 5.

---

## 3. Implementation

Three pull requests: one to ACA-Py core, two to oid4vc.

### 3.1 Prerequisite - the key metadata gap

`MultikeyManager` discards key metadata. The wallet layer supports it fully:

```python
KeyInfo(verkey=verkey, metadata=metadata, key_type=key_type, kid=kid)
```

```python
await self._session.handle.insert_key(
    verkey, keypair, metadata=json.dumps(metadata), tags=tags,
)
```

But `acapy_agent/wallet/keys/manager.py` contains **no reference to metadata at
all**. `create()` neither accepts nor forwards it, and `from_multikey()` /
`from_kid()` return only `{kid, multikey}`:

```python
async def create(self, seed: str = None, kid: str = None, alg: str = DEFAULT_ALG):
    key_info = await self.wallet.create_key(key_type=key_type, seed=seed, kid=kid)
    return {"kid": key_info.kid, "multikey": ...}
```

So metadata is writable by Askar but unreachable through the multikey
endpoints. Nothing else in approach A works until this is plumbed through.

### 3.2 PR 1 - ACA-Py core endpoints

Following the shape of the existing `/wallet/keys` routes:

```http
POST /wallet/keys/{multikey}/csr
{ "subject": { "organization": "Example Issuer", "country": "CA",
               "common_name": "issuer.example.gov.on.ca" } }

200 { "csr_pem": "-----BEGIN CERTIFICATE REQUEST-----..." }
```

```http
POST /wallet/keys/{multikey}/certificate
{ "certificate_pem": "-----BEGIN CERTIFICATE-----..." }

200 { "multikey": "zDna...", "certificate_pem": "...", "x5c": ["MIIB..."] }
```

```http
GET /wallet/keys/{multikey}

200 { "multikey": "zDna...", "kid": "...",
      "metadata": { "certificate_pem": "..." } }
```

`GET` already exists but `FetchKeyResponseSchema` cannot express metadata today.

Two behaviours to specify:

- **Import must verify** that the certificate's SubjectPublicKeyInfo matches the
  key. `kmslite`'s `assert_cert_matches_verkey` is the reference implementation.
  Without this check an unrelated certificate can be bound, and the mistake only
  surfaces when verifiers reject the credentials.
- **Store PEM, derive `x5c` on read.** PEM is the interchange format;
  base64-DER is a JOSE encoding detail. Storing both invites drift.

The CSR is signed through `wallet.sign_message`, which proves possession without
exporting the private key. `sign_message` is abstract on `BaseWallet` upstream
and implemented by the Askar and Kanon wallets, so no signing changes are
needed.

### 3.3 PR 2 - oid4vc

No new endpoints. A reference field on the supported credential:

```http
POST /oid4vci/credential-supported/create/sd-jwt
{
  "format": "vc+sd-jwt",
  "vct": "ExampleIDCard",
  "signing_multikey": "zDna...",
  "iss": "https://issuer.example.gov.on.ca"
}
```

At issuance the processor resolves the multikey, reads the certificate from key
metadata, derives `x5c`, and signs. This replaces:

```python
x5c_chain = (supported.vc_additional_data or {}).get("x5c_cert_chain")
```

The same mechanism serves mdoc, which is why the PR is scoped to "sd-jwt or
mdoc".

### 3.4 End-to-end flow

**1. Create the key** - no DID involved.

```http
POST /wallet/keys
{ "alg": "p256", "kid": "issuer-signing-2026" }

200 { "multikey": "zDna...", "kid": "issuer-signing-2026" }
```

**2. Produce a CSR.**

```http
POST /wallet/keys/zDna.../csr
{ "subject": { "organization": "Example Issuer", "country": "CA" } }
```

**3. Sign the CSR externally.** Out of scope for ACA-Py. Submit to the CA,
receive the leaf, assemble the chain (leaf first, then intermediates).

**4. Import the chain** back onto the key.

```http
POST /wallet/keys/zDna.../certificate
{ "certificate_pem": "-----BEGIN CERTIFICATE-----..." }
```

**5. Reference the key** from the supported credential (`signing_multikey`), and
set `iss` to the URI matching the certificate SAN.

**6. Issue** - unchanged.

```http
POST /oid4vci/exchange/create
GET  /oid4vci/credential-offer?exchange_id=...
```

The issued SD-JWT carries `x5c` and omits `kid`.

**7. Verifiers register the root** as a trust anchor (section 5 - not yet built).

---

## 4. What already exists

### Signing with `x5c` (exists)

`oid4vc/jwt.py::jwt_sign` accepts an `x5c_chain` argument and swaps the key
identification header:

```python
if x5c_chain:
    headers = {**headers, "x5c": x5c_chain}
elif "x5c" not in headers:
    headers = {**headers, "kid": verification_method}
```

The private key is still resolved from the wallet via `did` /
`verification_method`. The certificate only identifies the key to the verifier.

### SD-JWT already honours a configured chain (exists)

`sd_jwt_vc/cred_processor.py`:

```python
x5c_chain = (supported.vc_additional_data or {}).get("x5c_cert_chain")
headers = (
    {"x5c": x5c_chain}
    if x5c_chain
    else {"kid": ex_record.verification_method}
)
```

So issuance with `x5c` is a configuration problem, not a code problem - the
chain simply has to be present on the `SupportedCredential`.

### CSR building from a wallet key (exists, in `kmslite`)

`kmslite/v1_0/x509.py` contains a `cryptography` adapter that signs through the
wallet:

```python
class WalletBackedPrivateKey(EllipticCurvePrivateKey):
    """EllipticCurvePrivateKey adapter that signs via `wallet.sign_message`."""
```

It imports only `cryptography` and stock ACA-Py wallet modules - no
`SignerRegistry`, no PKCS#11 - so it works with an ordinary wallet key and can
be ported into `oid4vc` as-is.

`sign_message` is an abstract method on `BaseWallet` upstream, implemented by
the Askar and Kanon wallets. **No ACA-Py core change is required.**

### Uploading an externally issued chain (exists, VP-scoped)

`POST /oid4vp/x509-identity` already accepts an external PEM chain and performs
the PEM to base64-DER conversion that `x5c` requires:

```python
pem: str = body["cert_chain_pem"]
verification_method: str = body["verification_method"]
client_id: str = body["client_id"]

b64_certs: List[str] = [
    re.sub(r"\s+", "", cert)
    for cert in re.findall(
        r"-----BEGIN CERTIFICATE-----(.*?)-----END CERTIFICATE-----", pem, re.DOTALL
    )
]
```

It stores a single record (`OID4VP.x509_identity`) pairing the chain with the
wallet key that signs and a `client_id` identity. That is already the right
shape; it is just scoped to OID4VP and not consulted during issuance. Its
PEM-to-base64-DER parsing is directly reusable by the core import endpoint.

---

### `iss` and SAN binding

`iss` is set explicitly on the supported credential, independent of the signing
key, so no code needs to disentangle them. One question remains open.

**Open question:** SD-JWT VC is expected to require that, when the issuer is
identified by an X.509 certificate, `iss` is a URI whose host matches a SAN in
the leaf certificate. Confirm the exact wording in the current
draft-ietf-oauth-sd-jwt-vc before implementing, since it determines whether SAN
binding is mandatory or advisory, and therefore whether the import endpoint
should reject a certificate whose SAN does not cover the intended `iss`.

---

## 5. The gap - verification is unsafe

`oid4vc/jwt.py::jwt_verify`:

```python
elif "x5c" in headers:
    key = key_from_x5c(headers["x5c"])
```

`key_from_x5c` takes `x5c[0]`, extracts the public key, and returns it. It does
**not** build or validate the chain, check it against a trust anchor, check
validity dates, or check revocation.

Consequence: anyone can self-sign a certificate, place it in `x5c`, sign with
the matching key, and verification succeeds. As implemented, `x5c` on the
SD-JWT path provides no trust.

Compare `mso_mdoc`, which does this properly and **fails closed**:

> No trust anchors configured; credential verification requires at least one
> trust anchor.

Required: a trust anchor store plus chain validation in the `x5c` branch, with
the same fail-closed behaviour.

---

## 6. Trust anchors

### Do not import from `mso_mdoc`

`mso_mdoc/trust_anchor.py` is dependency-free in itself (only `BaseRecord` and
`marshmallow`), but `mso_mdoc/__init__.py` imports the mdoc credential
processor, which pulls in `isomdl_uniffi`. That wheel has no linux/aarch64
build, so any import from that package fails on ARM hosts.

Add `oid4vc/oid4vc/trust_anchor.py` instead - roughly 30 lines, modelled on
`TrustAnchorRecord`:

- keep `RECORD_TYPE = "trust_anchor"` so records stay mutually readable
- set `RECORD_TOPIC = "oid4vc"`
- drop `doctype` from `TAG_NAMES`; it is an mdoc concept. Keep `purpose`.

### Publishing the root

The certificate chain travels inside the JWT header, so nothing needs to be
fetched at verification time. What must be distributed is the **root**.

Publishing it at a stable HTTPS URL - the way an IACA root is published for
mDL - is a reasonable distribution mechanism, but it is onboarding, not trust.
An operator downloads it once, checks the fingerprint out of band, and installs
it. A verifier that fetches a root at verification time based on something in
the credential gains nothing, because a forged chain would point at the
attacker's root.

mDL solves runtime trust with a signed list (VICAL, ISO 18013-5) or a scheme
trust list. SD-JWT VC has no equivalent, so trust anchor distribution is
ecosystem-defined.

Practical recommendations:

- serve DER (`.cer`) and PEM at a stable, versioned path
- publish the SHA-256 fingerprint somewhere independent of that URL
- include CRL distribution points and AIA/OCSP in the issued leaf certificates
- plan rollover with two valid roots during the overlap window

Note that IACA certificates carry ISO 18013-5-specific extensions. Those are
mdoc requirements; for SD-JWT a plain CA certificate profile is what is wanted.
Same distribution pattern, different certificate profile.

---

## 7. Route summary

### Existing

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/wallet/keys` | create a wallet key, returns multikey |
| GET | `/wallet/keys/{multikey}` | fetch key info, **does not return metadata** |
| PUT | `/wallet/keys` | bind / unbind a `kid` |
| POST | `/oid4vp/x509-identity` | VP-side chain upload, PEM to base64 DER |
| POST | `/oid4vci/credential-supported/create/sd-jwt` | supported credential config |
| POST | `/oid4vci/exchange/create` | issuance |
| GET | `/oid4vci/credential-offer` | offer / QR |
| PUT | `/oid4vci/issuer/configuration` | issuer metadata |

### Proposed - ACA-Py core (PR 1)

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/wallet/keys/{multikey}/csr` | CSR for a wallet-held key |
| POST | `/wallet/keys/{multikey}/certificate` | import externally issued chain |
| GET | `/wallet/keys/{multikey}` | extend to return key metadata |

### Proposed - oid4vc (PR 3, verification)

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/oid4vc/trust-anchors` | register a trusted CA |
| GET | `/oid4vc/trust-anchors` | list |
| DELETE | `/oid4vc/trust-anchors/{id}` | remove |

PR 2 (oid4vc issuance) adds no routes - only a `signing_multikey` field on the
supported credential.

---

## 8. Files touched

### ACA-Py core (PR 1)

| File | Change |
| --- | --- |
| `acapy_agent/wallet/keys/manager.py` | plumb metadata through `create` / `from_multikey` / `from_kid` |
| `acapy_agent/wallet/keys/routes.py` | add CSR + certificate import routes; return metadata from `GET` |
| `acapy_agent/wallet/x509.py` | new - CSR building and cert/key matching |

### oid4vc (PR 2 - issuance)

| File | Change |
| --- | --- |
| `oid4vc/oid4vc/models/supported_cred.py` | add `signing_multikey` |
| `oid4vc/sd_jwt_vc/cred_processor.py` | resolve cert via multikey, derive `x5c` |
| `oid4vc/mso_mdoc/cred_processor.py` | same mechanism for mdoc |

### oid4vc (PR 3 - verification)

| File | Change |
| --- | --- |
| `oid4vc/oid4vc/trust_anchor.py` | new - `TrustAnchorRecord` |
| `oid4vc/oid4vc/routes/trust_anchor.py` | new - trust anchor CRUD |
| `oid4vc/oid4vc/jwt.py` | validate the chain in the `x5c` branch, fail closed |

`cryptography = "<51.0.0"` is already a non-optional dependency of `oid4vc`, and
ACA-Py core already depends on `cryptography`. No new third-party packages.

The CSR builder can be adapted from `kmslite/v1_0/x509.py`, which imports only
`cryptography` and stock ACA-Py wallet modules:

- `WalletBackedPrivateKey` - signs through `wallet.sign_message`
- `build_csr(wallet, verkey, key_type, subject)`
- `assert_cert_matches_verkey(cert_pem, verkey, key_type)`

---

## 9. Alternative worth weighing

If verifiers are online and you control the issuer domain, SD-JWT VC's other
issuer key mechanism is simpler: publish a JWKS under the `iss` URI
(`/.well-known/jwt-vc-issuer/...`) and keep using `kid`. Trust then comes from
HTTPS and the issuer URI, with no trust anchor distribution and no PKI to
operate.

Choose `x5c` when verification must work offline, or when an existing PKI or
trust list has to be reused. Choose JWKS otherwise. Both are standard; `x5c`
buys offline verification at the cost of a trust anchor distribution problem
and the verifier-side work in section 5.
