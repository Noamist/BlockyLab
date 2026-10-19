# Blocky — surface d'attaque & protocole d'audit

Ce document liste **tout ce qui peut être testé** avec Blocky Lab, comment le tester, et ce qui constitue une vraie faille plutôt qu'un comportement normal.

> Règles : un test = **une** tentative, sur **ton** compte, sur un serveur de test ou avec l'accord du staff. Pas de spam, pas d'exploitation à grande échelle, pas de compte d'autrui. Les économies et les classements ne valent pas un bannissement.

**Nouveauté (v2)** : cette version est **vérifiée par lecture du code source du bot** (Blocky-main : `game/`, `cogs/`, `utils/`). Chaque verdict indique où il a été vérifié. Ce qui ne peut se conclure qu'in game reste marqué « à confirmer in game ». Les probabilités par défaut viennent de `game/settings.py` (un serveur peut les avoir changées dans `config.json` → `balance`).

---

## 0. Failles et constats vérifiés dans le code

### L1 — Lucky Block : les mises impaires sont +EV (faille réelle, d'origine arithmétique)

- **Sévérité** : haute (gain attendu positif pour le joueur, plafonné par la limite quotidienne).
- **Composant** : `/luckyblock` — `game/luckyblock.py`, fonction `open_block`.
- **Cause** : le gain est `won = floor(mise × payout + 0,5)` — un arrondi au **demi supérieur**. Trois payouts ont une fraction .5 : cobblestone ×0,5, gold ×1,5, diamond ×2,5. Sur une mise **impaire**, ces trois résultats arrondissent systématiquement vers le haut.
- **Effet mesuré (calcul exact sur les poids 315/220/180/150/90/40/5 et payouts 0/0,5/1/1,5/2,5/4/10)** :

| Mise | Retour moyen (émeraudes) | RTP | EV par partie |
|---|---|---|---|
| 1 | 1,18 | **118,0 %** | +0,18 |
| 2 | 1,90 | 95,0 % | −0,10 |
| **3** | **3,08** | **102,7 %** | **+0,08** |
| 4 | 3,80 | 95,0 % | −0,20 |
| 5 | 4,905 | 98,1 % | −0,095 |
| 7 / 9 | — | ~98 % | — |
| ≥ 10 pair | — | 95,0 % | — |

  Sur mise paire, l'arrondi est neutre et le RTP vaut exactement 95 %. Sur mise 1 ou 3, **la maison perd de l'argent**.
- **Méthode de confirmation in game** : la plus rapide est la **mise de 1** (EV +0,18/partie, σ ≈ 1,28) : environ **200 à 400 parties** (200–400 émeraudes de mise, ~20–35 min avec le cooldown de 5 s) rendent un test z significatif si la théorie est exacte. La mise de 3 a un EV supérieur (+0,08/partie) mais une variance bien plus grande (σ ≈ 3,58 : ~7 700 parties pour un z de 1,96) — inutile pour confirmer statistiquement. Onglet Jeux → Lucky Block : le tableau « Faille vérifiée » recalcule l'EV par mise.
- **Impact plafonné** : la limite quotidienne (`games.daily_win_cap`, 1 500 nets par défaut) et le cooldown de 5 s bornent le gain quotidien ; le cap n'est vérifié **qu'avant** chaque partie (`gambling.check_day`), un dernier gain peut donc le dépasser.
- **Correctif suggéré** (à transmettre au staff) : `won = round()` (Python : demi vers le pair) au lieu de `floor(x + 0.5)`, ou interdire les mises impaires, ou payer les payouts .5 en arrondant **vers le bas**.

### L2 — Mines : le tableau du wiki était faux, le jeu est juste à 95 %

- **Verdict** : **pas** d'edge. Le multiplicateur est une formule, pas une table : `mult(d, tnt) = min(25, Π_{i<d} (20−i)/(20−tnt−i) × mines_return)` avec `mines_return = 0,95` (`game/mines.py`). Le RTP vaut exactement 95 % après chaque bloc (arrondi `floor(x+0,5)` compris, sauf mises minuscules).
- Le tableau du wiki repris par la v1 du Lab (×1,12 après 2 blocs avec 1 TNT, etc.) donnait une faux EV de +8 % ; la réalité est ×1,06 après 2 blocs. L'onglet Jeux → Mines utilise maintenant la formule réelle.
- Le bot cash out automatiquement à ×25 (`mines_max_multiplier`) et quand tous les blocs sûrs sont creusés.

