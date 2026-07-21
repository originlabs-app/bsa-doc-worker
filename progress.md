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

## 2026-07-20 — READER porté et gelé localement

- Mission : remplacer le `document-extractor` Vercel par un module READER
  long-running dans ce repo, en portant sa mécanique éprouvée puis en remplaçant
  uniquement le parsing OpenRouter manuel par Vercel AI SDK `generateObject` +
  schémas Zod par rôle.
- Sources lues sans modification : worker historique local
  `BSA_COPILOT_PRODUCTION-lots-guardrails-v4/agents/document-extractor`, contrat
  RPC et ledger de `BSA_COPILOT_PRODUCTION`, `memory.md` et story VC-1207.
- Implémentation : rôles `rc|avis|ccap|ae|cctp|dpgf|bpu|dqe|inconnu`, modèle
  `OPENROUTER_MODEL_EXTRACT` (défaut `google/gemini-3.5-flash`), retries SDK +
  réparation structurée bornée, erreurs invalides/provider typées, coûts
  agrégés et ledger `dce_extraction` uniquement en apply.
- Pipeline : claim owner-fenced, heartbeat périodique, téléchargement Supabase
  ou Nukema streamé sur disque, PDF texte/scanné, DOC/DOCX, tableurs, ZIP lazy
  borné et ZIP imbriqué à profondeur 1, materialisation des enfants, puis
  complete/fail/defer/release selon le contrat existant.
- Modes : `off` par défaut et sans client externe ; `dry_run` fait un tick puis
  release sans complete/fail/defer/upload/upsert/ledger ; `apply` est une boucle
  long-running et reste interdit opérationnellement avant GO Pierre.
- Sûreté : aucune connexion Supabase/Nukema/OpenRouter réelle, aucune donnée
  production, aucun push/deploy/GitHub/Railway. Les trois fixtures JSON non
  suivies déjà présentes dans le worktree ont été laissées intactes et hors
  commits.
- Fichiers code ajoutés : `src/llm/document-reader.ts`,
  `src/llm/document-schemas.ts`, et `src/reader/{archive,classification,cli,config,download,nukema,pdf-subset,pipeline,readers,service,source,storage,supabase,types}.ts`.
- Fichiers tests ajoutés : `tests/llm-document-reader.test.ts` et
  `tests/reader-{cli,config,contract,files,pipeline,service,source}.test.ts`.
- Documentation/config : `README.md`, `.env.example`, `memory.md`,
  `package.json`, `package-lock.json`.
- Commits fonctionnels `[skip ci]` : `8edf264`, `1b86224`, `4f65a3f`,
  `486f507`, `3dd7f5a` ; le commit de checkpoint final suit cette entrée.
- Gates Node 22 exécutés en avant-plan après la dernière correction code :
  tests READER ciblés 54/54, suite complète 107/107 (dont les 53 RECOVERY),
  lint vert, typecheck vert, build vert, smoke `READER_MODE=off npm start` vert,
  `npm audit --audit-level=high` = 0 vulnérabilité, gitleaks = 0 fuite sur 19
  commits.
- Écarts assumés : aucune recette staging/réelle ni preuve des 546, car la
  mission interdit toute connexion pendant le développement et réserve la
  recette/bascule à l'orchestrateur ; aucun service Railway ni credential n'a
  été créé. Le coût utilisé est le coût réel retourné dans les metadata
  OpenRouter, agrégé entre retries, pas une estimation locale par token.
- Statut : `READY_FOR_ORCHESTRATOR_REVIEW`; READER reste OFF.

## 2026-07-20 — WORKER-ANALYZE agentique gelé localement

- Mission : faire du worker l'analyste DCE qui lit le dossier extrait et produit
  une analyse riche par lot via Vercel AI SDK, tout en laissant le calcul final
  et les règles rédhibitoires au code.
- Base et isolation : branche `feat/analyze`, worktree dédié, base exacte
  `origin/main@827eba85ee1e4377548721baf8992b467da1eb00` (RECOVERY + READER).
