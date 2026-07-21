# BSA DCE Recovery Worker

External, fail-closed Node.js worker for recovering DCE manifests from buyer
profile links supplied by Nukema. AW Solutions, PLACE and Maximilien share one
safe adapter contract and can be verified from sanitized fixtures without
secrets, deployment or BSA production writes.

Status: local implementation only. The corrected authenticated AW dry-run is
recorded in `reports/recette-reelle-dry-run-20260720-login-fix.md`. The
autonomous one-shot recovery and its object-storage sink are implemented but
remain `off`; no migration has been applied, and no GitHub/Railway deployment
or BSA production write was performed by this lot.

PLACE and Maximilien are deterministic and mock-tested, but their real portal
selectors/login/manifests have not been recetted. That recipe remains an
orchestrator step after an explicit GO.

The 24-AO recovery-rate sweep is recorded in
`reports/sweep-dry-run-20260720.md`.

The repository now also contains the local-only READER replacement for the
former Vercel `document-extractor`. It is implemented and tested, but remains
disabled by default and has not been connected to Supabase, OpenRouter,
Nukema, Railway or any production environment.

## Legacy manifest worker architecture

```text
Nukema URL -> AW / PLACE / Maximilien route
           -> portal-specific Browserless session -> safe manifest
           \-> DILA / BOAMP / TED -> publication_only
           \-> every other host -> recovery_blocked

safe manifest -> dry_run JSON report (no download, no write)
ephemeral links -> guarded HTTP stream -> quarantine sink (library only)
apply -> APPLY_NOT_AUTHORIZED before Browserless or storage
```

Browserless is used only for the short browser phase that solves the CAPTCHA,
selects lots and reveals attachment links. The browser closes before any large
transfer. Signed links and portal session material remain in memory and never
appear in the safe manifest.

## Requirements and setup

- Node.js 22 (`.nvmrc`)
- npm

```sh
npm ci
npm run lint
npm run typecheck
npm run test:ci
npm run build
```

No secret is required for installation, tests, build or mock operation.

## Autonomous recovery one-shot

`src/recovery/cli.ts` selects active `opportunity` tenders with a buyer profile
and no active document, then searches AW, PLACE and Maximilien every time. It
accepts only an exact normalized reference or the calibrated strong match;
medium evidence is recorded as `ambiguous` and never fetched. An unsupported
buyer portal such as achatpublic is recorded as `blocked` when none of the
three allowlisted portals provides a match.

The worker is one-shot: Railway owns scheduling, and the process contains no
`setInterval`. Build and run it manually with:

```sh
npm run build
RECOVERY_MODE=dry_run node dist/recovery/cli.js
```

Apply is an explicit environment choice and requires Supabase plus every
portal secret. It downloads every attachment into a private quarantine,
rejects the whole batch before upload if one file exceeds 256 MiB, uploads
with overwrite disabled under `{company_id}/{tender_id}/{file_name}`, inserts
`tender_document` idempotently, then enqueues analysis through the existing
lot-aware database function:

```sh
RECOVERY_MODE=apply node dist/recovery/cli.js
```

The database contract is supplied but deliberately not applied by this repo:
`sql/20260721130000_tender_dce_recovery_attempt.sql`. It creates the
worker-owned attempt/backoff registry and bounded service-role RPCs. Apply
fails before portal traffic unless exactly one profile named
`Système Ingestion Nukema` exists; its UUID becomes the non-null `added_by`.

Recommended Railway command and UTC cron for 07:15 Europe/Paris across summer
and winter time:

```text
node dist/recovery/cli.js --scheduled
15 5,6 * * *
```

The duplicate UTC hours are intentional. `--scheduled` proceeds only during
the local Paris 07h hour (late starts are accepted) and logs
`recovery_skipped_wrong_hour` before constructing a database or portal client
otherwise.

Continuous recovery modes:

| `RECOVERY_MODE` | Behavior |
| --- | --- |
| `off` (default) | Exits without constructing Supabase, portal or storage clients. |
| `dry_run` | Reads eligible tenders and searches all three public indexes; no attempt write, Browserless session, CAPTCHA solve, download, upload or database mutation. |
| `apply` | Claims each tender once per Paris day, fetches exact/strong matches, uploads verified files and persists the manifest atomically. |

