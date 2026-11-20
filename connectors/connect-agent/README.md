# CaratOS Connect Agent

One outbound-only Windows agent for different customer systems. It reads the
customer's source locally, maps only fields declared in a reviewed profile, and
uploads canonical CSV through CaratOS's existing tenant-scoped import engine.
The cloud never opens a connection into the customer's network and the source is
never written to.

## What is ready

| Source | Transport | Starter data | Verification level |
|---|---|---|---|
| BUSY | password-protected `.bds` copy through Access ODBC | customers, products | Master1 structure verified against Eclat and Ashish Textile; every new installation still needs preview |
| TallyPrime | local XML over HTTP | customer ledgers and stock-item masters, using GUID identity only | request/parser fixture-tested; live company preview required |
| Gati / APRS-SJEP | SQL Server ODBC | discovery here; full Eclat sync remains in `synceclatcaratsense/` | Eclat adapter already live-shaped; a new client starts with discovery |
| Other ERP/database | ODBC | discovery, then customers/products/stores after a profile is reviewed | profile required |

Transactions, stock balances, payments and ledgers are deliberately not generic
starter entities. Their signs, cancellation rules, units and branch attribution
vary by installation. Add them only after reconciling real source samples; a
plausible but wrong voucher import is worse than an explicit gap.

