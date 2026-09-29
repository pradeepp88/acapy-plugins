"""Kanon storage integration tests for the kmslite admin routes.

Kanon splits storage: records live in the DBStore, keys stay in Askar.
`KanonAnonCredsProfileSession.handle` is the **DBStore** session, so any
plugin code that writes keys must use `askar_handle` instead. These tests
prove the split is handled and that HSM dispatch survives `KanonWallet`.

Point `KMSLITE_KANON_ADMIN` at a running kanon-anoncreds agent that has the
kmslite plugin loaded and a signer registered, then::

    KMSLITE_KANON_ADMIN=http://localhost:3001 pytest tests/test_kanon_integration.py

Skipped when the variable is unset. See integration/README.md for how to
start the agent (host-native) or docker-compose.kanon.yml (containerised).
"""

import os
import uuid

import pytest

from . import Agent

KANON_ADMIN = os.environ.get("KMSLITE_KANON_ADMIN")

pytestmark = pytest.mark.skipif(
    not KANON_ADMIN,
    reason="KMSLITE_KANON_ADMIN not set; no kanon-anoncreds agent to test against",
)


@pytest.fixture(scope="module")
def kanon() -> Agent:
    return Agent(KANON_ADMIN)


@pytest.fixture(scope="module")
def kanon_did(kanon: Agent) -> dict:
    """Create one HSM-backed DID on the kanon agent, reused by later tests.

    This is the regression guard: on Kanon `session.handle` is a
    `DBStoreSession` with no `insert_key`, so a plugin using the wrong
    handle fails here with a 500 (AttributeError) rather than a 200.
    """
    return kanon.post(
        "/kmslite/did/create",
        fail_with="create DID on kanon failed (wrong session handle?)",
        json={
            "method": "key",
            "key_type": "p256",
            "options": {"key_ref": f"kanon-itest-{uuid.uuid4()}"},
        },
    )


def test_create_did_writes_key_to_askar_store(kanon_did):
    """DID creation succeeded, so insert_key reached the Askar session."""
    assert kanon_did["did"].startswith("did:key:")
    assert kanon_did["key_type"] == "p256"
    assert kanon_did["metadata"]["signer"]
    assert kanon_did["metadata"]["key_ref"]


def test_public_key_is_readable(kanon: Agent, kanon_did):
    """The public-only Askar entry is retrievable through the wallet."""
    resp = kanon.get(
        f"/kmslite/did/{kanon_did['did']}/public-key",
        fail_with="public-key export failed on kanon",
    )
    assert "BEGIN PUBLIC KEY" in resp["public_key_pem"]


def test_csr_signing_dispatches_through_kanon_wallet(kanon: Agent, kanon_did):
    """Full chain: KanonWallet.sign_message -> super() -> SignerRegistry -> HSM."""
    resp = kanon.post(
        f"/kmslite/did/{kanon_did['did']}/csr",
        fail_with="CSR signing failed on kanon (dispatch broken?)",
        json={"subject": {"cn": "kmslite kanon integration"}},
    )
    assert "BEGIN CERTIFICATE REQUEST" in resp["csr_pem"]


def test_duplicate_key_ref_is_rejected(kanon: Agent, kanon_did):
    """The HSM label uniqueness pre-check still applies on kanon."""
    resp = kanon.post(
        "/kmslite/did/create",
        return_json=False,
        json={
            "method": "key",
            "key_type": "p256",
            "options": {"key_ref": kanon_did["metadata"]["key_ref"]},
        },
    )
    assert not resp.ok