The retry schedule is 24 hours after attempt 1, 72 hours after attempt 2 and
7 days thereafter. An interrupted in-flight attempt remains protected until
its retry time, then is marked `error` and replayed. AW shares one ten-unit
CAPTCHA budget across the whole run; PLACE and Maximilien recovery sessions do
not enable paid CAPTCHA solving.

## Legacy manifest CLI modes

| Mode | Default | Behavior |
| --- | --- | --- |
| `off` | yes | Routes nothing externally and reports `WORKER_OFF`. |
| `dry_run` | no | Discovers a manifest and prints one safe report per tender; zero download/storage/BSA write. |
| `apply` | no | Returns `APPLY_NOT_AUTHORIZED` before any external action. |

Providers:

- `mock` is the default and uses sanitized AW, PLACE and Maximilien responses.
- `real` constructs the bounded Browserless/Playwright session. Missing
  secrets return `MISSING_REAL_SECRETS`; they never crash the process.

## Mock dry-run

```sh
npm run worker -- \
  --mode dry_run \
  --provider mock \
  --input tests/fixtures/jobs.jsonl
```

The command writes structured operational logs to stderr and reports to
stdout. It does not create an output file. Redirecting stdout is an explicit
operator action outside the worker.

The input is JSON Lines, one validated job per line:

```json
{
  "jobId": "job-26dsp03",
  "tenderId": "tender-26dsp03",
  "sourceField": "link_to_buyer_profile",
  "providedUrl": "https://www.marches-publics.info/consultation?IDM=1841450",
  "requestedLots": { "kind": "all" }
}
```

`sourceField` accepts `link_to_buyer_profile` or `url_consultation`.
`requestedLots` defaults to `{ "kind": "all" }`; explicit lots use
`{ "kind": "ids", "ids": ["..."] }`. The worker CLI still expects a final
`providedUrl`. A portal session may search only inside its own allowlisted
domain and accepts one exact reference match, or one strict title-prefix plus
buyer match. The legacy public resolver remains limited to AWSolutions and
PLACE and never follows a third-party profile returned by either index.

Exit codes:

- `0`: all reports are `off`, `manifest_ready` or `publication_only`;
- `1`: invalid arguments or invalid JSON/input contract;
- `2`: at least one report is `recovery_blocked` or `failed`.

## Platform behavior

- `*.marches-publics.info`: AW Solutions adapter.
- `*.marches-publics.gouv.fr`: PLACE adapter.
- `*.marches.maximilien.fr`: Maximilien adapter.
- `*.dila.gouv.fr` and `*.boamp.fr`: `publication_only`; DILA is not a buyer
  profile.
- `*.ted.europa.eu`: `publication_only`; TED is not a buyer profile.
- all other hosts: `UNSUPPORTED_PORTAL`.

PLACE and Maximilien have separate session wrappers and mock fixtures; AW
selectors and credentials are never reused for either portal.

At most two sequential discovery attempts are made per tender. Retryable
CAPTCHA/browser failures stop with `RETRY_CAP_REACHED`; routing, missing-secret
and authorization failures do not retry.

## Real provider configuration

These values belong only in the worker secret manager or an ignored local
`.env`; never commit or paste their values into logs:

```dotenv
BROWSERLESS_TOKEN=""
AW_PORTAL_EMAIL=""
AW_PORTAL_PASSWORD=""
PLACE_PORTAL_EMAIL=""
PLACE_PORTAL_PASSWORD=""
MAXIMILIEN_PORTAL_EMAIL=""
MAXIMILIEN_PORTAL_PASSWORD=""
```

The repository intentionally does not auto-load `.env`. Use the explicit
worker loader for local execution so characters such as `#` remain part of a
secret instead of becoming a dotenv comment:

```sh
npm run worker -- \
  --env-file .env \
  --mode dry_run \
  --provider real \
  --input jobs.jsonl
```

In a secret manager, inject only the variables required by each routed portal,
plus `BROWSERLESS_TOKEN`. The AW login waits for APR's asynchronous Keycloak
redirect, fills the real `username` and
`password` controls, submits the original form so its hidden state is kept,
and does not reselect `BSA PARTNERS` when it is already the current entity.

