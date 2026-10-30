import express from "express";

import axios from "axios";

import { v4 as uuidv4 } from "uuid";
import {default as NodeCache } from "node-cache";
import QRCode from "qrcode-svg";

import path from "node:path";
import { readFile } from "node:fs/promises";
import crypto from "node:crypto";

import pino from "pino";
import colada from "pino-colada";

import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { EventEmitter } from 'node:events';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ##        #######   ######    ######   ######## ########
// ##       ##     ## ##    ##  ##    ##  ##       ##     ##
// ##       ##     ## ##        ##        ##       ##     ##
// ##       ##     ## ##   #### ##   #### ######   ########
// ##       ##     ## ##    ##  ##    ##  ##       ##   ##
// ##       ##     ## ##    ##  ##    ##  ##       ##    ##
// ########  #######   ######    ######   ######## ##     ##
// Setup the Pino Logger

const logger_stream = {
  formatter: colada(),
  console: (level, msg) => {
    if (level <= 30)
      process.stdout.write(msg);
    else
      process.stderr.write(msg);
  },
  write: function(msg) {
    msg = JSON.parse(msg);
    let level = msg["level"] ?? 30;
    msg = this.formatter(msg);
    if (msg.length > 0) {
      this.console(level, msg);
    }
  },
}

const logger = pino({
  prettifier: colada,
  level: 'trace',
}, logger_stream);

// ######## ##     ## ########  ########  ########  ######   ######
// ##        ##   ##  ##     ## ##     ## ##       ##    ## ##    ##
// ##         ## ##   ##     ## ##     ## ##       ##       ##
// ######      ###    ########  ########  ######    ######   ######
// ##         ## ##   ##        ##   ##   ##             ##       ##
// ##        ##   ##  ##        ##    ##  ##       ##    ## ##    ##
// ######## ##     ## ##        ##     ## ########  ######   ######
// Setup the Express app

const app = express();

