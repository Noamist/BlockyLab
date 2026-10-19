# Blocky — surface d'attaque & protocole d'audit

Ce document liste **tout ce qui peut être testé** avec Blocky Lab, comment le tester, et ce qui constitue une vraie faille plutôt qu'un comportement normal.

> Règles : un test = **une** tentative, sur **ton** compte, sur un serveur de test ou avec l'accord du staff. Pas de spam, pas d'exploitation à grande échelle, pas de compte d'autrui. Les économies et les classements ne valent pas un bannissement.

---

## 1. Modèle de menace

Blocky est un bot Discord qui :

- reçoit des interactions (slash commands, boutons) ;
- possède un état persistant (joueurs, inventaires, prêts, enchères, équipes) ;
- génère de l'aléatoire (minage, Lucky Block, wheel, blackjack, Mines, boss, butin) ;
- affiche des résultats dans des embeds, parfois avec des boutons.

Les failles intéressantes sont donc, par ordre de probabilité :

1. **Erreurs de logique économique** (arrondis, double dépense, races).
2. **RNG faible ou biaisée** (modulo, seed, état partagé).
3. **Validation insuffisante des entrées** (montants, IDs, texte libre).
4. **Fuites d'information** (IDs internes, timings, messages d'erreur).
5. **Abus de confiance côté client** (boutons, cooldowns, état local).

---

## 2. Tableau de bord des tests

| # | Test | Outil | Ce qu'on observe | Sévérité si échec |
|---|---|---|---|---|
| R1 | Distribution Lucky Block vs wiki | RNG Lab → Biais | χ², RTP, IC 95 % | Moyenne (si RTP > 100 %) |
| R2 | Uniformité wheel (37 numéros) | RNG Lab → Biais | χ² df 36, entropie | Haute si un numéro sort trop |
| R3 | Dépendance entre tirages | RNG Lab → Vue d'ensemble | runs test, Markov, autocorrélation | Haute |
| R4 | Seed temporelle | RNG Lab → Seed | candidats reproduisant 4–6 valeurs | Critique |
| R5 | Corrélation horloge → issue | RNG Lab → Séquences | taux de correspondance | Critique |
| R6 | Mines +EV | Jeux → Mines | multiplicateur × survie | Haute (edge monétaire) |
| R7 | Sabot blackjack persistant | Blackjack | true count, cartes vues | Haute |
| R8 | Blackjack : tirage avec remise | Blackjack + recon | 5 as dans une main, totaux impossibles | Haute |
| C1 | Drop snipé | Pilote → Drops | temps de clic vs butin | Moyenne (iniquité) |
| C2 | Double clic sur un bouton | Recon + manuel | deux récompenses ? | Critique |
| C3 | Interaction rejouée | Recon → custom_id | même `custom_id` → même effet ? | Critique |
| C4 | Race sur `/trade`, `/auction`, `/loan` | manuel | double acceptation, solde négatif | Critique |
| E1 | Montants négatifs / énormes | manuel | `/pay @x -1`, `/auction sell ... -1` | Critique |
| E2 | Arrondis de taxe / intérêt | manuel | 1 émeraude, 5 %, prêts 0 % | Moyenne |
| E3 | Dépassement d'entier | manuel | 2^31, 2^53 | Moyenne |
| E4 | Solde négatif | manuel | après achat/retrait | Critique |
| T1 | Injections dans les textes | manuel | bio, team name, bannière, titre | Moyenne |
| T2 | Mentions / @everyone dans les embeds | manuel | ping massif via nom d'équipe | Haute |
| T3 | Longueur / caractères de contrôle | manuel | 150 char, zéro-width, RTL | Faible |
| D1 | Daily à minuit Europe/Paris | manuel | double claim au changement d'heure | Moyenne |
| D2 | Saison / tournoi / robbery aux limites | manuel | double comptage, heure locale | Moyenne |
| I1 | Fuite de snowflake | Recon | worker/process/incrément | Info |
| I2 | `custom_id` porteur d'état | Recon | IDs uniques par partie | Info → Haute si rejouable |
| I3 | Messages d'erreur verbeux | manuel | stack trace, IDs internes | Faible |
| I4 | Latence | Recon | distribution des délais | Info |
| A1 | Cooldown contourné | manuel | multi-salons, edit, boutons | Moyenne |
| A2 | Limite de mise / gains quotidienne | Pilote | dépassement de 3 000 | Moyenne |
| A3 | Équipes : score logarithmique | manuel | members inactifs, transferts | Faible |
| A4 | Prêts : pénalité et saisie | manuel | 50 % des gains, blocage | Haute si contournable |

---

