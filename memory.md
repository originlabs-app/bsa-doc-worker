# Durable memory

## Product decisions — 2026-07-20

- The worker is a separate Node.js repository, never an Edge Function and never
  part of `BSA_COPILOT_PRODUCTION`.
- MVP recovery supports AW Solutions only. PLACE returns `recovery_blocked`;
  cross-portal equivalence is interface-only and TED is unsupported.
- Browserless is limited to manifest discovery. Attachment transfers are
  direct HTTP streams to durable object storage.
- Modes are `off`, `dry_run`, and `apply`; default is `off`. `dry_run` performs
  no writes and `apply` is not authorized in the MVP.
- Development and tests must work from sanitized fixtures without secrets.
