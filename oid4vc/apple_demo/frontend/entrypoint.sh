#!/bin/bash
set -e

# On OpenShift there is no ngrok: set AUTHSERVER_NGROK_URL to the auth server
# route and the tunnel lookup is skipped.
if [ -z "$AUTHSERVER_NGROK_URL" ]; then
  TUNNEL_ENDPOINT=${TUNNEL_ENDPOINT:-http://ngrok:4040}

  # Get the authserver tunnel public URL using jq
  AUTHSERVER_NGROK_URL=$(curl --silent "${TUNNEL_ENDPOINT}/api/tunnels" | jq -r '.tunnels[] | select(.name == "authserver") | .public_url')
fi
export AUTHSERVER_NGROK_URL
echo "AUTHSERVER_NGROK_URL: $AUTHSERVER_NGROK_URL"

exec "$@"