The 2026-07-20 recipe contacted only the
two authorized public indexes and Browserless/AW authentication surfaces; it
performed no persistent download or BSA write.

For a real `dry_run` batch with complete portal secrets, the CLI reads the
official Browserless account usage immediately before and after discovery. It
logs the exact account-level unit delta for the batch, never an estimated
per-AO allocation. A missing/invalid usage snapshot, counter regression or
billing-period change makes the batch exit with code `2`; the token and usage
endpoint are never logged. Mock, `off`, `apply`, publication-only and
missing-secret requests do not invoke the usage API.

## Download and storage safety

`streamAttachment(...)` is the guarded download boundary used by autonomous
apply after manifest discovery. The legacy manifest CLI does not call it. It:

- accepts only HTTPS attachment URLs matching the source adapter's AW, PLACE or
  Maximilien host/path allowlist;
- revalidates every redirect, rejects cross-portal URLs and never forwards
  cookies across hosts;
- streams directly into an injected quarantine writer;
- rejects HTTP errors, empty bodies, HTML/login/CAPTCHA content, bad PDF/ZIP
  magic bytes, size mismatches and responses over 100 MiB;
- computes bytes and SHA-256 while streaming;
- requires sink-level integrity validation before commit and aborts quarantine
  on any failure.

The library default remains 100 MiB for legacy callers. Autonomous recovery
passes the approved 256 MiB cap explicitly and performs every download in
local quarantine before the first storage upload.

## Activation remains a separate decision

The autonomous sink now exists behind `RECOVERY_MODE=apply`, but activation is
not part of this implementation lot. Applying the SQL migration, configuring
Railway/secrets, running a real recipe and enabling production writes remain
separate orchestrator decisions on this `prod-sensitive` surface.

## READER — document extraction queue

READER ports the proven document/OCR/archive mechanics of the historical local
`document-extractor` into this Node.js worker. It consumes the existing
owner-fenced queue contract without changing its RPC payloads:

```text
claim -> heartbeat -> streamed download -> PDF/OCR/ZIP read
      -> typed LLM read -> complete
      \-> typed failure -> fail/defer/release
```

PDF reads use Vercel AI SDK `generateObject`, the OpenRouter provider and a
strict Zod schema. The supported roles are `rc`, `avis`, `ccap`, `ae`, `cctp`,
`dpgf`, `bpu`, `dqe` and `inconnu`. Invalid model output is retried within a
bounded SDK-backed flow, then becomes `READER_LLM_INVALID_OUTPUT`; there is no
manual JSON parsing and no agent loop in this pipeline.

Downloads are streamed to private temporary files. ZIP entries are traversed
lazily with entry, inflated-size, total-size and nesting caps; a corrupt ZIP
becomes the short typed issue `ZIP_CORRUPT`. The Railway entrypoint is a
long-running process, not an HTTP or Vercel serverless handler:

```sh
npm run build
READER_MODE=off npm start
```

READER modes are independent from `RECOVERY_MODE`:

| `READER_MODE` | Behavior |
| --- | --- |
| `off` (default) | Exits without constructing external clients or claiming work. |
| `dry_run` | Runs one bounded tick: claim, heartbeat, process, log the complete tick report, then release. It never completes/fails/defers, uploads, materializes ZIP children or writes the ledger. OpenRouter calls can still incur a provider cost, reported in logs. |
| `apply` | Runs continuously, writes extraction output and one `dce_extraction` ledger row per billed logical PDF. Operationally forbidden until Pierre gives the rollout GO. |

Required only for `dry_run` and `apply`:

```dotenv
SUPABASE_URL=""
SUPABASE_SERVICE_ROLE_KEY=""
OPENROUTER_API_KEY=""
NUKEMA_USERNAME=""
NUKEMA_PASSWORD=""
```

Optional controls:

```dotenv
OPENROUTER_MODEL_EXTRACT="google/gemini-3.5-flash"
READER_BATCH="2"
READER_MAX_BYTES="314572800"
READER_MAX_MODEL_BYTES="20971520"
READER_HEARTBEAT_MS="30000"
READER_POLL_MS="5000"
```

