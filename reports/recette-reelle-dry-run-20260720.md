# Recette réelle DCE — dry_run — 2026-07-20

> Superseded for AW login diagnostics and final cost by
> `recette-reelle-dry-run-20260720-login-fix.md`. The public portal outcomes
> below remain valid.

## Verdict

- Récupérables : **0/3**.
- Bloqués : **3/3**.
- Pièces manifestées : **0** ; aucun nom ni taille n'est disponible sans lien
  DCE final sur un portail autorisé.
- Écritures et téléchargements persistants : **0**.

La recherche utilise une correspondance stricte du titre tronqué Nukema avec
le début du titre canonique. Un résultat voisin n'est jamais accepté. Chaque AO
a consommé deux tentatives de portail : AWSolutions puis PLACE.

## Résultats comparatifs

| Priorité | AO | AWSolutions | PLACE | Pièces | Temps AO | Verdict |
| --- | --- | --- | --- | ---: | ---: | --- |
| 100 | Travaux de rénovation patrimoniale du Bastion XV, Rue du Rempart à Strasbourg | Avis exact trouvé, mais DCE redirigé vers `plateforme.alsacemarchespublics.eu` (hors périmètre) | Aucun résultat exact | 0 | 56,508 s dont 54,584 s Browserless | `recovery_blocked` |
| 27 | Travaux d’extension du groupe scolaire Erckmann Chatrian à Strasbourg — lots 02 et 24 | Avis exact trouvé, mais DCE redirigé vers `plateforme.alsacemarchespublics.eu` (hors périmètre) | Aucun résultat exact | 0 | 1,610 s | `recovery_blocked` |
| 6 | CONTRÔLES RÈGLEMENTAIRES DES BÂTIMENTS ET ÉQUIPEMENTS POUR L… | Aucun résultat exact | Aucun résultat exact parmi les 15 résultats parcourus | 0 | 8,499 s | `recovery_blocked` |

Les deux liens Alsace ont seulement été identifiés par leur domaine dans la
page de résultats AWSolutions. Ils n'ont pas été ouverts ni scrapés.

## Coût Browserless

La mesure de l'API d'usage du compte est passée de **0 à 5 unités** pendant la
recette. Les quatre sessions bornées représentent environ **79,6 secondes** :

| Session | Temps | Unités constatées/interprétées |
| --- | ---: | ---: |
| Chargement initial `awsolutions.fr/apr/` | 3,990 s | 1 |
| Diagnostic de redirection vers l'authentification | environ 8 s | 1 |
| Tentative Bastion : authentification puis recherche | 54,584 s | 2 |
| Vérification ciblée du formulaire d'authentification | 12,999 s | 1 |
| **Total** | **environ 79,6 s** | **5** |

Le portail a refusé les identifiants présents dans `.env`. Aucune valeur de
secret n'a été imprimée ou stockée. Aucun CAPTCHA n'a été rencontré sur les
cibles, donc aucune tentative de résolution CAPTCHA facturée à 10 unités n'a
eu lieu.

## Preuves de sûreté

- Mode `dry_run` strict.
- Une recherche AWSolutions et une recherche PLACE maximum par AO.
- Aucun `GET` de pièce DCE, aucun fichier DCE créé, aucune écriture stockage.
- Aucune lecture/écriture BSA Copilot et aucune transition d'AO.
- Les sept cibles `echanges.dila.gouv.fr` ont été exclues avant le replay.
- Aucun profil tiers suivi ; aucune URL signée, cookie ou credential persisté.
- Aucun push, déploiement, projet GitHub ou service Railway.

## Conclusion opérationnelle

Le blocage des trois AO ne vient pas d'un CAPTCHA insoluble. Pour les deux AO
strasbourgeois, la limite est le périmètre autorisé : le profil final est une
troisième plateforme. Pour le troisième AO, les deux index autorisés ne
fournissent pas d'équivalent exact. Un futur GO devrait choisir entre étendre
l'allowlist à Alsace Marchés Publics ou fournir une URL DCE finale autorisée.
