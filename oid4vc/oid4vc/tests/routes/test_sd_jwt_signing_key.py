"""Test signing_key handling on the SD-JWT VC supported credential routes."""

import pytest
from acapy_agent.wallet.base import BaseWallet
from acapy_agent.wallet.key_type import KeyTypes
from acapy_agent.wallet.keys.manager import MultikeyManager, multikey_to_verkey
from acapy_agent.wallet.x509 import build_csr
from aiohttp import web
from marshmallow import RAISE

from oid4vc.cred_processor import CredProcessors
from oid4vc.models.supported_cred import SupportedCredential
from oid4vc.tests.test_x509_issuance import SUBJECT, _issue_leaf
from sd_jwt_vc.cred_processor import SdJwtCredIssueProcessor
from sd_jwt_vc import routes
from sd_jwt_vc.routes import SdJwtSupportedCredCreateReq

# Tenant auth is not under test here; call the undecorated handlers.
supported_credential_create = routes.supported_credential_create.__wrapped__
update_supported_credential_sd_jwt = routes.update_supported_credential_sd_jwt

BODY = {
    "format": "vc+sd-jwt",
    "id": "ExampleCredential",
    "vct": "ExampleCredential",
    "credential_metadata": {"claims": {}},
    "iss": "https://issuer.example.com",
}


@pytest.fixture
async def sd_jwt_context(context):
    """Admin context with the SD-JWT processor registered for vc+sd-jwt."""
    processors = CredProcessors({"vc+sd-jwt": SdJwtCredIssueProcessor()})
    # The admin context scopes its own injector; sessions use the profile's.
    for injector in (context.injector, context.profile.context.injector):
        injector.bind_instance(CredProcessors, processors)
        injector.bind_instance(KeyTypes, KeyTypes())
    return context


@pytest.fixture
async def bare_multikey(sd_jwt_context):
    """A p256 key with no certificate bound to it."""
    async with sd_jwt_context.profile.session() as session:
        key = await MultikeyManager(session).create(alg="p256")
    return key["multikey"]


def test_create_schema_accepts_signing_key_and_iss():
    loaded = SdJwtSupportedCredCreateReq().load(
        {**BODY, "signing_key": "zDnaExample"}, unknown=RAISE
    )
    assert loaded["signing_key"] == "zDnaExample"
    assert loaded["iss"] == "https://issuer.example.com"


@pytest.mark.asyncio
async def test_create_rejects_signing_key_without_certificate(
    sd_jwt_context, dummy_request, bare_multikey
):
    request = dummy_request(json_data={**BODY, "signing_key": bare_multikey})
    with pytest.raises(web.HTTPBadRequest, match="no certificate"):
        await supported_credential_create(request)

    async with sd_jwt_context.profile.session() as session:
        assert await SupportedCredential.query(session) == []


@pytest.mark.asyncio
async def test_create_without_signing_key_persists_iss(sd_jwt_context, dummy_request):
    response = await supported_credential_create(dummy_request(json_data=BODY))
    assert response.status == 200

    async with sd_jwt_context.profile.session() as session:
        (record,) = await SupportedCredential.query(session)
    assert record.iss == "https://issuer.example.com"
    assert record.signing_key is None


@pytest.mark.asyncio
async def test_update_rejects_signing_key_without_certificate(
    sd_jwt_context, dummy_request, bare_multikey
):
    await supported_credential_create(dummy_request(json_data=BODY))
    async with sd_jwt_context.profile.session() as session:
        (record,) = await SupportedCredential.query(session)

    request = dummy_request(
        json_data={**BODY, "signing_key": bare_multikey},
        match_info={"supported_cred_id": record.supported_cred_id},
    )
    with pytest.raises(web.HTTPBadRequest, match="no certificate"):
        await update_supported_credential_sd_jwt(request)

    async with sd_jwt_context.profile.session() as session:
        stored = await SupportedCredential.retrieve_by_id(
            session, record.supported_cred_id
        )
    assert stored.signing_key is None


@pytest.mark.asyncio
async def test_create_accepts_signing_key_with_certificate(
    sd_jwt_context, dummy_request, bare_multikey
):
    async with sd_jwt_context.profile.session() as session:
        wallet = session.inject(BaseWallet)
        key_info = await wallet.get_signing_key(multikey_to_verkey(bare_multikey))
        csr_pem = await build_csr(wallet, key_info.verkey, key_info.key_type, SUBJECT)
        await MultikeyManager(session).update_metadata(
            bare_multikey, {"certificate_pem": _issue_leaf(csr_pem)}
        )

    request = dummy_request(json_data={**BODY, "signing_key": bare_multikey})
    response = await supported_credential_create(request)
    assert response.status == 200

    async with sd_jwt_context.profile.session() as session:
        (record,) = await SupportedCredential.query(session)
    assert record.signing_key == bare_multikey