## 3. Détail des tests

### R1–R2 — Biais de distribution

**But** : vérifier que les probabilités annoncées sont respectées.

- Lucky Block : 7 issues, probabilités `31,5 / 22 / 18 / 15 / 9 / 4 / 0,5 %`, RTP 95 %.
- Wheel : 37 numéros uniformes, rouge/noir ×2, numéro ×36, RTP 97,3 %.

**Procédure** : collecter ≥ 300 Lucky Blocks et ≥ 500 tirages de wheel. Lire χ² et p dans RNG Lab. Un p < 0,01 avec un échantillon suffisant est un signal.

**Faux positifs** : tester 37 numéros à 5 % donne ~1,85 faux positif par test. Utiliser le seuil de Bonferroni affiché (|z| > 2,9). Répliquer sur un second échantillon avant de conclure.

**Ce qui serait critique** : un RTP mesuré > 100 % avec un IC 95 % qui exclut 100 %, ou un numéro avec un |z| > 4.

---

### R4 — Recherche de seed

**Hypothèse** : le bot fait `seed = Date.now()` (ou secondes/minutes) puis utilise un PRNG déterministe.

**Procédure** :

1. RNG Lab → Seed, jeu = wheel, famille = mulberry32, unité = ms, fenêtre ±5 000.
2. Lancer. Le moteur teste 10 001 seeds et compare 6 sorties.
3. Si aucun candidat : essaie xorshift32, LCG, java.util.Random, MT19937 ; puis unité = s ou min.
4. Si un candidat sort : bouton **Prédire**, puis 3 nouvelles sorties pour confirmer.

**Interprétation** :

- Aucun candidat ≠ pas de faille : cela élimine seulement les familles testées sur cette fenêtre.
- Un candidat qui reproduit 6 valeurs puis se trompe = faux positif (probabilité ≈ 37⁻⁶).
- `Math.random` de V8 est un xorshift128+ seedé par l'OS : **non récupérable** par force brute. Si le bot l'utilise, la seule voie est statistique (R1–R3).

**Astuce timing** : la fenêtre doit couvrir le moment du **tirage**, pas celui du message. Utilise l'onglet Recon pour mesurer le délai bot (message envoyé → embed reçu) et élargis la fenêtre en conséquence.

---

### R6 — Mines : la piste la plus concrète

La table du wiki donne, pour 1 TNT : `×1,00` après 1 bloc, `×1,12` après 2, `×1,27` après 3.
La survie exacte vaut `19/20 = 0,95`, `18/20 = 0,90`, `17/20 = 0,85`.

| Blocs | Multiplicateur | Survie | EV |
|---|---|---|---|
| 1 | 1,00 | 0,950 | 95,0 % |
| 2 | 1,12 | 0,900 | **100,8 %** |
| 3 | 1,27 | 0,850 | **107,95 %** |

Si ces chiffres sont exacts **en jeu**, creuser 3 blocs avec 1 TNT est +EV de ~8 %. C'est soit une table de paiement mal calibrée, soit une erreur du wiki.

**Vérification** : jouer une partie, relever le multiplicateur affiché au cash-out et le nombre de TNT. Le calculateur (Jeux → Mines) recalcule l'EV avec tes valeurs. Ne tire pas de conclusion d'une seule partie : le résultat est binaire (survie ou boom), il faut plusieurs essais pour approcher l'EV.

**À signaler** : « le multiplicateur documenté/affiché dépasse l'inverse de la probabilité de survie ». Fournis la capture du cash-out et le calcul.

---

### R7–R8 — Blackjack

**R7 — sabot persistant.** Si le bot utilise un sabot de 6 jeux mélangé seulement quand il est vide (ou à un seuil), le comptage Hi-Lo donne un avantage. Le script suit le running count, le true count et la pénétration. Vérifie :

- le true count monte-t-il réellement après une série de petites cartes ?
- le bot annonce-t-il un mélange ? Sinon, le script réinitialise à la pénétration configurée (75 % par défaut) — à ajuster.

**R8 — tirage avec remise.** Un vrai sabot ne peut pas donner 5 as dans une main. Si tu observes des combinaisons impossibles (5 as, 6 rois, total de 5 cartes > 21 impossible), le bot tire chaque carte indépendamment : le comptage ne sert à rien, mais la stratégie de base reste correcte.

**Procédure** : collecter 100 mains, vérifier dans les observations que les cartes affichées sont cohérentes. Le script ne compte que les cartes nouvelles (delta), pas les répétitions de réaffichage.

---

### C1 — Sniper de drops

