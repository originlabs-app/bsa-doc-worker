# Sweep DCE élargi — dry_run — 2026-07-20

## Verdict

- Protocole A : **1/3 AO avec manifeste**, soit **33,3 %**.
- Protocole B : **0/21 équivalent accepté**, soit **0 %**.
- Taux global de manifeste : **1/24**, soit **4,2 %**.
- Pièces manifestées : **3**, toutes pour le musée de Saint-Gilles.
- Téléchargements persistants et écritures BSA/stockage : **0**.

Le protocole B n'est pas négatif faute de résultats possibles : les 21 lignes
ont toutes `reference=""` et `acheteur=""`. La règle autorisée exige une
référence exacte ou le couple acheteur+titre strict. Neuf AO ont bien produit
un candidat de titre exact, mais ces neuf candidats ont été rejetés plutôt que
d'être assimilés par approximation.

## Résultats par AO

Les temps B correspondent à la recherche AWSolutions puis PLACE. Les résultats
des titres dupliqués ont été mis en cache. Pour A, le temps Browserless indique
les sessions auxquelles l'AO a participé et n'est donc pas additionnable entre
Béziers et Saint-Gilles.

| # | Prot. | Score | AO | Résultat strict | Pièces | Unités BL allouées | Temps |
| ---: | :---: | ---: | --- | --- | ---: | ---: | ---: |
| 1 | A | 100 | Bastion XV, Strasbourg | Externe : `plateforme.alsacemarchespublics.eu` | 0 | 0 | 0,205 s |
| 2 | B | 100 | Bastion XV, Strasbourg | Candidat titre exact rejeté : identité cible absente | 0 | 0 | 10,327 s |
| 3 | B | 88 | Centre de Secours Principal de Béziers | Candidat titre exact rejeté : identité cible absente | 0 | 0 | 5,783 s |
| 4 | B | 85 | 288 logements à Gennevilliers | Aucun équivalent strict prouvé | 0 | 0 | 5,168 s |
| 5 | B | 85 | Centre de Secours Principal de Béziers | Candidat titre exact rejeté : identité cible absente | 0 | 0 | 5,783 s |
| 6 | B | 85 | Extension/restructuration du SAMU 83 | Aucun équivalent strict prouvé | 0 | 0 | 5,608 s |
| 7 | B | 82 | Tours F et H, Frais Vallon | Aucun équivalent strict prouvé | 0 | 0 | 4,895 s |
| 8 | A | 82 | Centre de Secours Principal de Béziers | Consultation AWS exacte ; `CAPTCHA_UNSOLVED` au cap de 2 | 0 | 32 estimées | 62,524 s non additif |
| 9 | B | 82 | Groupe Hospitalo-Universitaire AP-HP | Candidat PLACE exact rejeté : identité cible absente | 0 | 0 | 5,230 s |
| 10 | B | 80 | Remise en état et aménagements divers | Aucun équivalent strict prouvé | 0 | 0 | 6,006 s |
| 11 | B | 79 | Jardin d'enfants en crèche multi-accueil | Aucun équivalent strict prouvé | 0 | 0 | 4,967 s |
| 12 | B | 79 | Local gardien de la déchèterie d'Aussillon | Aucun résultat exact AWS/PLACE | 0 | 0 | 4,757 s |
| 13 | B | 79 | Résidences Lou PL — réhabilitation thermique | Aucun équivalent strict prouvé | 0 | 0 | 5,738 s |
| 14 | B | 79 | Musée de Saint-Gilles | Candidat titre exact rejeté : identité cible absente | 0 | 0 | 6,033 s |
| 15 | B | 77 | Lycée Léonard de Vinci | Aucun équivalent strict prouvé | 0 | 0 | 5,946 s |
| 16 | B | 74 | Centrale de groupes électrogènes — Hôpital NOVO | Candidat PLACE exact rejeté : identité cible absente | 0 | 0 | 5,906 s |
| 17 | B | 74 | Construction de 44 logements collectifs | Aucun équivalent strict prouvé | 0 | 0 | 6,134 s |
| 18 | B | 73 | Centrale de groupes électrogènes — Hôpital NOVO | Candidat PLACE exact rejeté : identité cible absente | 0 | 0 | 5,906 s |
| 19 | B | 73 | Musée de Saint-Gilles | Candidat titre exact rejeté : identité cible absente | 0 | 0 | 6,033 s |
| 20 | B | 72 | Fort de Saint-Cyr | Aucun équivalent strict prouvé | 0 | 0 | 5,773 s |
| 21 | B | 70 | Plateau pour deux locaux | Aucun équivalent strict prouvé | 0 | 0 | 5,904 s |
| 22 | B | 69 | Groupe Hospitalo-Universitaire AP-HP | Candidat PLACE exact rejeté : identité cible absente | 0 | 0 | 5,230 s |
| 23 | A | 67 | Musée de Saint-Gilles | `manifest_ready_with_size_blocker` | 3 | 22 estimées | 68,319 s non additif ; manifeste final 6,632 s |
| 24 | B | 67 | Résidences Lou PL — réhabilitation thermique | Aucun équivalent strict prouvé | 0 | 0 | 5,738 s |

