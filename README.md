# BSA DCE Recovery Worker

External, fail-closed Node.js worker for recovering DCE manifests from buyer
profile links supplied by Nukema. The MVP lets the team develop and verify the
AW Solutions path from sanitized fixtures without secrets, deployment or BSA
production writes.

Status: local MVP only. The corrected authenticated dry-run is recorded in
`reports/recette-reelle-dry-run-20260720-login-fix.md`. No GitHub repository, Railway
service, object-storage sink or BSA import is configured.

The 24-AO recovery-rate sweep is recorded in
`reports/sweep-dry-run-20260720.md`.

The repository now also contains the local-only READER replacement for the
former Vercel `document-extractor`. It is implemented and tested, but remains
disabled by default and has not been connected to Supabase, OpenRouter,
Nukema, Railway or any production environment.

## Architecture

```text
Nukema URL -> final URL? -> AW Browserless session -> safe manifest
           \-> generic URL -> public exact-match search on AWS + PLACE
           \-> DILA/BOAMP -> publication_only
           \-> PLACE manifest/TED/unknown -> recovery_blocked

safe manifest -> dry_run JSON report (no download, no write)
ephemeral links -> guarded HTTP stream -> quarantine sink (library only)
apply -> APPLY_NOT_AUTHORIZED before Browserless or storage
```

Browserless is used only for the short browser phase that solves the CAPTCHA,
selects lots and reveals attachment links. The browser closes before any large
transfer. Signed links and AWS session material remain in memory and never
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

## Modes

| Mode | Default | Behavior |
| --- | --- | --- |
| `off` | yes | Routes nothing externally and reports `WORKER_OFF`. |
| `dry_run` | no | Discovers a manifest and prints one safe report per tender; zero download/storage/BSA write. |
| `apply` | no | Returns `APPLY_NOT_AUTHORIZED` before any external action. |

Providers:

- `mock` is the default and uses sanitized in-code AW responses.
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
`providedUrl`. The public resolver module handles strict title-prefix lookup on
AWSolutions and PLACE for operator recipes; it does not follow third-party
profiles returned by either index.

Exit codes:

- `0`: all reports are `off`, `manifest_ready` or `publication_only`;
- `1`: invalid arguments or invalid JSON/input contract;
- `2`: at least one report is `recovery_blocked` or `failed`.

## Platform behavior

- `*.marches-publics.info`: AW Solutions adapter.
- `*.dila.gouv.fr` and `*.boamp.fr`: `publication_only`; DILA is not a buyer
  profile.
- `*.marches-publics.gouv.fr`: public equivalence search is available, but
  manifest recovery remains `PLACE_V2_PENDING_VALIDATION`; AWS selectors are
  never reused for PLACE.
- TED and all other hosts: `UNSUPPORTED_PORTAL`.

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

In a secret manager, inject the three variables directly. The AW login waits
for APR's asynchronous Keycloak redirect, fills the real `username` and
`password` controls, submits the original form so its hidden state is kept,
and does not reselect `BSA PARTNERS` when it is already the current entity.

The 2026-07-20 recipe contacted only the
two authorized public indexes and Browserless/AW authentication surfaces; it
performed no persistent download or BSA write.

## Download and storage safety

`streamAttachment(...)` is a library boundary for the future authorized apply
path; the CLI does not call it today. It:

- accepts only HTTPS AW attachment or same-host `dce.TDoc` URLs;
- revalidates every redirect and never forwards AWS cookies to
  `downloads.awsolutions.fr`;
- streams directly into an injected quarantine writer;
- rejects HTTP errors, empty bodies, HTML/login/CAPTCHA content, bad PDF/ZIP
  magic bytes, size mismatches and responses over 100 MiB;
- computes bytes and SHA-256 while streaming;
- requires sink-level integrity validation before commit and aborts quarantine
  on any failure.

The 100 MiB threshold is a temporary safety guard, not an approved product
limit. A future durable sink must validate complete ZIP integrity before
promotion.

## Future authorized apply path

After a fresh explicit GO from Pierre, a separate lot may implement a durable
`DocumentIngestionSink`, promote only fully validated attachments, then inject
them through BSA's normal documentary circuit (`tender_document` and existing
DCE analysis queue). It must remain idempotent by tender, platform, attachment
identity and hash.

Creating the GitHub repository, configuring Railway, adding secrets, running a
real recipe and enabling production writes are separate ship decisions.

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
kill-switch. Logs are JSON lines and carry queue, tender, document, duration,
cost, status and short issue fields; configured secrets and URLs are redacted.

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
