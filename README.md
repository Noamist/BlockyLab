# Blocky Lab

Suite d'userscripts Tampermonkey pour **analyser la RNG du bot Blocky**, mesurer ses biais, tester des hypothèses de seed et automatiser des actions de test — depuis ton propre compte, dans ton navigateur.

> ⚠️ **Cadre** : automatiser un compte Discord et exploiter les failles d'un bot de jeu va à l'encontre des CGU de Discord et des règles du serveur. Ces outils sont faits pour un **audit sur ton propre compte**, de préférence sur un serveur de test, avec restitution au staff. Aucun token n'est lu, stocké ni exfiltré : tout passe par l'interface Discord déjà ouverte. Les probes décrites dans [FINDINGS.md](docs/FINDINGS.md) doivent rester unitaires (un essai, pas d'abus de masse).

---

## 1. Ce que contient la suite

| Fichier | Rôle |
|---|---|
| [`userscripts/00-blocky-core.user.js`](userscripts/00-blocky-core.user.js) | Noyau : stockage IndexedDB, analyse des embeds, accès webpack Discord, envoi de commandes, panneau à onglets, statistiques (χ², z-test, runs, Markov, autocorrélation). |
| [`userscripts/01-blocky-collector.user.js`](userscripts/01-blocky-collector.user.js) | Collecte live + **backfill de l'historique**, export JSON/CSV, onglet **Recon** (snowflakes, custom_id, schémas d'embeds, commandes). |
| [`userscripts/02-blocky-rng-lab.user.js`](userscripts/02-blocky-rng-lab.user.js) | **RNG Lab** : vue d'ensemble, biais Lucky Block / Wheel, indépendance des résultats, corrélations horloge → issue, **force brute de seed** sur 9 familles (et balayage automatique), prédiction en direct. |
| [`userscripts/03-blocky-blackjack.user.js`](userscripts/03-blocky-blackjack.user.js) | Stratégie de base complète (S17), **comptage Hi-Lo** avec shoe persistante, déviations au true count, auto-play, stop-loss. Remplace `blackjack-advisor (7).user.js`. |
| [`userscripts/04-blocky-games.user.js`](userscripts/04-blocky-games.user.js) | **Lucky Block** (RTP empirique + IC 95 % + χ²), **Wheel** (uniformité, entropie, EV conditionnelle), **Mines** (survie exacte, EV, stop optimal), **Minage** (piles, types de blocs, XP, lapis). |
| [`userscripts/05-blocky-autopilot.user.js`](userscripts/05-blocky-autopilot.user.js) | Planificateur : minage, daily, vente, dummy, boss, paris et **sniper de drops par ID de salon** (Flux + historique même salon fermé, rendu différé des boutons, clic séparément simulable). |
| [`userscripts/06-blocky-audit.user.js`](userscripts/06-blocky-audit.user.js) | **Audit** : catalogue de 31 tests inspirés du wiki (RNG, Mines, trade, auction, loan, duel, PVE, boss, saison, équipes…), statuts, notes, capture de preuves et rapport Markdown/JSON. |
| [`userscripts/07-blocky-trade.user.js`](userscripts/07-blocky-trade.user.js) | **Trade Lab** : composeur structuré `member/give/give_amount/get/get_amount`, aperçu séparé des paramètres, mode libre, inspecteur d'offre, double acceptation, accept-then-cancel, auto-trade, offre à 0, acceptation rapide, rejeu, course synchronisée, lecture du solde et export de preuves. |
| [`userscripts/08-blocky-fuzzer.user.js`](userscripts/08-blocky-fuzzer.user.js) | **Fuzzer** : valeurs limites (0, négatif, 1e9, NaN, Infinity, 2⁵³), rafales d'idempotence, file contrôlée, exécution temporisée et classification des réponses (refus / accepté / erreur / rate limit). |
| [`userscripts/09-blocky-blockdl.user.js`](userscripts/09-blocky-blockdl.user.js) | **BlockDL** : solveur du bloc du jour, élimination par indices, top candidats, saisie manuelle d'indices et auto-play (modale, bouton ou commande de secours). |
| [`server/server.mjs`](server/server.mjs) | Serveur local zéro dépendance : ingestion, agrégats, CSV, dashboard. |
| [`server/dashboard.html`](server/dashboard.html) | Dashboard sombre (Canvas, sans lib) : RTP, χ², histogrammes, activité horaire. |
| [`tools/simulator.html`](tools/simulator.html) | Simulateur Monte Carlo hors ligne : EV blackjack (sabot réel) et EV Mines (survie exacte vs simulation). |
| [`syntax-check.html`](syntax-check.html) | Auto-test hors ligne des fonctions statistiques et des tables EV. |
| [`unit-check.html`](unit-check.html) | Harnais navigateur : charge le noyau et le script blackjack réels, teste la détection des boutons et les parseurs sur des messages synthétiques. |
| [`docs/FINDINGS.md`](docs/FINDINGS.md) | Surface d'attaque complète, protocole de test et ce qui constitue une vraie faille. |

