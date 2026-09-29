# Combined agent image: local ACA-Py (Kanon + SignerRegistry) + kmslite + oid4vc.
#
# Build context MUST be the parent of both repos (acapy/ and acapy-plugins/),
# i.e. the `acapy-ivan` directory. docker-compose.yaml sets this.
#
# Two deviations from oid4vc/docker/Dockerfile, both deliberate:
#
#  1. ACA-Py is installed from the LOCAL checkout, not PyPI. oid4vc pins
#     `acapy-agent ~1.6.1`, which has neither Kanon's KanonWallet nor the
#     SignerRegistry that kmslite dispatches through.
#  2. Two PKCS#11 modules are available. SoftHSM2 (from apt) is the default;
#     BouncyHsm's client is built below and selected by
#     docker-compose.bouncyhsm.yml.

# BouncyHsm's client is C, so it builds for whatever arch the image targets.
# build_linux/Makefile only defines -m64/-m32 targets, so ARCH_FLAGS is
# cleared to get a native build (needed on arm64).
FROM almalinux:latest AS bouncyhsm-client
ARG BOUNCYHSM_VERSION=v2.3.0
RUN dnf -y install git gcc clang make binutils && dnf clean all
WORKDIR /build
RUN git clone --depth 1 --branch ${BOUNCYHSM_VERSION} \
        https://github.com/harrison314/BouncyHsm.git src
WORKDIR /build/src/build_linux
ENV BOUNCYOSENVIROMENT=rehl_like
RUN make build ARCH_FLAGS= LIBNAME=BouncyHsm.Pkcs11Lib.so

FROM python:3.13-bookworm

WORKDIR /usr/src/app

# softhsm2 = default PKCS#11 token; opensc gives pkcs11-tool for debugging.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl jq softhsm2 opensc \
    && rm -rf /var/lib/apt/lists/*

COPY --from=bouncyhsm-client /build/src/build_linux/BouncyHsm.Pkcs11Lib.so \
     /opt/bouncyhsm/BouncyHsm.Pkcs11Lib.so

# ACA-Py first so its pinned dependency set wins.
COPY acapy/ /usr/src/acapy/
RUN pip install --no-cache-dir /usr/src/acapy

# Plugin runtime deps that ACA-Py doesn't already pull in.
RUN pip install --no-cache-dir \
    jsonschema aiohttp-cors jsonpath jsonpointer bitarray filelock python-pkcs11

# --no-deps keeps each plugin's `acapy-agent` version pin from replacing the
# local checkout installed above.
COPY acapy-plugins/oid4vc/ /usr/src/plugins/oid4vc/
COPY acapy-plugins/status_list/ /usr/src/plugins/status_list/
COPY acapy-plugins/kmslite/ /usr/src/plugins/kmslite/
RUN pip install --no-cache-dir --no-deps \
        /usr/src/plugins/oid4vc \
        /usr/src/plugins/status_list \
        /usr/src/plugins/kmslite

COPY acapy-plugins/kmslite/demo/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV SOFTHSM2_CONF=/etc/softhsm/softhsm2.conf

ENTRYPOINT ["/entrypoint.sh"]
CMD ["aca-py", "start", "--arg-file", "kanon-demo.yml"]
