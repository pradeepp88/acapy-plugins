import express from "express";

import axios from "axios";

import { v4 as uuidv4 } from "uuid";
import {default as NodeCache } from "node-cache";
import QRCode from "qrcode-svg";

import path from "node:path";
import os from "node:os";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";

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
app.set("views", path.join(__dirname, "templates"));
app.set('view engine', 'ejs');
app.use(express.urlencoded({extended: false}));
app.use(express.json());
app.use(express.static("public"));

const events = new EventEmitter();
const exchangeCache = new NodeCache({ stdTTL: 300, checkperiod: 400 });
const presentationCache = new NodeCache({ stdTTL: 300, checkperiod: 400 });

const API_BASE_URL = process.env.API_BASE_URL || "http://localhost:3001";
const API_KEY = process.env.API_KEY;
const AUTHSERVER_NGROK_URL = process.env.AUTHSERVER_NGROK_URL;
const ADMIN_MANAGE_AUTH_TOKEN = process.env.ADMIN_MANAGE_AUTH_TOKEN;
const TENANT_SECRET = process.env.TENANT_SECRET;
// The issuer's OID4VCI public server as reached from this app. Defaults to the
// admin API's host on the OID4VCI port, so it follows whatever API_BASE_URL is
// (http://issuer:3001 under compose, http://issuing-service:3001 on OpenShift).
const OID4VCI_INTERNAL_URL = process.env.OID4VCI_INTERNAL_URL || (() => {
  const url = new URL(API_BASE_URL);
  url.port = process.env.OID4VCI_PORT || "8082";
  return url.origin;
})();

//certificate and private key to import for mDL issuance
//expires 2036, private_key is PEM base64 encoded PKCS #8.
//TODO the certifciate does not work for verification as a trust anchor - IACA extensions are missing.
const certificate_pem = "-----BEGIN CERTIFICATE-----\nMIIB1DCCAXmgAwIBAgIIdNRHwTfOGwcwCgYIKoZIzj0EAwIwDTELMAkGA1UEBhMC\nQ0EwHhcNMjYwNDEzMTkyNDAwWhcNMzYwNDEzMTkyNDAwWjANMQswCQYDVQQGEwJD\nQTBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABNKdpd24SPAyNLWNd4J/hlEU5awn\nh26s4sQnJ6cy5tzF92eoNCoz/RKeUD2pCUStdJhN3qYnXgnMbDqLlGIt0bmjgcIw\ngb8wEgYDVR0TAQH/BAgwBgEB/wIBADAdBgNVHQ4EFgQUQHLNvJUIYoRcUOiu5qhb\nvaxt4UgwDgYDVR0PAQH/BAQDAgEGMCIGA1UdEgQbMBmGF21haWx0bzp1c2VyQGV4\nYW1wbGUuY29tMCMGA1UdHwQcMBowGKAWoBSGEmh0dHA6Ly9leGFtcGxlLmNvbTAR\nBglghkgBhvhCAQEEBAMCAAcwHgYJYIZIAYb4QgENBBEWD3hjYSBjZXJ0aWZpY2F0\nZTAKBggqhkjOPQQDAgNJADBGAiEA0zfq5zFY1hz9E//K9n/JlcVDZ+WN1bTduq8u\n/MXtoPkCIQCQw3KbsNB9e/2yskidmuJe5CdFK3VvZpw0SC8IsG2H5A==\n-----END CERTIFICATE-----\n";
const private_key_pem = "-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg6Al13xaXxheg2tsc\nIQEdUKWRqaCAdcHCfPxw6+yTufWhRANCAATSnaXduEjwMjS1jXeCf4ZRFOWsJ4du\nrOLEJyenMubcxfdnqDQqM/0SnlA9qQlErXSYTd6mJ14JzGw6i5RiLdG5\n-----END PRIVATE KEY-----\n";
let jwtVcSupportedCredCreated = false;
let sdJwtSupportedCredCreated = false;
let mdocSupportedCredCreated = false;
let sdJwtStatusListCreated = false;
let jwtStatusListCreated = false;
let jwtVcSupportedCredID = "";
let sdJwtSupportedCredID = "";
let mdocSupportedCredID = "";
let jwtStatusListID = "";
let sdJwtStatusListID = "";
let sdJwtX509SupportedCredID = "";
let sdJwtX509SupportedCredKey = ""; // multikey the X.509 supported credential signs with


//    ###     ######     ###            ########  ##    ##
//   ## ##   ##    ##   ## ##           ##     ##  ##  ##
//  ##   ##  ##        ##   ##          ##     ##   ####
// ##     ## ##       ##     ## ####### ########     ##
// ######### ##       #########         ##           ##
// ##     ## ##    ## ##     ##         ##           ##
// ##     ##  ######  ##     ##         ##           ##
// ACA-Py related controller helper functions

