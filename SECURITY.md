# Security Policy

## Supported versions

Until the first stable release, security fixes are applied to the default
branch. Published release support will be documented here when versioned
releases begin.

## Reporting a vulnerability

Please do not disclose a suspected vulnerability in a public issue. Open a
private security advisory through GitHub, or contact the project maintainers
privately with the subject `AgentWeave security report`.

Include:

- affected commit, release, or component;
- reproduction steps or a minimal proof of concept;
- impact and any required permissions;
- suggested mitigation, if known.

We will acknowledge reports as soon as practical, investigate, coordinate a
fix and disclosure timeline, and credit reporters who want attribution.

## Deployment guidance

AgentWeave is currently a single-host MVP. Before exposing it beyond a trusted
local network:

- protect the Control API and dashboard with an authenticated reverse proxy;
- keep PostgreSQL, NATS, and observability ports private;
- use strong, unique provider and bridge credentials;
- set a narrow workspace allowlist and never mount a broad home directory;
- do not place credentials in `.env` committed to Git;
- review logs before sharing them, because prompts and tool output may contain
  sensitive project information;
- keep Docker, Node.js, PostgreSQL, NATS, and provider clients patched.

Provider credentials must remain in runtime configuration and must not be
persisted in event payloads, task evidence, or dashboard read models.