L'ancien `reverse-rng (5).user.js` reste intact : il est remplacé par `00` + `01` + `02`, avec stockage illimité et analyse au lieu du simple T/P manuel.

---

## 2. Installation

1. Installe **Tampermonkey** (Chrome/Edge/Firefox).
2. Crée un nouveau script pour chaque fichier de `userscripts/`, dans l'ordre `00` → `09`. L'ordre d'installation n'a pas d'importance, mais le noyau doit être présent (les autres attendent jusqu'à 20 s).
3. Ouvre `https://discord.com/channels/<serveur>/<salon>`.
4. Un bouton **BL** apparaît en bas à gauche. `Alt+Maj+B` ouvre/ferme le panneau.

### Personnaliser l'interface

L'onglet **Interface** (ajouté par le noyau) permet de changer : thème (sombre, minuit, clair, contraste), couleur d'accent (six pastilles), largeur, hauteur, taille de police, arrondi, police, style des onglets (souligné / pastilles / cartes), onglets sur plusieurs lignes ou défilement, titre du panneau, texte du bouton flottant, opacité, densité compacte, flou du fond, ancrage dans les **quatre coins**, position des toasts, **onglets visibles et leur ordre** (flèches ↑ ↓), et sauvegarde/import complet. Le bouton **☰** de la barre de titre ouvre la liste de tous les onglets : même si la barre est très chargée ou repliée, aucun onglet n'est inaccessible. Le panneau se déplace par sa barre de titre et se recentre depuis l'onglet Interface.

Aucun `@require`, aucun build, aucune dépendance.

Ne charge pas l'ancien `blackjack-advisor (7).user.js` en même temps que `03` : il installait un sniffer de token et deux conseillers se contrediraient. Idem pour `reverse-rng (5).user.js`, remplacé par `00` + `01` + `02`.

### Salon et bot

Dans l'onglet **Collecte** :

- **ID du salon** : vide = salon actuellement ouvert. Pour forcer un salon, colle son ID.
- **IDs des bots** : vide = tous les bots. Sinon, mets l'ID de Blocky (clic droit → Copier l'identifiant).
- **Historique** : `fetchMessages` du client Discord, sans token. 500 messages par défaut, jusqu'à 20 000.

Dans l'onglet **Pilote → Drops** :

- **ID du salon de drops** : `1557793570243477524` par défaut, modifiable. L'observateur écoute les `MESSAGE_CREATE` de ce salon (Flux Discord) **et** le DOM, même quand le pilote n'est pas démarré.
- **Cliquer seulement s'il n'y a qu'un bouton** : utilise le custom_id / libellé du composant du bot, jamais la barre « Répondre ».
- **Aller au salon si le message n'est pas rendu** : si le drop arrive dans un salon fermé, le script tente d'ouvrir le salon avant de cliquer. Sans cette option, il attend le rendu et journalise l'échec.
- Le compteur *drops vus / clics* et l'heure du dernier clic sont affichés. « Scanner les messages affichés » rejoue la détection sur le salon ouvert.

