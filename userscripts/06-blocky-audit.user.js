// ==UserScript==
// @name         Blocky Lab · 06 · Audit
// @namespace    blocky-lab
// @version      1.2.0
// @description  Catalogue d'audit ancré sur le code source du bot (Blocky-main) : failles vérifiées, verdicts réels, étapes, preuves et rapport exportable.
// @match        https://discord.com/*
// @match        https://canary.discord.com/*
// @match        https://ptb.discord.com/*
// @run-at       document-idle
// @noframes
// @grant        unsafeWindow
// ==/UserScript==

(function () {
    "use strict";

    const W = typeof unsafeWindow !== "undefined" && unsafeWindow ? unsafeWindow : window;

    async function boot() {
        for (let i = 0; i < 200 && !W.BlockyLab; i++) await new Promise(r => setTimeout(r, 100));
        const lab = W.BlockyLab;
        if (!lab) { console.warn("[BlockyLab] audit : noyau absent"); return; }
        if (W.__blockyAuditLoaded) return;
        W.__blockyAuditLoaded = true;

        const { h, toast } = lab;
        const KEY = "audit.v1";
        const saved = lab.store.get(KEY, {}) || {};
        const state = {
            results: saved.results || {},
            filter: "todo",
            category: "all",
            search: "",
            allowRun: false,
            last: null,
            recent: [],
            sentAt: 0,
            openId: null
        };
        const cfg = Object.assign({ amount: 10, target: "", name: "test", color: "#ff5555" }, saved.cfg || {});
        const save = () => lab.store.set(KEY, { results: state.results, cfg });

        const SEV = {
            crit: { label: "Critique", cls: "bl-badge-bad" },
            high: { label: "Élevé", cls: "bl-badge-bad" },
            med: { label: "Moyen", cls: "bl-badge-warn" },
            low: { label: "Faible", cls: "" }
        };
        const STATUS = {
            todo: "À tester",
            pass: "Passé",
            fail: "Échoué",
            blocked: "Bloqué",
            na: "N/A"
        };

        /* ------------------------------------------------------------------ */
        /* Catalogue                                                           */
        /* ------------------------------------------------------------------ */

        const TESTS = [
            {
                id: "lucky-rounding", cat: "Minijeux", sev: "crit", title: "Lucky Block : arrondi des gains sur mises impaires (faille L1)",
                hypo: "Vérifié dans le code (game/luckyblock.py) : won = floor(mise × payout + 0,5). Les payouts à 0,5 (×0,5 / ×1,5 / ×2,5) arrondissent vers le HAUT sur une mise impaire — mise 1 → RTP 118 %, mise 3 → 102,7 % ; mises paires → 95 % exact.",
                expect: "Confirmation in game : sur 200–400 mises de 1 émeraude, le net mesuré doit être nettement positif (z > 1,96).",
                cmd: "/luckyblock amount:1", safe: false,
                steps: [
                    "Noter le solde ; jouer 200–400 /luckyblock amount:1 (cooldown 5 s ; le cap quotidien de 1 500 nets ne bloque pas les pertes).",
                    "Onglet Jeux > Lucky Block : lire le RTP mesuré (attendu ~118 %) et le net total.",
                    "Un z > 1,96 confirme ; capture + calcul = rapport à envoyer au staff (correctif : round() au lieu de floor(x+0,5)).",
                    "Ne pas pousser au-delà : c'est un bug d'arrondi à signaler, pas une mine d'or (plafonné par le cap)."
                ]
            },
            {
                id: "mines-rtp", cat: "Minijeux", sev: "med", title: "Mines : vérifier la formule réelle (EV attendue 95 %)",
                hypo: "Piste +EV ÉCARTÉE par le code : mult(d, tnt) = Π (20−i)/(20−tnt−i) × 0,95 (plafond ×25). Le tableau du wiki (×1,27 à 3 blocs) était faux. Reste à vérifier la calibration affichée in game.",
                expect: "1 TNT : ×1,00 après 1 bloc, ×1,06 après 2, ×1,12 après 3. EV = 95 % exact après chaque bloc.",
                cmd: "/mines amount:{amount} tnt:1", safe: false,
                steps: [
                    "Jouer 1 TNT, noter le multiplicateur affiché après 1, 2 et 3 blocs creusés.",
                    "Comparer à ×1,00 / ×1,06 / ×1,12 (l'onglet Jeux > Mines calcule la valeur exacte).",
                    "Un écart > 0,01 est un vrai bug de calibration à signaler.",
                    "Vérifier aussi l'auto cash-out à ×25 et le remboursement si aucun bloc creusé."
                ]
            },
            {
                id: "mines-tnt", cat: "Minijeux", sev: "high", title: "Mines : nombre de TNT et grille",
                hypo: "Le bot peut tirer la position des TNT après le choix des cases, ou utiliser un nombre de TNT différent de celui affiché.",
                expect: "Avec 3 TNT, la survie après 3 cases doit être 17/20 × 16/19 × 15/18 = 85 %. Avec 6 TNT, 14/20 × 13/19 × 12/18 = 31,9 %.",
                cmd: "/mines amount:{amount} tnt:3", safe: false,
                steps: [
                    "Comparer les fréquences de bust sur 200 parties à la survie théorique.",
                    "Vérifier si changer de case après un cash-out partiel est possible.",
                    "Tester une mise à 0 ou négative (voir Fuzz) pour observer la validation."
                ]
            },
            {
                id: "bj-payout", cat: "Minijeux", sev: "high", title: "Blackjack : paiement 3:2, push et double",
                hypo: "Le bot peut payer un blackjack 1:1, mal rembourser un push, ou autoriser un double après trois cartes.",
                expect: "Blackjack naturel payé 3:2 ; push = mise rendue ; double uniquement sur deux cartes ; croupier S17.",
                cmd: "/blackjack amount:{amount}", safe: false,
                steps: [
                    "Jouer jusqu'à obtenir un blackjack naturel, comparer le crédit au solde.",
                    "Provoquer un push et vérifier que la mise est exactement rendue.",
                    "Tenter Double après une troisième carte : le bouton doit être désactivé.",
                    "Vérifier que le croupier reste sur 17 (S17) sur 100 mains."
                ]
            },
            {
                id: "bj-shoe", cat: "Minijeux", sev: "low", title: "Blackjack : sabot neuf à chaque main (comptage sans objet)",
                hypo: "ÉCARTÉ par le code : blackjack.start crée un sabot de 52 cartes mélangé pour CHAQUE main (new_deck). Le comptage Hi-Lo est inutile ; seule la stratégie de base compte (EV ≈ −0,4 %).",
                expect: "Chaque main part d'un sabot neuf : aucune corrélation entre deux mains ; une même carte sort au plus 4 fois par main.",
                cmd: "", safe: true,
                steps: [
                    "Rejouer 20 mains : le comptage du script repart à zéro à chaque main (comportement normal).",
                    "Vérifier l'affichage des cartes (`` `A♠` ``, `` `🂠` ``) pour le parseur du noyau.",
                    "Un blackjack naturel paie 3:2 (sur mise 1 : ×2, arrondi de floor(x+0,5))."
                ]
            },
            {
                id: "wheel-rtp", cat: "Minijeux", sev: "high", title: "Wheel : RTP et biais de couleur",
                hypo: "La roulette peut avoir un RTP > 100 % sur une couleur, ou un biais détectable sur les 37 numéros.",
                expect: "RTP 36/37 = 97,3 % (une seule case verte par défaut). Sur 370 tours, χ² à 36 ddl doit rester non significatif après Bonferroni. Les emojis de l'animation ne sont PAS des sorties du jeu.",
                cmd: "/wheel number:0 amount:{amount}", safe: false,
                steps: [
                    "Collecter 300+ tours dans l'onglet RNG Lab.",
                    "Vérifier le χ² global et par couleur.",
                    "Comparer le RTP par couleur ; une couleur > 100 % est exploitable.",
                    "Tester la mise 0 / négative via Fuzz."
                ]
            },
            {
                id: "lucky-rtp", cat: "Minijeux", sev: "high", title: "Lucky Block : RTP et catégories",
                hypo: "Les probabilités de catégories peuvent différer du wiki, ou une catégorie rare peut être sur-pondérée.",
                expect: "RTP 95 % sur mises paires ; creeper 31,5 % ×0, cobblestone 22 % ×0,5, fer 18 % ×1, or 15 % ×1,5, diamants 9 % ×2,5, émeraudes 4 % ×4, netherite 0,5 % ×10 (poids 315/220/180/150/90/40/5, game/settings.py).",
                cmd: "/luckyblock amount:{amount}", safe: false,
                steps: [
                    "Collecter 200+ blocs dans l'onglet Jeux > Lucky Block.",
                    "Comparer les fréquences aux probabilités du wiki (χ²).",
                    "Vérifier le multiplicateur appliqué à chaque catégorie.",
                    "Un RTP > 100 % sur 300+ parties est un signal fort."
                ]
            },
            {
                id: "drop-first", cat: "Événements", sev: "crit", title: "Drop : premier clic et course",
                hypo: "Le premier clic gagne, mais le bot peut créditer plusieurs clics ou récompenser un clic après la fin.",
                expect: "Un seul gagnant par drop ; un second clic renvoie « déjà réclamé ».",
                cmd: "", safe: true,
                steps: [
                    "Activer le sniper de drops (05) sur un serveur de test.",
                    "Mesurer le délai entre l'apparition et le clic ; viser < 300 ms.",
                    "Cliquer deux fois très vite avec deux comptes et vérifier qu'un seul est crédité.",
                    "Vérifier si le bouton reste actif après la récompense."
                ]
            },
            {
                id: "daily-race", cat: "Commandes", sev: "high", title: "Daily : double réclamation et fuseau",
                hypo: "Deux commandes daily envoyées en parallèle peuvent créditer deux fois si la vérification n'est pas atomique.",
                expect: "Une seule récompense par jour ; la limite se réinitialise à minuit (fuseau du bot).",
                cmd: "/daily", safe: false,
                steps: [
                    "Noter le solde et le streak avant.",
                    "Envoyer /daily deux fois à moins de 500 ms (deux onglets ou spam contrôlé).",
                    "Comparer le crédit ; un double crédit est une faille critique.",
                    "Vérifier l'heure de reset réelle sur 2 jours."
                ]
            },
            {
                id: "sell-round", cat: "Économie", sev: "med", title: "Sell : arrondi et bonus marchand",
                hypo: "Les arrondis de vente peuvent être favorables (0,5 → 1) ou le bonus Trader/Villager peut s'appliquer deux fois.",
                expect: "Prix fixe du marché ; arrondi documenté ; bonus +5 % Trader/Villager une seule fois.",
                cmd: "/sell item:{name} amount:1", safe: false,
                steps: [
                    "Vendre 1 unité d'un item à prix impair et comparer au prix affiché.",
                    "Tester 2, 3, 10 unités : le total doit être linéaire.",
                    "Avec Trader, vérifier le bonus ; le revendre ne doit pas re-appliquer le bonus.",
                    "Vendre du gear usé : le prix doit dépendre de la durabilité."
                ]
            },
            {
                id: "repair-cost", cat: "Économie", sev: "med", title: "Repair / Anvil : coût et usure",
                hypo: "Le coût de réparation peut être inférieur à la valeur restaurée, ou l'enclume peut ne pas consommer d'usure.",
                expect: "Coût croissant avec la durabilité manquante ; enclume -12 % de durabilité par utilisation ; réparation plafonnée.",
                cmd: "/repair item:{name}", safe: false,
                steps: [
                    "Réparer un item très usé et noter le coût + la durabilité restaurée.",
                    "Répéter : le coût doit augmenter (pénalité de travail).",
                    "Utiliser une enclume et vérifier la durabilité de l'enclume.",
                    "Comparer coût de réparation vs revente : une boucle rentable est une faille."
                ]
            },
            {
                id: "enchant-cost", cat: "Économie", sev: "high", title: "Enchant : coût en lapis et combinaisons",
                hypo: "Les niveaux III ou les combinaisons I+I peuvent ignorer le coût en lapis, ou appliquer deux fois un enchantement.",
                expect: "Coût en lapis croissant ; I+I = II ; application III valide ; Mending rare ; un seul enchantement par item et par action.",
                cmd: "/enchant item:{name} enchant:sharpness", safe: false,
                steps: [
                    "Noter le lapis avant/après chaque enchantement.",
                    "Combiner deux livres I et vérifier le niveau II.",
                    "Tenter d'appliquer un livre III sur un item déjà enchanté.",
                    "Vérifier qu'un enchantement n'est pas dupliqué dans le message."
                ]
            },
            {
                id: "trade-double", cat: "Trade", sev: "crit", title: "Trade : double acceptation",
                hypo: "Accepter deux fois la même offre peut dupliquer les items ou débiter deux fois.",
                expect: "Une seule transaction par offre ; le second accept renvoie une erreur.",
                cmd: "/trade member:{target} give:emeralds give_amount:{amount} get:emeralds get_amount:1", safe: false,
                steps: [
                    "Avec deux comptes de test, créer une offre à 1 émeraude contre 1 item.",
                    "Cliquer Accepter deux fois à ~100 ms d'intervalle (script 07).",
                    "Vérifier les soldes et inventaires des deux côtés.",
                    "Répéter avec un item enchanté et un item de grande valeur."
                ]
            },
            {
                id: "trade-modify", cat: "Trade", sev: "crit", title: "Trade : modification après acceptation",
                hypo: "Modifier l'offre après que la victime a accepté peut valider la nouvelle version sans son consentement.",
                expect: "Toute modification annule l'acceptation précédente et exige une nouvelle confirmation.",
                cmd: "/trade member:{target} give:emeralds give_amount:{amount} get:emeralds get_amount:1", safe: false,
                steps: [
                    "Compte A propose 1 émeraude, compte B accepte.",
                    "Avant la validation finale, A remplace par 1 item sans valeur.",
                    "Vérifier si B est débité de son item.",
                    "Tester aussi l'ajout d'un second item après acceptation."
                ]
            },
            {
                id: "trade-insufficient", cat: "Trade", sev: "high", title: "Trade : solde insuffisant et valeurs négatives",
                hypo: "Une offre peut être acceptée avec un solde insuffisant ou un montant négatif, créant de la monnaie.",
                expect: "Validation du solde au moment de l'acceptation ; montants strictement positifs.",
                cmd: "/trade member:{target} give:emeralds give_amount:{amount} get:emeralds get_amount:1", safe: false,
                steps: [
                    "Proposer plus d'émeraudes que le solde disponible.",
                    "Tenter un montant 0 puis -1 (si le formulaire l'accepte).",
                    "Accepter avec l'autre compte et vérifier le solde.",
                    "Tester deux offres simultanées qui dépassent le solde total."
                ]
            },
            {
                id: "trade-self", cat: "Trade", sev: "high", title: "Trade : auto-échange et comptes liés",
                hypo: "S'échanger à soi-même peut dupliquer des items ou contourner les limites.",
                expect: "Auto-échange refusé ; un compte ne peut pas accepter sa propre offre.",
                cmd: "/trade member:{self} give:emeralds give_amount:1 get:emeralds get_amount:1", safe: false,
                steps: [
                    "Tenter /trade sur son propre compte.",
                    "Si une offre apparaît, l'accepter et comparer l'inventaire.",
                    "Tester avec deux comptes partageant la même IP si le bot limite.",
                    "Vérifier les logs de l'offre dans l'historique."
                ]
            },
            {
                id: "auction-tax", cat: "Économie", sev: "high", title: "Auction : taxe 5 %, annulation et enchère",
                hypo: "La taxe peut être contournée par annulation, ou l'enchérisseur peut retirer son enchère après la vente.",
                expect: "Taxe 5 % à la vente ; 10 annonces max ; 7 jours ; annulation possible avant enchère ; pas d'auto-achat.",
                cmd: "/auction list", safe: true,
                steps: [
                    "Mettre un item à 100, acheter avec un second compte, vérifier le net (95).",
                    "Annuler une annonce sans enchère : aucun frais indu.",
                    "Enchérir puis annuler : l'enchère doit être bloquée ou remboursée.",
                    "Tenter d'acheter sa propre annonce."
                ]
            },
            {
                id: "auction-price", cat: "Économie", sev: "high", title: "Auction : prix 0, négatif et dépassement",
                hypo: "Un prix 0 ou négatif peut créer une vente gratuite ou un crédit inversé.",
                expect: "Prix minimum > 0 ; plafond raisonnable ; validation côté serveur.",
                cmd: "/auction start price:{amount}", safe: false,
                steps: [
                    "Tenter prix 0, -1, 1e9, NaN.",
                    "Vérifier la réponse du bot et l'état de l'annonce.",
                    "Si l'annonce est créée à 0, l'acheter immédiatement.",
                    "Exporter les réponses via l'onglet Fuzz."
                ]
            },
            {
                id: "loan-limits", cat: "Économie", sev: "crit", title: "Loan : limite, intérêt et défaut",
                hypo: "Un emprunteur peut avoir plusieurs prêts impayés, ou le prêteur dépasser 5 prêts.",
                expect: "50–5000 ; intérêt 0–20 % ; 1–7 jours ; un seul impayé par emprunteur ; 5 prêts max par prêteur ; offre valable 15 min ; +10 % de pénalité ; 50 % de saisie ; paiements bloqués si impayé.",
                cmd: "/loan list", safe: true,
                steps: [
                    "Créer un prêt, ne pas rembourser, vérifier le statut impayé.",
                    "Tenter un second prêt impayé avec le même compte.",
                    "Créer 5 prêts comme prêteur, tenter le 6e.",
                    "Vérifier la saisie de 50 % sur les gains et le blocage de /pay."
                ]
            },
            {
                id: "loan-race", cat: "Économie", sev: "crit", title: "Loan : deux acceptations simultanées",
                hypo: "Deux prêteurs peuvent accepter la même demande en parallèle, créant deux prêts.",
                expect: "Une demande = un seul prêt ; la seconde acceptation échoue.",
                cmd: "/loan list", safe: true,
                steps: [
                    "Créer une demande de 5000.",
                    "Faire accepter par deux comptes au même instant (course coordonnée).",
                    "Vérifier le total emprunté et les deux soldes prêteurs.",
                    "Tester aussi l'annulation pendant l'acceptation."
                ]
            },
            {
                id: "duel-cooldown", cat: "PvP", sev: "high", title: "Duel : cooldown, mise et bouclier",
                hypo: "Le cooldown d'une minute peut être contourné par deux duels simultanés, ou le bouclier ne bloque pas la mise.",
                expect: "Mise min 10 ; cooldown 1 min ; défi valable 1 min ; bouclier bloque ; 3 potions max ; crit 15 %.",
                cmd: "/duel user:{target} amount:{amount}", safe: false,
                steps: [
                    "Défier un compte, vérifier le cooldown après acceptation.",
                    "Envoyer deux défis en parallèle.",
                    "Activer un bouclier et vérifier que le duel est refusé.",
                    "Compter les crits sur 200 attaques (attendu ~15 %)."
                ]
            },
            {
                id: "pve-ready", cat: "PvP", sev: "med", title: "PVE : ready, vagues et récompenses",
                hypo: "Un joueur peut rester « ready » après la fin, ou recevoir deux fois la récompense de vague.",
                expect: "5 joueurs max ; 15 min de cooldown ; timeout de ready ; récompense par vague une seule fois.",
                cmd: "/pve", safe: false,
                steps: [
                    "Lancer un PVE et vérifier le cooldown après la fin.",
                    "Tester le ready d'un joueur qui a déjà quitté.",
                    "Comparer les récompenses de deux vagues.",
                    "Tester 6 joueurs dans la même instance."
                ]
            },
            {
                id: "boss-window", cat: "PvP", sev: "med", title: "Boss de porte : entry, cooldown 12 h, groupes (ancien serveur-boss retiré)",
                hypo: "Les anciens boss partagés (/attack) ont été remplacés par des boss de porte en groupe : Wither (entrée 1 500, butin 3 000), Dragon (3 000 / 6 000), Warden (6 000 / 12 000). Une double entrée ou un cooldown contournable serait une faille.",
                expect: "1 combat / 12 h / joueur ; groupe ≤ 4 ; entrée remboursée si le groupe ne démarre pas (5 min) ou si le leader part ; chaque survivant ouvre la dimension suivante.",
                cmd: "/boss info", safe: true,
                steps: [
                    "Relire /boss info : entrée, butin, cooldown, dimensions ouvertes.",
                    "Rejoindre un groupe puis le quitter avant le start : l'entrée doit être remboursée.",
                    "Tenter un second combat dans les 12 h : refus attendu.",
                    "Vérifier qu'un double clic sur le bouton d'entrée ne paie pas deux fois."
                ]
            },
            {
                id: "villager-offers", cat: "Économie", sev: "high", title: "Villager : offres 18–21 et exclusivité",
                hypo: "Un villageois peut proposer plus de 21 offres, ou les mêmes offres à plusieurs joueurs.",
                expect: "18–21 offres ; une offre acceptée disparaît ; échange exclusif.",
                cmd: "/villager", safe: true,
                steps: [
                    "Compter les offres sur 10 villageois.",
                    "Accepter une offre et vérifier qu'elle disparaît.",
                    "Faire accepter la même offre par deux comptes.",
                    "Vérifier le prix et la quantité échangés."
                ]
            },
            {
                id: "season-score", cat: "Saison", sev: "med", title: "Season : score, prêts exclus et reset",
                hypo: "Les prêts sont exclus du score, mais un remboursement peut le gonfler.",
                expect: "Lundi–dimanche ; prêts exclus ; top récompensé ; reset hebdomadaire.",
                cmd: "/season", safe: true,
                steps: [
                    "Comparer le score avant/après un prêt et un remboursement.",
                    "Vérifier le classement et l'heure du reset.",
                    "Tester un gain de saison via duel et via vente.",
                    "Vérifier qu'un prêt ne compte pas dans le score."
                ]
            },
            {
                id: "challenges", cat: "Commandes", sev: "high", title: "Challenges : 3/jour, 3/semaine",
                hypo: "Une même challenge peut être réclamée deux fois, ou la limite journalière peut être dépassée.",
                expect: "3 défis journaliers + 3 hebdomadaires ; pas de doublon ; récompense unique.",
                cmd: "/challenges", safe: true,
                steps: [
                    "Noter les défis proposés.",
                    "Réclamer un défi, recharger, vérifier qu'il a disparu.",
                    "Tenter de réclamer le même défi deux fois.",
                    "Vérifier la limite à 3 sur 24 h."
                ]
            },
            {
                id: "team-create", cat: "Social", sev: "med", title: "Team : création 500, 5 membres, 48 h",
                hypo: "Une invitation peut être acceptée après 48 h, ou une team peut dépasser 5 membres.",
                expect: "Création 500 émeraudes ; 5 membres max ; invitation 48 h ; score de team ; catégorie à 300.",
                cmd: "/team info", safe: true,
                steps: [
                    "Créer une team et vérifier le débit de 500.",
                    "Inviter 5 comptes, tenter le 6e.",
                    "Laisser une invitation expirer 48 h et l'accepter.",
                    "Vérifier le score et la catégorie."
                ]
            },
            {
                id: "customize", cat: "Social", sev: "low", title: "Customize : 150 couleurs, 750 hex, bio 150",
                hypo: "Une couleur hex invalide ou une bio trop longue peut être acceptée, ou le coût en émeraudes contourné.",
                expect: "150 couleurs prédéfinies ; 750 pour un hex ; bio 150 caractères ; coût débité une fois.",
                cmd: "/customize color:{color}", safe: false,
                steps: [
                    "Tester une couleur prédéfinie et vérifier le coût.",
                    "Tester #GGGGGG, #fff, rgb(0,0,0), une chaîne vide.",
                    "Tester une bio de 151 caractères.",
                    "Vérifier le solde après changement."
                ]
            },
            {
                id: "rob-rules", cat: "PvP", sev: "high", title: "Rob : fenêtre, cooldown et cibles",
                hypo: "Un joueur peut être volé hors fenêtre, ou un compte protégé (niveau < 5, nuit, bouclier) peut être ciblé.",
                expect: "200–500 ou 50–100 ; fenêtre 1 h ; cooldown 6 h ; protection 12 h ; niveau 5 ; nuit 22–06 ; cibles non protégées uniquement.",
                cmd: "/rob user:{target} amount:{amount}", safe: false,
                steps: [
                    "Tenter un vol hors fenêtre de 1 h.",
                    "Cibler un compte de niveau < 5 ou protégé.",
                    "Tester la nuit (22–06) et vérifier le refus.",
                    "Comparer le montant volé à la fourchette annoncée."
                ]
            },
            {
                id: "link-staff", cat: "Social", sev: "high", title: "Link : approbation staff et doublons",
                hypo: "Un lien Minecraft peut être approuvé deux fois, ou un compte Discord peut lier plusieurs comptes.",
                expect: "Approbation staff ; un lien unique ; pas de double récompense.",
                cmd: "/link", safe: false,
                steps: [
                    "Demander un lien, vérifier l'ID Minecraft.",
                    "Tenter de lier un second compte au même Discord.",
                    "Vérifier le statut avant/après approbation.",
                    "Ne jamais tester sur un compte principal."
                ]
            },
            {
                id: "cooldown-race", cat: "Commandes", sev: "high", title: "Course de cooldown générique",
                hypo: "La plupart des cooldowns sont vérifiés en lecture puis écrite : deux commandes simultanées peuvent passer.",
                expect: "Une seule commande par cooldown, même en parallèle.",
                cmd: "/daily", safe: false,
                steps: [
                    "Choisir une commande à cooldown (daily, wheel, mining).",
                    "Envoyer deux commandes à < 200 ms via deux onglets ou un script.",
                    "Comparer les récompenses et le solde.",
                    "Répéter sur 3 commandes différentes."
                ]
            },
            {
                id: "drop-race", cat: "Événements", sev: "high", title: "Drop : deux clics simultanés",
                hypo: "Le bouton reste actif quelques millisecondes après le premier clic, permettant deux récompenses.",
                expect: "Un seul crédit ; le bouton se désactive immédiatement.",
                cmd: "", safe: true,
                steps: [
                    "Attendre un drop.",
                    "Cliquer deux fois avec 50 ms d'écart (script 05).",
                    "Vérifier le crédit et le message.",
                    "Tester avec deux comptes dans le même salon."
                ]
            }
        ];

        /* ------------------------------------------------------------------ */
        /* Capture des réponses                                                */
        /* ------------------------------------------------------------------ */

        function remember(text, id) {
            const item = { id: id || "", text: String(text || "").slice(0, 5000), at: Date.now() };
            if (!item.text.trim()) return;
            state.last = item;
            state.recent.unshift(item);
            state.recent = state.recent.slice(0, 25);
        }

        const sameChannel = id => {
            const current = lab.channelId?.();
            return !current || !id || String(id) === String(current);
        };
        lab.on("obs", o => { if (sameChannel(o.channelId)) remember(o.text, o.id); });
        lab.watch((msg) => {
            const isBot = msg?.author?.bot === true || msg?.webhook_id;
            if (!isBot) return;
            if (!sameChannel(msg.channel_id)) return;
            const sf = lab.snowflake(msg.id);
            if (sf && Date.now() - sf.ts > 5 * 60 * 1000) return;
            remember(lab.embed.messageText(msg), msg.id);
        });

        function fill(cmd) {
            return String(cmd)
                .replace(/\{amount\}/g, String(cfg.amount))
                .replace(/\{target\}/g, cfg.target || "@cible")
                .replace(/\{self\}/g, lab.discord.currentUser()?.id ? `<@${lab.discord.currentUser().id}>` : "@moi")
                .replace(/\{name\}/g, cfg.name || "test")
                .replace(/\{color\}/g, cfg.color || "#ff5555");
        }

        async function copyText(text) {
            try {
                await navigator.clipboard.writeText(text);
                toast("Commande copiée", "success");
            } catch (_) {
                lab.export.download("blocky-commande.txt", text, "text/plain");
            }
        }

        async function runTest(t) {
            if (!t.cmd) { toast("Pas de commande pour ce test", "warn"); return; }
            if (!t.safe) { toast("Test risqué : copie la commande et exécute-la manuellement", "warn"); return; }
            if (!state.allowRun) { toast("Active « Autoriser l'envoi » dans l'onglet Audit", "warn"); return; }
            const cmd = fill(t.cmd);
            if (/\{target\}/.test(t.cmd) && !cfg.target) { toast("Renseigne une cible", "warn"); return; }
            state.sentAt = Date.now();
            const ok = await lab.discord.sendText(cmd);
            if (!ok) { toast("Envoi refusé (éditeur occupé ?)", "error"); return; }
            toast("Commande envoyée : " + cmd, "info");
            setTimeout(() => {
                if (state.last && state.last.at >= state.sentAt) {
                    const r = result(t.id);
                    r.evidence = state.last.text;
                    r.evidenceId = state.last.id;
                    r.at = new Date().toISOString();
                    save();
                    lab.ui.refresh("audit");
                }
            }, 6500);
        }

        function result(id) {
            if (!state.results[id]) state.results[id] = { status: "todo", note: "", evidence: "", evidenceId: "", at: "" };
            return state.results[id];
        }

        function setStatus(id, status) {
            const r = result(id);
            r.status = status;
            r.at = new Date().toISOString();
            state.openId = id;
            save();
            lab.ui.refresh("audit");
        }

        function capture(id) {
            if (!state.last) { toast("Aucune réponse capturée : ouvre une commande", "warn"); return; }
            const r = result(id);
            r.evidence = state.last.text;
            r.evidenceId = state.last.id;
            r.at = new Date().toISOString();
            state.openId = id;
            save();
            toast("Réponse capturée", "success");
            lab.ui.refresh("audit");
        }

        /* ------------------------------------------------------------------ */
        /* Rapport                                                             */
        /* ------------------------------------------------------------------ */

        function summary() {
            const counts = { todo: 0, pass: 0, fail: 0, blocked: 0, na: 0 };
            for (const t of TESTS) {
                const s = result(t.id).status || "todo";
                counts[s] = (counts[s] || 0) + 1;
            }
            return counts;
        }

        function report() {
            const c = summary();
            const lines = [
                "# Blocky Lab — rapport d'audit",
                "",
                `Généré : ${new Date().toLocaleString()}`,
                "",
                `- Tests : ${TESTS.length}`,
                `- À tester : ${c.todo}`,
                `- Passés : ${c.pass}`,
                `- Échoués : ${c.fail}`,
                `- Bloqués : ${c.blocked}`,
                `- N/A : ${c.na}`,
                "",
                "## Détail",
                ""
            ];
            for (const t of TESTS) {
                const r = result(t.id);
                lines.push(`### [${(r.status || "todo").toUpperCase()}] ${t.title}`);
                lines.push("");
                lines.push(`- Catégorie : ${t.cat}`);
                lines.push(`- Sévérité : ${SEV[t.sev]?.label || t.sev}`);
                lines.push(`- Hypothèse : ${t.hypo}`);
                lines.push(`- Attendu : ${t.expect}`);
                if (t.cmd) lines.push(`- Commande : \`${fill(t.cmd)}\``);
                if (r.note) lines.push(`- Note : ${r.note}`);
                if (r.evidence) {
                    lines.push(`- Preuve (${r.evidenceId || "sans id"}, ${r.at || "date inconnue"}) :`);
                    lines.push("");
                    lines.push("```");
                    lines.push(r.evidence.slice(0, 3000));
                    lines.push("```");
                }
                lines.push("");
            }
            return lines.join("\n");
        }

        /* ------------------------------------------------------------------ */
        /* Onglet                                                              */
        /* ------------------------------------------------------------------ */

        function render() {
            const wrap = h("div");
            const c = summary();

            const cfgCard = h("div", { class: "bl-card" },
                h("b", { text: "Paramètres de test" }),
                h("div", { class: "bl-grid2" },
                    h("label", { class: "bl-col" }, h("span", { class: "bl-label", text: "Cible (ID, @ ou pseudo)" }),
                        (() => {
                            const i = h("input", { class: "bl-input", value: cfg.target, placeholder: "@compte-test" });
                            i.addEventListener("change", () => { cfg.target = i.value.trim(); save(); });
                            return i;
                        })()),
                    h("label", { class: "bl-col" }, h("span", { class: "bl-label", text: "Montant de test" }),
                        (() => {
                            const i = h("input", { class: "bl-input", type: "number", min: 1, value: cfg.amount });
                            i.addEventListener("change", () => { cfg.amount = Math.max(1, Number(i.value) || 10); save(); });
                            return i;
                        })())
                ),
                h("div", { class: "bl-grid2" },
                    h("label", { class: "bl-col" }, h("span", { class: "bl-label", text: "Nom d'item" }),
                        (() => {
                            const i = h("input", { class: "bl-input", value: cfg.name });
                            i.addEventListener("change", () => { cfg.name = i.value.trim() || "test"; save(); });
                            return i;
                        })()),
                    h("label", { class: "bl-col" }, h("span", { class: "bl-label", text: "Couleur" }),
                        (() => {
                            const i = h("input", { class: "bl-input", value: cfg.color });
                            i.addEventListener("change", () => { cfg.color = i.value.trim() || "#ff5555"; save(); });
                            return i;
                        })())
                ),
                (() => {
                    const cb = h("input", { type: "checkbox" });
                    cb.checked = state.allowRun;
                    cb.addEventListener("change", () => { state.allowRun = cb.checked; });
                    return h("label", { class: "bl-row", style: { cursor: "pointer" } }, cb,
                        h("span", { text: "Autoriser l'envoi des commandes marquées « sûres »" }));
                })(),
                h("div", { class: "bl-muted", text: "Les commandes qui modifient le jeu ne sont jamais envoyées automatiquement : copie-les et exécute-les sur un compte de test. Les commandes « sûres » sont en lecture seule." })
            );

            const top = h("div", { class: "bl-card" },
                h("b", { text: "Progression" }),
                h("div", { class: "bl-kv" }, h("span", { text: "Tests" }), h("b", { text: String(TESTS.length) })),
                h("div", { class: "bl-kv" }, h("span", { text: "À tester" }), h("b", { text: String(c.todo) })),
                h("div", { class: "bl-kv" }, h("span", { text: "Échoués" }), h("b", { class: c.fail ? "bl-bad" : "", text: String(c.fail) })),
                h("div", { class: "bl-kv" }, h("span", { text: "Passés" }), h("b", { class: "bl-good", text: String(c.pass) })),
                h("div", { class: "bl-bar" }, h("i", { style: { width: `${Math.round(((c.pass + c.fail) / TESTS.length) * 100)}%` } })),
                h("div", { class: "bl-row" },
                    h("button", { class: "bl-btn bl-sec", text: "Rapport Markdown", onclick: () => lab.export.download("blocky-audit.md", report(), "text/markdown") }),
                    h("button", { class: "bl-btn bl-sec", text: "JSON", onclick: () => lab.export.download("blocky-audit.json", JSON.stringify({ generatedAt: new Date().toISOString(), results: state.results, cfg, tests: TESTS }, null, 2)) }),
                    h("button", {
                        class: "bl-btn bl-danger", text: "Réinitialiser",
                        onclick: () => {
                            state.results = {};
                            save();
                            lab.ui.refresh("audit");
                        }
                    })
                )
            );

            const cats = ["all", ...new Set(TESTS.map(t => t.cat))];
            const filterRow = h("div", { class: "bl-card" },
                h("div", { class: "bl-grid2" },
                    h("label", { class: "bl-col" }, h("span", { class: "bl-label", text: "Catégorie" }),
                        (() => {
                            const s = h("select", { class: "bl-select" });
                            for (const cat of cats) s.appendChild(h("option", { value: cat, text: cat === "all" ? "Toutes" : cat }));
                            s.value = state.category;
                            s.addEventListener("change", () => { state.category = s.value; lab.ui.refresh("audit"); });
                            return s;
                        })()),
                    h("label", { class: "bl-col" }, h("span", { class: "bl-label", text: "Statut" }),
                        (() => {
                            const s = h("select", { class: "bl-select" });
                            for (const [k, v] of [["todo", "À tester"], ["fail", "Échoués"], ["pass", "Passés"], ["blocked", "Bloqués"], ["all", "Tous"]]) {
                                s.appendChild(h("option", { value: k, text: v }));
                            }
                            s.value = state.filter;
                            s.addEventListener("change", () => { state.filter = s.value; lab.ui.refresh("audit"); });
                            return s;
                        })())
                ),
                (() => {
                    const i = h("input", { class: "bl-input", placeholder: "Rechercher…", value: state.search });
                    i.dataset.blSearch = "1";
                    let timer = 0;
                    i.addEventListener("input", () => {
                        state.search = i.value;
                        clearTimeout(timer);
                        timer = setTimeout(() => {
                            lab.ui.refresh("audit", true);
                            setTimeout(() => {
                                const next = document.querySelector("#bl-panel [data-bl-search]");
                                if (next) {
                                    next.focus();
                                    try { next.setSelectionRange(next.value.length, next.value.length); } catch (_) { /* ignore */ }
                                }
                            }, 0);
                        }, 260);
                    });
                    return i;
                })()
            );

            wrap.append(top, cfgCard, filterRow);

            const list = TESTS.filter(t => {
                if (state.category !== "all" && t.cat !== state.category) return false;
                const st = result(t.id).status || "todo";
                if (state.filter !== "all" && st !== state.filter) return false;
                if (state.search && !(t.title + " " + t.hypo + " " + t.id).toLowerCase().includes(state.search.toLowerCase())) return false;
                return true;
            });

            if (!list.length) {
                wrap.appendChild(h("div", { class: "bl-card bl-muted", text: "Aucun test ne correspond à ce filtre." }));
            }

            for (const t of list) {
                const r = result(t.id);
                const details = h("details", { class: "bl-card" });
                details.dataset.test = t.id;
                details.open = state.openId === t.id;
                details.addEventListener("toggle", () => {
                    if (details.open) state.openId = t.id;
                    else if (state.openId === t.id) state.openId = null;
                });
                const statusBadge = h("span", {
                    class: "bl-badge " + (r.status === "fail" ? "bl-badge-bad" : r.status === "pass" ? "bl-badge-good" : r.status === "blocked" ? "bl-badge-warn" : ""),
                    text: STATUS[r.status || "todo"]
                });
                details.appendChild(h("summary", null,
                    h("span", { class: "bl-badge " + (SEV[t.sev]?.cls || ""), text: SEV[t.sev]?.label || t.sev }),
                    h("b", { text: " " + t.title + " " }),
                    statusBadge
                ));
                details.appendChild(h("div", { class: "bl-muted", style: { margin: "6px 0", fontSize: "11px" }, text: `#${t.id} · ${t.cat}` }));
                details.appendChild(h("div", { text: t.hypo }));
                details.appendChild(h("div", { class: "bl-muted", style: { fontSize: "11px", marginTop: "5px" }, text: "Attendu : " + t.expect }));
                if (t.cmd) {
                    details.appendChild(h("div", { class: "bl-code", text: fill(t.cmd) }));
                    details.appendChild(h("div", { class: "bl-row" },
                        h("button", { class: "bl-btn bl-sec", text: "Copier", onclick: () => copyText(fill(t.cmd)) }),
                        h("button", { class: "bl-btn", text: "Envoyer", onclick: () => runTest(t) }),
                        t.safe ? h("span", { class: "bl-badge bl-badge-good", text: "lecture seule" }) : h("span", { class: "bl-badge bl-badge-warn", text: "risqué" })
                    ));
                }
                details.appendChild(h("div", { class: "bl-sub", text: "Étapes" }));
                const ol = h("ol", { style: { margin: "4px 0 4px 18px", padding: "0" } });
                for (const step of t.steps) ol.appendChild(h("li", { text: step, style: { margin: "3px 0" } }));
                details.appendChild(ol);

                details.appendChild(h("div", { class: "bl-row" },
                    h("label", { class: "bl-col", style: { flex: "1" } },
                        h("span", { class: "bl-label", text: "Statut" }),
                        (() => {
                            const s = h("select", { class: "bl-select" });
                            for (const [k, v] of Object.entries(STATUS)) s.appendChild(h("option", { value: k, text: v }));
                            s.value = r.status || "todo";
                            s.addEventListener("change", () => setStatus(t.id, s.value));
                            return s;
                        })())
                ));
                const note = h("textarea", { class: "bl-textarea", placeholder: "Notes, compte utilisé, heure, observation…" });
                note.value = r.note || "";
                note.addEventListener("change", () => { r.note = note.value; save(); });
                details.appendChild(note);

                if (r.evidence) {
                    details.appendChild(h("div", { class: "bl-sub", text: "Preuve capturée" }));
                    details.appendChild(h("div", { class: "bl-code", text: r.evidence }));
                }
                details.appendChild(h("div", { class: "bl-row" },
                    h("button", { class: "bl-btn bl-sec", text: "Capturer la dernière réponse", onclick: () => capture(t.id) }),
                    h("button", { class: "bl-btn bl-sec", text: "Effacer la preuve", onclick: () => { r.evidence = ""; r.evidenceId = ""; save(); lab.ui.refresh("audit"); } })
                ));
                wrap.appendChild(details);
            }

            wrap.appendChild(h("div", { class: "bl-muted", style: { fontSize: "10px", marginTop: "10px" }, text: "Les tests sont des hypothèses issues du wiki, pas des failles confirmées. Utilise un compte de test et respecte les règles du serveur." }));
            return wrap;
        }

        lab.ui.tab({ id: "audit", title: "Audit", hint: "Catalogue de tests wiki", render });
        console.info("[BlockyLab] audit prêt");
    }

    boot();
})();