### L3 — Blackjack : le comptage est impossible (sabot neuf à chaque main)

- **Verdict** : **pas** d'edge par le comptage. `blackjack.start` crée un **nouveau sabot mélangé pour chaque main** (`new_deck(ctx.rng)`). Hi-Lo, true count, déviations : sans objet. La stratégie de base reste juste (EV ≈ −0,4 % avec le croupier qui s'arrête à 17 et le blackjack payé 3:2).
- À noter : le blackjack naturel paie `floor(bet × 1,5 + 0,5)` — sur une mise de 1, cela fait ×2 au lieu de ×2,5 (petit désavantage joueur, sans intérêt exploitable).

### L4 — RNG : générateur unique, semé par l'OS (recherche de seed par l'horloge : vouée à échouer)

- **Verdict** : `Database.rng = random.Random()` (`game/db.py`) — **un seul** Mersenne Twister (MT19937) partagé par **tous** les jeux, semé par l'OS (urandom), utilisé dans le thread de la base. Il n'y a **pas** de seed d'horloge : `seed = Date.now()`, LCG maison, mulberry32, xorshift… ne reproduiront **jamais** les sorties. Un résultat négatif de l'onglet Seed est donc **la réponse attendue**, pas un échec du Lab.
- Théoriquement, l'état d'un MT19937 se reconstruit à partir de 624 sorties de 32 bits non tronquées ; les sorties du bot sont tronquées (modulo 37, échantillons de sabot…) : irréalisable en pratique. Les tests statistiques (R1–R3) restent la bonne approche.
- La bande animée de la wheel utilise un `random.Random()` **séparé** dans le cog (`games_roulette.py`) : les emojis d'animation ne sont **pas** des sorties du générateur du jeu — ne pas les collecter comme telles.

### L5 — Surfaces vérifiées comme protégées (par lecture du code)

| Surface | Protection vérifiée | Où |
|---|---|---|
| Double accept d'un `/trade` | Drapeau `done` posé **avant** le `await` + `exchange.trade` revalide les possessions dans une transaction unique | `cogs/economy_exchange.py`, `game/exchange.py` |
| Boutons de trade par un tiers | `allowed_ids={a,b}` → « ❌ This isn't for you. » | `utils/ui.py` (`BaseView.interaction_check`) |
| Double accept d'un `/loan` | `_open_offer` refuse si `status != 'open'`, dans la transaction | `game/loans.py` |
| Rejeu du bouton d'un prêt après redémarrage | Boutons persistants `blocky:loan:…` mais l'état est en base : « already answered / expired » | idem |
| Achat d'enchère par deux joueurs | `buy` supprime l'annonce dans la transaction ; le second reçoit « doesn't exist » | `game/exchange.py` |
| Achat de sa propre annonce | refusé explicitement | idem |
| Boutons Blackjack / Mines par un tiers | `my_game` vérifie `user_id` : « This isn't your game » | `game/gambling.py` |
| Courses entre deux commandes | tout passe par **un seul thread** de base avec `BEGIN IMMEDIATE` : les actions sont sérialisées, pas de double dépense | `game/db.py` |
| Cooldown entre deux envois simultanés | réservé **avant** le `await` dans le cog (dictionnaire monotonic) | `games_*.py` |
| Montants négatifs / 0 | slash `Range[int, 1]` côté Discord + revalidation (`check_bet`, `spend_emeralds` gardé par `emeralds >= ?`) | cogs + `game/players.py` |
| Ping de masse via un texte de joueur | `allowed_mentions(everyone=False, roles=False)` au niveau du bot | `bot.py` |
| Solde négatif | contrainte `CHECK (emeralds >= 0)` + mises à jour gardées | migrations `game/db.py` |

Ces lignes restent à **confirmer in game** une fois chacune (une tentative), car la lecture ne couvre pas une version déployée modifiée : voir les tests C2–C5 plus bas.

---

## 1. Modèle de menace