---

## 3. Workflow d'audit

```
Collecte (live + historique)
        │
        ├─► onglet Recon : IDs, latence, custom_id, schémas
        │
        └─► IndexedDB ──► RNG Lab (stats, biais, seed)
                       └─► Jeux (RTP, EV Mines, wheel)
                       └─► serveur local (dashboard, CSV)
```

1. **Collecter** au moins quelques centaines d'issues : `/wheel`, `/luckyblock`, `/blackjack`, `/mines`, drops, `/blockdl`… Le collecteur reconnaît le jeu et le résultat automatiquement.
2. **Vérifier la classification** dans « Dernières observations » : le libellé affiche **gain / perte / retour** et un badge `auto`. Le bouton **Reclasser tout** repasse la base entière avec le classifieur courant (utile après une mise à jour ou un ancien scan). Si un format n'est pas reconnu, l'onglet Recon montre les champs réellement présents : adapte les regex du noyau (`GAME_RULES`, `luckyCategory`, `wheelNumber`).
3. **Mesurer** : RNG Lab → Vue d'ensemble / Biais. Un p < 0,05 isolé n'est pas une preuve ; il faut répliquer.
4. **Tester la seed** : RNG Lab → Seed. Choisis la wheel (37 valeurs), une famille de PRNG, une fenêtre de ±5 s autour de la première observation.
5. **Confirmer** : si un candidat sort, arme le prédicteur et attends 3-4 nouvelles sorties. Un seul hit peut être un faux positif.
6. **Automatiser prudemment** : Pilote en mode simulation d'abord, puis réel avec des limites basses.
7. **Auditer** : onglet Audit, filtre « À tester », ouvre un test, copie la commande ou utilise l'envoi en lecture seule. Note le statut et capture la réponse du bot. Exporte le rapport à la fin.
8. **Tester les courses** : Trade Lab → **Auto-tests de failles** pour le double accept, accept-then-cancel, offre à 0, auto-trade, acceptation la plus rapide, rejeu d'un vieux bouton et course synchronisée. Le composeur structuré ignore les descriptions d'autocomplete entre parenthèses et envoie chaque valeur une seule fois. Le mode simulation est actif par défaut. Le Fuzzer ajoute les montants limites et les **rafales d'idempotence** (plusieurs envois très rapprochés). Un seul essai par hypothèse, sur un compte de test.
9. **BlockDL** : onglet BlockDL. Colle un indice ou laisse le bot parler : le solveur élimine les blocs, affiche les 8 meilleurs candidats et peut jouer la recommandation (modale, bouton ou commande de secours). Il s'arrête dès que « correct / trouvé » apparaît.

### Serveur local

```bash
cd server
node server.mjs
# http://127.0.0.1:3210
```

- `POST /api/ingest` : lot d'observations (appelé par le noyau).
- `GET /api/stats` : agrégats + tests.
- `GET /api/export.csv` : export.
- Données : `server/data/observations.ndjson` (une ligne par observation).

Le serveur n'écoute que sur `127.0.0.1` par défaut (`HOST`/`PORT` pour changer).

---

## 4. Ce qui est réellement testable (résumé)