- Module ajouté : `src/analyze/` avec schémas Zod stricts, agent OpenRouter
  `generateText` + `Output.object`, quatre outils bornés, une seule réparation
  structurée et budgets globaux partagés entre les tentatives.
- Doctrine gardée par le code : grille de Paul 30/20/20/15/15 avec gate métier
  multiplicative, critères inconnus renormalisés, meilleur lot accessible,
  score zéro et blocage par lot sur rédhibitoire. Le verdict proposé par le
  modèle n'est jamais utilisé pour calculer ou débloquer le résultat final.
- Marchés allotis : sortie riche par lot, couverture obligatoire des numéros de
  lot déjà identifiés par READER et citations limitées aux documents réellement
  présents dans le dossier.
- Boucle VC-1211 : port de `match_ao_lessons`, règles company approuvées de
  `scraping_memory`, embedding `google/gemini-embedding-2` en 768 dimensions et
  `record_scraping_memory_usage` seulement après une écriture apply réussie.
  Le résultat trace `lessons_count`, `rules_count` et `learning_applied`.
- Modes indépendants : `off` par défaut et court-circuit total ; `dry_run`
  analyse et logue sans sink ni comptage d'usage ; `apply` exige un sink injecté
  avant tout appel agent. Aucun sink production, queue ou cutover n'est câblé
  dans ce lot.
- Commits fonctionnels `[skip ci]` : `56cddae`, `d8a3977`, `c7de8b9`,
  `6a02f45` ; le commit de checkpoint final suit cette entrée.
- Gates Node 22 exécutés au premier plan : suite complète 134/134 (24 fichiers),
  lint vert, typecheck vert, build vert, `npm audit --audit-level=high` =
  0 vulnérabilité, gitleaks 8.30.1 = 0 fuite sur les 4 commits du lot.
- Sûreté : aucun appel réel OpenRouter/Supabase, aucune donnée production,
  aucune écriture BSA, aucun push, merge, deploy, GitHub ou Railway. RECOVERY et
  READER ne sont pas modifiés hors imports de types existants.
- Revue finale : budgets de retry cumulés et ancrage documents/lots durcis ;
  aucun finding bloquant restant sur correction, lisibilité, architecture,
  sécurité ou performance.
- Statut : `READY_FOR_ORCHESTRATOR_REVIEW`; `ANALYZE_MODE` reste `off`.

## 2026-07-20 — ANALYZE câblé en shadow one-shot, lecture seule

- Mission : câbler le module ANALYZE à la file existante sans modifier
  RECOVERY, READER ni le cœur agent/domain/scoring/redhibitory, et sans couper
  l'edge historique `analyze-dce`.
- Base et isolation : branche `feat/analyze-wiring`, worktree dédié, base exacte
  `origin/main@deb8adad4ba186dd5165bd8c50fa145212af2c53`.
- Contrats DB relus uniquement contre Supabase local via
  `pg_get_functiondef` : `claim_dce_analysis_queue_row`,
  `list_tender_analysis_documents`, `sync_tender_lot_analysis` et
  `record_ai_spend`. Aucune connexion production.
- Modes : `off` par défaut et sans construction de client ; `shadow` observe au
  plus dix lignes puis analyse un seul dossier sans claim/acquittement/update/
  ledger/comptage d'usage ; `apply` est préparé derrière une capacité distincte
  mais reste interdit jusqu'au GO explicite de Pierre.
- Assemblage : tender + profil entreprise + qualifications + pièces de
  `list_tender_analysis_documents`, lecture des textes privés READER, rôles et
  lots conservés, refus des extractions non terminales, limites de 100 pièces et
  1 000 000 caractères.
- Shadow : résultat riche journalisé par lot sans texte brut ni extrait de
  citation, rappel des leçons actif, score existant relu après analyse et delta
  tracé avec `learning_applied`, `lessons_count` et `rules_count`.
- One-shot : nouvelle CLI `analyze` / `analyze:start`, une passe puis exit ; le
  script Railway `start` du READER reste inchangé. Un shadow répété peut revoir
  la même ligne, conséquence volontaire de la lecture seule stricte.