Blocky est un bot Discord qui :

- reçoit des interactions (slash commands, boutons persistants `blocky:*`) ;
- possède un état persistant (SQLite, une transaction par action, un thread unique) ;
- génère de l'aléatoire (minage, Lucky Block, wheel, blackjack, Mines, boss, butin) via **un MT19937 partagé** ;
- affiche des résultats dans des embeds, parfois avec des boutons.

Les failles intéressantes sont donc, par ordre de probabilité :

1. **Erreurs de logique arithmétique** (arrondis — c'est comme ça que L1 a été trouvée, par lecture du code).
2. **RNG faible ou biaisée** (verdict L4 : le générateur est sain ; la testabilité est statistique).
3. **Validation insuffisante des entrées** (les slash sont gardés ; la surface réelle est dans les boutons et les autocomplétions).
4. **Fuites d'information** (IDs, timings, messages d'erreur).
5. **Abus de confiance côté client** (boutons, cooldowns, état local).

---

## 2. Tableau de bord des tests

| # | Test | Outil | Verdict code | Sévérité si échec |
|---|---|---|---|---|
| R1 | Distribution Lucky Block vs code | RNG Lab → Biais | poids 31,5/22/18/15/9/4/0,5 % — à confirmer in game | Moyenne |
| R1b | **Arrondis Lucky Block (L1)** | Jeux → Lucky Block | **faille réelle** : mises 1 et 3 +EV | **Haute** |
| R2 | Uniformité wheel (37 numéros) | RNG Lab → Biais | `rng.choice(slots())` uniforme — à confirmer in game | Haute si un numéro sort trop |
| R3 | Dépendance entre tirages | RNG Lab → Vue d'ensemble | un seul flux MT partagé : indépendant en pratique | Haute |
| R4 | Seed temporelle | RNG Lab → Seed | **écartée par le code** (L4) : attendu « aucun candidat » | — |
| R5 | Corrélation horloge → issue | RNG Lab → Séquences | idem | — |
| R6 | Mines +EV | Jeux → Mines | **écartée** (L2) : EV = 95 % exact | — |
| R7 | Sabot blackjack persistant | Blackjack | **écarté** (L3) : sabot neuf par main | — |
| R8 | Tirage avec remise | Blackjack + recon | écarté : deck réel de 52 cartes par main | — |
| C1 | Drop snipé | Pilote → Drops | 1er clic gagne ; 2e reçoit « Too late! » éphémère ; 60 s | Moyenne (iniquité) |
| C2 | Double clic sur un bouton | Recon + manuel | à confirmer in game (drapeaux `done` / statut en base) | Critique |
| C3 | Interaction rejouée | Recon → custom_id | à confirmer : IDs portent game_id/offer_id, l'état est en base | Critique |
| C4 | Race `/trade`, `/auction`, `/loan` | Trade Lab | **protégé par conception** (L5) — une confirmation in game suffit | Critique |
| E1 | Montants négatifs / énormes | Fuzzer | slash `Range[int,1]` ; surfaces restantes : boutons, autocomplétions | Critique |
| E2 | Arrondis de taxe / intérêt | manuel | taxe 5 % entière (`//100`), intérêt `amount*interest//100` (arrondi bas) | Moyenne |
| E3 | Dépassement d'entier | Fuzzer | SQLite INTEGER 64 bits ; Discord `Range[int]` 32 bits | Faible |
| T1–T2 | Mentions / @everyone | manuel | **bloqué au niveau du bot** (`AllowedMentions`) | — |
| T3 | Longueur / caractères de contrôle | manuel | bio 150 (validation non vérifiée : à tester) | Faible |
| D1 | Daily à minuit Europe/Paris | manuel | `ctx.today` sur le fuseau configuré | Moyenne |
| I1–I4 | Fuites (snowflakes, custom_id, erreurs, latence) | Recon | custom_id = `blocky:bj:…`, `blocky:mines:…`, `blocky:loan:…` (IDs de session) | Info |
| A1 | Cooldown contourné | manuel | réservé en mémoire par joueur ; **réinitialisé par un redémarrage du bot** (staff seulement) | Moyenne |
| A2 | Limite quotidienne de gains | Pilote | vérifiée **avant** chaque partie : un dernier gain peut la dépasser | Moyenne |
| A4 | Prêts : pénalité et saisie | manuel | `garnish` 50 % appliqué dans `give_emeralds` (toute entrée d'émeraudes) | Haute si contournable |

---

## 3. Détail des tests

### R1 / R1b — Lucky Block

**R1 — distribution** : collecter ≥ 300 Lucky Blocks, lire χ² et p dans RNG Lab → Biais. Seuils : Bonferroni (|z| > 2,9 par catégorie), répliquer avant de conclure.

**R1b — arrondis (L1, la faille)** :

1. Note ton solde. Joue **200 à 400 `/luckyblock` avec amount:1** (cooldown 5 s ; la limite quotidienne de gains nets ne bloque pas les pertes).
2. Le collecteur calcule le RTP mesuré dans Jeux → Lucky Block : la théorie annonce **118 %**. Un z > 1,96 sur le net total confirme.
3. Une fois confirmé : c'est un **correctif à signaler** (`floor(x+0,5)` → `round()`), pas une mine d'or durable (plafonné par le cap quotidien, et visible dans les stats du staff).

### R2 / R3 — Wheel et indépendance

La wheel est `rng.choice(slots())` sur 37 emplacements (une seule case verte par défaut). χ² df 36, entropie, runs, Markov dans RNG Lab. Collecter ≥ 500 tirages. Les emojis de l'animation ne sont pas des sorties du jeu (L4).

### R4 / R5 — Recherche de seed : **verdict attendu = aucun candidat**

Le générateur est un MT19937 semé par l'OS (L4). L'onglet Seed sert d'outil de **réfutation** : il élimine explicitement les familles faibles. Un candidat qui reproduirait 6 valeurs puis se trompe est un faux positif (probabilité ≈ 37⁻⁶). Ne pas perdre plus de temps que ça dessus contre ce bot.

### R6 — Mines : **écarté**, mais la calibration reste à vérifier

La formule réelle paie 95 % exact (L2). Le test utile : pendant une partie, relever le multiplicateur affiché (`Cash out now: **×1,06**`) et le comparer à la formule (onglet Jeux → Mines, en saisissant TNT et blocs creusés). Un écart est un vrai bug de calibration.

### R7 / R8 — Blackjack : **écartés**

Sabot neuf à chaque main (L3). Le test utile : vérifier l'affichage des cartes (le noyau 00 les parse : `` `A♠` ``, `🂠` pour la carte cachée) et la cohérence des totaux. Le comptage n'a aucun intérêt ; la stratégie de base oui.

### C1 — Sniper de drops

Le bot : « ⛏️ {titre} appeared! » + bouton **⛏️ Mine it!** ; le premier clic gagne ; un second clique reçoit « Too late! @X got there first. » (éphémère) ; 60 s pour cliquer ; au-delà : « The vein collapsed… ». Test : 2e clic après claim (refus attendu), clic après expiration (bouton désactivé). **Ne pas** laisser le sniper tourner en permanence sur un serveur public : c'est le comportement le plus visible pour le staff.

### C2–C3 — Boutons et interactions

- **Double clic** sur un bouton de blackjack/mines : le second reçoit « This game is over. » (état en base).
- **Bouton d'un autre joueur** : « This isn't your game: start your own! » (vérification `user_id`).
- **Rejeu d'un vieux custom_id** : `blocky:bj:hit:123` ne marche que pour le joueur de la game 123, et seulement si elle est encore active. Un rejeu après completion = refus.
- Le comportement **normal** : le bouton reste affiché après expiration et répond « interaction expirée » ou « These buttons don't work anymore ». Ce n'est pas une faille.

### C4–C5 — Courses économiques : protégées (L5), à confirmer une fois

Avec deux comptes de test (Trade Lab → Auto-tests de failles) : double accept de trade, accept-puis-cancel, double accept de prêt, deux acheteurs sur la même annonce, achat de sa propre annonce. **Résultat attendu d'après le code** : chaque tentative échoue proprement avec un message du bot. Toute acceptance double = faille critique immédiate à capturer (soldes avant/après).

### C6 — Cooldowns et idempotence

Deux commandes identiques à < 200 ms : la seconde doit être refusée (cooldown réservé avant le `await`). À noter : les cooldowns des jeux de chance sont **en mémoire** — un redémarrage du bot les remet à zéro (relevant du staff, pas des joueurs).

### E1–E3 — Validation des entrées

- `/pay @toi 0`, `-1`, `1.5` : refusés par `Range[int, 1]` (Discord) — test rappe mais le vrai surface est ailleurs.
- `/loan offer interest:25` : accepté par Discord (Range 0–100) mais **refusé par le serveur** (max 20 %) — vérifier le message.
- `/wheel bet:number number:37`, `number:00` avec une seule zéro : refus par `roulette.slots()`.
- `/mines tnt:0`, `tnt:11` : refus (1 à 10 par défaut).
- Fuzzer (08) : les valeurs limites n'ont d'intérêt que sur les **boutons** et les champs libres, les slash sont filtrés côté client.

### T1–T3 — Texte libre

`allowed_mentions` coupe les pings de masse (vérifié dans `bot.py`) : « T2 » n'est plus une menace sérieuse. Reste : bio (150), nom/étiquette d'équipe, bannière — longueur, markdown, RTL, zéro-width. Un embed qui affiche du markdown non échappé (faux lien) reste possible : à tester.

### D1 — Temps

Fuseau `Europe/Paris` (configurable). Daily à 23:59/00:01, changement d'heure (fin mars/fin octobre), tournoi à la clôture, robbery lancée à 21:59 (l'alourdissement de 50 % franchit-il la nuit ?). Comportement attendu : une seule récompense par période, horloge serveur.