| Hypothèse | Où | Verdict attendu |
|---|---|---|
| RNG biaisée (Lucky Block / Wheel) | RNG Lab → Biais | Le plus probable si le bot utilise `Math.random` avec des arrondis ou un modulo biaisé. |
| Résultats dépendants du précédent | RNG Lab → Vue d'ensemble | Markov / runs test. |
| Seed = horloge | RNG Lab → Seed | Possible avec les LCG maison ; **impossible** avec `Math.random` de V8 (xorshift128+, seedé par l'OS). |
| Mines +EV | Jeux → Mines | La table du wiki donne **+8 %** à 3 blocs avec 1 TNT. À vérifier en jeu : c'est la piste la plus concrète. |
| Shoe de blackjack persistante | Blackjack | Si le sabot n'est pas mélangé à chaque main, le comptage Hi-Lo donne un edge réel. |
| Drop snipé | Pilote → Drops | Le premier clic gagne : un script bat un humain de 100–300 ms. |
| Latence exploitable | Recon | La distribution des délais permet de réduire la fenêtre de seed. |
| Boutons rejouables | Recon → custom_id | Un `custom_id` contenant un ID de session/partie est un candidat ; un ID statique ne l'est pas. |
| Double acceptation d'un trade | Trade Lab | Accepter deux fois / accepter puis annuler. Un double crédit est critique. |
| Course sur `/loan`, `/auction` | Trade Lab + Fuzz | Deux clients, même instant. Vérifier les soldes et les doublons. |
| Montants limites | Fuzzer | 0, négatif, 1e9, NaN, Infinity, 2⁵³. Un refus propre est le comportement attendu. |
| Cooldowns contournés | Audit → Course de cooldown | Deux commandes simultanées, deux salons, boutons. |

Détails, protocole et limites : [docs/FINDINGS.md](docs/FINDINGS.md).

---

## 5. Différences avec les scripts d'origine

- **Plus de lecture de token.** `blackjack-advisor (7)` installait un sniffer `Authorization` et pouvait envoyer via l'API REST. Supprimé : c'est le vecteur le plus dangereux pour ton compte et il n'apporte rien pour l'analyse.
- **Stockage IndexedDB** au lieu de `GM_setValue` : des dizaines de milliers d'observations sans saturer le stockage Tampermonkey.
- **Collecte par message normalisé**, pas seulement T/P manuel : jeu, catégorie, numéro, couleur, cartes, multiplicateurs, montants.
- **Backfill d'historique** : `MessageStore` + `fetchMessages`, sans requête forgée.
- **Statistiques réelles** : intervalles de confiance, χ², runs, Markov, autocorrélation, entropy, corrections de Bonferroni.
- **9 PRNG** réimplémentés pour la recherche de seed, avec progression et budget temps.
- **Stratégie blackjack complète** (souple/dure, double, S17) au lieu d'une table partielle, plus le comptage et les déviations.
- **Sécurité par défaut** : pilote en simulation, limites d'actions et d'erreurs, arrêt automatique.

---

## 6. Vérifications effectuées

Les briques mathématiques ont été exécutées hors de Discord (Chromium) :

- **χ² / erf / z-test** : p(3,841 ; df 1) = 0,050000, p(z=1,96) = 0,049996, p(z=2) = 0,045500.
- **PRNG** : pour mulberry32, xorshift32, splitmix32, LCG, java.util.Random et MT19937, une séquence générée avec la seed 1 234 567 est retrouvée par la force brute sur ±1 000 seeds (6/6 familles).
- **Blackjack** : 100 000 mains simulées, stratégie de base 6 jeux S17 → EV **−0,382 %** par main (43,53 % gains / 47,92 % pertes / 8,55 % push), cohérent avec l'avantage maison attendu.
- **Mines** : 200 000 parties, 1 TNT, 3 blocs, ×1,27 → survie observée 85,09 % (exact 85 %), EV simulée **+8,06 %** (exact **+7,95 %**).
- **Détection blackjack** : logique testée sur 6 cas synthétiques (anglais, français, emojis + `custom_id`, emojis sans `custom_id`, libellés inconnus, bouton Double désactivé) ; les quatre premiers signaux et le repli par position donnent les bonnes actions.

Ces tests valident les formules, les générateurs et l'algorithme de détection, pas l'intégration Discord : les userscripts n'ont pas été exécutés contre un vrai salon dans cet environnement. Les sélecteurs webpack (`MessageStore`, `fetchMessages`, `sendMessage`) et les formats exacts des embeds restent à valider via l'onglet **Recon**.

Pour exécuter `unit-check.html`, sers le dossier (un simple serveur statique suffit, les scripts sont chargés en relatif) :

```bash
cd blocky-lab
python3 -m http.server 8000
# http://127.0.0.1:8000/unit-check.html
```

## 7. Limites honnêtes

- **On ne casse pas `Math.random` de V8.** Un xorshift128+ seedé par l'OS ne se retrouve pas à partir de sorties modulo 37. L'onglet Seed élimine les générateurs faibles ; un résultat négatif est une information, pas un échec.
- **Le format des embeds n'est pas documenté.** Les parseurs sont tolérants (libellés FR/EN, emojis, plusieurs ordres de champs) mais peuvent rater un format. L'onglet Recon sert exactement à ça.
- **Les probabilités du wiki peuvent être fausses ou obsolètes.** C'est justement ce que mesure le RTP empirique.
- **Le bot peut valider côté serveur.** Un bouton cliqué deux fois, un montant négatif ou une interaction rejouée doivent être rejetés par le serveur ; sinon c'est une vraie faille à signaler.
- **Pas de test bout-en-bout Discord fourni** : le projet est testé manuellement dans un salon. `lab.selfTest()` (icône 🩺 du panneau) et `syntax-check.html` vérifient les fonctions statistiques ; `tools/simulator.html` vérifie les EV. `unit-check.html` charge le noyau et le script blackjack réels dans un navigateur et teste la détection des boutons sur des messages synthétiques ; il ne peut pas vérifier les sélecteurs webpack de Discord.

---

## 8. Arborescence

```
blocky-lab/
├── README.md
├── docs/FINDINGS.md
├── server/
│   ├── server.mjs
│   └── dashboard.html
├── tools/
│   ├── simulator.html
│   └── unit-check.html
├── unit-check.html
├── syntax-check.html
└── userscripts/
    ├── 00-blocky-core.user.js
    ├── 01-blocky-collector.user.js
    ├── 02-blocky-rng-lab.user.js
    ├── 03-blocky-blackjack.user.js
    ├── 04-blocky-games.user.js
    ├── 05-blocky-autopilot.user.js
    ├── 06-blocky-audit.user.js
    ├── 07-blocky-trade.user.js
    ├── 08-blocky-fuzzer.user.js
    └── 09-blocky-blockdl.user.js
```

---

## 9. Autoplay blackjack : ce qui a changé (v5.2)

L'ancienne version cherchait les boutons uniquement par texte et injectait un panneau **dans l'embed**. Deux causes de blocage :

- les boutons du bot peuvent n'avoir que des emojis ou des libellés inconnus ;
- insérer un nœud DOM dans le message contrôle par React peut faire remplacer les boutons au moment du clic.

La v5 combine maintenant cinq signaux : texte visible, `aria-label`/`title`, `alt` des emojis, `data-list-item-id` et `custom_id` du composant. Elle interroge aussi `#message-accessories…`, car Discord peut rendre la ligne de boutons hors du `<li>` du message. Les libellés du type `👊 Hit`, `✋ Stand`, `💰 Double` et les formats `Dealer — 8♥ 🂠 · 8 + ?` / `You — 2♠ 4♣ · 6` sont couverts, y compris les cartes emoji Unicode. Si les boutons restent non identifiés, le **repli par position** prend le relais.

Le clic est désormais progressif : clic natif `element.click()` (handler React), puis événements pointeur, puis handler React direct, avec vérification du DOM entre chaque étape pour ne **jamais tirer deux cartes**. L'onglet affiche les boutons détectés, l'action disponible, les clics OK/échecs et un journal des stratégies ; « Forcer l'action conseillée » permet de tester un bouton sans attendre le cycle auto.

La v5.2 élargit la confirmation des résultats (gain, perte, push en anglais et en français), bloque l'envoi de la main suivante tant que le résultat n'est pas reconnu et suit la mise doublée dans le calcul du net. Le comptage Hi-Lo et les déviations restent des aides statistiques : aucune stratégie ne garantit un bénéfice à chaque session.