// Begin Issue JWT Credential Flow
async function issue_jwt_credential(req, res) {
  res.status(200).send("");
  events.emit(`issuance-${req.body.registrationId}`, {type: "message", message: "Received credential data from user."});

  const { fname: firstName, lname: lastName, email } = req.body

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
  const createCredentialSupportedUrl = `${API_BASE_URL}/oid4vci/credential-supported/create/jwt`;
  const createCredentialSupportedOptions = {
    method: "POST",
    headers: commonHeaders,
    body: JSON.stringify({
      cryptographic_binding_methods_supported: ["did"],
      credential_signing_alg_values_supported: ["ES256"],
      format: "jwt_vc_json",
      id: "UniversityDegreeCredential",
      proof_types_supported: {
        jwt: {
          proof_signing_alg_values_supported: ["ES256"]
        }
      },
      credential_definition: {
        "@context": [
          "https://www.w3.org/2018/credentials/v1",
          "https://www.w3.org/2018/credentials/examples/v1",
        ],
        type: [
          "VerifiableCredential",
          "UniversityDegreeCredential"
        ],
      },
      credential_metadata: {
        display: [
          {
            name: "University Credential",
            locale: "en-US",
            logo: {
             url: "https://w3c-ccg.github.io/vc-ed/plugfest-1-2022/images/JFF_LogoLockup.png",
              alt_text: "a square logo of a university",
            },
            background_color: "#12107c",
            text_color: "#FFFFFF",
          },
        ],
        claims: [
          {
             path: [
              "degree"
             ],
             display: [
                {
                  name: "Degree",
                  locale: "en-US",
                },
             ],
          },
          {
            path: [
              "given_name"
            ],
            display: [
              {
                name: "Given Name",
                locale: "en-US",
              },
            ],
          },
          {
            path: [
              "gpa"
            ],
            display: [
              {
                name: "GPA Score",
                locale: "en-US",
              },
            ],
          },
          {
            path: [
              "last_name"
            ],
            display: [
              {
                name: "Surname",
                locale: "en-US",
              },
            ],
          },
        ],
      },
    }),
  };

  if (!jwtVcSupportedCredCreated){
    events.emit(`issuance-${req.body.registrationId}`, {type: "message", message: `Posting Create Credential Request to: ${createCredentialSupportedUrl}`});
    events.emit(`issuance-${req.body.registrationId}`, {type: "debug-message", message: "Request options", data: createCredentialSupportedOptions});
    const supportedCredentialData = await fetchApiData(
      createCredentialSupportedUrl,
      createCredentialSupportedOptions
    );
    jwtVcSupportedCredID = supportedCredentialData.supported_cred_id;
    jwtVcSupportedCredCreated = true;
  }

   logger.info(jwtVcSupportedCredID);

  // Create bitstring status list Configuration
  const statusListCreateUrl = `${API_BASE_URL}/status-list/defs`;
  const statusListCreateOptions = {
    method: "POST",
    headers: commonHeaders,
    body: JSON.stringify({
      issuer_did: issuerDID,
      list_size: 131072,
      list_type: "w3c",
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
    supported_cred_id: jwtVcSupportedCredID,
    verification_method: issuerDID+"#0"
    })
  };

  if (!jwtStatusListCreated){
    events.emit(`issuance-${req.body.registrationId}`, {type: "message", message: `Posting Create Status List Request to: ${statusListCreateUrl}`});
    events.emit(`issuance-${req.body.registrationId}`, {type: "debug-message", message: "Request options", data: statusListCreateOptions});
    const statusListResponse = await fetchApiData(statusListCreateUrl, statusListCreateOptions);
    jwtStatusListID = statusListResponse.id;
    events.emit(`issuance-${req.body.registrationId}`, {type: "message", message: `Created Status List ID: ${jwtStatusListID}`});
    jwtStatusListCreated = true;
  };

  // Create Credential Exchange records
  const exchangeCreateUrl = `${API_BASE_URL}/oid4vci/exchange/create`;
  const exchangeCreateOptions = {
    credential_subject: { id: req.body.registrationId, first_name: firstName, last_name: lastName, email },
    did: issuerDID,
    verification_method: issuerDID+"#0",
    supported_cred_id: jwtVcSupportedCredID,
  };
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
  exchangeCache.set(exchangeId, { exchangeId, credentialOffer, did: issuerDID, jwtVcSupportedCredID, registrationId: req.body.registrationId });

  // Polling for the credential is an option at this stage, but we opt to just listen for the appropriate webhook instead
  events.emit(`issuance-${req.body.registrationId}`, {type: "message", message: "Begin listening for credential to be issued."});
}


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
            "background_color": "#12107c",
            "text_color": "#FFFFFF"
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

  const isRefresh = req.body['is-refresh'] === 'on';
  const refreshId = req.body['refresh-id'];

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
  
  let exchangeId;
  if (isRefresh) {
    const refreshUrl = `${API_BASE_URL}/oid4vci/credential-refresh/${refreshId}`;
    events.emit(`issuance-${req.body.registrationId}`, {type: "message", message: `Posting Credential Refresh Request to: ${refreshUrl}`});
    events.emit(`issuance-${req.body.registrationId}`, {type: "debug-message", message: "Request options", data: exchangeCreateOptions});
    const exchangeResponse = await axios.patch(refreshUrl, exchangeCreateOptions);
    exchangeId = exchangeResponse.data.exchange_id;
  } else {
    const exchangeCreateUrl = `${API_BASE_URL}/oid4vci/exchange/create`;
    events.emit(`issuance-${req.body.registrationId}`, {type: "message", message: "Generating Credential Exchange."});
    events.emit(`issuance-${req.body.registrationId}`, {type: "message", message: `Posting Credential Exchange Creation Request to: ${exchangeCreateUrl}`});
    events.emit(`issuance-${req.body.registrationId}`, {type: "debug-message", message: "Request options", data: exchangeCreateOptions});
    const exchangeResponse = await axios.post(exchangeCreateUrl, exchangeCreateOptions);
    exchangeId = exchangeResponse.data.exchange_id;
  }
  events.emit(`issuance-${req.body.registrationId}`, {type: "message", message: `Received Credential Exchange ID: ${exchangeId}`});


  if (!isRefresh) {
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
  } else {
    events.emit(`issuance-${req.body.registrationId}`, {type: "message", message: "Credential Refresh API call was successful."});
  }
}

// X.509 onboarding and SD-JWT VC issuance signed with a certificate (x5c)
//
// Instead of a DID, the credential is signed by a bare wallet key that has a
// certificate bound to it. The certificate chain travels in the JWT's x5c
// header, so verifiers identify the issuer through PKI rather than DID
// resolution. The "X.509 Onboarding" tab walks through setting up the key:
//   1. create a P-256 key in the issuer wallet        POST /wallet/keys
//   2. have the wallet build a CSR for it             POST /wallet/keys/{multikey}/csr
//   3. sign the CSR with a CA (here: a local demo CA, using openssl)
//   4. bind the issued chain to the key               POST /wallet/keys/{multikey}/certificate
// Issuance then references the key from the supported credential (signing_key + iss).

const execFileAsync = promisify(execFile);

