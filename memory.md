# Durable memory

## Product decisions — 2026-07-20

- The worker is a separate Node.js repository, never an Edge Function and never
  part of `BSA_COPILOT_PRODUCTION`.
- The manifest adapter supports AW Solutions only. When a Nukema buyer-profile
  URL is generic or inaccessible, public equivalence lookup is authorized by
  title/reference on AWSolutions and PLACE only. PLACE manifest recovery still
  returns `recovery_blocked`; TED and third-party profiles are unsupported.
- Browserless is limited to manifest discovery. Attachment transfers are
  direct HTTP streams to durable object storage.
- Modes are `off`, `dry_run`, and `apply`; default is `off`. `dry_run` performs
  no writes and `apply` is not authorized in the MVP.
- Development and tests must work from sanitized fixtures without secrets.
- The 2026-07-20 real dry-run found two exact Strasbourg notices in the public
  AWSolutions index, but both DCEs route to `plateforme.alsacemarchespublics.eu`
  and are therefore out of scope. The configured AW credentials were present
  but rejected by the portal; no credential value was stored.
