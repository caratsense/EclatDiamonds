# RETIRED — legacy CaratOS BUSY agent

Do not install or run this client. The current server contract requires a
reviewed profile, immutable source IDs, source-descriptor pinning, exact backend
preview and idempotent receipts that this historical implementation cannot
provide.

Use `connectors/connect-agent/profiles/busy-bds-starter.json` with the unified
`connectors/connect-agent` runtime. The old `busy_connect.py` and
`install_task.ps1` entry points deliberately fail closed and remain only as
historical field-discovery reference.

There is intentionally no operational setup in this folder. The only supported
BUSY installation instructions are in `connectors/connect-agent/README.md`.
