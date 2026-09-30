# Security Policy

## Supported versions

Security fixes target the latest published version of
[`@aeondave/pi-persona`](https://www.npmjs.com/package/@aeondave/pi-persona).
Older versions do not have a guaranteed backport policy. Check the
[release notes](https://github.com/AeonDave/pi-persona/releases) for fixes and
upgrade instructions. Keep your Pi host and Node.js runtime updated as well.

## Reporting a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/AeonDave/pi-persona/security/advisories/new).
Do not open a public issue with exploit details, credentials, private session
logs, or other sensitive material. Ordinary bugs can use the public issue tracker.

Include the affected package version or commit, Pi and Node.js versions, operating
system, relevant configuration, expected security boundary, actual behavior, and
a minimal reproduction with synthetic data. Explain the impact and any safe
workaround you have verified. Do not test against other users' sessions or systems
without their permission.

Follow-up and disclosure coordination happen in the private advisory. This is a
maintainer-run project, with no guaranteed response or remediation deadline and
no paid bug bounty. Agree on public disclosure after triage so users can receive
a fix or mitigation before exploit details are published.

## Security boundaries

Pi extensions and installed persona/agent definitions are trusted local code and
configuration, not an OS sandbox. Capability checks and Exocom's cooperative file
claims do not isolate a malicious local process. A workspace join code is a
same-host routing reference, not an authentication secret. See the
[architecture](docs/ARCHITECTURE.md) for the actual trust boundaries.

Reports of capability bypasses, broker/Exocom trust violations, unsafe handling of
untrusted worker output, or unintended disclosure of session data are welcome.
Use synthetic credentials and payloads in reproductions.

The npm package uses Pi-provided peer dependencies rather than shipping another
Pi runtime. Development lockfile fixes do not update an installed user's host;
host vulnerabilities must also be addressed by updating Pi itself.
