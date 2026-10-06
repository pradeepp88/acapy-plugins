"""Test x5c issuance driven by a signing key multikey."""

import datetime

import pytest
from acapy_agent.utils.testing import create_test_profile
from acapy_agent.wallet.base import BaseWallet
from acapy_agent.wallet.key_type import KeyTypes
from acapy_agent.wallet.keys.manager import MultikeyManager, multikey_to_verkey
from acapy_agent.wallet.x509 import build_csr
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID

from oid4vc.jwt import jwt_sign, jwt_verify
from sd_jwt_vc.cred_processor import _x5c_for_signing_key

SUBJECT = {"country": "CA", "common_name": "issuer.example.com"}
_NOT_BEFORE = datetime.datetime(2020, 1, 1)
_NOT_AFTER = datetime.datetime(2040, 1, 1)


def _issue_leaf(csr_pem: bytes) -> str:
    """Stand in for the CA: return a PEM chain, leaf first."""
    ca_key = ec.generate_private_key(ec.SECP256R1())
    ca_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Test Root CA")])
    ca_cert = (
        x509.CertificateBuilder()
        .subject_name(ca_name)
        .issuer_name(ca_name)
        .public_key(ca_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(_NOT_BEFORE)
        .not_valid_after(_NOT_AFTER)
        .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
        .sign(ca_key, hashes.SHA256())
    )
    csr = x509.load_pem_x509_csr(csr_pem)
    leaf = (
        x509.CertificateBuilder()
        .subject_name(csr.subject)
        .issuer_name(ca_name)
        .public_key(csr.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(_NOT_BEFORE)
        .not_valid_after(_NOT_AFTER)
        .add_extension(
            x509.SubjectAlternativeName([x509.DNSName("issuer.example.com")]),
            critical=False,
        )
        .sign(ca_key, hashes.SHA256())
    )
    return (
        leaf.public_bytes(serialization.Encoding.PEM).decode()
        + ca_cert.public_bytes(serialization.Encoding.PEM).decode()
    )


@pytest.fixture
async def profile_with_cert_key():
    """A profile holding a p256 key with a CA-issued chain in its metadata."""
    profile = await create_test_profile()
    profile.context.injector.bind_instance(KeyTypes, KeyTypes())

    async with profile.session() as session:
        manager = MultikeyManager(session)
        key = await manager.create(alg="p256")
        wallet = session.inject(BaseWallet)
        key_info = await wallet.get_signing_key(
            verkey=multikey_to_verkey(key["multikey"])
        )
        csr_pem = await build_csr(wallet, key_info.verkey, key_info.key_type, SUBJECT)
        chain = _issue_leaf(csr_pem)
        await manager.update_metadata(key["multikey"], {"certificate_pem": chain})

    return profile, key["multikey"], chain


@pytest.mark.asyncio
async def test_x5c_resolved_from_signing_key(profile_with_cert_key):
    profile, multikey, _ = profile_with_cert_key
    x5c = await _x5c_for_signing_key(profile, multikey)
    assert x5c and len(x5c) == 2
    assert "-----BEGIN" not in x5c[0]


@pytest.mark.asyncio
async def test_no_signing_key_yields_no_chain(profile_with_cert_key):
    profile, _, _ = profile_with_cert_key
    assert await _x5c_for_signing_key(profile, None) is None


@pytest.mark.asyncio
async def test_key_without_certificate_yields_no_chain(profile_with_cert_key):
    profile, _, _ = profile_with_cert_key
    async with profile.session() as session:
        bare = await MultikeyManager(session).create(alg="p256", kid="bare")
    assert await _x5c_for_signing_key(profile, bare["multikey"]) is None


@pytest.mark.asyncio
async def test_sign_by_multikey_emits_x5c_and_omits_kid(profile_with_cert_key):
    """The whole point: no DID, x5c header, and the signature verifies."""
    profile, multikey, _ = profile_with_cert_key
    x5c = await _x5c_for_signing_key(profile, multikey)

    jws = await jwt_sign(
        profile,
        {"typ": "vc+sd-jwt"},
        {"iss": "https://issuer.example.com", "vct": "ExampleCredential"},
        x5c_chain=x5c,
        multikey=multikey,
    )

    result = await jwt_verify(profile, jws)
    assert result.verified
    assert result.headers["x5c"] == x5c
    assert "kid" not in result.headers
    assert result.headers["alg"] == "ES256"
    assert result.payload["iss"] == "https://issuer.example.com"


@pytest.mark.asyncio
async def test_bare_multikey_emits_no_key_identifier(profile_with_cert_key):
    """Without a chain there is no kid to emit, and none should be invented."""
    profile, multikey, _ = profile_with_cert_key
    jws = await jwt_sign(profile, {}, {"hello": "world"}, multikey=multikey)

    from acapy_agent.wallet.jwt import b64_to_dict

    headers = b64_to_dict(jws.split(".")[0])
    assert "kid" not in headers
    assert "x5c" not in headers
    assert headers["alg"] == "ES256"


@pytest.mark.asyncio
async def test_missing_key_identifier_is_rejected():
    profile = await create_test_profile()
    profile.context.injector.bind_instance(KeyTypes, KeyTypes())
    with pytest.raises(ValueError, match="multikey required"):
        await jwt_sign(profile, {}, {"a": 1})
