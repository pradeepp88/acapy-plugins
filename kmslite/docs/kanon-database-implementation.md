# Kanon database implementation - findings

Notes gathered while running the kmslite + oid4vc demo (`kmslite/demo`) on the
`kanon-anoncreds` wallet type with PostgreSQL. Every claim here was verified
against a live stack or against source in the local ACA-Py checkout.

ACA-Py version: 1.6.0 (local checkout, branch `kmslite`).

**Multitenancy stance:** this deployment uses the default `basic` manager, which
gives each tenant its own database pair. That is what the Kanon documentation's
own multitenant example uses, and it suits a use case that wants per-tenant
database separation anyway. `single-wallet-kanon` is undocumented and currently
non-functional; its defects are recorded in section 7 and do not apply here.

---

## 1. Kanon is a dual-store backend

Unlike `askar` / `askar-anoncreds`, which use a single Askar store, Kanon splits
persistence across two independent stores held together by `KanonOpenStore`:

| store | holds | class |
| --- | --- | --- |
| `db_store` | records | `DBStore` |
| `askar_store` | key material | Askar `Store` |

`KanonAnonCredsProfileSession` exposes both:

| accessor | backing field | used for |
| --- | --- | --- |
| `session.handle` | `_dbstore_handle` | records |
| `session.askar_handle` | `_askar_handle` | keys |

Two consequences that repeatedly caused bugs:

- `KanonAnonCredsProfile.store` returns **only** `opened.db_store`. Anything
  that needs the Askar store must go through `profile.opened.askar_store`.
- `session.handle` is a `DBStoreSession`, **not** an Askar session. Code written
  against Askar that calls `session.handle.insert_key(...)` raises
  `AttributeError` on Kanon.

Both stores are opened with the same `profile_id`:

```python
self._dbstore_opener = profile.opened.db_store.session(profile.profile_id)
self._askar_opener = profile.opened.askar_store.session(profile.profile_id)
```

Registration name and manager:

```
"kanon-anoncreds": "acapy_agent.kanon.profile_anon_kanon.KanonAnonProfileManager"
```

Source lives in `acapy_agent/kanon/` (`profile_anon_kanon.py`, `store_kanon.py`).

---

## 2. Physical layout in PostgreSQL

Each logical store becomes **two databases**:

| logical store | Askar database | DBStore database |
| --- | --- | --- |
| `issuer` | `issuer` | `issuer_dbstore` |
| `multitenant_sub_wallet` | `multitenant_sub_wallet` | `multitenant_sub_wallet_dbstore` |

The `_dbstore` suffix is appended automatically.

### Schema name

Tables are **not** in `public`. They land in a schema named after the connecting
role - with `account: postgres` that schema is literally called `postgres`.

This is the single biggest stumbling block when inspecting the data:

- `psql` finds tables anyway, because `search_path` is `"$user", public` and
  `$user` resolves to `postgres`.
- GUI clients that default to `public` show an apparently empty database.

To browse in DBeaver: connect to a real database (not the default `postgres`,
which is empty), then enable **Show all databases** and **Show all schemas**, and
expand `Schemas -> postgres -> Tables`.

### Table counts

| database | tables | contents |
| --- | --- | --- |
| Askar side | 4 | `config`, `profiles`, `items`, `items_tags` |
| DBStore side | 34 | `config`, `profiles`, `items`, `items_tags` + typed tables |

---

## 3. The normalized DBStore schema

With `ACAPY_DBSTORE_SCHEMA_CONFIG=normalize`, release `release_0_1` defines
**20 known categories plus a `default`**:

```
anoncreds_cred_ex_v20, connection, connection_invitation, connection_metadata,
connection_request, cred_def_sent, cred_ex_v20, credential, credential_def,
did, did_doc, did_key, issuer_cred_rev, oob_record, pres_ex_v20,
revocation_list, revocation_reg_def, schema, schema_sent, transaction
```

Known categories get typed, queryable tables suffixed with the release version,
for example `did_v0_1`, `connection_v0_1`, `cred_ex_v20_v0_1`.

