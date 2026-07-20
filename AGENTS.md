# BSA DCE Recovery Worker

External Node.js worker for recovering DCE manifests from buyer-profile links.

Surface livraison: `prod-sensitive`. Production imports, database/storage
writes, deploys and secret writes require Pierre's explicit authorization.

## Scope

- Keep every buyer-profile recovery implementation in this repository, never
  in `BSA_COPILOT_PRODUCTION`.
- Manifest adapters are limited to AW Solutions (`marches-publics.info`), PLACE
  (`marches-publics.gouv.fr`) and Maximilien (`marches.maximilien.fr`).
- DILA/BOAMP and TED are publication-only sources, not buyer profiles.
- Every other buyer profile, including
  `plateforme.alsacemarchespublics.eu`, remains out of scope without a new
  portal-specific GO from Pierre.

## Safety

- Default recovery mode is `off`; `apply` remains fail-closed until authorized.
- Never log or persist tokens, credentials, cookies, CAPTCHA values, signed
  attachment URLs, `CFID` or `CFTOKEN`.
- Browserless discovers attachment links only. Downloads use direct bounded
  HTTP streaming to an injected object sink.
- Use the exact consultation URL supplied by Nukema when it is final. A
  fallback search must resolve a unique exact reference, or a strict title
  prefix plus buyer, within the adapter's own allowlisted domain. Enforce host
  allowlists and at most two portal attempts per tender.
- `.env` is local and ignored. Commit only empty variable names in
  `.env.example`.

## Commands

```sh
npm run lint
npm run typecheck
npm run test:ci
npm run build
```

Run the mock dry-run fixture:

```sh
npm run worker -- --mode dry_run --provider mock --input tests/fixtures/jobs.jsonl
```

Keep all gates in the foreground. Do not create a GitHub repository, configure
Railway, deploy, or perform a real PLACE/Maximilien portal recipe in the
adapter implementation lot; that recipe belongs to the orchestrator after GO.