- Apply préparé : claim RPC exact, update tender protégé, synchronisation des
  seuls lots enfants déjà existants pour un parent marché, ledger existant,
  aucune création de lot et aucune transition GO/NO-GO/rejet.
- Tests mockés : off sans dépendances, one-shot, claim puis assemblage,
  extraction non prête, couverture partielle terminale, texte manquant, marché
  alloti, comparaison shadow, zéro écriture vérifiée au niveau du client,
  contrats apply et erreurs externes assainies.
- Commits fonctionnels `[skip ci]` : `8559112`, `aabe38b`, `cd4bc7a`,
  `e60f155`, `84a2ea3` ; le commit de checkpoint final suit cette entrée.
- Gates Node 22 exécutés au premier plan : suite complète 150/150 (27 fichiers),
  lint, typecheck et build verts ; `npm audit --audit-level=high` = 0
  vulnérabilité ; gitleaks 8.30.1 = 0 fuite sur les cinq commits fonctionnels.
- Sûreté : aucun appel réel OpenRouter, aucune donnée/écriture production, aucun
  push, merge, deploy, GitHub ou Railway. `ANALYZE_MODE` reste `off`.
- Revue finale qualité/sécurité : aucun finding bloquant restant.
- Statut : `READY_FOR_ORCHESTRATOR_REVIEW`.
## 2026-07-20 — Adaptateurs PLACE + Maximilien gelés localement

- Lot développé dans le worktree dédié
  `BSA_DCE_RECOVERY_WORKER-adapters-place-maximilien`, branche
  `feat/adapters-place-maximilien`, depuis `origin/main` au commit `827eba8`.
- Ajout de deux adaptateurs sur le contrat AW existant : sessions Playwright
  bornées, login, résolution exacte de consultation, sélection des lots,
  manifeste sûr, mocks et fixtures séparés pour PLACE et Maximilien.
- Routage gelé : AW, PLACE et Maximilien vers leurs adaptateurs ; DILA/BOAMP et
  TED en `publication_only` ; autres domaines en `recovery_blocked`.
- Sûreté : `off` reste le défaut, `apply` reste bloqué, deux tentatives maximum,
  CAPTCHA/auth/erreur deviennent des échecs typés, aucune URL signée ni secret
  dans les rapports ou logs.
- Browserless est limité à la découverte du manifeste. Les contrôles pouvant
  télécharger une pièce sont refusés dans la session navigateur ; le transfert
  futur reste un stream HTTP avec host/path et redirections revalidés.
- Le CLI réel mesure l'usage officiel Browserless avant/après le lot et
  journalise uniquement le delta de compte. Une mesure indisponible ou
  incohérente bloque le lot ; aucune allocation estimée par AO.
- Preuves finales Node 22, toutes exécutées en avant-plan : RECOVERY 85/85
  (incluant les 53 tests historiques), READER 54/54 inchangés, suite complète
  139/139, lint vert, typecheck vert, build vert, `npm audit` = 0 vulnérabilité,
  gitleaks = aucune fuite sur 28 commits, `git diff --check` vert.
- Commits fonctionnels `[skip ci]` : `bc288eb`, `e259129`, `f4fe5b9`,
  `6454036`, `aa8c594`, `6112252`, `6a6a419`; le commit de checkpoint final
  porte le gel.
- Aucune recette réelle PLACE/Maximilien, aucun credential utilisé, aucun
  téléchargement persistant, écriture BSA/prod, push, merge, deploy, GitHub ou
  Railway. La recette réelle reste à l'orchestrateur après GO.
- Statut : `READY_FOR_ORCHESTRATOR_REVIEW`; RECOVERY et READER restent OFF.

## 2026-07-20 — ADAPTERS-FIX : les 2 blocages du sweep nocturne corrigés

- Ce que ça change : les 6 AO dont le DCE est en périmètre (5 AW + 1
  Maximilien) ne sont plus bloqués par l'adaptateur. Les pièces PLACE et
  Maximilien exposées en query-string Atexo sont maintenant reconnues (plus de
  manifeste faux-positif « Signer un document »), et le mur AW `choixDCE`
  est franchi par l'identification Keycloak déjà prouvée, avec un budget
  CAPTCHA borné.