### I1–I4 — Fuites

- Les `custom_id` portent `game_id` / `offer_id` : ce sont des identifiants de session, pas des secrets (l'état est en base).
- Les erreurs sont génériques (« ❌ Something went wrong. The error has been logged. ») : pas de stack trace côté joueur (vérifié : `utils/ui.py` `report_error`).
- La latence (Recon) mesure la charge et le délai bot, sans valeur d'attaque directe ici (pas de seed d'horloge).

### A1–A4 — Robustesse

- **Cooldown** : voir C6.
- **Limite quotidienne** : testable en observant le footer « Today at games of chance: +N (you can win 1,500 a day) » — le bot peut accepter une dernière partie au-dessus du cap (vérifié : `check_day` avant le jeu).
- **Prêts** : la saisie de 50 % est appliquée dans `players.give_emeralds` (toute entrée d'émeraudes y passe : ventes, transferts, récompenses) — contournable uniquement si un chemin d'entrée contourne `give_emeralds` (à chercher dans les gains de duels/pve/boss si on creuse).

---

## 4. Ce qui n'est PAS une faille

- Le bouton reste affiché après expiration, mais répond « expiré ».
- Un embed public montre les gains des autres : c'est le design du bot.
- Le résultat est aléatoire et tu perds : ce n'est pas un bug.
- Un `custom_id` statique (`blocky:bj:hit:<id>`) est adressé par la base côté serveur : possèder l'ID ne donne rien.
- Le cap quotidien dépassé de quelques émeraudes par un dernier gain : comportement connu, sans intérêt d'exploitation (contrairement à L1).
- Deviner le bloc du jour avec un solveur : c'est utiliser l'interface normalement.

---

## 5. Template de rapport

```md
### [ID] Titre court
- Sévérité : critique / haute / moyenne / basse / info
- Composant : commande, bouton, embed
- Hypothèse :
- Étapes : 1. … 2. … 3. …
- Résultat observé :
- Résultat attendu (d'après le code) :
- Preuve : capture, ID de message, heure, valeur du χ² / p / RTP
- Impact : économique, disponibilité, information
- Correctif suggéré :
```

Pour les analyses RNG, joins toujours :

- le nombre d'observations,
- le test utilisé (χ², z, runs, Markov),
- la p-value **et** l'intervalle de confiance,
- une réplication sur un second échantillon.

Un p < 0,05 sur 20 tests n'est pas une preuve : c'est 1 faux positif attendu. En revanche, **un calcul exact sur le code** (comme L1) n'a pas besoin de statistiques : il doit seulement être confirmé in game une fois.
