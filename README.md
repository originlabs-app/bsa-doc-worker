# BSA DCE Recovery Worker

External, fail-closed Node.js worker for recovering DCE manifests from buyer
profile links supplied by Nukema. The MVP lets the team develop and verify the
AW Solutions path from sanitized fixtures without secrets, deployment or BSA
production writes.

Status: local MVP only. No GitHub repository, Railway service, real portal
recipe, object-storage sink or BSA import is configured.

## Architecture

```text
Nukema URL -> portal router -> AW Browserless session -> safe manifest
                         \-> DILA/BOAMP -> publication_only
                         \-> PLACE/TED/unknown -> recovery_blocked

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
`{ "kind": "ids", "ids": ["..."] }`. Optional `searchHints` are reserved
for a future cross-portal resolver and are ignored by the MVP. The MVP always
uses the exact `providedUrl`; it never searches another portal.

Exit codes:

- `0`: all reports are `off`, `manifest_ready` or `publication_only`;
- `1`: invalid arguments or invalid JSON/input contract;
- `2`: at least one report is `recovery_blocked` or `failed`.

## Platform behavior

- `*.marches-publics.info`: AW Solutions adapter.
- `*.dila.gouv.fr` and `*.boamp.fr`: `publication_only`; DILA is not a buyer
  profile.
- `*.marches-publics.gouv.fr`: `PLACE_V2_PENDING_VALIDATION`; AWS selectors are
  never reused for PLACE.
- TED and all other hosts: `UNSUPPORTED_PORTAL`.

At most two sequential discovery attempts are made per tender. Retryable
CAPTCHA/browser failures stop with `RETRY_CAP_REACHED`; routing, missing-secret
and authorization failures do not retry.

## Real provider configuration

These values belong only in the worker secret manager or an ignored local
`.env`; never commit or paste their values into logs:

```dotenv
BROWSERLESS_TOKEN=
AW_PORTAL_EMAIL=
AW_PORTAL_PASSWORD=
```

The repository intentionally does not auto-load `.env`. Export the variables
through the execution environment. The first real dry-run is a separate
orchestrator/Pierre recipe gate; this MVP lot did not contact the portal.

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
