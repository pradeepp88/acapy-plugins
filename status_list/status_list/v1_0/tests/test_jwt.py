import pytest

from ..jwt import jwt_sign


@pytest.mark.asyncio
async def test_jwt(context):
    headers = {"alg": "Ed25519"}
    payload = {"test": "test"}

    jwt = await jwt_sign(
        context.profile,
        headers=headers,
        payload=payload,
        verification_method="did:web:example.com#3Dn1SJNPaCXcvvJvSbsFWP2xaCjMom3can8CQNhWrTRx",
    )
    assert jwt


def _issue_cert(csr_pem: bytes) -> str:
    """Stand in for a CA: return a PEM chain for the CSR, leaf first."""
    import datetime

    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import NameOID

    ca_key = ec.generate_private_key(ec.SECP256R1())
    ca_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Test CA")])
    start, end = datetime.datetime(2020, 1, 1), datetime.datetime(2040, 1, 1)
    ca = (
        x509.CertificateBuilder()
        .subject_name(ca_name)
        .issuer_name(ca_name)
        .public_key(ca_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(start)
        .not_valid_after(end)
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
        .not_valid_before(start)
        .not_valid_after(end)
        .sign(ca_key, hashes.SHA256())
    )
    return "".join(
        c.public_bytes(serialization.Encoding.PEM).decode() for c in (leaf, ca)
    )


async def _key_with_cert(profile, with_cert=True):
    from acapy_agent.wallet.base import BaseWallet
    from acapy_agent.wallet.key_type import KeyTypes
    from acapy_agent.wallet.keys.manager import MultikeyManager, multikey_to_verkey
    from acapy_agent.wallet.x509 import build_csr

    profile.context.injector.bind_instance(KeyTypes, KeyTypes())
    async with profile.session() as session:
        manager = MultikeyManager(session)
        key = await manager.create(alg="p256")
        if with_cert:
            wallet = session.inject(BaseWallet)
            info = await wallet.get_signing_key(multikey_to_verkey(key["multikey"]))
            csr = await build_csr(
                wallet, info.verkey, info.key_type, {"common_name": "issuer"}
            )
            await manager.update_metadata(
                key["multikey"], {"certificate_pem": _issue_cert(csr)}
            )
    return key["multikey"]


@pytest.mark.asyncio
async def test_jwt_signed_with_x5c_key(context):
    """A signing_key status list token carries x5c, not kid, and verifies with it."""
    import base64
    import json

    from cryptography import x509
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature

    multikey = await _key_with_cert(context.profile)
    token = await jwt_sign(
        context.profile,
        headers={"typ": "statuslist+jwt", "kid": "did:example:ignored#0"},
        payload={"sub": "https://issuer.example/status/1"},
        multikey=multikey,
    )

    h64, p64, s64 = token.split(".")
    pad = lambda s: s + "=" * (-len(s) % 4)  # noqa: E731
    headers = json.loads(base64.urlsafe_b64decode(pad(h64)))
    assert headers["typ"] == "statuslist+jwt"
    assert headers["alg"] == "ES256"
    assert "kid" not in headers
    assert len(headers["x5c"]) == 2

    leaf = x509.load_der_x509_certificate(base64.b64decode(headers["x5c"][0]))
    sig = base64.urlsafe_b64decode(pad(s64))
    leaf.public_key().verify(
        encode_dss_signature(int.from_bytes(sig[:32]), int.from_bytes(sig[32:])),
        f"{h64}.{p64}".encode(),
        ec.ECDSA(hashes.SHA256()),
    )


@pytest.mark.asyncio
async def test_jwt_x5c_key_without_certificate_is_rejected(context):
    multikey = await _key_with_cert(context.profile, with_cert=False)
    with pytest.raises(ValueError, match="has no certificate"):
        await jwt_sign(context.profile, headers={}, payload={}, multikey=multikey)