Unknown categories are **not an error**. Dispatch falls through silently:

```python
handler = handlers.get(category, handlers["default"])
```

The default handler writes to the generic `items` / `items_tags` pair. This is
why every plugin category - `oid4vci`, `supported_cred`, `status-list-def`,
`status-list-shard`, `issuer_configuration`, `nonce` - is stored untyped. Kanon
has no knowledge of plugin schemas, so plugin data is functional but not
normalized.

`did` is the interesting case: it appears **both** as an `items` row and as a
`did_v0_1` projection, with a foreign key back to the item.

### Useful queries

```sql
-- what categories exist, and under which profile
SELECT p.name AS profile, i.category, count(*)
FROM postgres.items i
JOIN postgres.profiles p ON p.id = i.profile_id
GROUP BY 1, 2 ORDER BY 1, 2;

-- read an untyped plugin record
SELECT i.category, i.name, convert_from(i.value, 'UTF8')::json
FROM postgres.items i
WHERE i.category = 'status-list-def';

-- searchable tags live in a side table
SELECT i.category, t.name AS tag, t.value
FROM postgres.items i
JOIN postgres.items_tags t ON t.item_id = i.id;
```

---

## 4. Encryption asymmetry

| store | encrypted | inspectable in SQL |
| --- | --- | --- |
| Askar | yes - category, name, value and tags are ciphertext | no |
| DBStore | no - plaintext | yes |

An Askar row looks like this, which is easy to mistake for corruption:

```
category | \x71503c8fd69bc60c1423d2f1998e3bed4f991d91197d45f0...
name     | \x7860677c9830850d1ed3a8926fea9e6c75d2e36acd9963c6...
```

Practical effect: correlation work must be done from the DBStore side. The Askar
store can only be read through the Askar API.

---

## 5. Configuration

Kanon needs two independent storage configurations:

```yaml
# Askar (keys)
ACAPY_WALLET_STORAGE_TYPE: postgres
ACAPY_WALLET_STORAGE_CONFIG: '{"url":"db:5432","max_connections":10,"min_idle_count":2}'
ACAPY_WALLET_STORAGE_CREDS: '{"account":"postgres","password":"postgres"}'

# DBStore (records)
ACAPY_DBSTORE_STORAGE_TYPE: postgres
ACAPY_DBSTORE_STORAGE_CONFIG: '{"url":"db:5432","connection_timeout":30.0,"max_connections":10,"min_idle_count":2}'
ACAPY_DBSTORE_STORAGE_CREDS: '{"account":"postgres","password":"postgres"}'
ACAPY_DBSTORE_SCHEMA_CONFIG: normalize
```

**These must be environment variables, not compose `command:` arguments.** A
folded YAML scalar is shell-split, which strips the inner double quotes from the
JSON and produces:

```
json.decoder.JSONDecodeError: Expecting property name enclosed in double quotes: line 1 column 2
```

---

## 6. Multitenancy

ACA-Py offers three multitenant managers:

| `multitenant.wallet_type` | manager | tenant isolation |
| --- | --- | --- |
| `basic` (default) | `MultitenantManager` | one database pair per tenant |
| `single-wallet-askar` | `SingleWalletAskarMultitenantManager` | Askar profiles, not Kanon-compatible |
| `single-wallet-kanon` | `SingleWalletKanonMultitenantManager` | Kanon profiles in one shared store |

**Use `basic`.** It is the default, it is what the Kanon documentation's own
multitenant example uses, and it is the only mode verified working end to end
here. `docs/features/KanonStorage.md` shows:

```bash
--wallet-type kanon-anoncreds \
--multitenant \
--multitenant-admin \
--jwt-secret secret
```

with no `--multitenancy-config` at all. `single-wallet-kanon` is registered in
`ProfileManagerProvider.MANAGER_TYPES` but appears nowhere in the Kanon
documentation, and is non-functional (section 7).

### How `basic` behaves