Le premier clic gagne. Le sniper écoute le salon **1557793570243477524** par défaut (modifiable dans Pilote → Drops), via `MESSAGE_CREATE` et le DOM. Il clique uniquement le premier composant de l'embed du bot (custom_id ou libellé, jamais « Répondre »), avec un délai configurable (~220 ms). Un humain met 300–800 ms.

**Test** : activer Drops en simulation, mesurer le délai sur 10 drops. Puis réel sur un serveur de test. **Ne pas** laisser tourner en permanence sur un serveur public : c'est le comportement le plus visible pour le staff.

**Variantes utiles** : drop déjà réclamé, drop cliqué par deux comptes au même instant, bouton encore cliquable après expiration, drop sans vérification d'ancienneté du compte.

**Faille côté bot** : un drop sans limite par joueur, sans vérification d'ancienneté de compte, ou qui reste cliquable après expiration. Teste un drop déjà réclamé : le bouton doit répondre « déjà pris ».

---

### C2–C3 — Boutons et interactions

**Double clic** : clique deux fois sur un bouton de récompense (Lucky Block, drop, daily). Le serveur doit traiter une seule interaction. Un doublon = faille critique.

**Rejeu** : dans Recon, repère un `custom_id` unique par partie (contient souvent un identifiant). Discord signe les interactions ; un rejeu brut est normalement rejeté. Mais un `custom_id` qui encode un montant ou un état peut être modifié côté client avant l'envoi — c'est le test le plus intéressant. **Ne le fais qu'une fois, avec un montant minimal.**

**Ce qui est normal** : le bouton reste cliquable, mais le serveur répond « interaction expirée ». Ce n'est pas une faille.

---

### C4 — Races économiques

Les commandes qui déplacent de l'argent en deux temps sont les plus fragiles :

- `/trade` : accepter deux fois, accepter puis annuler, modifier l'offre après acceptation.
- `/auction` : acheter la même annonce depuis deux clients, annuler pendant l'achat.
- `/loan` : accepter deux prêts simultanément (la limite est « un prêt impayé par emprunteur »), rembourser deux fois.

**Outil** : Trade Lab (07) → Auto-tests de failles pour le double accept, accept-puis-annulation, offre à 0, auto-trade, acceptation rapide, rejeu et course synchronisée ; Fuzzer (08) pour les montants limites et les rafales d'idempotence. Deux comptes de test, jamais un joueur tiers. Vérifier les soldes avant/après (le Trade Lab lit le dernier solde et calcule le delta). Une duplication d'émeraudes est critique.

### C5 — Validation des trades et des enchères

Le composeur de Trade Lab scanne les boutons du message **et des modales visibles** (`[role="dialog"]`), puis permet de tester, sans spam :

- **double accept** : deux clics à 80 ms d'écart ;
- **accept puis cancel** : le serveur doit annuler proprement ;
- **modification après accept** : l'acceptation doit être invalidée ;
- **solde insuffisant / montant 0 / négatif** : refus attendu ;
- **auto-trade** : refus attendu ;
- **course** : les deux clients envoient et acceptent au même instant (délai armé).

Pour les enchères, tester en plus : achat de sa propre annonce, annulation pendant une enchère, prix 0/négatif, deux acheteurs simultanés. Le Fuzzer génère ces valeurs et classe les réponses (`rejected`, `accepted`, `error`, `ratelimit`).

### C6 — Cooldowns et idempotence

Le test le plus simple : envoyer deux fois la même commande à moins de 200 ms (deux onglets, ou bouton + commande). Les cooldowns doivent être vérifiés côté serveur, par joueur, et non par message. Répéter sur `/daily`, `/wheel`, `/mines`, `/loan` et un bouton de récompense. Un second crédit est critique ; un message « déjà réclamé » est le comportement attendu.

---

### E1–E3 — Validation des entrées

Tester, avec des montants minimaux :

- `/pay @toi 0`, `-1`, `1.5`, `1e9`, `999999999999999999999`.
- `/auction sell item:... price:-1`, prix énorme.
- `/loan offer ... interest:25` (max 20), `interest:-1`, `days:0`, `days:99`.
- `/wheel number:-1`, `number:37`, `amount:-10`.
- `/mines amount:-10 tnt:0`, `tnt:11`.

**Comportement attendu** : refus propre, message d'erreur, aucun changement de solde. **Faille** : acceptation silencieuse, solde négatif, wrap-around, ou crash du bot.

---

### T1–T3 — Texte libre

Les champs libres : bio (150 caractères), nom d'équipe, tag, bannière, titre.

