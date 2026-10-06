# Developer Guide: Deploying to OpenShift

This guide explains how to use the files under `oid4vc/openshift-changes` to deploy the OID4VC service into OpenShift. These files are required for developers to set up and deploy the service correctly.

## 1. Overview
The `openshift-changes` directory contains configuration and deployment files tailored for OpenShift environments. These files must be integrated into the main deployment structure before deploying.

## 2. Required Files and Their Destinations

| Source (oid4vc/openshift-changes)         | Destination Path                             |
|-------------------------------------------|----------------------------------------------|
| `default_openshift.yml`                   | `oid4vc/docker`                              |
| `Dockerfile.oid4vc.openshift`             | `oid4vc/docker`                              |
| `Dockerfile.authserver.openshift`         | `oid4vc/auth_server/docker`                  |
| `entrypoint_authserver_openshift.sh`      | `oid4vc/auth_server/docker`                  |

## 3. Steps for Developers

1. **Copy OpenShift Files:**
   - Copy `default_openshift.yml` to `oid4vc/docker` (overwrite if exists).
   - Copy `Dockerfile.oid4vc.openshift` to `oid4vc/docker` (overwrite if exists).
   - Copy `Dockerfile.authserver.openshift` to `oid4vc/auth_server/docker` (overwrite if exists).
   - Copy `entrypoint_authserver_openshift.sh` to `oid4vc/auth_server/docker` (overwrite if exists).
   - If there are additional files in `openshift-changes`, copy them to the corresponding locations under `oid4vc/docker/` or related subfolders as appropriate.

2. **Verify Configuration:**
   - Ensure all copied files are present in their target locations.
   - Review the configuration for any environment-specific changes required (e.g., image names, secrets, resource limits).


3. **Deploy to OpenShift:**
   - Deploy using the OpenShift portal as follows:
     1. Go to the OpenShift portal: [https://console-openshift-console.apps.xkh544cb.canadacentral.aroapp.io](https://console-openshift-console.apps.xkh544cb.canadacentral.aroapp.io)
     2. In the left menu, go to **Home** > **Software Catalog**.
     3. Search for `ecp-issuing-service` in the catalog.
     4. Select the template for `ecp-issuing-service`.
     5. Click the **Instantiate Template** button.
     6. When prompted, select your namespace, your git repository for acapy-plugins, your branch and enter the namespace in the last textbox.
     7. Click **Create** to instantiate the service.
     8. Once created, go to **Routes** in the OpenShift console.
     9. Look for the `frontend` route and click on it to access the demo frontend.

## 4. Notes
- Always keep the `openshift-changes` directory up to date with any changes required for OpenShift compatibility.
- If you make changes to the deployment files, communicate with your team to ensure everyone is using the latest versions.

## 5. Troubleshooting
- If deployment fails, double-check that all files were copied to the correct locations and that there are no syntax errors in the YAML or Dockerfiles.
- Consult your team or DevOps engineer for environment-specific issues.

---