// Portal password (HTTP Basic). On when DEMO_PORTAL_PASSWORD is set, for
// example from a Secret; DEMO_PORTAL_USER defaults to "demo". Left open: the
// issuer's webhooks. The browser sends the credentials on every other call,
// including the event stream; wallets never call this app directly.
const PORTAL_USER = process.env.DEMO_PORTAL_USER || "demo";
const PORTAL_PASSWORD = process.env.DEMO_PORTAL_PASSWORD || "";
const PORTAL_OPEN_PATHS = [/^\/webhook(\/|$)/];
function sameSecret(presented, expected) {
  const a = Buffer.from(presented), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
if (PORTAL_PASSWORD) {
  app.use((req, res, next) => {
    if (PORTAL_OPEN_PATHS.some((open) => open.test(req.path))) return next();
    const [scheme, encoded] = (req.headers.authorization || "").split(" ");
    if (scheme === "Basic" && encoded) {
      const decoded = Buffer.from(encoded, "base64").toString();
      const sep = decoded.indexOf(":");
      // Check both, always, so a wrong user name takes as long as a wrong password.
      const userOk = sameSecret(decoded.slice(0, sep), PORTAL_USER);
      const passwordOk = sameSecret(decoded.slice(sep + 1), PORTAL_PASSWORD);
      if (sep > 0 && userOk && passwordOk) return next();
    }
    res.set("WWW-Authenticate", 'Basic realm="Ontario Wallet Sandbox", charset="UTF-8"');
    res.status(401).send("Sign in to the Ontario Wallet Sandbox.");
  });
}

app.set("views", path.join(__dirname, "templates"));
app.set('view engine', 'ejs');
app.use(express.urlencoded({extended: false}));
app.use(express.json());
app.use(express.static("public"));

const events = new EventEmitter();
const exchangeCache = new NodeCache({ stdTTL: 300, checkperiod: 400 });
// Registration IDs whose credential was issued, so a reconnecting stream still shows the tick.
const issuedCache = new NodeCache({ stdTTL: 600, checkperiod: 600 });

const API_BASE_URL = process.env.API_BASE_URL || "http://localhost:3001";
const API_KEY = process.env.API_KEY;
const AUTHSERVER_NGROK_URL = process.env.AUTHSERVER_NGROK_URL;
const ADMIN_MANAGE_AUTH_TOKEN = process.env.ADMIN_MANAGE_AUTH_TOKEN;
const TENANT_SECRET = process.env.TENANT_SECRET;

// Card face for the ID card (wallets show it instead of a plain colour). Embedded as a
// data: URI so wallets need not reach this frontend. Source: card-art/id-card.html,
// rendered at 760x479 and saved as JPEG (wallets only decode PNG/JPEG).
const ID_CARD_ART = `data:image/jpeg;base64,${(await readFile(path.join(__dirname, "card-art/id-card.jpg"))).toString("base64")}`;

// SD-JWT credential definition and status list, created on first issuance.
let sdJwtSupportedCredCreated = false;
let sdJwtStatusListCreated = false;
let sdJwtSupportedCredID = "";
let sdJwtStatusListID = "";


//    ###     ######     ###            ########  ##    ##
//   ## ##   ##    ##   ## ##           ##     ##  ##  ##
//  ##   ##  ##        ##   ##          ##     ##   ####
// ##     ## ##       ##     ## ####### ########     ##
// ######### ##       #########         ##           ##
// ##     ## ##    ## ##     ##         ##           ##
// ##     ##  ######  ##     ##         ##           ##
// ACA-Py related controller helper functions

// Begin Issue SD-JWT Credential Flow
async function issue_sdjwt_credential(req, res) {
  res.status(200).send("");
  events.emit(`issuance-${req.body.registrationId}`, {type: "message", message: "Received credential data from user."});

  const { fname: firstName, lname: lastName, age: ageString } = req.body
  const age = parseInt(ageString);

  const headers = {
    accept: "application/json",
  };
  const commonHeaders = {
    accept: "application/json",
    "Content-Type": "application/json",
    "Authorization": "Bearer " + token.token,
  };
  if (API_KEY) {
    commonHeaders["X-API-KEY"] =  API_KEY;
  }
  axios.defaults.withCredentials = true;
  axios.defaults.headers.common["Access-Control-Allow-Origin"] = API_BASE_URL;
  axios.defaults.headers.common["X-API-KEY"] = API_KEY;
  axios.defaults.headers.common["Authorization"] = "Bearer " + token.token;

  const fetchApiData = async (url, options) => {
    const response = await fetch(url, options);
    return await response.json();
  };


  // Create credential schema
  const createCredentialSupportedUrl = `${API_BASE_URL}/oid4vci/credential-supported/create/sd-jwt`;
  const createCredentialSupportedOptions = {
    method: "POST",
    headers: commonHeaders,
    body: JSON.stringify({
      format: "vc+sd-jwt",
      id: "IDCard",
      proof_types_supported: {
        jwt: {
          proof_signing_alg_values_supported: [
            "ES256"
          ]
        }
      },
      cryptographic_binding_methods_supported: ["jwk"],
      credential_signing_alg_values_supported: ["ES256K"],
      vct: "ExampleIDCard",
      sd_list: [
          "/given_name",
          "/family_name",
          "/age_is_over_12",
          "/age_is_over_14",
          "/age_is_over_16",
          "/age_is_over_18",
          "/age_is_over_21",
          "/age_is_over_65"
        ],
      credential_metadata: {  
        display: [
          {
            "name": "ID Card",
            "locale": "en-US",
            "background_color": "#11577A",
            "text_color": "#FFFFFF",
            "background_image": { "uri": ID_CARD_ART, "alt_text": "Ontario Wallet Sandbox identity card" }
          }
        ],
        "claims": [
          {
          "path": ["given_name"],
          "display": [
            {
              "name": "Given Name",
              "locale": "en-US"
            }
          ]
          },
          {
            "path": ["family_name"],
            "display": [
              {
                "name": "Family Name",
                "locale": "en-US"
              }
            ]
          },
          {
            "path": ["something_nested", "key1", "key2", "key3"],
            "display": [
              {
                "name": "Something Nested",
                "locale": "en-US"
              }
            ]
          },
          {
            "path": ["is_over_12"],
            "display": [
              {
                "name": "Age 12 or Over",
                "locale": "en-US"
              }
            ]
          },
          {
            "path": ["is_over_14"],
            "display": [
              {
                "name": "Age 14 or Over",
                "locale": "en-US"
              }
            ]
          },
          {
            "path": ["is_over_16"],
            "display": [
              {
                "name": "Age 16 or Over",
                "locale": "en-US"
              }
            ]
          },
          {
            "path": ["is_over_18"],
            "display": [
              {
                "name": "Age 18 or Over",
                "locale": "en-US"
              }
            ]
          },
          {
            "path": ["is_over_21"],
            "display": [
              {
                "name": "Age 21 or Over",
                "locale": "en-US"
              }
            ]
          },
          {
            "path": ["is_over_65"],
            "display": [
              {
                "name": "Age 65 or Over",
                "locale": "en-US"
              }
            ]
          }
        ],
      }
    }),
  };

  if (!sdJwtSupportedCredCreated){

    events.emit(`issuance-${req.body.registrationId}`, {type: "message", message: `Posting Create Credential Request to: ${createCredentialSupportedUrl}`});
    events.emit(`issuance-${req.body.registrationId}`, {type: "debug-message", message: "Request options", data: createCredentialSupportedOptions});
    const supportedCredentialData = await fetchApiData(
      createCredentialSupportedUrl,
      createCredentialSupportedOptions
    );
    sdJwtSupportedCredID = supportedCredentialData.supported_cred_id;
    sdJwtSupportedCredCreated = true;
  }

  logger.info(sdJwtSupportedCredID);

  // Create IETF Token status list Configuration
  const statusListCreateUrl = `${API_BASE_URL}/status-list/defs`;
  const statusListCreateOptions = {
    method: "POST",
    headers: commonHeaders,
    body: JSON.stringify({
      issuer_did: issuerDID,
      list_size: 131072,
      list_type: "ietf",
      shard_size: 131072,
      status_message: [
        {
            status: "0x00",
            message: "active"
        },
        {
            status: "0x01",
            message: "inactive"
        },
    ],
    status_purpose: "revocation",
    status_size: 1,
    supported_cred_id: sdJwtSupportedCredID,
    verification_method: issuerDID+"#0"
    })
  };

  if (!sdJwtStatusListCreated){
    events.emit(`issuance-${req.body.registrationId}`, {type: "message", message: `Posting Create Status List Request to: ${statusListCreateUrl}`});
    events.emit(`issuance-${req.body.registrationId}`, {type: "debug-message", message: "Request options", data: statusListCreateOptions});
    const statusListResponse = await fetchApiData(statusListCreateUrl, statusListCreateOptions);
    sdJwtStatusListID = statusListResponse.id;
    events.emit(`issuance-${req.body.registrationId}`, {type: "message", message: `Created Status List ID: ${sdJwtStatusListID}`});
    sdJwtStatusListCreated = true;
  };

  const exchangeCreateOptions = {
    did: issuerDID,
    verification_method: issuerDID+"#0",
    supported_cred_id: sdJwtSupportedCredID,
    credential_subject: {
      given_name: firstName,
      family_name: lastName,
      something_nested: {key1: {key2: {key3: "something nested"}}},
      source_document_type: "id_card",
      age_is_over_12: true,
      age_is_over_14: true,
      age_is_over_16: true,
      age_is_over_18: true,
      age_is_over_21: true,
      age_is_over_65: false,
    },
  };
  
  const exchangeCreateUrl = `${API_BASE_URL}/oid4vci/exchange/create`;
  events.emit(`issuance-${req.body.registrationId}`, {type: "message", message: "Generating Credential Exchange."});
  events.emit(`issuance-${req.body.registrationId}`, {type: "message", message: `Posting Credential Exchange Creation Request to: ${exchangeCreateUrl}`});
  events.emit(`issuance-${req.body.registrationId}`, {type: "debug-message", message: "Request options", data: exchangeCreateOptions});
  const exchangeResponse = await axios.post(exchangeCreateUrl, exchangeCreateOptions);
  const exchangeId = exchangeResponse.data.exchange_id;
  events.emit(`issuance-${req.body.registrationId}`, {type: "message", message: `Received Credential Exchange ID: ${exchangeId}`});


  // Get Credential Offer information
  const credentialOfferUrl = `${API_BASE_URL}/oid4vci/credential-offer`;
  const queryParams = {
    user_pin_required: false,
    exchange_id: exchangeId,
  };
  const credentialOfferOptions = {
    params: queryParams,
    headers: headers,
  };
  events.emit(`issuance-${req.body.registrationId}`, {type: "message", message: "Requesting Credential Offer."});
  events.emit(`issuance-${req.body.registrationId}`, {type: "message", message: `Retrieving Credential Offer from: ${credentialOfferUrl}`});
  events.emit(`issuance-${req.body.registrationId}`, {type: "debug-message", message: "Request options", data: credentialOfferOptions});
  const offerResponse = await axios.get(credentialOfferUrl, credentialOfferOptions);
  const credentialOffer = offerResponse.data;

  // Generate QRCode and send it to the browser via HTMX events
  logger.info(JSON.stringify(offerResponse.data));
  logger.info(exchangeId);

  let qrcode;
  if (credentialOffer.hasOwnProperty("credential_offer")) {
    // credential offer is passed by value
    qrcode = credentialOffer.credential_offer
  } else {
    // credential offer is passed by reference, and the wallet must dereference it using the
    // /oid4vci/dereference-credential-offer endpoint
    qrcode = credentialOffer.credential_offer_uri
  }

  events.emit(`issuance-${req.body.registrationId}`, {type: "message", message: `Sending offer to user: ${qrcode}`});
  events.emit(`issuance-${req.body.registrationId}`, {type: "qrcode", credentialOffer, exchangeId, qrcode});
  exchangeCache.set(exchangeId, { exchangeId, credentialOffer, issuerDID, sdJwtSupportedCredID, registrationId: req.body.registrationId });

  // Polling for the credential is an option at this stage, but we opt to just listen for the appropriate webhook instead
  events.emit(`issuance-${req.body.registrationId}`, {type: "message", message: "Begin listening for credential to be issued."});
}

// ##     ## ######## ##     ## ##     ##
// ##     ##    ##    ###   ###  ##   ##
// ##     ##    ##    #### ####   ## ##
// #########    ##    ## ### ##    ###
// ##     ##    ##    ##     ##   ## ##
// ##     ##    ##    ##     ##  ##   ##
// ##     ##    ##    ##     ## ##     ##
// ######## ##     ## ######## ##    ## ########  ######
// ##       ##     ## ##       ###   ##    ##    ##    ##
// ##       ##     ## ##       ####  ##    ##    ##
// ######   ##     ## ######   ## ## ##    ##     ######
// ##        ##   ##  ##       ##  ####    ##          ##
// ##         ## ##   ##       ##   ###    ##    ##    ##
// ########    ###    ######## ##    ##    ##     ######

// Shown in place of the QR code once the credential is issued (one line: it is sent as SSE data).
const ISSUED_TICK = '<div style="text-align: center;"><svg width="128" height="128" viewBox="0 0 24 24" role="img" aria-label="Credential issued"><circle cx="12" cy="12" r="11" fill="#2e7d32"/><path d="M6.5 12.5l3.5 3.5 7.5-8" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg><p class="w3-large w3-text-green"><b>Credential Issued!</b></p></div>';

function handleEvents(event_type, req, res) {
  // Send headers indicating that this is an HTMX stream
  res.writeHead(200, {
    "Connection": "keep-alive",
    "Cache-Control": "no-cache",
    "Content-Type": "text/event-stream",
  });

  logger.trace("HTMX Stream started!");
  // The browser reconnects when the router drops the stream; the QR code stays on the
  // page, but an issued credential may have arrived in between.
  if (issuedCache.get(req.params.id)) res.write(`event: qrcode\ndata: ${ISSUED_TICK}\n\n`);
  // Comment lines keep the stream from idling out at the OpenShift router (30s).
  const heartbeat = setInterval(() => res.write(`: ping\n\n`), 15000);

  // Only the QR code and the issued notice are sent to the browser; progress
  // messages and webhook data stay in the server log.
  const listener = (data) => {
    if (data.type == "webhook") {
      logger.trace(JSON.stringify(data, null, 2));
      // The wallet scanned the QR code and collected the credential: replace the code with a tick
      if (data.path == "/webhook/topic/oid4vci/" && data?.data?.state == "issued") {
        res.write(`event: qrcode\ndata: ${ISSUED_TICK}\n\n`);
      }
      return;
    }

    // When we receive a "qrcode" message, generate a code and send it to the browser
    if ("qrcode" in data) {
      var qrcode = new QRCode({
        content: data.qrcode,
        padding: 4,
        width: 256,
        height: 256,
        color: "#000000",
        background: "#ffffff",
        ecl: "M",
      });
      logger.debug(data.qrcode);
      // Deep link to the same offer, for a wallet on this device
      const href = String(data.qrcode).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
      const deepLink = `<div style="text-align: center; margin-top: 12px;"><a class="w3-button w3-green w3-round" href="${href}">Open in wallet</a></div>`;
      res.write(`event: qrcode\ndata: ${qrcode.svg().replace(/\r?\n|\r/g, " ")}${deepLink}\n\n`);
    }
  };
  events.on(`${event_type}-${req.params.id}`, listener);

  res.on("close", () => {
    clearInterval(heartbeat);
    events.off(`${event_type}-${req.params.id}`, listener);
    res.end();
  });
}


// ########   #######  ##     ## ######## ########  ######
// ##     ## ##     ## ##     ##    ##    ##       ##    ##
// ##     ## ##     ## ##     ##    ##    ##       ##
// ########  ##     ## ##     ##    ##    ######    ######
// ##   ##   ##     ## ##     ##    ##    ##             ##
// ##    ##  ##     ## ##     ##    ##    ##       ##    ##
// ##     ##  #######   #######     ##    ########  ######
// Express.js Routes

// Render main app
app.get("/", (req, res) => {
  res.render("index", {"registrationId": uuidv4()});
});

const fetchApiData = async (url, options) => {
  const response = await fetch(url, options);
  return await response.json();
};

// The demo's issuer tenant, created at start.
let token = null;
let WALLET_ID = null;

async function createTenant() {
  token = await fetchApiData(
    `${API_BASE_URL}/multitenancy/wallet`,
    {
      method: "POST",
      headers: {
        accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(
        {
            "label": "Alice",
            "wallet_type": "askar",
        }
      )
    }
  );
  WALLET_ID = token.settings["wallet.id"];
  logger.info(`Issuer tenant: ${WALLET_ID}`);
}

// Configure Auth server tenant
async function initializeAuthServer() {
  try {
 
    const AUTHSERVER="http://auth-server:9000"

    const commonHeaders = {
      accept: "application/json",
      "Authorization": "Bearer " + ADMIN_MANAGE_AUTH_TOKEN,
      "Content-Type": "application/json",
    };

    // Create tenant
    const tenantRes = await axios.post(
      `${AUTHSERVER}/admin/tenants`,
      {
        uid: WALLET_ID,
        name: `tenant-${WALLET_ID}`,
        active: true,
        notes: "demo tenant"
      },
      { headers: commonHeaders }
    );
    logger.info("Tenant created:", tenantRes.data);

    // Create key for tenant
    const notBefore = new Date();
    const notAfter = new Date(new Date().setFullYear(new Date().getFullYear() + 1));
    console.log("Not before:", notBefore.toISOString());
    console.log("Not after:", notAfter.toISOString());
    

    const keyRes = await axios.post(
      `${AUTHSERVER}/admin/tenants/${WALLET_ID}/keys`,
      {
        alg: "ES256",
        not_before: notBefore.toISOString(),
        not_after: notAfter.toISOString(),
        status: "active"
      },
      { headers: commonHeaders }
    );
    logger.info("Key created:", keyRes.data);

    // Create client for tenant
    const clientRes = await axios.post(
      `${AUTHSERVER}/admin/tenants/${WALLET_ID}/clients`,
      {
        client_id: "client1",
        client_auth_method: "client_secret_basic",
        client_secret: TENANT_SECRET,
      },
      { headers: commonHeaders }
    );
    logger.info("Client created:", clientRes.data);

  } catch (err) {
    logger.error("Auth server initialization failed:", err?.response?.data || err.message);
  }
}

// Configure the Issuer to use the use the Auth server and define issuer metadata.
async function initializeIssuerMetadata() {
  try {
    const commonHeaders = {
      accept: "application/json",
      "Content-Type": "application/json",
      "Authorization": "Bearer " + token.token,
    };
    if (API_KEY) {
      commonHeaders["X-API-KEY"] = API_KEY;
    }

    const payload = {
      authorization_servers: [
        {
          public_url: `${AUTHSERVER_NGROK_URL}/tenants/${WALLET_ID}`,
          private_url: `http://auth-server:9001/tenants/${WALLET_ID}`,
          auth_type: "client_secret_basic",
          client_credentials: {
            client_id: "client1",
            client_secret: TENANT_SECRET
          }
        }
      ]
    };

    const response = await axios.put(
      `${API_BASE_URL}/oid4vci/issuer/configuration`,
      payload,
      { headers: commonHeaders }
    );
    logger.info("Issuer metadata initialized:", response.data);
  } catch (err) {
    logger.error("Issuer metadata initialization failed:", err?.response?.data || err.message);
  }
}

// Create Signing DID. Note that this DID is used to sign both the credential and status list (required by IETF token status list spec)
let issuerDID = null;
async function initializeSigningDid() {
  try {
    const commonHeaders = {
      accept: "application/json",
      "Content-Type": "application/json",
      "Authorization": "Bearer " + token.token,
    }
    const createDidUrl = `${API_BASE_URL}/did/jwk/create`;
    const createDidOptions = {
      method: "POST",
      headers: commonHeaders,
      body: JSON.stringify({
        key_type: "p256",
      }),
    };
    logger.info(`Posting Create DID Request to: ${createDidUrl}`);
    logger.info("Request options", createDidOptions);
    const didData = await fetchApiData(createDidUrl, createDidOptions);
    const { did } = didData;
    issuerDID = did;
    logger.info(`Created signing DID: ${issuerDID}`);
  } catch (err) {
    logger.error("Signing DID initialization failed:", err?.response?.data || err.message);
  }
}

async function initializeDemo() {
  await initializeAuthServer();
  await initializeIssuerMetadata();
  await initializeSigningDid();
}

await createTenant();
await initializeDemo();

// Render Credential Issuance form
app.get("/issue", (req, res) => {
  res.render("issue-form", {"page": "register", "registrationId": uuidv4()});
});
app.post("/issue", (req, res, next) => {
  // Begin Credential issuance flow
  //events.on(`${event_type}-${req.params.id}`, (data) => {
    console.log(req.body);
    issue_sdjwt_credential(req, res).catch(next);
  });

  // Event Stream for Issuance page
  app.get("/stream/issue/:id", (req, res) => {
    handleEvents("issuance", req, res);
  });

  // ##      ## ######## ########  ##     ##  #######   #######  ##    ##  ######
  // ##  ##  ## ##       ##     ## ##     ## ##     ## ##     ## ##   ##  ##    ##
  // ##  ##  ## ##       ##     ## ##     ## ##     ## ##     ## ##  ##   ##
  // ##  ##  ## ######   ########  ######### ##     ## ##     ## #####     ######
  // ##  ##  ## ##       ##     ## ##     ## ##     ## ##     ## ##  ##         ##
  // ##  ##  ## ##       ##     ## ##     ## ##     ## ##     ## ##   ##  ##    ##
  //  ###  ###  ######## ########  ##     ##  #######   #######  ##    ##  ######
  // ACA-Py sends webhook events when something happens within ACA-Py (such as
    // when a credential is issued or a presentation has been varified). These
  // webhooks showcase the current state of ACA-Py flows and can be acted upon to
  // give users up-to-date and realtime info.

    app.post("/webhook/*topic", (req, res, next) => {
      // Answer straight away so ACA-Py doesn't hold the request open.
      res.status(200).end();
      logger.trace("Webhook received");
      logger.trace(req.path);
      logger.trace(JSON.stringify(req.body));
      if (req.path == "/webhook/topic/oid4vci/") {
        // If there's no exchange ID, we can't look up the request
        if (!req.body.exchange_id) return;

        // Check to see if this belongs to us
        let exchange = exchangeCache.get(req.body.exchange_id);
        if (!exchange) return;

        if (req.body.state == "issued") issuedCache.set(exchange.registrationId, true);

        // Dispatch event
        events.emit(`issuance-${exchange.registrationId}`, {type: "webhook", path: req.path, data: req.body});
      }
    });

  app.listen(3000, () => {
    console.log("App listening on port 3000");
  });
