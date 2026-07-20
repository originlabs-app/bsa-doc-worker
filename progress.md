# Progress

## 2026-07-20 — dce-recovery-worker MVP

- Repository initialized locally on `main` with no remote.
- Scope frozen: AW Solutions manifest discovery on mocks, PLACE/DILA routing,
  dry-run safety, two-attempt cap and fail-closed apply.
- Implemented validated JSONL contracts, portal allowlisting, safe manifest
  projection, mock and bounded real Browserless sessions, secret-safe logs and
  direct HTTP quarantine streaming.
- Mock CLI proof: `26DSP03`/`IDM=1841450` returns `manifest_ready`, three
  sanitized fixture attachments and `productionWriteOccurred=false`.
- Gates: lint, typecheck, 28 tests, build and mock CLI pass; npm audit reports
  no vulnerability.
- No Browserless/AW credential was used. No portal, BSA database, storage,
  GitHub or Railway action occurred.
- `apply` remains fail-closed with `APPLY_NOT_AUTHORIZED`.
- Status: `READY_FOR_ORCHESTRATOR_REVIEW`.

## 2026-07-20 — Recette réelle dry_run

- Scope: the three `www.marches-publics.info` targets from
  `recette-targets-20260720.json`; seven DILA rows excluded before execution.
- Added a fail-closed public equivalence resolver for AWSolutions and PLACE,
  with strict normalized title-prefix matching and host-allowlisted redirects.
- Bastion (score 100) and Erckmann Chatrian (score 27) were found in the public
  AWSolutions index, but their DCE route is the out-of-scope third-party portal
  `plateforme.alsacemarchespublics.eu`. PLACE returned no exact match.
- The controls tender (score 6) returned no exact match on either authorized
  portal. Result: 0/3 recoverable, 3/3 `recovery_blocked`, zero attachments.
- Browserless: 5 units, about 79.6 s across four bounded sessions; no CAPTCHA
  solve unit. The AW credentials were present but rejected by the login page.
- Safety proof: no DCE downloaded or persisted, no BSA/storage write, no DILA
  request, no third-party profile followed, no secret logged.
- Gates: lint, typecheck, 37 tests, build, npm audit and gitleaks pass.
- No remote, push, deploy, GitHub or Railway action.
- Detailed report: `reports/recette-reelle-dry-run-20260720.md`.

## 2026-07-20 — Correctif login AW et replay authentifié

- Correction durable capturée : les identifiants `.env` sont valides. APR
  redirige vers Keycloak après le chargement initial de la SPA ; le worker
  attend maintenant cette surface et reconnaît `username`/`#kc-login`.
- Ajout d'un chargeur local explicite `--env-file` qui conserve `#` dans les
  secrets non quotés sans jamais les journaliser. Le secret manager continue
  d'injecter les variables directement.
- Login Browserless prouvé : POST Keycloak 302, échange OIDC 200, API utilisateur
  200, tableau de bord atteint et entité `BSA PARTNERS` active. L'entité active
  n'est plus recliquée comme si elle était une étape de sélection.
- Replay strict des trois cibles : Bastion et Erckmann exacts dans AWSolutions,
  mais sans `urlDCE`/`urlRC` interne et avec `urlDemat` vers
  `plateforme.alsacemarchespublics.eu`; troisième AO absent d'AWSolutions et
  PLACE. Résultat : 0 pièce, 3 `recovery_blocked`.
- Coût mission : usage Browserless de 5 à 18, soit 13 unités sur le cap de 20 ;
  session finale 14,263 s, environ 132 s de diagnostic cumulé.
- Zéro téléchargement, persistance, écriture BSA, requête DILA ou navigation
  Alsace. Aucun secret, cookie ou lien signé journalisé.
- `plateforme.alsacemarchespublics.eu` reste interdit jusqu'à un GO explicite
  de Pierre. Aucun push, déploiement, GitHub ou Railway.
- Gates finaux : lint, typecheck, 46 tests, build et audit npm verts ; gitleaks
  ne détecte aucun secret dans le diff.
- Rapport : `reports/recette-reelle-dry-run-20260720-login-fix.md`.

## 2026-07-20 — Sweep dry_run élargi, 24 AO

- Source : `sweep-targets-20260720.json`, 24 AO sans pièces sur 10 jours ; 3
  lignes AWSolutions (protocole A), 21 lignes DILA/TED/autres (protocole B).
- Protocole A : Bastion redirige vers
  `plateforme.alsacemarchespublics.eu` sans navigation ; Béziers expose une
  consultation AWS exacte mais finit `CAPTCHA_UNSOLVED` au cap de 2 ;
  Saint-Gilles produit un manifeste de 3 pièces.
- Manifeste Saint-Gilles : tailles inconnue, 686 614 et 630 219 763 octets ;
  les trois routes répondent à HEAD, mais la plus grande dépasse le garde-fou
  actuel de 100 MiB. Aucun corps ou fichier n'a été téléchargé.
- Protocole B : 0/21 équivalent accepté car les 21 lignes ont référence et
  acheteur vides. Neuf candidats de titre exact ont été observés et rejetés ;
  aucune correspondance approximative n'a été acceptée.
- Taux : A 1/3 (33,3 %), B 0/21, global 1/24 (4,2 %), 3 pièces manifestées.
- Census externe : `plateforme.alsacemarchespublics.eu`, 2 lignes pour 1
  consultation distincte ; domaine toujours interdit sans GO explicite.
- Browserless : usage consolidé de 18 à 72, soit 54 unités sur le cap de 120 ;
  78,808 s sur trois sessions. Allocation estimée : Béziers 32, Saint-Gilles
  22, autres AO 0.
- Sûreté : deux tentatives maximum par AO, zéro portail interdit visité, zéro
  GET de pièce, téléchargement, persistance, écriture BSA/stockage ou statut AO.
- Matching strict et requêtes distinctives couverts par tests et commits
  `[skip ci]`. Aucun push, déploiement, GitHub ou Railway.
- Gates finaux : lint, typecheck, 53 tests, build et audit npm verts ; gitleaks
  ne détecte aucun secret dans le diff.
- Rapport : `reports/sweep-dry-run-20260720.md`.
