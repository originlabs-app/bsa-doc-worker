# Recette réelle DCE — correctif login AW — 2026-07-20

## Verdict

- Login Browserless/AWSolutions : **OK**.
- Entité authentifiée : **BSA PARTNERS**, déjà active ; aucune sélection
  supplémentaire nécessaire.
- Récupérables dans les deux portails autorisés : **0/3**.
- Bloqués : **3/3** ; pièces manifestées : **0**.
- Téléchargements persistants, écritures BSA et écritures stockage : **0**.

Le défaut venait du parcours automatisé, pas des identifiants. APR charge sa
SPA avant de rediriger de façon asynchrone vers Keycloak. Le worker regardait
la page trop tôt et ne reconnaissait pas le champ réel `username`. En local,
le chargeur Node pouvait aussi tronquer le mot de passe non quoté à son
caractère `#`. Le parcours corrigé attend Keycloak, soumet le formulaire réel
avec son état caché, suit les redirections OIDC et reconnaît l'entité courante.

## Résultats comparatifs

Chaque AO a utilisé exactement deux recherches publiques : AWSolutions puis
PLACE. Une session Browserless authentifiée partagée a ensuite vérifié les
trois titres dans l'API de recherche AWSolutions et la surface « Mes
Consultations ».

| Score | AO | AWSolutions authentifié | PLACE | Pièces | Temps recherches publiques | Verdict |
| ---: | --- | --- | --- | ---: | ---: | --- |
| 100 | Travaux de rénovation patrimoniale du Bastion XV, Rue du Rempart à Strasbourg | Avis exact `26EMS0120`; annonce interne AWS, mais seul `urlDemat` cible `plateforme.alsacemarchespublics.eu`; absent de « Mes Consultations » | Aucun résultat exact | 0 | 2,073 s | `recovery_blocked` |
| 27 | Travaux d'extension du groupe scolaire Erckmann Chatrian à Strasbourg — lots 02 et 24 | Avis exact `26VDS0103`; annonce interne AWS, mais seul `urlDemat` cible `plateforme.alsacemarchespublics.eu`; absent de « Mes Consultations » | Aucun résultat exact | 0 | 1,652 s | `recovery_blocked` |
| 6 | CONTRÔLES RÈGLEMENTAIRES DES BÂTIMENTS ET ÉQUIPEMENTS POUR L… | Aucun résultat exact | Aucun résultat exact | 0 | 9,084 s | `recovery_blocked` |

La session authentifiée finale a duré **14,263 s** pour le login et les trois
recherches. Elle a confirmé que Bastion et Erckmann n'ont aucun `urlDCE` ou
`urlRC` AWS : seulement leur annonce `www.marches-publics.info` et le portail
de dématérialisation externe. Aucun lien Alsace n'a été ouvert.

## Coût Browserless

L'API d'usage officielle est passée de **5 à 18 unités** pendant la mission de
réparation et recette, soit **13 unités**, sous le plafond de 20. Les onze
sessions de diagnostic représentent environ **132 secondes** de navigateur ;
la session probante finale représente 14,263 s. Aucun solve CAPTCHA n'a été
déclenché.

## Preuves de sûreté

- `dry_run` strict, aucune pièce téléchargée ou persistée.
- Aucune requête vers DILA et aucune navigation vers Alsace Marchés Publics.
- Aucun cookie, jeton, mot de passe ou URL signée imprimé ou stocké.
- Aucun accès ou changement dans BSA Copilot, aucune transition d'AO.
- Deux tentatives maximum par AO ; un refus d'authentification ou un CAPTCHA au
  cap retourne désormais `recovery_blocked` sans insistance.
- Aucun push, déploiement, dépôt GitHub ou service Railway.

## Décision restante

Le Bastion et Erckmann ne pourront être manifestés qu'après un GO explicite
ajoutant `plateforme.alsacemarchespublics.eu` à la whitelist. Le modèle retenu
reste : un portail supplémentaire = un GO explicite de Pierre.