Each tenant gets its own `wallet_config` call and therefore its own pair of
databases, named after the tenant's wallet name:

```
tenant-<uuid>           <- Askar, keys
tenant-<uuid>_dbstore   <- DBStore, records
```

`MultitenantManager` is Kanon-aware and returns the right profile class:

```python
if profile.context.settings.get(WALLET_TYPE_KEY) == "kanon-anoncreds":
    return KanonAnonCredsProfile(profile.opened, profile.context)
```

Note it constructs the profile with **no** `profile_id`. Each store has only its
default profile, so there is no profile-scoping to get wrong - which is exactly
why the defects in section 7 cannot occur here.

### Creating a tenant

`basic` requires each tenant to supply its own name and key on
`POST /multitenancy/wallet`:

```json
{
  "label": "Alice",
  "wallet_name": "tenant-<unique>",
  "wallet_key": "<per-tenant key>",
  "key_management_mode": "managed"
}
```

Omitting `wallet_key` fails at store creation with:

```
Error opening Askar store. Key derivation password not provided.
```

Omitting `wallet_name` is worse: it is not rejected, but the tenant store can
collide with the base agent's own store. Always supply a unique name.

Do **not** send `wallet_type`. The subwallet must match the base wallet, and
ACA-Py defaults it to the base type:

```python
sub_wallet_type = body.get("wallet_type", base_wallet_type)
```

Hardcoding `"askar"` against a `kanon-anoncreds` base wallet is a common demo
bug and produces confusing downstream failures.

### Operational consequences

- A tenant is a database pair, so tenant count drives database count. Plan for
  connection-pool sizing accordingly.
- Reusing a wallet name raises `WalletAlreadyExistsError`. Demos that recreate a
  tenant on every boot should generate a fresh name, at the cost of accumulating
  databases.
- Tenant data is isolated by database, not by a `profile_id` column, so
  cross-tenant queries are impossible by construction.

---

## 7. `single-wallet-kanon` defects (not used here)

Recorded for completeness and for upstream reporting. **None of this affects a
`basic` deployment.** All three defects are in
`SingleWalletKanonMultitenantManager`, which `basic` never loads.

In this mode all tenants share one pair of databases and are separated by Kanon
**profiles** - rows in the `profiles` table, with `items.profile_id` as the
discriminator.

### Bug 1 - wrong sub-wallet type (fixed)

`sub_wallet_settings` hardcoded `"wallet.type": "askar"` while the method
returns a `KanonAnonCredsProfile`. The `cast()` immediately below is a typing
construct with no runtime effect, so nothing caught the mismatch:

```
AttributeError: 'AskarOpenStore' object has no attribute 'db_store'
```

Fix: set `"wallet.type": "kanon-anoncreds"`.

### Bug 2 - profile created in only one store (fixed)

Tenant provisioning called `create_profile` on `self._multitenant_profile.store`,
which is only the DBStore. The Askar store never learned about the tenant, and
opening a session failed:

```
Profile not found
```

That string appears nowhere in ACA-Py's Python - it comes from the aries-askar
native library, which is the clue that the Askar store is the one missing the
profile. Fix: create the profile in both stores.

```python
await self._multitenant_profile.opened.db_store.create_profile(wallet_record.wallet_id)
await self._multitenant_profile.opened.askar_store.create_profile(wallet_record.wallet_id)
```

### Bug 3 - plugin records escape tenant scoping (CONFIRMED, not fixed)

Confirmed by experiment: the failure is caused by profile topology, not by the
status list query. See "Confirming experiment" below.

Observed in a live run:

| profile | categories |
| --- | --- |
| `<tenant-uuid>` | `config`, `did` |
| `multitenant_sub_wallet` (base) | `status-list-*`, `oid4vci`, `supported_cred`, `issuer_configuration`, `nonce` |

Wallet-level writes are tenant-scoped; plugin record writes land in the shared
base profile. The visible symptom is a 500 on the tenant-scoped public status
list endpoint, because the read looks in the tenant profile and finds nothing:

```
GET /tenant/<wallet_id>/status/0  ->  500
shards = await StatusListShard.query(session, tag_filter, limit=1)
definition_id = shards[0].definition_id   # IndexError: list index out of range
```

Implications beyond the status list: with more than one tenant, all plugin data
would share a single namespace. This is a tenant isolation defect, not merely a
status list defect.

Ruled out so far:

- Not a session-level inconsistency. `KanonAnonCredsProfileSession` passes the
  same `profile_id` to both stores.
- Not missing `@tenant_authentication`. `status_list` has none, but oid4vc's
  `supported_credential.py` and `issuer_config.py` do have it and their records
  still land in the base profile.
- Not caused by the did:key change. The stored definition holds correct
  `issuer_did` and `verification_method` values.

**Important counter-evidence - the mechanism is still not fully explained.**
`POST /tenant/<id>/credential` and `GET /tenant/<id>/status/0` are served by the
same middleware in `oid4vci_server.py`, which builds one
`AdminRequestContext(profile=wallet_profile, root_profile=self.profile)`. The
credential request returned 200 while reading `oid4vci` and `supported_cred`
records that are stored under the base profile.

### Located: two sessions per request, the write uses the base one

Instrumenting `KanonAnonCredsProfileSession.__init__` and
`PostgresSession._setup_session` shows that a single tenant-authenticated admin
request opens **both** a tenant-scoped and a base-scoped DBStore session against
the same multitenant store:

```
PUT /oid4vci/issuer/configuration
  profile='4b37c2e6-a9e9-4d2d-88af-8b05f1758af4' -> profile_id=3   tenant
  profile='multitenant_sub_wallet'               -> profile_id=1   base
```

The resulting `issuer_configuration` row lands under `profile_id=1`, timestamped
inside that request (`18:06:47.799353`, response logged at `18:06:47,801`), so
this is not stale data from an earlier run.

What this rules out:

- `SingleWalletKanonMultitenantManager.get_wallet_profile` is correct. It
  returns `KanonAnonCredsProfile(..., profile_id=wallet_record.wallet_id)`.
- `DBStore.session(profile)` is correct. The profile propagates through
  `DBOpenSession._open` to `effective_profile = profile or self.default_profile`.
- `PostgresSession._get_profile_id` is correct. It resolves the tenant name to
  the right id (`-> profile_id=3`).
- The generic handler is correct. Its INSERT uses the `profile_id` it is given.

Every layer honours the profile it receives. The defect is that a base-profile
session is *created and used at all* for a tenant-scoped write. The remaining
question is which caller opens a session on the manager's shared
`_multitenant_profile` rather than on the per-tenant profile returned by
`get_wallet_profile`.

Why `did` is unaffected: `did` is one of the 20 normalized categories, and that
write path is tenant-scoped. Every plugin category falls to the generic handler
and is written through the base-profile session.

### Confirming experiment

Switching only the multitenancy manager, with no code change:

| `multitenant.wallet_type` | store topology | `GET /tenant/<id>/status/0` |
| --- | --- | --- |
| `single-wallet-kanon` | one store, many profiles | 500, `IndexError` |
| `basic` | one store per tenant, single profile | **200** |

The shard query, its tag filter and the stored records are identical in both
runs. Only the profile topology differs. That isolates the fault to profile
scoping rather than to the status list query, and confirms `basic` is unaffected.

The remaining unknown is which caller opens a session on the manager's shared
`_multitenant_profile` rather than on the per-tenant profile returned by
`get_wallet_profile`. That is where a fix should start.

### If you must run `single-wallet-kanon`

Options, in order of preference:

1. Don't - use `basic`.
2. Drop `--plugin status_list.v1_0`. `StatusHandler` degrades to a no-op, so
   credentials are issued without a `status` claim and the endpoint is never
   called. Loses revocation, and only hides this particular symptom; every other
   plugin category is still written to the shared base profile.
3. Single tenant, which removes profiles entirely.

Secondary defect: `shards[0]` should raise a 404, not an `IndexError` surfaced
as a 500.