The process rechecks `READER_MODE` between ticks and before apply-only writes;
setting it to `off` and restarting/reloading the Railway service is the
kill-switch. In `off` mode every CLI (READER, ANALYZE, RECOVERY) logs
`*_stopped` and exits immediately: there is no in-process wait, so the restart
interval while `off` is owned by the Railway start command (for example a
`sleep` between one-shot runs) or the service cron, never by this code. Logs
are JSON lines and carry queue, tender, document, duration, cost, status and
short issue fields; configured secrets and URLs are redacted. Lifecycle events
(`*_started`, `*_stopped` off/summary) are written to stdout at info level;
real failures (`*_failed`, `*_terminal`, `analyze_error_detail`, `*_stopped`
with an `issue`) go to stderr so Railway tags only them as errors. Each
`*_started` event carries a `release` field sourced from `WORKER_RELEASE_SHA`
(`unknown` when the variable is absent).

All READER tests use mocks or generated local fixtures. No development or gate
command requires or authorizes a production connection.

## ANALYZE — agentic DCE analysis

`src/analyze/` is the worker-side analyst that consumes READER's already
extracted documents. Its dedicated one-shot entrypoint observes the existing
analysis queue, assembles a typed dossier, recalls client learning and runs the
bounded analyst once before exiting.

```text
typed READER dossier + company profile + recalled lessons
  -> bounded Vercel AI SDK agent (OpenRouter, four read-only tools)
  -> strict Zod criteria and rich summaries per lot
  -> deterministic score recalculation and redhibitory rules in code
  -> off | read-only shadow comparison | guarded apply sink
```

The agent may read bounded text windows, consult the company profile, inspect
recalled learning and preview redhibitory checks. It never calculates the final
score and cannot override a redhibitory rule. The code reuses Paul's
multiplicative five-criterion formula, selects the best accessible lot and
blocks each lot independently. Invalid structured output gets one bounded
repair attempt; step and output-token budgets are shared across both attempts.

ANALYZE modes are independent from `RECOVERY_MODE` and `READER_MODE`:

| `ANALYZE_MODE` | Behavior |
| --- | --- |
| `off` (default) | Exits before constructing Supabase/OpenRouter clients. |
| `shadow` | Peeks at up to ten eligible queue rows, analyzes one ready dossier, logs the full per-lot result and the delta against the score re-read after analysis. It never claims or advances the queue and never writes a tender, lot, ledger or learning counter. Repeated launches can therefore observe the same row. |
| `apply` | Claims through `claim_dce_analysis_queue_row`, writes the guarded existing tender/lot/AI-ledger contracts and completes one queue row. This path exists for a later authorized cutover and must remain disabled until Pierre's explicit GO. |

The ANALYZE command is separate from the READER Railway `start` command:

```sh
npm run build
ANALYZE_MODE=off npm run analyze:start
```

`shadow` and `apply` execute one pass only: no polling, sleep or service loop.
The shadow path uses a read-only TypeScript capability and calls only selects,
Storage downloads, `list_tender_analysis_documents`, `match_ao_lessons` and
approved-rule reads. OpenRouter analysis and embeddings can still incur cost.

Configuration:

```dotenv
ANALYZE_MODE="off"
OPENROUTER_MODEL_SCORE="openai/gpt-5.6-terra"
ANALYZE_MAX_STEPS="8"            # hard maximum: 12
ANALYZE_MAX_OUTPUT_TOKENS="8192" # hard maximum: 8192
OPENROUTER_API_KEY=""            # required only outside off
SUPABASE_URL=""                  # required only outside off
SUPABASE_SERVICE_ROLE_KEY=""     # required only outside off
```

Lesson recall ports `match_ao_lessons`, the approved company rules in
`scraping_memory`, and `record_scraping_memory_usage`. Recall fails open so a
memory outage cannot block analysis. The result reports `lessons_count`,
`rules_count` and `learning_applied`; usage is recorded only after a successful
apply write. Dossier assembly uses `list_tender_analysis_documents` and the
private READER text objects, refuses non-terminal extraction states and caps a
pass at 100 documents / 1,000,000 characters. All tests use mocks and fixtures,
with no OpenRouter, Supabase or Railway connection. The historical edge
`analyze-dce` remains active until the separate cutover lot.
