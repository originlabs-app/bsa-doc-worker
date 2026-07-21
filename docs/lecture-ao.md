# Doctrine de lecture d'un AO — worker bsa-ai-worker

Statut : source de vérité LECTURE pour les prompts du worker (reader + analyze).
Consolidé le 21/07/2026 à partir de trois sources :
1. **Manuel Paul** (`BSA_COPILOT_PRODUCTION/docs/veille/regles-metier-extraction-paul.md`,
   05/07/2026 — email + 3 vocaux + docx CY Cergy). Règle d'or : à utiliser tel
   quel, ne pas réinterpréter sans revalider avec Paul.
2. **Méthode pro publique** (guides chefs d'étude BTP : kalao-solution.fr,
   remporte.fr, marchespublicsoptimises.fr, marche-public.fr, aoconquete.fr).
3. **Leçons d'exploitation** (nuit 21→22/07, `reports/night-demos-20260721.md`).

Principe : un chef d'étude ne lit pas un DCE, il le **fouille**. Décision
go/no-go humaine = 30-60 min sur une fiche d'une page — pas 4 h de lecture.
Le worker reproduit cet entonnoir : moins de tokens, mieux placés.

## 1. Entonnoir à deux passes

**Passe 1 — go/no-go (coût minimal, tous les pertinents)**
Lire uniquement : RC (en entier — il est court et porte 10 champs sur 15 du
manuel Paul) + DPGF/BPU/DQE (postes tarifés) + **scan ciblé** du CCAP
(pénalités + plafond, révision des prix, délais de paiement, retenue de
garantie, section « dérogations au CCAG » en fin de document).
Produit : la **fiche de synthèse 1 page** (§4) + les éliminatoires (§3).

