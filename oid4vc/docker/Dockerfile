FROM python:3.13-slim-bookworm AS base
WORKDIR /usr/src/app

# Install and configure poetry
USER root

# Install and configure poetry
WORKDIR /usr/src/app
ENV POETRY_VERSION=2.1.2
ENV POETRY_HOME=/opt/poetry
RUN apt-get update && apt-get install -y curl jq && apt-get clean
RUN curl -sSL https://install.python-poetry.org | python -

ENV PATH="/opt/poetry/bin:$PATH"
RUN poetry config virtualenvs.in-project true

# Setup project
RUN mkdir oid4vc && touch oid4vc/__init__.py
RUN mkdir jwt_vc_json && touch jwt_vc_json/__init__.py
RUN mkdir sd_jwt_vc && touch sd_jwt_vc/__init__.py
RUN mkdir mso_mdoc && touch mso_mdoc/__init__.py
RUN mkdir status_list && touch status_list/__init__.py
RUN mkdir mso_mdoc/isomdl
COPY pyproject.toml poetry.lock README.md ./
RUN poetry install --without dev --all-extras

USER $user

FROM python:3.13-bookworm

ARG TARGETARCH

WORKDIR /usr/src/app
COPY --from=base /usr/src/app/.venv /usr/src/app/.venv
ENV PATH="/usr/src/app/.venv/bin:$PATH"
RUN apt-get update && apt-get install -y curl jq git && apt-get clean

# TEMPORARY: the x5c work depends on wallet certificate support that is not in a
# released acapy-agent yet. Drop this once it lands and the pyproject pin covers it.
ARG ACAPY_REPO=https://github.com/pradeepp88/acapy.git
ARG ACAPY_REF=x-509-support
# --force-reinstall: the fork shares the released version number, so pip would
# otherwise treat the PyPI copy installed by poetry as satisfying it.
RUN python -m pip install --no-cache-dir --no-deps --force-reinstall "git+${ACAPY_REPO}@${ACAPY_REF}" \
    && python -c "import acapy_agent.wallet.x509"

COPY jwt_vc_json/ jwt_vc_json/
COPY mso_mdoc/ mso_mdoc/
COPY sd_jwt_vc/ sd_jwt_vc/
COPY oid4vc/ oid4vc/
# Sparse clone rather than `ADD <git>#ref:subdir`, which older BuildKit (e.g.
# Docker 20.10) silently treats as a plain file download.
ARG STATUS_LIST_REF=main
RUN git clone --depth 1 --branch "${STATUS_LIST_REF}" --filter=blob:none --sparse \
        https://github.com/openwallet-foundation/acapy-plugins.git /tmp/acapy-plugins \
    && git -C /tmp/acapy-plugins sparse-checkout set status_list/status_list \
    && cp -r /tmp/acapy-plugins/status_list/status_list/. status_list/ \
    && rm -rf /tmp/acapy-plugins \
    && python -c "import status_list.v1_0"
COPY docker/*.yml ./


# Using isomdl library from indicio
RUN if [ "$TARGETARCH" = "amd64" ]; then \
        pip install --no-cache-dir https://github.com/Indicio-tech/isomdl-uniffi/releases/download/v0.1.0-indicio.1/isomdl_uniffi-0.1.0-py3-none-manylinux_2_17_x86_64.manylinux2014_x86_64.whl; \
    elif [ "$TARGETARCH" = "arm64" ]; then \
        pip install --no-cache-dir https://github.com/Indicio-tech/isomdl-uniffi/releases/download/v0.1.0-indicio.1/isomdl_uniffi-0.1.0-py3-none-macosx_11_0_arm64.whl \
    else \
        echo "Unsupported architecture: $TARGETARCH"; \
        exit 1; \
    fi


ENTRYPOINT ["/bin/bash", "-c", "aca-py \"$@\"", "--"]
CMD ["start", "--arg-file", "default.yml"]