async function openssl(args) {
  return execFileAsync("openssl", args);
}

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "x509-demo-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// A throwaway root CA, generated once per demo-app run. In production the CSR
// goes to a real CA and its root is distributed to verifiers as a trust anchor.
let demoCa = null;
async function getDemoCa() {
  if (demoCa) return demoCa;
  demoCa = await withTempDir(async (dir) => {
    const keyFile = path.join(dir, "ca.key");
    const certFile = path.join(dir, "ca.pem");
    await openssl(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", keyFile]);
    await openssl([
      "req", "-x509", "-new", "-key", keyFile, "-sha256", "-days", "3650",
      "-subj", "/C=CA/O=OID4VC Demo/CN=OID4VC Demo Root CA",
      "-addext", "basicConstraints=critical,CA:TRUE",
      "-addext", "keyUsage=critical,keyCertSign,cRLSign",
      "-addext", "subjectKeyIdentifier=hash",
      "-out", certFile,
    ]);
    return {
      keyPem: await readFile(keyFile, "utf8"),
      certPem: await readFile(certFile, "utf8"),
    };
  });
  return demoCa;
}

// Verify the CSR's proof of possession, then issue a leaf certificate for it.
// The SAN carries the issuer URL so verifiers can match it against `iss`.
async function signCsrWithDemoCa(csrPem, issuerUrl) {
  const ca = await getDemoCa();
  return withTempDir(async (dir) => {
    const files = {
      caKey: path.join(dir, "ca.key"),
      caCert: path.join(dir, "ca.pem"),
      csr: path.join(dir, "leaf.csr"),
      ext: path.join(dir, "leaf.ext"),
      leaf: path.join(dir, "leaf.pem"),
    };
    await writeFile(files.caKey, ca.keyPem);
    await writeFile(files.caCert, ca.certPem);
    await writeFile(files.csr, csrPem);
    await writeFile(files.ext, [
      "basicConstraints=critical,CA:FALSE",
      "keyUsage=critical,digitalSignature",
      `subjectAltName=DNS:${new URL(issuerUrl).hostname},URI:${issuerUrl}`,
      "subjectKeyIdentifier=hash",
      "authorityKeyIdentifier=keyid",
      "",
    ].join("\n"));

    // Fails if the CSR was not signed by the key it names.
    await openssl(["req", "-in", files.csr, "-verify", "-noout"]);
    await openssl([
      "x509", "-req", "-in", files.csr,
      "-CA", files.caCert, "-CAkey", files.caKey,
      // Positive 128-bit serial (leading byte kept below 0x80).
      "-set_serial", "0x" + (randomBytes(1)[0] & 0x7f).toString(16).padStart(2, "0") + randomBytes(15).toString("hex"),
      "-days", "365", "-sha256", "-extfile", files.ext, "-out", files.leaf,
    ]);
    return readFile(files.leaf, "utf8");
  });
}

// Human-readable summary of a CSR or certificate, for display.
async function describePem(kind, pem) {
  return withTempDir(async (dir) => {
    const file = path.join(dir, "in.pem");
    await writeFile(file, pem);
    const args = kind === "csr"
      ? ["req", "-in", file, "-noout", "-subject", "-verify"]
      : ["x509", "-in", file, "-noout", "-subject", "-issuer", "-serial", "-dates",
         "-ext", "subjectAltName,keyUsage,basicConstraints"];
    const { stdout, stderr } = await openssl(args);
    return (stdout + stderr).trim();
  });
}

function tenantHeaders() {
  const headers = {
    accept: "application/json",
    "Content-Type": "application/json",
    "Authorization": "Bearer " + token.token,
  };
  if (API_KEY) {
    headers["X-API-KEY"] = API_KEY;
  }
  return headers;
}

function newX509State() {
  return {
    iss: null,
    multikey: null,
    keyRequest: null,
    keyResponse: null,
    csrRequest: null,
    csrPem: null,
    csrText: null,
    caCertPem: null,
    caText: null,
    leafCertPem: null,
    leafText: null,
    importResponse: null,
    keyRecord: null,
    error: null,
    errorStep: null,
  };
}
let x509 = newX509State();

// The next step to run; 5 means onboarding is complete.
function x509NextStep() {
  if (!x509.multikey) return 1;
  if (!x509.csrPem) return 2;
  if (!x509.leafCertPem) return 3;
  if (!x509.importResponse) return 4;
  return 5;
}

const x509Steps = {
  // 1. Create a key pair in the issuer's wallet.
  1: async () => {
    x509.keyRequest = { alg: "p256" };
    const response = await axios.post(`${API_BASE_URL}/wallet/keys`, x509.keyRequest, { headers: tenantHeaders() });
    x509.keyResponse = response.data;
    x509.multikey = response.data.multikey;
  },

  // 2. The wallet builds and signs a CSR; the private key never leaves it.
  2: async () => {
    // The credential issuer identifier doubles as `iss` and goes in the certificate.
    const metadataUrl = `${OID4VCI_INTERNAL_URL}/.well-known/openid-credential-issuer/tenant/${WALLET_ID}`;
    x509.iss = (await axios.get(metadataUrl)).data.credential_issuer;
    // The hostname goes in the certificate's SAN (step 3), which is what
    // verifiers match. CN is capped at 64 characters, too short for many
    // hosted hostnames, so it carries a label instead.
    x509.csrRequest = {
      subject: {
        country: "CA",
        organization: "OID4VC Demo Issuer",
        common_name: "OID4VC Demo Issuer",
      },
    };
    const response = await axios.post(
      `${API_BASE_URL}/wallet/keys/${x509.multikey}/csr`, x509.csrRequest, { headers: tenantHeaders() }
    );
    x509.csrPem = response.data.csr_pem;
    x509.csrText = await describePem("csr", x509.csrPem);
  },

  // 3. The CA (a local demo CA here) issues a certificate for the CSR.
  3: async () => {
    const ca = await getDemoCa();
    x509.caCertPem = ca.certPem;
    x509.caText = await describePem("cert", ca.certPem);
    x509.leafCertPem = await signCsrWithDemoCa(x509.csrPem, x509.iss);
    x509.leafText = await describePem("cert", x509.leafCertPem);
  },

  // 4. Bind the chain (leaf first) to the key; the wallet checks they match.
  4: async () => {
    const response = await axios.post(
      `${API_BASE_URL}/wallet/keys/${x509.multikey}/certificate`,
      { certificate_pem: x509.leafCertPem + x509.caCertPem },
      { headers: tenantHeaders() }
    );
    x509.importResponse = response.data;
    x509.keyRecord = (await axios.get(
      `${API_BASE_URL}/wallet/keys/${x509.multikey}`, { headers: tenantHeaders() }
    )).data;
  },
};

function errorDetail(err) {
  return String(
    err?.response?.data ? JSON.stringify(err.response.data) : (err?.stderr || err.message)
  );
}

async function issue_sdjwt_x509_credential(req, res) {
  res.status(200).send("");
  const registrationId = req.body.registrationId;
  const emit = (message) => events.emit(`issuance-${registrationId}`, {type: "message", message});
  const emitDebug = (message, data) => events.emit(`issuance-${registrationId}`, {type: "debug-message", message, data});
  emit("Received credential data from user. Issuing an SD-JWT VC signed with an X.509 certificate.");

  const { fname: firstName, lname: lastName } = req.body;
  const headers = tenantHeaders();

  if (x509NextStep() !== 5) {
    emit(`<span style="color: #c62828;"><b>X.509 onboarding is not complete.</b> Finish the steps in the "X.509 Onboarding" tab first (next step: ${x509NextStep()} of 4).</span>`);
    return;
  }

  try {
    emit(`Signing with X.509 key ${x509.multikey} (iss: ${x509.iss}).`);

    // A new key after an onboarding reset needs its own supported credential.
    if (sdJwtX509SupportedCredKey !== x509.multikey) {
      const supportedUrl = `${API_BASE_URL}/oid4vci/credential-supported/create/sd-jwt`;
      const supportedBody = {
        format: "vc+sd-jwt",
        id: `IDCardX509-${x509.multikey.slice(-8)}`,
        vct: "ExampleIDCard",
        // signing_key selects the wallet key; its certificate chain becomes the
        // x5c header. iss is required because there is no DID to derive it from.
        signing_key: x509.multikey,
        iss: x509.iss,
        proof_types_supported: {
          jwt: { proof_signing_alg_values_supported: ["ES256"] },
        },
        cryptographic_binding_methods_supported: ["jwk"],
        credential_signing_alg_values_supported: ["ES256"],
        sd_list: [
          "/given_name",
          "/family_name",
          "/age_is_over_18",
          "/age_is_over_21",
          "/age_is_over_65",
        ],
        credential_metadata: {
          display: [
            {
              name: "ID Card (X.509)",
              locale: "en-US",
              background_color: "#0b5d1e",
              text_color: "#FFFFFF",
            },
          ],
          claims: [
            { path: ["given_name"], display: [{ name: "Given Name", locale: "en-US" }] },
            { path: ["family_name"], display: [{ name: "Family Name", locale: "en-US" }] },
            { path: ["age_is_over_18"], display: [{ name: "Age 18 or Over", locale: "en-US" }] },
            { path: ["age_is_over_21"], display: [{ name: "Age 21 or Over", locale: "en-US" }] },
            { path: ["age_is_over_65"], display: [{ name: "Age 65 or Over", locale: "en-US" }] },
          ],
        },
      };
      emit(`Creating supported credential that signs with the X.509 key: ${supportedUrl}`);
      emitDebug("Request options", supportedBody);
      const supported = (await axios.post(supportedUrl, supportedBody, { headers })).data;
      sdJwtX509SupportedCredID = supported.supported_cred_id;
      sdJwtX509SupportedCredKey = x509.multikey;
      emit(`Created supported credential: ${sdJwtX509SupportedCredID}`);
    }

    // The exchange API still requires a DID; with signing_key set it is not
    // used for signing, and iss comes from the supported credential.
    const exchangeBody = {
      did: issuerDID,
      supported_cred_id: sdJwtX509SupportedCredID,
      credential_subject: {
        given_name: firstName,
        family_name: lastName,
        age_is_over_18: true,
        age_is_over_21: true,
        age_is_over_65: false,
      },
    };
    const exchangeUrl = `${API_BASE_URL}/oid4vci/exchange/create`;
    emit(`Posting Credential Exchange Creation Request to: ${exchangeUrl}`);
    emitDebug("Request options", exchangeBody);
    const exchangeId = (await axios.post(exchangeUrl, exchangeBody, { headers })).data.exchange_id;
    emit(`Received Credential Exchange ID: ${exchangeId}`);

    const offerUrl = `${API_BASE_URL}/oid4vci/credential-offer`;
    emit(`Retrieving Credential Offer from: ${offerUrl}`);
    const credentialOffer = (await axios.get(offerUrl, {
      params: { user_pin_required: false, exchange_id: exchangeId },
      headers,
    })).data;
    const qrcode = credentialOffer.credential_offer ?? credentialOffer.credential_offer_uri;

    emit(`Sending offer to user: ${qrcode}`);
    events.emit(`issuance-${registrationId}`, {type: "qrcode", credentialOffer, exchangeId, qrcode});
    exchangeCache.set(exchangeId, { exchangeId, credentialOffer, sdJwtX509SupportedCredID, registrationId });
    emit("Begin listening for credential to be issued. The issued SD-JWT carries an x5c header instead of kid.");
  } catch (err) {
    const detail = errorDetail(err).replace(/</g, "&lt;").replace(/\r?\n/g, " ");
    logger.error(`X.509 SD-JWT issuance failed: ${detail}`);
    emit(`<span style="color: #c62828;"><b>X.509 issuance failed:</b> ${detail}</span>`);
  }
}

// Begin Issue mDL (mso_mdoc) Credential Flow
async function issue_mdoc_credential(req, res) {
  res.status(200).send("");
  events.emit(`issuance-${req.body.registrationId}`, {type: "message", message: "Received mDL credential data from user."});

  console.log("req.body", req.body);
  const {
    family_name,
    given_name,
    birth_date,
    issue_date,
    expiry_date,
    issuing_authority,
    document_number,
    issuing_country,
    un_distinguishing_sign,
    portrait,
  } = req.body;

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

  const createCredentialSupportedUrl = `${API_BASE_URL}/oid4vci/credential-supported/create/mso-mdoc`;
  const createCredentialSupportedOptions = {
    method: "POST",
    headers: commonHeaders,
    body: JSON.stringify({
      format: "mso_mdoc",
      id: "org.iso.18013.5.1.mDL",
      doctype: "org.iso.18013.5.1.mDL",
      signing_key_id: mdocKeyId,
      cryptographic_binding_methods_supported: ["jwk"],
      credential_signing_alg_values_supported: [
        "ES256"
      ],
      proof_types_supported: {
        jwt: {
          proof_signing_alg_values_supported: [
            "ES256"
          ]
        }
      },
      "credential_metadata": {
        claims: [
          { path: ["org.iso.18013.5.1", "given_name"], display: [{ name: "Given Name", locale: "en-US" }] },
          { path: ["org.iso.18013.5.1", "family_name"], display: [{ name: "Family Name", locale: "en-US" }] },
          { path: ["org.iso.18013.5.1", "birth_date"], display: [{ name: "Birth Date", locale: "en-US" }] },
          { path: ["org.iso.18013.5.1", "issue_date"], display: [{ name: "Issue Date", locale: "en-US" }] },
          { path: ["org.iso.18013.5.1", "expiry_date"], display: [{ name: "Expiry Date", locale: "en-US" }] },
          { path: ["org.iso.18013.5.1", "issuing_authority"], display: [{ name: "Issuing Authority", locale: "en-US" }] },
          { path: ["org.iso.18013.5.1", "document_number"], display: [{ name: "Document Number", locale: "en-US" }] },
          { path: ["org.iso.18013.5.1", "issuing_country"], display: [{ name: "Issuing Country", locale: "en-US" }] },
          { path: ["org.iso.18013.5.1", "un_distinguishing_sign"], display: [{ name: "UN Distinguishing Sign", locale: "en-US" }] },
          { path: ["org.iso.18013.5.1", "portrait"], display: [{ name: "Portrait", locale: "en-US" }] }
        ],
        display: [
          {
            name: "Sample Driving License",
            locale: "en-US",
            background_image: {
              uri: "data:image/png;base64,iVBORw0KGgoAAAANS",
              alt_text: "Driver's License Background"
            }
          }
        ],
      },
    }),
  };

  if (!mdocSupportedCredCreated) {
    events.emit(`issuance-${req.body.registrationId}`, {type: "message", message: `Posting Create Credential Request to: ${createCredentialSupportedUrl}`});
    events.emit(`issuance-${req.body.registrationId}`, {type: "debug-message", message: "Request options", data: createCredentialSupportedOptions});
    console.log("Creating mDL supported credential", createCredentialSupportedOptions);
    const supportedCredentialData = await fetchApiData(
      createCredentialSupportedUrl,
      createCredentialSupportedOptions
    );
    mdocSupportedCredID = supportedCredentialData.supported_cred_id;
    mdocSupportedCredCreated = true;
  }

  logger.info(mdocSupportedCredID);
  
  // Create credential exchange
  const exchangeCreateUrl = `${API_BASE_URL}/oid4vci/exchange/create`;
 
  console.log("FAMILY NAME", family_name);
  const exchangeCreateOptions = {
      supported_cred_id: mdocSupportedCredID,
      credential_subject: {
        "org.iso.18013.5.1": {
          family_name,
          given_name,
          birth_date,
          issue_date,
          expiry_date,
          issuing_country,
          issuing_authority,
          document_number,
          portrait,
          un_distinguishing_sign,
        }
      },
      verification_method: issuerDID + "#0",
  };

  events.emit(`issuance-${req.body.registrationId}`, {type: "message", message: "Generating Credential Exchange."});
  events.emit(`issuance-${req.body.registrationId}`, {type: "message", message: `Posting Credential Exchange Creation Request to: ${exchangeCreateUrl}`});
  events.emit(`issuance-${req.body.registrationId}`, {type: "debug-message", message: "Request options", data: exchangeCreateOptions});
  
  const exchangeResponse = await axios.post(exchangeCreateUrl, exchangeCreateOptions);
  const exchangeId = exchangeResponse.data.exchange_id;
  events.emit(`issuance-${req.body.registrationId}`, {type: "message", message: `Received Credential Exchange ID: ${exchangeId}`});
  
  
  // Get credential offer and emit QR code as in other flows
  const credentialOfferUrl = `${API_BASE_URL}/oid4vci/credential-offer`;
  const queryParams = {
    exchange_id: exchangeId,
    user_pin_required: false,
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
  
  let qrcode;
  if (credentialOffer.credential_offer) {
    qrcode = credentialOffer.credential_offer;
  } else {
    qrcode = credentialOffer.credential_offer_uri;
  } 
  logger.info(JSON.stringify(offerResponse.data));
  logger.info(exchangeId);
  events.emit(`issuance-${req.body.registrationId}`, {type: "message", message: `Sending offer to user: ${qrcode}`});
  events.emit(`issuance-${req.body.registrationId}`, {type: "qrcode", credentialOffer, exchangeId, qrcode});
  exchangeCache.set(exchangeId, { exchangeId, credentialOffer, mdocSupportedCredID, registrationId: req.body.registrationId });

  events.emit(`issuance-${req.body.registrationId}`, {type: "message", message: "Begin listening for credential to be issued."});
}

// Begin JWT VC JSON Presentation Flow
async function create_jwt_vc_presentation(req, res) {
  const presentationId = req.params.id;
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


  // Create Presentation Definition
  events.emit(`presentation-${presentationId}`, {type: "message", message: "Creating Presentation Definition."});
  const presentationDefinition = {"pres_def": {
    "id": uuidv4(),
    "purpose": "Present basic profile info",
    "format": {
      "jwt_vc_json": {
        "alg": [
          "ES256"
        ]
      },
      "jwt_vp_json": {
        "alg": [
          "ES256"
        ]
      },
      "jwt_vc": {
        "alg": [
          "ES256"
        ]
      },
      "jwt_vp": {
        "alg": [
          "ES256"
        ]
      }
    },
    "input_descriptors": [
      {
        "id": "4ce7aff1-0234-4f35-9d21-251668a60950",
        "name": "Profile",
        "purpose": "Present basic profile info",
        "constraints": {
          "fields": [
            {
              "name": "name",
              "path": [
                "$.vc.credentialSubject.first_name",
                "$.credentialSubject.first_name"
              ],
              "filter": {
                "type": "string",
                "pattern": "^.{1,64}$"
              }
            },
            {
              "name": "lastname",
              "path": [
                "$.vc.credentialSubject.last_name",
                "$.credentialSubject.last_name"
              ],
              "filter": {
                "type": "string",
                "pattern": "^.{1,64}$"
              }
            }
          ]
        }
      }
    ]
  }
  };

  const presentationDefinitionUrl = `${API_BASE_URL}/oid4vp/presentation-definition`;
  const presentationDefinitionOptions = {
    method: "POST",
    headers: commonHeaders,
    body: JSON.stringify(presentationDefinition),
  };
  logger.warn(presentationDefinitionUrl);
  events.emit(`presentation-${presentationId}`, {type: "message", message: `Posting Presentation Definition to: ${presentationDefinitionUrl}`});
  events.emit(`presentation-${presentationId}`, {type: "debug-message", message: "Request options", data: presentationDefinitionOptions});
  const presentationDefinitionData = await fetchApiData(
    presentationDefinitionUrl,
    presentationDefinitionOptions
  );
  logger.info("Created presentation?");
  logger.trace(JSON.stringify(presentationDefinitionData));
  logger.trace(presentationDefinitionData.pres_def_id);
  events.emit(`presentation-${presentationId}`, {type: "message", message: `Created Presentation Definition`});
  events.emit(`presentation-${presentationId}`, {type: "message", message: `Presentation Definition ID: ${presentationDefinitionData.pres_def_id}`});
  events.emit(`presentation-${presentationId}`, {type: "debug-message", message: "Response data", data: presentationDefinitionData});


  // Create Presentation Request
  const presentationRequestUrl = `${API_BASE_URL}/oid4vp/request`;
  const presentationRequestOptions = {
    method: "POST",
    headers: commonHeaders,
    body: JSON.stringify({
      "pres_def_id": presentationDefinitionData.pres_def_id,
      "vp_formats": {
        "jwt_vc": { "alg": [ "ES256", "EdDSA" ] },
        "jwt_vp": { "alg": [ "ES256", "EdDSA" ] },
        "jwt_vc_json": { "alg": [ "ES256", "EdDSA" ] },
        "jwt_vp_json": { "alg": [ "ES256", "EdDSA" ] }
      },
    }),
  };
  events.emit(`presentation-${presentationId}`, {type: "message", message: `Generating Presentation Request.`});
  events.emit(`presentation-${presentationId}`, {type: "message", message: `Posting Presentation Request to: ${presentationRequestUrl}`});
  events.emit(`presentation-${presentationId}`, {type: "debug-message", message: "Request options", data: presentationRequestOptions});
  const presentationRequestData = await fetchApiData(
    presentationRequestUrl,
    presentationRequestOptions
  );
  events.emit(`presentation-${presentationId}`, {type: "message", message: `Generated Presentation Request.`});
  events.emit(`presentation-${presentationId}`, {type: "message", message: `Presentation Request URI: ${presentationRequestData?.request_uri}`});
  events.emit(`presentation-${presentationId}`, {type: "debug-message", message: "Response data", data: presentationRequestData});

  // Grab the relevant data and store it for later reference while waiting for the webhooks from ACA-Py
  let code = presentationRequestData.request_uri;
  presentationCache.set(presentationDefinitionData.pres_def_id, { presentationDefinitionData, presentationRequestData, presentationId: presentationId });
  logger.trace(JSON.stringify(presentationRequestData, null, 2));

  // Generate a QRCode and return it to the browser (HTMX replaces a div with our current response)
  var qrcode = new QRCode({
    content: code,
    padding: 4,
    width: 256,
    height: 256,
    color: "#000000",
    background: "#ffffff",
    ecl: "M",
  });
  qrcode = qrcode.svg()
  qrcode = qrcode.substring(qrcode.indexOf('?>')+2,qrcode.length)
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(qrcode);

  // Polling for the credential is an option at this stage, but we opt to just listen for the appropriate webhook instead
}

// Begin SD-JWT Presentation Flow
async function create_sd_jwt_presentation(req, res) {
  const presentationId = req.params.id;
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


  // Create Presentation Definition
  events.emit(`presentation-${presentationId}`, {type: "message", message: "Creating Presentation Definition."});
  const presentationDefinition = {"pres_def": {
    "id": uuidv4(),
    "purpose": "Present basic profile info",
    "input_descriptors": [
      {
        "format": {
          "vc+sd-jwt": {}
        },
        "id": "ID Card",
        "name": "Profile",
        "purpose": "Present basic profile info",
        "constraints": {
          "limit_disclosure": "required",
          "fields": [
            {
              "path": [
                "$.vct"
              ],
              "filter": {
                "type": "string"
              }
            },
            {
              "path": [
                "$.family_name"
              ]
            },
            {
              "path": [
                "$.given_name"
              ]
            },
            {
              "path": [
                "$.something_nested.key1.key2.key3"
              ]
            },
          ]
        }
      }
    ]
  }};

  const presentationDefinitionUrl = `${API_BASE_URL}/oid4vp/presentation-definition`;
  const presentationDefinitionOptions = {
    method: "POST",
    headers: commonHeaders,
    body: JSON.stringify(presentationDefinition),
  };
  logger.warn(presentationDefinitionUrl);
  events.emit(`presentation-${presentationId}`, {type: "message", message: `Posting Presentation Definition to: ${presentationDefinitionUrl}`});
  events.emit(`presentation-${presentationId}`, {type: "debug-message", message: "Request options", data: presentationDefinitionOptions});
  const presentationDefinitionData = await fetchApiData(
    presentationDefinitionUrl,
    presentationDefinitionOptions
  );
  logger.info("Created presentation?");
  logger.trace(JSON.stringify(presentationDefinitionData));
  logger.trace(presentationDefinitionData.pres_def_id);
  events.emit(`presentation-${presentationId}`, {type: "message", message: `Created Presentation Definition`});
  events.emit(`presentation-${presentationId}`, {type: "message", message: `Presentation Definition ID: ${presentationDefinitionData.pres_def_id}`});
  events.emit(`presentation-${presentationId}`, {type: "debug-message", message: "Response data", data: presentationDefinitionData});


  // Create Presentation Request
  const presentationRequestUrl = `${API_BASE_URL}/oid4vp/request`;
  const presentationRequestOptions = {
    method: "POST",
    headers: commonHeaders,
    body: JSON.stringify({
      "pres_def_id": presentationDefinitionData.pres_def_id,
      "vp_formats": {
        "vc+sd-jwt": {
            "sd-jwt_alg_values": [
                "ES256",
                "ES384"
            ],
            "kb-jwt_alg_values": [
                "ES256",
                "ES384"
            ]
        }
      },
    }),
  };
  events.emit(`presentation-${presentationId}`, {type: "message", message: `Generating Presentation Request.`});
  events.emit(`presentation-${presentationId}`, {type: "message", message: `Posting Presentation Request to: ${presentationRequestUrl}`});
  events.emit(`presentation-${presentationId}`, {type: "debug-message", message: "Request options", data: presentationRequestOptions});
  const presentationRequestData = await fetchApiData(
    presentationRequestUrl,
    presentationRequestOptions
  );
  events.emit(`presentation-${presentationId}`, {type: "message", message: `Generated Presentation Request.`});
  events.emit(`presentation-${presentationId}`, {type: "message", message: `Presentation Request URI: ${presentationRequestData?.request_uri}`});
  events.emit(`presentation-${presentationId}`, {type: "debug-message", message: "Response data", data: presentationRequestData});

  // Grab the relevant data and store it for later reference while waiting for the webhooks from ACA-Py
  let code = presentationRequestData.request_uri;
  presentationCache.set(presentationDefinitionData.pres_def_id, { presentationDefinitionData, presentationRequestData, presentationId: presentationId });
  logger.trace(JSON.stringify(presentationRequestData, null, 2));

  // Generate a QRCode and return it to the browser (HTMX replaces a div with our current response)
  var qrcode = new QRCode({
    content: code,
    padding: 4,
    width: 256,
    height: 256,
    color: "#000000",
    background: "#ffffff",
    ecl: "M",
  });
  qrcode = qrcode.svg()
  qrcode = qrcode.substring(qrcode.indexOf('?>')+2,qrcode.length)
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(qrcode);

  // Polling for the credential is an option at this stage, but we opt to just listen for the appropriate webhook instead
}

// Begin mDOC Presentation Flow (DCQL)
async function create_mdoc_presentation(req, res) {
  const presentationId = req.params.id;
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

  // Create DCQL Query for mDL
  events.emit(`presentation-${presentationId}`, {type: "message", message: "Creating DCQL Query for mDL."});
  const dcqlQueryUrl = `${API_BASE_URL}/oid4vp/dcql/queries`;
  const dcqlQueryOptions = {
    method: "POST",
    headers: commonHeaders,
    body: JSON.stringify({
      credentials: [
        {
          id: "mDL",
          format: "mso_mdoc",
          meta: {
            doctype_value: "org.iso.18013.5.1.mDL"
          },
          claims: [
            { namespace: "org.iso.18013.5.1", claim_name: "family_name" },
            { namespace: "org.iso.18013.5.1", claim_name: "given_name" },
            { namespace: "org.iso.18013.5.1", claim_name: "document_number" },
            { namespace: "org.iso.18013.5.1", claim_name: "issuing_country" },
            { namespace: "org.iso.18013.5.1", claim_name: "expiry_date" },
          ],
        }
      ]
    }),
  };
  events.emit(`presentation-${presentationId}`, {type: "message", message: `Posting DCQL Query to: ${dcqlQueryUrl}`});
  events.emit(`presentation-${presentationId}`, {type: "debug-message", message: "Request options", data: dcqlQueryOptions});
  const dcqlQueryData = await fetchApiData(dcqlQueryUrl, dcqlQueryOptions);
  const dcqlQueryId = dcqlQueryData.dcql_query_id;
  events.emit(`presentation-${presentationId}`, {type: "message", message: `Created DCQL Query ID: ${dcqlQueryId}`});
  events.emit(`presentation-${presentationId}`, {type: "debug-message", message: "Response data", data: dcqlQueryData});

  // Create Presentation Request using the DCQL query
  const presentationRequestUrl = `${API_BASE_URL}/oid4vp/request`;
  const presentationRequestOptions = {
    method: "POST",
    headers: commonHeaders,
    body: JSON.stringify({
      dcql_query_id: dcqlQueryId,
      vp_formats: {
        mso_mdoc: {
          alg: ["ES256"]
        }
      },
    }),
  };
  events.emit(`presentation-${presentationId}`, {type: "message", message: `Generating Presentation Request.`});
  events.emit(`presentation-${presentationId}`, {type: "message", message: `Posting Presentation Request to: ${presentationRequestUrl}`});
  events.emit(`presentation-${presentationId}`, {type: "debug-message", message: "Request options", data: presentationRequestOptions});
  const presentationRequestData = await fetchApiData(
    presentationRequestUrl,
    presentationRequestOptions
  );
  events.emit(`presentation-${presentationId}`, {type: "message", message: `Generated Presentation Request.`});
  events.emit(`presentation-${presentationId}`, {type: "message", message: `Presentation Request URI: ${presentationRequestData?.request_uri}`});
  events.emit(`presentation-${presentationId}`, {type: "debug-message", message: "Response data", data: presentationRequestData});

  // Grab the relevant data and store it for later reference while waiting for the webhooks from ACA-Py
  let code = presentationRequestData.request_uri;
  presentationCache.set(dcqlQueryId, { dcqlQueryData, presentationRequestData, presentationId: presentationId });
  logger.trace(JSON.stringify(presentationRequestData, null, 2));

  // Generate a QRCode and return it to the browser (HTMX replaces a div with our current response)
  var qrcode = new QRCode({
    content: code,
    padding: 4,
    width: 256,
    height: 256,
    color: "#000000",
    background: "#ffffff",
    ecl: "M",
  });
  qrcode = qrcode.svg()
  qrcode = qrcode.substring(qrcode.indexOf('?>')+2,qrcode.length)
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(qrcode);
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

function handleEvents(event_type, req, res) {
  // Send headers indicating that this is an HTMX stream
  res.writeHead(200, {
    "Connection": "keep-alive",
    "Cache-Control": "no-cache",
    "Content-Type": "text/event-stream",
  });

  // Reset data
  logger.trace("HTMX Stream started!");
  res.write(`event: debug\ndata: \n\n`);
  res.write(`event: qrcode\ndata: \n\n`);
  let state = ""

  // When we receive an event
  events.on(`${event_type}-${req.params.id}`, (data) => {

    // Send messages verbatim
    if (data.type == "message") {
      res.write(`event: message\ndata: ${data.message}<br />\n\n`);
      return;
    }
    // Debug messages get special formatting
    if (data.type == "debug-message") {
      res.write(`event: message\ndata: <div style="text-indent: -1rem; padding-left: 1rem;">&gt; ${data.message}: ${JSON.stringify(data.data)}</div>\n\n`);
    }

    // Webhooks mean that ACA-Py sent us data regarding presentations or credential issuance
    if (data.type == "webhook") {

      // Log it for debugging
      logger.trace(JSON.stringify(data, null, 2));
      res.write(`event: message\ndata: <div style="text-indent: -1rem; padding-left: 1rem;">&gt; Webhook data: ${JSON.stringify(data.data)}</div>\n\n`);

      // Grab the state
      state = data?.data?.state;

      // Handle OID4VP webhooks
      if (data.path == "/webhook/topic/oid4vp/") {
        if (state == "request-retrieved")
          res.write(`event: status\ndata: <div style="text-align: center;">QRCode Scanned, awaiting presentation...</div>\n\n`);
        if (state == "presentation-invalid")
          res.write(`event: status\ndata: <div style="text-align: center;">Presentaion verification failed</div>\n\n`);
        if (state == "presentation-valid")
          res.write(`event: status\ndata: <div style="text-align: center;">Presentation Verified!</div>\n\n`);
      }

      // Handle OID4VCI webhooks
      if (data.path == "/webhook/topic/oid4vci/") {
        if (state == "issued") {
          res.write(`event: qrcode\ndata: Credential Issued!\n\n`);
          return;
        }
      }
    }
    res.write(`event: debug\ndata: ${JSON.stringify(data)}\n\n`);

    // For OID4VCI: when we receive a "qrcode" message, generate a code and send it to the browser
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
      res.write(`event: qrcode\ndata: ${qrcode.svg().replace(/\r?\n|\r/g, " ")}\n\n`);
    }
  });

  res.on("close", () => {
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

const token = await fetchApiData(
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

console.log("_______TOKEN________\n\n\n");
console.log(token);

const WALLET_ID = token.settings["wallet.id"];

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
        // Tenant names are unique on the auth server, and each demo-app start
        // creates a new wallet; naming by wallet ID lets the demo-app restart
        // without hitting a duplicate name.
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

// Import Certificate and private key.
let mdocKeyId = null;
async function initializeMdocSigningKey() {
  try {
    const commonHeaders = {
      accept: "application/json",
      "Content-Type": "application/json",
      "Authorization": "Bearer " + token.token,
    }
    const createKeyUrl = `${API_BASE_URL}/mso-mdoc/signing-keys/import`;
    const createKeyOptions = {
      method: "POST",
      headers: commonHeaders,
      body: JSON.stringify({
          "certificate_pem": certificate_pem,
          "private_key_pem": private_key_pem,
          "doctype": "org.iso.18013.5.1.mDL",
          "label": "mDOC signing key",
      }),
    };
    logger.info(`Importing mDOC Signing Key Request to: ${createKeyUrl}`);
    logger.info("Request options", createKeyOptions);
    const keyData = await fetchApiData(createKeyUrl, createKeyOptions);
    mdocKeyId = keyData.id;
    logger.info(`Imported mDOC signing key with ID: ${mdocKeyId}`);

    // Register the certificate as a trust anchor
    const trustAnchorUrl = `${API_BASE_URL}/mso-mdoc/trust-anchors`;
    const trustAnchorOptions = {
      method: "POST",
      headers: commonHeaders,
      body: JSON.stringify({
        certificate_pem: certificate_pem,
      }),
    };
    logger.info(`Registering mDOC trust anchor to: ${trustAnchorUrl}`);
    const trustAnchorData = await fetchApiData(trustAnchorUrl, trustAnchorOptions);
    logger.info(`Registered mDOC trust anchor:`, trustAnchorData);
  } catch (err) {
    logger.error("mDOC signing key initialization failed:", err?.response?.data || err.message);
  }
}

await initializeAuthServer();
await initializeIssuerMetadata();
await initializeSigningDid();
await initializeMdocSigningKey();


// Credential Info route
app.get("/credential-info", async (req, res, next) => {
  try {
    const recordsUrl = `${API_BASE_URL}/oid4vci/exchange/records`;
    const commonHeaders = {
      accept: "application/json",
      "Content-Type": "application/json",
      "Authorization": "Bearer " + token.token,
    };
    if (API_KEY) {
      commonHeaders["X-API-KEY"] = API_KEY;
    }

    const response = await fetch(recordsUrl, {
      method: "GET",
      headers: commonHeaders
    });
    
    if (response.ok) {
      const records = await response.json();
      res.render("credential-info", { "page": "credential-info", records: JSON.stringify(records, null, 2) });
    } else {
      const respData = await response.text();
      res.status(response.status).send(`<div class="w3-panel w3-pale-red w3-border"><p>Failed to fetch records: ${respData}</p></div>`);
    }
  } catch (err) {
    next(err);
  }
});

// Update Status routes
app.get("/update-status", (req, res) => {
  res.render("update-status-form", {"page": "update-status"});
});
app.get("/update-status/select", (req, res) => {
  res.render(`update-status-fields`, {"page": "update-status"});
});
app.post("/update-status", async (req, res, next) => {
  try {
    const credType = req.body["credential-type"];
    const credId = req.body["credential-id"];
    
    let defId = "";
    if (credType === "jwt") {
      defId = jwtStatusListID;
    } else if (credType === "sdjwt") {
      defId = sdJwtStatusListID;
    } else {
      return res.status(400).send("Invalid credential type for status update.");
    }
    
    if (!defId) {
      return res.status(400).send("Status list for this credential type has not been created yet.");
    }

    const updateUrl = `${API_BASE_URL}/status-list/defs/${defId}/creds/${credId}`;
    const commonHeaders = {
      accept: "application/json",
      "Content-Type": "application/json",
      "Authorization": "Bearer " + token.token,
    };
    if (API_KEY) {
      commonHeaders["X-API-KEY"] = API_KEY;
    }

    const response = await fetch(updateUrl, {
      method: "PATCH",
      headers: commonHeaders,
      body: JSON.stringify({ status: "1" })
    });
    
    const respData = await response.text();
    
    if (respData.includes("StatusListCred record not found")) {
      res.send(`<div class="w3-panel w3-pale-red w3-border"><p>${respData}</p></div>`);
    } else if (response.ok) {
      res.send(`<div class="w3-panel w3-pale-green w3-border"><p>Status successfully updated for Credential Exchange ID: ${credId}</p></div>`);
    } else {
      res.status(response.status).send(`<div class="w3-panel w3-pale-red w3-border"><p>Failed to update status: ${respData}</p></div>`);
    }
  } catch (err) {
    next(err);
  }
});

// X.509 Onboarding routes: each step runs on its own button press and the
// step list is re-rendered with that step's request and result.
app.get("/x509", (req, res) => {
  res.render("x509-onboarding", { page: "x509", x509, step: x509NextStep(), apiBaseUrl: API_BASE_URL });
});
app.post("/x509/step/:n", async (req, res) => {
  const n = parseInt(req.params.n);
  // Ignore out-of-order presses, e.g. a double click on a finished step.
  if (n === x509NextStep() && x509Steps[n]) {
    x509.error = null;
    x509.errorStep = null;
    try {
      await x509Steps[n]();
    } catch (err) {
      logger.error(`X.509 onboarding step ${n} failed: ${errorDetail(err)}`);
      x509.error = errorDetail(err);
      x509.errorStep = n;
    }
  }
  res.render("x509/steps", { x509, step: x509NextStep(), apiBaseUrl: API_BASE_URL });
});
app.post("/x509/reset", (req, res) => {
  x509 = newX509State();
  res.render("x509/steps", { x509, step: x509NextStep(), apiBaseUrl: API_BASE_URL });
});
app.get("/x509/ca.pem", async (req, res) => {
  const { certPem } = await getDemoCa();
  res.type("application/x-pem-file").attachment("oid4vc-demo-root-ca.pem").send(certPem);
});

// Render Credential Issuance form
app.get("/issue", (req, res) => {
  res.render("issue-form", {"page": "register", "registrationId": uuidv4()});
});
app.get("/issue/select", (req, res) => {
  console.log(req.query);
  res.render(`issue/${req.query["credential-type"]}`, {"page": "register", "registrationId": uuidv4(), x509, x509Step: x509NextStep()});
});

app.post("/issue", (req, res, next) => {
  // Begin Credential issuance flow
  //events.on(`${event_type}-${req.params.id}`, (data) => {
    console.log(req.body);
    switch(req.body["credential-type"]) {
      case "jwt":
        issue_jwt_credential(req, res).catch(next);
        break;
      case "sdjwt":
        issue_sdjwt_credential(req, res).catch(next);
        break;
      case "sdjwt-x509":
        issue_sdjwt_x509_credential(req, res).catch(next);
        break;
      case "mdoc":
        issue_mdoc_credential(req, res).catch(next);
      break;
      default:
        res.status(400).send("");
    }
  });

  // Event Stream for Issuance page
  app.get("/stream/issue/:id", (req, res) => {
    handleEvents("issuance", req, res);
  });

  app.get("/present/select/:id", (req, res) => {
    console.log(req.query);
    res.render(`present/${req.query["credential-type"]}`, {"page": "register", "presentationId": req.params.id});
  });

  // Render Presentation Exchange form
  app.get("/present", (req, res) => {
    res.render("presentation", {"page": "present", "presentationId": uuidv4()});
  });

  app.get("/present/create/:id", (req, res, next) => {
    // Begin Presentation Exchange flow

    switch(req.query["credential-type"]) {
      case "jwt":
        create_jwt_vc_presentation(req, res).catch(next);
        break;
      case "multi":
        create_jwt_vc_presentation_multi(req, res).catch(next);
        break;
      case "sdjwt":
        create_sd_jwt_presentation(req, res).catch(next);
        break;
      case "mdoc":
        create_mdoc_presentation(req, res).catch(next);
        break;
      default:
        res.status(400).send("");
    }
  });

  // Event Stream for Presentation page
  app.get("/stream/present/:id", (req, res) => {
    handleEvents("presentation", req, res);
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
      logger.trace("Webhook received");
      logger.trace(req.path);
      logger.trace(JSON.stringify(req.body));
      if (req.path == "/webhook/topic/oid4vci/") {
        // If there's no exchange ID, we can't look up the request
        if (!req.body.exchange_id) return;

        // Check to see if this belongs to us
        let exchange = exchangeCache.get(req.body.exchange_id);
        if (!exchange) return;

        // Dispatch event
        events.emit(`issuance-${exchange.registrationId}`, {type: "webhook", path: req.path, data: req.body});
      }
      if (req.path == "/webhook/topic/oid4vp/") {
        // Look up by pres_def_id or dcql_query_id
        const lookupId = req.body.pres_def_id || req.body.dcql_query_id;
        if (!lookupId) return;

        // Check to see if this belongs to us
        let exchange = presentationCache.get(lookupId);
        if (!exchange) return;

        // Dispatch event
        events.emit(`presentation-${exchange.presentationId}`, {type: "webhook", path: req.path, data: req.body});
      }
    });

  app.listen(3000, () => {
    console.log("App listening on port 3000");
  });