- Mentions `@everyone`, `@here`, `<@&id>` : un embed qui les rend peut ping tout le serveur.
- Markdown : `**`, `||spoiler||`, liens `[x](https://...)`, backticks.
- Unicode : zéro-width, RTL override (`\u202E`), emojis custom `<:x:id>`.
- Longueur : 150 caractères exactement, puis 151.

**Attendu** : échappement, pas de ping, troncature propre. **Faille** : ping de masse, faux embed, lien cliquable trompeur.

---

### B1 — BlockDL : solveur et limites

Le bloc du jour est une recherche d'information : chaque indice (couleur, outil, dureté, dimension, gravité, transparence, lumière, résistance aux explosions) élimine une partie des blocs. L'onglet **BlockDL** applique ces filtres, classe les candidats par information attendue et peut jouer la recommandation.

**Ce qui est une faille** : un indice qui révèle directement la réponse avant les essais, une seed de bloc du jour prévisible, ou un bouton qui accepte plusieurs propositions dans la même interaction. **Ce qui ne l'est pas** : deviner le bloc avec un solveur, c'est utiliser l'interface normalement.

**Test** : noter la date, les indices et le nombre d'essais. Rejouer le même jour sur un second compte pour vérifier que le bloc est global (attendu) ou par joueur (peut être contourné).

### D1–D2 — Temps

Le serveur utilise `Europe/Paris`, minuit pour le daily, lundi pour la saison, vendredi/samedi/dimanche pour le tournoi, 22 h–6 h pour les vols.

Tests :

- daily à 23 h 59 et 00 h 01 (deux jours consécutifs) ;
- changement d'heure (dernier dimanche de mars / octobre) ;
- tournoi : inscription à 20 h 59 samedi, `join` après la clôture ;
- robbery : lancer à 21 h 59, la victime a 1 h pour réagir — le vol franchit-il la nuit ?
- villager : 18 h–21 h, offre exclusive déjà prise.

**Attendu** : une seule récompense par période, horloge serveur. **Faille** : double claim, inscription hors délai, vol nocturne.

---

### I1–I4 — Fuites

- **Snowflakes** : l'ID de message encode ms + worker + process + incrément. Le collecteur les agrège. Un incrément qui repart à 0 souvent = redémarrage du bot ; utile pour corréler une seed.
- **custom_id** : un ID qui change à chaque partie est un identifiant de session. S'il contient le montant, le joueur, ou un timestamp, c'est une fuite d'état.
- **Erreurs** : un message d'erreur qui expose un chemin de fichier, une stack, un ID de base ou une requête SQL est une fuite.
- **Latence** : la distribution des délais (Recon) révèle la charge et peut réduire la fenêtre de seed.

**Attendu** : IDs opaques, erreurs génériques. **Faille réelle** seulement si l'ID permet une action non autorisée.

---

### A1–A4 — Robustesse et contournements

- **Cooldown** : envoyer la commande depuis deux salons, éditer un message, utiliser le bouton au lieu de la commande. Le cooldown doit être côté serveur, par joueur, pas par message.
- **Limite quotidienne** : 3 000 émeraudes de gains nets. Le pilote peut enchaîner : vérifie que la limite tient.
- **Équipes** : le score logarithmique et le partage des récompenses. Un membre inactif compte-t-il ? Un transfert de leader permet-il de contourner la limite de 5 ?
- **Prêts** : la pénalité de 10 %, la saisie de 50 % des gains, le blocage des paiements. Un emprunteur peut-il encaisser sur un second compte ? (Test éthique : ne pas harceler un joueur ; utiliser deux comptes de test.)

---

## 4. Ce qui n'est PAS une faille

- Le bouton reste affiché après expiration, mais répond « expiré ».
- Un embed public montre les gains des autres : c'est le design du bot.
- Le résultat est aléatoire et tu perds : ce n'est pas un bug.
- Le script ne peut pas prédire `Math.random` de V8.
- Un `custom_id` statique (`blackjack_hit`) est partagé par tout le monde : normal.

---

## 5. Template de rapport

```md
### [ID] Titre court
- Sévérité : critique / haute / moyenne / basse / info
- Composant : commande, bouton, embed
- Hypothèse :
- Étapes : 1. … 2. … 3. …
- Résultat observé :
- Résultat attendu :
- Preuve : capture, ID de message, heure, valeur du true count / χ² / p
- Impact : économique, disponibilité, information
- Correctif suggéré :
```

Pour les analyses RNG, joins toujours :

- le nombre d'observations,
- le test utilisé (χ², z, runs, Markov),
- la p-value **et** l'intervalle de confiance,
- une réplication sur un second échantillon.

Un p < 0,05 sur 20 tests n'est pas une preuve : c'est 1 faux positif attendu.