---

## 8. Writing plugins that work on Kanon

The recurring failure is assuming an Askar session. Two variants were found and
fixed in this workspace.

### Real dependency on the Askar key handle

Any code calling `insert_key` needs the Askar handle, not `session.handle`:

```python
def askar_key_handle(session):
    """Return the Askar session handle that holds key material.

    Kanon splits storage: `session.handle` is the record store (DBStore) and
    keys live on `askar_handle`. Plain Askar exposes only `handle`.
    """
    handle = getattr(session, "askar_handle", None) or getattr(session, "handle", None)
    if handle is None:
        raise ValueError("Profile session does not expose Askar key storage")
    return handle
```

This pattern is backward compatible: on plain Askar there is no `askar_handle`,
so it falls back to `handle`.

Applied in:

- `kmslite/v1_0/routes.py` (`_key_handle`)
- `oid4vc/oid4vc/did_utils.py` and `oid4vc/oid4vc/routes/did_jwk.py`

### Spurious Askar assertions

Several oid4vc helpers asserted `isinstance(session, AskarProfileSession)` but
only ever called `record.save(session)`, which works on any `ProfileSession`.
The assertion and the narrow type annotation were the only things blocking
Kanon. Found in `jwt_vc_json/routes.py`, `sd_jwt_vc/routes.py` and
`mso_mdoc/routes.py`.

---

## 9. Operational notes

### Benign log noise at startup

```
config ERROR Database 'issuer_dbstore' not found
config ERROR Failed to check database existence: Database 'issuer_dbstore' does not exist
dbstore ERROR open error: DatabaseError
```

This is the existence probe that runs before auto-creation. Logged at ERROR, but
harmless when followed by successful startup.

Also seen and harmless:

```
dbstore ERROR StopAsyncIteration in __anext__
config WARNING Skipping category default: schema is None
```

### Long-running session warning

```
profile_anon_kanon WARNING Long-running session detected: 45.010s for profile=<uuid>
```

Emitted when a session is held open across a slow operation.

### Store corruption from interrupted or buggy runs

Seen with `single-wallet-kanon` (section 7) but worth knowing generally: a
healthy Askar store has its own name as the default profile. After a run with
the section 7 defects, the store was left in this state:

```
profiles:         <tenant-uuid>, <tenant-uuid>
default_profile:  <tenant-uuid>          <- should be the store name
```

Opening it then fails with:

```
Error opening Askar store. Backend error.
Caused by: no rows returned by a query that expected to return at least one row
```

`compose down` does not remove volumes, so a corrupt store survives restarts.
Recovery is to drop the affected databases and let them be recreated. The same
applies to any half-provisioned store: drop and recreate rather than repair.

### Keep HSM and database volumes in sync

For HSM-backed DIDs the link is `metadata.key_ref` on the DID record matching
`CKA_LABEL` on the PKCS#11 object. Nothing else binds them. Destroying the HSM
volume while keeping the database leaves a DID pointing at a key that no longer
exists.

---

## 10. Summary of changes made to core

The chosen configuration (`basic`) needs **no core changes**. Everything below
fixes `single-wallet-kanon`, which this deployment does not use; the changes are
kept because they are valid upstream fixes.

| file | change | status |
| --- | --- | --- |
| `acapy_agent/multitenant/single_wallet_kanon_manager.py` | `wallet.type` -> `kanon-anoncreds` | fixed, tested |
| `acapy_agent/multitenant/single_wallet_kanon_manager.py` | `create_profile` on both stores | fixed, tested |
| `acapy_agent/multitenant/tests/test_single_wallet_kanon_manager_unit.py` | mock updated, asserts both stores | fixed |

Test status at time of writing: 68 passed in the ACA-Py multitenant suite, 61
passed in kmslite.

The plugin-side changes in section 8 **are** required regardless of multitenancy
mode, since they fix Askar assumptions in plugin code running on Kanon.

Section 7 bug 3 is confirmed but not fixed. It does not affect `basic`.