- FIX A (commit `4afd7b1`) : `isAttachmentUrl`/`isPortalAttachmentUrl`
  reconnaissent les actions Atexo `page=Entreprise.EntrepriseDemandeTelechargementDce`
  et `EntrepriseDownloadReglement` (module partagé `src/adapters/atexo.ts`) ;
  les liens d'action non-pièce (« Signer un document ») sont exclus du
  manifeste ; `isSafeManifestControlTarget` ne clique plus un lien de
  téléchargement Atexo comme contrôle de révélation (la session reste sur la
  page qui liste les pièces — cause racine du témoin PLACE 3040234) ;
  identité stable des pièces Atexo via action+id de la query. Fixtures neuves
  calquées sur Maximilien 942952 et le témoin PLACE.
- FIX B (commit `f70ed87`) : sur `dematEnt.choixDCE`, clic du lien « VOUS
  DEVEZ VOUS IDENTIFIER » puis login Keycloak existant inchangé ; choix
  « DCE complet » géré (lots `all`), formulaire de lots sauté uniquement si
  le parcours DCE complet l'a remplacé ; `AwCaptchaSolveBudget` finance au
  plus une résolution Browserless (10 unités) par tentative, au-delà échec
  `CAPTCHA_UNSOLVED` retryable, et le cap worker de 2 tentatives termine en
  `recovery_blocked` honnête (`RETRY_CAP_REACHED`).
- Périmètre respecté : READER et ANALYZE intacts, aucun credential utilisé,
  lot 100 % mocks/fixtures, pas de recette réelle (réservée à
  l'orchestrateur), pas de push.
- Gates avant-plan : suite complète 158/158 (139 existants + 19 nouveaux,
  zéro régression), lint vert, typecheck vert, build vert,
  `npm audit --audit-level=high` = 0 vulnérabilité, gitleaks = 0 fuite sur
  41 commits, `git diff --check` vert, smoke mock dry-run `manifest_ready`
  3 pièces sans écriture.
- Corpus réel futur (recette orchestrateur) : AW IDM 1848852 / 1849180 /
  1848459 / 1840818 / 1846761 et Maximilien 942952.
- Statut : ADAPTERS-FIX GELÉ, prêt pour recette réelle orchestrateur.

## 2026-07-20 (nuit) — FIX C mur AW choixDCE (lien anonyme) + re-preuve réelle

- FIX C (commit `b6fd0d7`) : sur `dematEnt.choixDCE`, si le bouton RETRAIT
  ANONYME est absent, suivre le lien « retirer le DCE en mode anonyme »
  (`a[href*="fuseaction=dce.avertissement" i]`) AVANT toute dépense captcha
  (le mur porte son propre `#texteCaptcha` d'identification qu'on abandonne) ;
  la page d'arrivée expose la surface déjà gérée (RETRAIT ANONYME +
  `#texteCaptcha` + verifLotsDCE). Bouton direct et identification Keycloak
  gardés en fallback. + commit `d91d4f3` : event stderr
  `adapter_attempt_failed` avec errorDetail statique (le run 1 réel était
  indiagnosticable au seul reasonCode) ; contrat stdout inchangé.
- Tests 158 → 163 (helper ×2, flux discover complet ×2 avec assertion
  « solve financé sur avertissement, jamais sur choixDCE », worker ×1).
  Gates avant-plan vertes aux 2 commits : test:ci, lint, typecheck, build.
