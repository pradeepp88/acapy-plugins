# Kanon database implementation - findings

Notes gathered while running the kmslite + oid4vc demo (`kmslite/demo`) on the
`kanon-anoncreds` wallet type with PostgreSQL. Every claim here was verified
against a live stack or against source in the local ACA-Py checkout; the one
unresolved item is marked as such.

ACA-Py version: 1.6.0 (local checkout, branch `kmslite`).

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

Selected with `--multitenancy-config wallet_type=single-wallet-kanon`, handled by
`SingleWalletKanonMultitenantManager`. All tenants share one pair of databases
and are separated by Kanon **profiles** - rows in the `profiles` table, with
`items.profile_id` as the discriminator.

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

### Bug 3 - plugin records escape tenant scoping (UNRESOLVED)

Two related observations, whose causal link is **not** established. See the
counter-evidence note below before acting on this section.

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

**Important counter-evidence - the profile split may not be the cause.**
`POST /tenant/<id>/credential` and `GET /tenant/<id>/status/0` are served by the
same middleware in `oid4vci_server.py`, which builds one
`AdminRequestContext(profile=wallet_profile, root_profile=self.profile)`. The
credential request returned 200 while reading `oid4vci` and `supported_cred`
records that are stored under the base profile. If a tenant-profile session
could not see base-profile rows, issuance would have failed as well.

So two separate facts are established, and the link between them is not:

1. Plugin records are written to the base profile while `did` and `config` are
   written to the tenant profile. This is real and reproducible.
2. The shard query returns zero rows. This is real and reproducible.

Whether (1) causes (2) is **unproven**. An equally plausible cause for (2) is
the tag filter itself - `tag_filter = {"list_number": list_number}` where
`list_number` arrives from the URL as a string, matched against tags stored by
the status_list plugin.

kmslite's `/kmslite/did/create` writes tenant-scoped, while oid4vc's equally
tenant-authenticated routes write base-scoped, through what appears to be
identical `context.profile.session()` code. That asymmetry is also unexplained.

Suggested next step: log `profile_id` plus request path in
`KanonAnonCredsProfileSession.__init__`, and separately log the resolved
`tag_filter` and row count inside `get_status_list_token`. That distinguishes a
profile-scoping fault from a query-filter fault.

Secondary defect: `shards[0]` should raise a 404, not an `IndexError` surfaced
as a 500.

---

## 7. Writing plugins that work on Kanon

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

## 8. Operational notes

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

A healthy Askar store has its own name as the default profile. After a run with
the Bug 1 / Bug 2 code, the store was left in this state:

```
profiles:         <tenant-uuid>, <tenant-uuid>
default_profile:  <tenant-uuid>          <- should be multitenant_sub_wallet
```

Opening it then fails with:

```
Error opening Askar store. Backend error.
Caused by: no rows returned by a query that expected to return at least one row
```

`compose down` does not remove volumes, so a corrupt store survives restarts.
Recovery is to drop the affected databases and let them be recreated.

### Keep HSM and database volumes in sync

For HSM-backed DIDs the link is `metadata.key_ref` on the DID record matching
`CKA_LABEL` on the PKCS#11 object. Nothing else binds them. Destroying the HSM
volume while keeping the database leaves a DID pointing at a key that no longer
exists.

---

## 9. Summary of changes made to core

| file | change | status |
| --- | --- | --- |
| `acapy_agent/multitenant/single_wallet_kanon_manager.py` | `wallet.type` -> `kanon-anoncreds` | fixed, tested |
| `acapy_agent/multitenant/single_wallet_kanon_manager.py` | `create_profile` on both stores | fixed, tested |
| `acapy_agent/multitenant/tests/test_single_wallet_kanon_manager_unit.py` | mock updated, asserts both stores | fixed |

Test status at time of writing: 68 passed in the ACA-Py multitenant suite, 61
passed in kmslite.

Bug 3 remains open.