## Manifeste Saint-Gilles

AWSolutions n'a pas exposé de nom métier stable sans réutiliser un identifiant
signé. Les libellés ci-dessous sont donc volontairement neutres.

| Libellé sûr | Type observé | Taille | HEAD | Faisabilité actuelle |
| --- | --- | ---: | ---: | --- |
| `document-pdf-1` | PDF | inconnue | 200 | accessible, taille à confirmer avant apply |
| `piece-dce-1` | inconnu | 686 614 octets | 200 | oui, sous le cap de 100 MiB |
| `piece-dce-2` | inconnu | 630 219 763 octets | 200 | non : dépasse le cap actuel de 100 MiB |

Les requêtes `HEAD` n'ont transféré aucun corps et aucun fichier n'a été créé.
Le manifeste prouve la disponibilité du dossier, mais un futur `apply` devrait
faire valider le relèvement du cap pour la pièce de 630,2 Mo.

## Protocole B et ambiguïtés rejetées

- Équivalents acceptés : **0/21**.
- Candidats de titre exact observés puis rejetés : **9/21** : Bastion (1),
  Béziers (2), AP-HP (2), Saint-Gilles (2), Hôpital NOVO (2).
- Recherches PLACE arrêtées par le garde-fou de plus de 20 résultats : **15/21**.
- Correspondances approximatives acceptées : **0**.

Même si un candidat supplémentaire se trouvait au-delà des 20 résultats, il
resterait non réconciliable : aucune des 21 lignes B ne fournit la référence ou
l'acheteur nécessaire au contrat de matching.

## Census des redirections externes

| Domaine externe | AO concernées | Consultations distinctes | Action |
| --- | ---: | ---: | --- |
| `plateforme.alsacemarchespublics.eu` | 2 | 1 | interdit, aucun accès ; GO portail requis |

Aucun autre domaine externe n'a été rencontré sur un candidat strict ou un
candidat de titre exact. Les domaines DILA, TED, Achatpublic et Maximilien sont
des liens sources de Nukema, pas des redirections suivies.

## Coût et sûreté

- Usage Browserless : **18 → 72 unités**, soit **54 unités** sur le cap de 120.
- Temps Browserless : **78,808 s** sur trois sessions ; temps HTTP de recherche
  des 16 titres uniques : **94,735 s**.
- Allocation par AO estimée à partir des phases et de la session partagée :
  Béziers **32 unités**, Saint-Gilles **22**, toutes les autres **0**.
- Login BSA PARTNERS : OK. Le coût agrégé correspond à cinq tentatives de
  résolution CAPTCHA et quatre unités de temps navigateur ; aucune réponse
  CAPTCHA n'a été journalisée.
- Deux tentatives maximum par AO : Béziers et Saint-Gilles ont atteint deux ;
  aucune troisième tentative. Bastion n'a déclenché aucune session Browserless.
- Zéro navigation vers un portail interdit, zéro GET de pièce, zéro fichier
  DCE, zéro écriture BSA ou stockage, zéro changement de statut AO.
- Aucun secret, cookie ou URL signée n'est conservé dans ce rapport.

## Conclusion opérationnelle

Le taux réellement prouvé sur ce sweep est faible (**4,2 %**), mais le principal
frein du protocole B est mesurable et corrigeable en amont : Nukema doit fournir
au moins la référence acheteur ou le nom exact de l'acheteur. Le prochain portail
à considérer reste Alsace Marchés Publics, observé sur deux lignes pour une même
consultation ; il demeure interdit sans GO explicite.
