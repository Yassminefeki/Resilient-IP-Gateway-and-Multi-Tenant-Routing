# Security and operational boundaries

This document records the security model implied by the current repository configuration and service code. It is intentionally explicit about what is verified in code and what remains a deployment concern.

## Security posture

The current control plane enforces authentication and rate limiting on mutating routes, with a default secure model unless `AUTH_DISABLED=true` is explicitly set.

Relevant code:

- [../controlplane/auth.go](../controlplane/auth.go)
- [../controlplane/server.go](../controlplane/server.go)

## Authentication

The server reads bearer credentials from the `Authorization` header and validates them against `ADMIN_TOKEN` unless the environment explicitly disables auth. Legacy fallback support for `CONTROL_PLANE_TOKEN` is present and logged as deprecated when used.

Key validation behavior:

- token length minimum is enforced
- whitespace is rejected
- CORS origin validation is enforced when configured
- mutating endpoints are rate-limited by client IP
- gateway event requests can also accept a dedicated event token or a trusted subnet condition

## CORS and origin handling

When `CORS_ORIGIN` is provided, the server restricts requests to that exact origin and handles preflight checks according to the configured allowlist. This is enforced in [../controlplane/auth.go](../controlplane/auth.go).

## Input validation

The repository includes strict JSON decoding and constrained validation for mutating requests, especially around control-plane and gateway APIs. Strict request validation helps reduce malformed payloads from untrusted clients.

This should not be treated as a guarantee of complete security hardening, but it does constitute a meaningful first layer of validation.

## SSH and host trust

Gateway operations rely on SSH and known-host trust behavior. The repo both configures SSH trust paths and warns about first-connect host key acceptance in configuration templates and examples. This is a real operational requirement and should be treated with care in deployment.

Environment examples that influence this are in:

- [../.env.example](../.env.example)
- [../ansible](../ansible)

## Gateway data-plane exposure

The design separates the control plane and the data plane:

- the control plane is the management and orchestration layer
- HAProxy and Keepalived on the gateway nodes serve traffic to sandboxes
- management ports such as the HAProxy DPA port are intended to be reachable only inside the management path or via approved trusted network rules

This is a design boundary that should be preserved in deployment and should not be widened without explicit review.

## Secrets and vault handling

The repository expects some values to remain secrets and not be tracked in plaintext.

Important points:

- `.env.example` is the template and is intentionally safe
- Ansible Vault is the expected secure location for secret values when used in deployment
- no credentials should be copied into Markdown reports or commit messages
- real credentials should remain outside the repository and be rotated according to environment policy

The repo includes a `vault.yml` under the Ansible group_vars area; treat that file as a secret-bearing artifact and never print or expose its contents.

## Operational security checklist

Before any live deployment or failover test, confirm:

- `ADMIN_TOKEN` is set and is not trivially weak
- `AUTH_DISABLED` is not accidentally enabled in a real environment
- rate limits and CORS values are intentionally set
- gateway SSH and known-host trust are provisioned
- management network access to the HAProxy DPA and control-plane services is limited to approved sources

## Not verified

The repository contains code-level controls, but the following remain deployment-specific and were not confirmed by live infrastructure testing in this audit:

- real gateway exposure and firewall posture
- actual SSH trust deployment across gateway hosts
- true production secret rotation and vault configuration
- final live failover protections in a running OpenStack environment