**Passe 2 — lecture profonde (seulement si GO ou zone de seuil)**
CCTP réduit au chapitre « prestations attendues » (jamais les conditions
techniques d'exécution — verbatim Paul), contrôle de cohérence DPGF↔CCTP
(postes manquants, écarts quantitatifs >10 %), exigences implicites, normes.
Hiérarchie contractuelle en cas de contradiction : RC et CCAP priment sur CCTP
— une divergence (ex. Qualibat RC vs CCTP) est une **vigilance à citer**, pas
à résoudre silencieusement.

**Jamais** : plans, annexes graphiques, mémoires types — hiérarchisés, listés
dans la couverture, non lus (ADR extraction sélective du 10/06).

## 2. Où regarder, pièce par pièce (encadrés)

| Pièce | Zones précises | Ce qu'on y prend |
|---|---|---|
| RC | page de garde (référence au **milieu** ou note en bas à gauche ; acheteur en gros + adresse dessous), premières pages, tableau des critères | référence, acheteur, objet, allotissement (« Non allotie », jamais « lot 0 »), critères d'attribution **avec pondération** (obligatoire en procédure ouverte), DLRO, visite (obligatoire/facultative/sans objet), qualifications & admissibilité, type de contrat (3 valeurs, jamais la procédure) |
| CCAP | sections pénalités, prix, paiement ; **fin de document** (dérogations CCAG) | pénalités **et leur plafond** (CCAG Travaux ~10 % ; >1/1000e/jour = drapeau rouge), formule de révision (ferme/révisable/actualisable), délais de paiement, garanties, résiliation, début/durée des prestations |
| CCTP | chapitre « prestations attendues » (souvent chap. 3) uniquement | prestations, qualifications par corps de métier, exigences techniques clés |
| DPGF/BPU/DQE | postes tarifés, récapitulatifs (souvent en **fin**) | description des prestations (« je copie-colle ça, c'est 95 % des cas » — Paul), quantités, montants |
| AE | champs montant | vérification croisée du montant |

Ordre de recherche par champ (manuel Paul, à respecter tel quel) : montant =
RC → AAPC → CCAP → AE (accord-cadre : montant MAXIMUM obligatoirement publié ;
annuel × durée reconductions comprises) ; début des prestations = RC → CCAP →
planning prévisionnel ; durée = RC → CCAP → AAPC.

Lecture physique : classification d'une pièce par sa **page 1** seule ;
extraction tête+queue (les montants et récapitulatifs vivent au début et à la
fin) — `copyPdfHeadTailPages` existe déjà, l'edge utilisait 100k/50k chars.

## 3. Éliminatoires précoces (tuent l'AO en passe 1, coût quasi nul)

- Qualification/certification obligatoire absente chez le client du dossier.
- Délai de réponse ou d'exécution impossible (DLRO dépassée ou < plancher).
- Pénalités sans plafond combinées à un délai serré.
- Rédhibitoires métier du scorer (amiante SS4 sans habilitation, etc.).
Un éliminatoire **suspecté** n'écarte jamais seul : il déclenche l'audit
(cascade §6) avant tout écartement. Leçon CY Cergy : **jamais créditer une
information absente** — un critère inconnu va dans `criteres_inconnus`, pas
dans le score.

## 4. Le livrable : fiche de synthèse 1 page

Objet/allotissement · acheteur · référence · montant (sourcé, jamais estimé) ·
DLRO + délai restant · visite (avec date) · critères pondérés · qualifications
exigées · clauses sensibles (pénalités/plafond, révision, dérogations CCAG) ·
éliminatoires & vigilances (chacune citée : fichier + passage) ·
couverture honnête (pièces lues / non lues / illisibles, `pages_lues`).
C'est la fiche qui remplace les 1-3 h d'analyse manuelle du client et lui
permet de tenir le ratio pro « répondre à 1 AO sur 3 ».

## 5. Règles d'honnêteté (non négociables, héritées du 21/07)

- Toute valeur extraite porte sa **citation exacte** (fichier + passage) ; le
  nombre extrait doit correspondre au nombre cité, sinon `null`.
- Couverture sincère : `partial_weak` distingue lecture partielle et dossier
  non lu ; les pièces non lues sont listées, jamais passées sous silence.
- Le modèle **informe**, la grille de code **décide** la note. Sorties typées
  (`generateObject` + Zod), jamais de texte libre dans le pipeline cœur.
- Verrous humains (`locked_fields`, `human_validated`) : le worker n'écrase
  jamais, en aucune passe.

## 6. Implémentation SDK (cascade modèles, décision Pierre 21/07)

- **Reader** : `gemini-3.1-flash-lite` en lecture ciblée (bench 10/06 : 9/9
  champs, ~30× moins cher que 3.5-flash) ; fallback `gemini-3.5-flash` sur
  échec. **Préalable** : corriger la troncature `maxOutputTokens` (JSON
  invalide observé nuit 21/07 sur gros texte — problème de sortie, pas
  d'intelligence) : chunker l'entrée pour que la sortie tienne, ou élever la
  limite, et re-valider Zod avec retry.
- **Analyze** : `gpt-5.6-terra` sur contexte **assemblé** (~40k tokens
  d'extraits structurés par rôle, pas le texte brut) pour **tous** les
  pertinents (~0,11 $ observé). Terra en intégrale (ctx 1M) = mode d'exception
  (arbitrage, multi-lots complexes).
- **Tri amont** : fiche seule (sonnet-5 en prod), inchangé.
- Coût cible : ~0,15-0,20 $/dossier complet, ~5-8 $/jour au volume actuel.
- Tout est pilotable par env (`OPENROUTER_MODEL_*`, `ANALYZE_RECORD_TYPES`).

## 7. Leçons d'exploitation (à enrichir en continu)

- 21/07 : le READER représentait 85 % du coût dossier (0,61 $/0,72 $) — le
  levier d'économie est la lecture ciblée, pas le modèle d'analyse.
- 21/07 : refus honnête `ANALYZE_NO_READABLE_DOCUMENTS` sur dossier non
  extrait = comportement voulu, à préserver.
- (à compléter au matin avec les résultats de la bascule de nuit :
  écarts flash vs terra sur l'échantillon d'audit, faux éliminatoires,
  champs manqués par la lecture ciblée.)

## Rattachement

Les Q/R et rectificatifs acheteur peuvent invalider une analyse en cours de
consultation (pratique pro) : à traiter comme un chantier distinct
(re-analyse sur mise à jour du DCE), hors périmètre de ce document.