- Re-preuve réelle AW Saint-Gilles IDM 1848459 (dry_run strict, cap 40 u,
  2 tentatives) : mur choixDCE FRANCHI (plus de PROFILE_LINK_NOT_FINAL,
  52,9 s puis 52,7 s au lieu de 143 s), mais MANIFESTE NON OBTENU —
  `ADAPTER_FAILURE / "AW select-all control is unavailable"` ×2. Diagnostic
  prouvé par sonde HTTP gratuite : POST captcha faux → 302
  `dce.avertissement&typeErreur=captcha` (rebond silencieux, 0 `#selectAll`)
  = signature exacte ; Browserless a rempli le captcha image custom FAUX aux
  2 tentatives (l'aléa connu, solves facturés). 22 unités (195 → 217, stable),
  0 téléchargement, 0 écriture BSA (`productionWriteOccurred=false` ×2).
- Candidat FIX D (non implémenté) : détecter `typeErreur=captcha` après le
  clic RETRAIT ANONYME → `CAPTCHA_UNSOLVED` retryable (refinance un captcha
  frais en tentative 2 interne) au lieu d'ADAPTER_FAILURE non-retryable.
- Rapport complet : `reports/proof-sweep-20260721.md` (section FIX C).
- Statut : ADAPTERS-FIX-C GELÉ (code aux commits `b6fd0d7` + `d91d4f3`).

## 2026-07-21 — READER-HARDENING : PDF longs par tranches + isolation feuilles ZIP

- Contexte : 2 défauts PROUVÉS par la démo chaîne réelle Maximilien 942952
  (`reports/night-demos-20260721.md`, DÉMO 1) — CCAP 902 Ko et PGC 427 Ko en
  `READER_LLM_INVALID_OUTPUT` 2×2 tentatives (~0,41 $ brûlés, sortie > cap
  8 192 tokens), et `processZipDocument` qui propageait l'échec d'UNE feuille
  au ZIP entier (AO sans analyse pour un PGC illisible).
- FIX 1 (commit `038451d`) : `splitPdfIntoPageChunks` + lecture par tranches
  de 8 pages dans `readPdf` (> 8 pages → tranches séquentielles, texte
  concaténé, `pages_lues` sommées, coût tracé par tranche en notes
  `chunk_read`, retry schéma-invalide borné PAR tranche) ; cap sortie LLM
  8 192 → 16 384 pour les docs denses ≤ 8 pages restés single-shot. Choix
  tranches (vs continuation) : le file-parser facture l'entrée par page, le
  découpage envoie chaque page une seule fois → coût ≈ single-shot, linéaire
  et prévisible ; la continuation renverrait tout le PDF à chaque tour et
  `generateObject` n'a pas de continuation native sur JSON tronqué. Un doc
  long ne peut plus brûler 2 tentatives pour un dépassement structurel.
- FIX 2 (commit `46a32e9`) : isolation par feuille dans `processZipDocument` —
  feuille qui jette = marquée dans les notes (entry + raison typée + coût
  brûlé, spend enregistré), les autres complètent ; échec global UNIQUEMENT
  si aucune feuille lisible (`READER_ZIP_NO_READABLE_LEAF`, coût agrégé +
  notes par feuille dans `store.fail`) ; `complete()` reflète le partiel
  honnêtement (statut + liste des feuilles échouées, coût total brûlé
  compris). WeakSet anti-double-spend supprimé (mort après le refactor).
- Tests 206 → 211 : découpage borné (8 pages entier / 9 pages en 8+1), doc
  20 pages → 3 tranches concaténées 1 seule tentative logique coût par
  tranche, tranche invalide bornée à son propre retry (0,018 $ agrégé), ZIP
  4 feuilles dont 1 LLM-échouée + 1 corrompue → 2 lues + échecs marqués sans
  échec global, ZIP 100 % échoué → échec global propre typé. Zéro régression.
- Gates avant-plan : test:ci 211/211, lint, typecheck, build, `npm audit`
  0 vulnérabilité, gitleaks 0 fuite (45 commits + dir src/tests).
- Worktree dédié `../BSA_DCE_RECOVERY_WORKER-reader-hardening`, branche
  `feat/reader-hardening` depuis main `8ffab18`. Pas de push (merge Pierre).
- Statut : READER-HARDENING GELÉ (fixes aux commits `038451d` + `46a32e9`).

## 2026-07-21 — Recovery apply continuous — tranche SQL

- TRANCHE SQL GELÉE au 5ebe62b