TallyPrime officially supports XML-over-HTTP and ODBC. The starter uses the XML
server because the agent can ask for named fields and keep the connection local.
Tally must be running, the company must be loaded, and the HTTP server enabled
(normally port 9000). Official references: [XML integration](https://help.tallysolutions.com/xml-integration/)
and [ODBC integration](https://help.tallysolutions.com/odbc-integrations/).

## Safe onboarding sequence

1. In CaratOS, enrol an agent for `busy`, `tally`, `gati` or `odbc`. Copy the
   `cxa_...` token when shown; it cannot be retrieved later.
2. Install matching Windows/ODBC prerequisites on the customer's machine, then
   run `setup_agent.ps1 -ProfilePath <profile>`. It creates a package-local virtual environment, prints
   Python bitness and visible ODBC drivers, installs the reviewed exact dependency
   set from `requirements-lock.txt`, requires the profile's Access driver to be
   visible to that exact Python architecture, and runs the connector self-tests.
3. Run `configure` once as the same Windows user that will run the scheduled
   task. It stores the token and source connection values in a user-bound,
   DPAPI-protected credential file; never put secrets in a profile.
4. Run `discover`. It lists schema/fields but uploads nothing.
5. Copy a starter/template profile and adjust SELECT-only queries and mappings.
6. Run `preview`; values are masked unless `--show-values` is explicitly used.
   Record the printed `profileHash` and `sourceInstanceHash` in the agent's
   head-office configuration. Live sync refuses any other profile or descriptor.
7. Reconcile counts with the customer, then run `sync --dry-run`. Dry-run calls
   the same server-side validation as a real import but writes no data or state.
8. Run one real sync and reconcile the returned imported/updated/failed counts.
9. Only then install the scheduled task. It is registered disabled unless the
   operator explicitly supplies `-Enable` after reviewing the dry-run output.
   Installation also refuses while the server-side agent policy is disabled,
   so a disabled no-op cannot be mistaken for a completed source/mapper preflight.

## Commands

```text
cd connectors/connect-agent
powershell -File setup_agent.ps1 -ProfilePath profiles/busy-bds-starter.json

.\.venv\Scripts\python.exe -m caratos_connect.cli --profile profiles/busy-bds-starter.json doctor
.\.venv\Scripts\python.exe -m caratos_connect.cli --profile profiles/busy-bds-starter.json configure
.\.venv\Scripts\python.exe -m caratos_connect.cli --profile profiles/busy-bds-starter.json discover
.\.venv\Scripts\python.exe -m caratos_connect.cli --profile profiles/busy-bds-starter.json preview
.\.venv\Scripts\python.exe -m caratos_connect.cli --profile profiles/busy-bds-starter.json sync --dry-run
.\.venv\Scripts\python.exe -m caratos_connect.cli --profile profiles/busy-bds-starter.json sync

# Repeats exact server dry-run, then registers a disabled task for review.
powershell -File install_task.ps1 -ProfilePath profiles/busy-bds-starter.json

# Explicitly enable only after acceptance; -Replace is required for reinstall.
powershell -File install_task.ps1 -ProfilePath profiles/busy-bds-starter.json -Enable -Replace
```

For an offline customer network, first populate a reviewed wheelhouse on a
connected build machine, transfer it with the release, and run
`setup_agent.ps1 -Wheelhouse <path>`. The installer then uses `--no-index` and
will not contact a package registry. The scheduled task is explicitly bound to
the same interactive Windows user as DPAPI, runs without administrator rights,
and keeps redacted daily logs for 14 days under
`%LOCALAPPDATA%\CaratOS\Connect\logs`.

`configure` prompts for these values and writes the encrypted file under
`%LOCALAPPDATA%\CaratOS\Connect\credentials` by default. Environment variables
are supported only as a temporary/manual input (`configure --from-env`) and are
not required by the scheduled task.

Common values:

```text
CARATOS_BASE_URL=https://api.example.com
CARATOS_AGENT_TOKEN=cxa_...
```

BUSY `.bds`:

```text
CONNECT_SOURCE_FILE=D:\BusyData\DATA\COMP0001\db12027.bds
CONNECT_SOURCE_PASSWORD=...
```

The source file is copied to a private temporary file before ODBC opens it.
The agent checks free space and refuses the run if the source size or modified
time changes during that copy; retry while BUSY is idle. This is a safety check,
not an application-consistent backup guarantee—client acceptance must still use
a vendor-supported backup/export or a coordinated idle window.

TallyPrime:

```text
TALLY_URL=http://127.0.0.1:9000
TALLY_COMPANY=Exact Loaded Company Name
```

Generic ODBC / SQL Server / Gati discovery:

```text
CONNECT_SOURCE_DSN=Driver={ODBC Driver 18 for SQL Server};Server=...;Database=...;UID=readonly_user;PWD=...;Encrypt=yes
```

Use a database login that has only SELECT access. Profiles reject anything that
is not a single SELECT/CTE, including SELECT INTO and SQL comments. This guard is
defence-in-depth, not a replacement for a read-only source login.

## Profile contract

`profile.schema.json` documents the outer shape. An entity query returns source
columns; `fields` maps each canonical field to one or more candidate source
columns. Candidates are tried case-insensitively. `prefixValues` first marks a
local source identifier (`busy:123`, `tally:<guid>`). Before upload, the runner
expands it to `source:<128-bit descriptor namespace>:id`. The server pins the
enrolment to that reviewed connection descriptor immediately before the first
accepted live import. Repointing the token to a different path/DSN/company label
is refused, while re-enrolling the same descriptor retains stable record
identity. Fields
beginning `_` may be used for local filters and are never uploaded.

Source identity is immutable but insensitive to harmless spelling differences:
ODBC attribute order, key case and surrounding whitespace are normalized, and
credential attributes are excluded before hashing. Every other ODBC selector,
including driver-specific options such as the current schema, participates in
the hash so a changed view of the source requires approval. Access paths use
Windows case normalization. Tally URL scheme/host/default port are normalized;
company names are trimmed at their edges but retain case, so a case change is
treated as a different exact company label. Neither credentials nor descriptors
are sent or written by the agent.

Currently accepted canonical master fields are those exposed by the CaratOS
import dictionaries for `customers`, `products` and `stores`. Unknown columns are
not silently uploaded.

An empty live export fails closed by default. Set an entity's `allowEmpty` to
`true` only after explicitly reviewing that zero rows is a legitimate complete
snapshot for that source; the setting is part of the reviewed profile hash.

Accepted state is a hash of canonical rows, written atomically only after the
entire entity was accepted. Immediately before an upload, the agent atomically
stores a random pending-attempt UUID; an ambiguous retry reuses it, and successful
checkpointing removes it in the same replacement that records the accepted hash.
If the state file is lost, a fresh UUID forces a real re-application instead of
replaying an older content receipt. State is isolated by tenant, agent, store,
profile and source instance, and a process lock prevents overlapping runs. Source
limits fail closed instead of silently truncating a real sync; `preview` remains
a clearly labelled bounded sample. Server receipts retain the effective target
store and a renewed worker lease. `--dry-run` sends the canonical file to the
validation endpoint but creates no customer/product/store, ImportBatch, source
pin or local checkpoint. The first accepted live import performs the one-time
descriptor pin before any business row or receipt is written.

The profile and descriptor hashes are operational approval controls, not remote
attestation: possession of an agent token still authorizes narrowly scoped
master-data submissions that pass server validation. Protect and rotate that
token like any integration credential.

The descriptor hash is not a fingerprint of database contents. Replacing a
database at the same file path/DSN, or a Tally company under the same label,
requires a new enrolment and operator review. The starter also caps one snapshot
at 5,000 rows/7 MiB; larger clients need deterministic, reviewed pagination.

For the MVP, each imported master field is treated as source-owned and sync is
upsert-only (source-side deletions are not inferred). Do not attach two systems
that both maintain the same fields until SourceLink, deletion manifests and
per-field conflict resolution are implemented for that client.
