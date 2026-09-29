#!/bin/bash
# Provision the PKCS#11 token for kmslite, then hand off to the ngrok wait that
# oid4vc's own entrypoint performs.
set -e

TOKEN_LABEL="${KMSLITE_PKCS11_TOKEN_NAME:-kmslite-demo}"
USER_PIN="${KMSLITE_PKCS11_PIN:-1234}"
SO_PIN="${SOFTHSM_SO_PIN:-12345678}"
PKCS11_LIB="${KMSLITE_PKCS11_LIBRARY_PATH:-/usr/lib/softhsm/libsofthsm2.so}"

if [[ "$PKCS11_LIB" == *bouncyhsm* ]]; then
    # BouncyHsm tokens are created through the server's REST API, not locally.
    BOUNCY_HTTP="${BOUNCY_HSM_HTTP:-http://bouncyhsm:8080}"
    for attempt in $(seq 1 30); do
        curl -sf "${BOUNCY_HTTP}/Slot" >/dev/null 2>&1 && break
        [[ $attempt -eq 30 ]] && { echo "BouncyHsm not reachable at ${BOUNCY_HTTP}" >&2; exit 1; }
        sleep 2
    done
    if curl -s "${BOUNCY_HTTP}/Slot" | jq -e --arg l "$TOKEN_LABEL" \
            '.[] | select(.Token.Label == $l)' >/dev/null 2>&1; then
        echo "BouncyHsm token '${TOKEN_LABEL}' already present"
    else
        echo "Creating BouncyHsm token '${TOKEN_LABEL}'"
        curl -sf -X POST "${BOUNCY_HTTP}/Slot" -H 'Content-Type: application/json' \
            -d "{\"Description\":\"kmslite demo\",\"Token\":{\"Label\":\"${TOKEN_LABEL}\",\"UserPin\":\"${USER_PIN}\",\"SoPin\":\"${SO_PIN}\",\"SerialNumber\":\"kmslite01\",\"SimulateHwRng\":false,\"SimulateQualifiedArea\":false}}" >/dev/null
    fi
elif softhsm2-util --show-slots 2>/dev/null | grep -q "Label:  *${TOKEN_LABEL}"; then
    echo "SoftHSM token '${TOKEN_LABEL}' already present"
else
    echo "Initialising SoftHSM token '${TOKEN_LABEL}'"
    softhsm2-util --init-token --free \
        --label "${TOKEN_LABEL}" \
        --pin "${USER_PIN}" \
        --so-pin "${SO_PIN}"
fi

TUNNEL_ENDPOINT=${TUNNEL_ENDPOINT:-http://ngrok:4040}
WAIT_INTERVAL=${WAIT_INTERVAL:-3}
WAIT_ATTEMPTS=${WAIT_ATTEMPTS:-20}

for attempt in $(seq 1 "$WAIT_ATTEMPTS"); do
    if curl -s "${TUNNEL_ENDPOINT}/api/tunnels" \
        | jq -e '.tunnels[] | select(.name == "issuer" and .public_url != null)' >/dev/null 2>&1; then
        break
    fi
    if [[ $attempt -ge $WAIT_ATTEMPTS ]]; then
        echo "Failed waiting for the 'issuer' ngrok tunnel at ${TUNNEL_ENDPOINT}" >&2
        exit 1
    fi
    echo "Waiting for 'issuer' tunnel..." >&2
    sleep "$WAIT_INTERVAL"
done

OID4VCI_ENDPOINT=$(curl -s "${TUNNEL_ENDPOINT}/api/tunnels" \
    | jq -r '.tunnels[] | select(.name == "issuer") | .public_url')
export OID4VCI_ENDPOINT
export STATUS_LIST_PUBLIC_URI="${OID4VCI_ENDPOINT}/tenant/{tenant_id}/status/{list_number}"

echo "OID4VCI_ENDPOINT:       $OID4VCI_ENDPOINT"
echo "STATUS_LIST_PUBLIC_URI: $STATUS_LIST_PUBLIC_URI"

exec "$@"
