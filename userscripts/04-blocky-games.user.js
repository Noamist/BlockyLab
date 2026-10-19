// ==UserScript==
// @name         Blocky Lab · 04 · Jeux & EV
// @namespace    blocky-lab
// @version      1.1.0
// @description  Analyse des mini-jeux Blocky : RTP réel du Lucky Block, biais et espérance de la wheel, calcul exact de survie/EV des Mines et stop optimal.
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

    const LUCKY = [
        { key: "creeper", label: "💥 Creeper", p: 0.315, mult: 0 },
        { key: "cobblestone", label: "🪨 Cobblestone", p: 0.22, mult: 0.5 },
        { key: "iron", label: "⚙️ Fer", p: 0.18, mult: 1 },
        { key: "gold", label: "🟨 Or", p: 0.15, mult: 1.5 },
        { key: "diamonds", label: "💎 Diamant", p: 0.09, mult: 2.5 },
        { key: "emeralds", label: "🟩 Émeraude", p: 0.04, mult: 4 },
        { key: "netherite", label: "⬛ Netherite", p: 0.005, mult: 10 }
    ];

    // Vérité terrain (game/mines.py du bot) : le multiplicateur EST une formule,
    // pas une table. Le wiki affichait ×1,12 / ×1,27 après 2 / 3 blocs avec
    // 1 TNT — le bot paie en réalité ×1,06 / ×1,12. EV = mines_return exact
    // (95 % par défaut) : les Mines ne sont PAS +EV.
    //   fair(d, tnt) = Π_{i=0..d−1} (20−i) / (20−tnt−i)
    //   mult(d, tnt) = min(mines_max_multiplier (25), fair × mines_return (0,95))
    // Payout entier : floor(mise × mult + 0,5) (arrondi au demi supérieur).
    const MINES = { CELLS: 20, RETURN: 0.95, MAX_MULT: 25, TNT_MAX: 10 };

    function minesFair(dug, tnt) {
        let fair = 1;
        for (let i = 0; i < dug; i++) fair *= (MINES.CELLS - i) / (MINES.CELLS - tnt - i);
        return fair;
    }

    function minesMult(dug, tnt) {
        if (!dug) return 0;
        return Math.min(MINES.MAX_MULT, minesFair(dug, tnt) * MINES.RETURN);
    }

    function minesSurvival(safe, digs) {
        let p = 1;
        for (let i = 0; i < digs; i++) p *= (safe - i) / (MINES.CELLS - i);
        return p;
    }

    async function boot() {
        for (let i = 0; i < 200 && !W.BlockyLab; i++) await new Promise(r => setTimeout(r, 100));
        const lab = W.BlockyLab;
        if (!lab) { console.warn("[BlockyLab] jeux : noyau absent"); return; }
        if (W.__blockyGamesLoaded) return;
        W.__blockyGamesLoaded = true;

        const { h, stats, toast } = lab;
        const card = (title, ...kids) => h("div", { class: "bl-card" }, h("b", { text: title }), ...kids);
        const kv = (k, v, cls) => h("div", { class: "bl-kv" }, h("span", { text: k }), h("b", { class: cls || "", text: v }));
        const pct = x => `${(x * 100).toFixed(2)} %`;
        const pFmt = p => p < 0.0001 ? "< 0.0001" : p.toFixed(4);
        const sig = p => p < 0.01 ? "bl-bad" : p < 0.05 ? "bl-warn" : "bl-good";

        async function load() { return lab.idb.all(); }

        /* ============================================================== */
        /* Lucky Block                                                     */
        /* ============================================================== */

        async function luckyTab() {
            const all = await load();
            const obs = all.filter(o => o.game === "luckyblock" && o.detail?.category);
            const wrap = h("div");

            const theoretical = LUCKY.reduce((s, o) => s + o.p * o.mult, 0);
            wrap.appendChild(card("Table documentée",
                ...LUCKY.map(o => kv(o.label, `${pct(o.p)} × ${o.mult}`)),
                kv("RTP théorique", pct(theoretical)),
                kv("Espérance par mise", `${((theoretical - 1) * 100).toFixed(2)} %`)
            ));

            // Faille VÉRIFIÉE dans le code (game/luckyblock.py du bot) :
            // won = floor(mise × payout + 0,5) → l'arrondi est au demi SUPÉRIEUR.
            // Les payouts à 0,5 (cobblestone ×0,5, gold ×1,5, diamond ×2,5)
            // arrondissent vers le haut sur une mise IMPAIRE : mise 3 → 3,08
            // émeraudes de retour (+26,7 %), mise 1 → 1,18 (+18 %). Sur mise
            // paire l'arrondi est neutre : RTP = 95 % exact.
            const evBet = bet => LUCKY.reduce((s, o) => s + o.p * Math.floor(bet * o.mult + 0.5), 0);
            const rows = [];
            for (let b = 1; b <= 20; b++) rows.push({ bet: b, ev: evBet(b), rtp: evBet(b) / b });
            const best = rows.reduce((a, r) => (r.rtp > a.rtp ? r : a), rows[0]);
            wrap.appendChild(card("Faille vérifiée : arrondi des gains (mises impaires)",
                ...rows.slice(0, 10).map(r => kv(`Mise ${r.bet}`, `${r.ev.toFixed(3)} émeraudes — RTP ${pct(r.rtp)}`, r.rtp > 1 ? "bl-good" : "")),
                kv("Meilleure mise (1–20)", `mise ${best.bet} → RTP ${pct(best.rtp)}`, best.rtp > 1 ? "bl-good" : ""),
                h("div", { class: "bl-muted", text: "Vérifié dans game/luckyblock.py : floor(mise × payout + 0,5). Cobblestone (×0,5), gold (×1,5) et diamond (×2,5) arrondissent VERS LE HAUS sur mise impaire — la maison perd alors 2 à 27 % au lieu de gagner 5 %. À confirmer in game (quelques mises de 3 dans la limite quotidienne), et à signaler au staff : c'est un correctif d'arrondi, pas une stratégie durable." })
            ));

            if (obs.length) {
                const counts = LUCKY.map(o => obs.filter(x => x.detail.category === o.key).length);
                const n = counts.reduce((a, b) => a + b, 0);
                const observedP = counts.map(c => c / n);
                const chi = stats.chiSquare(counts, LUCKY.map(o => o.p * n));

                // RTP exact : payout/mise lus dans le message (le noyau 00 les
                // extrait désormais) ; repli sur le multiplicateur de table.
                const payouts = obs.map(o => (o.detail.bet > 0 && o.detail.payout != null)
                    ? o.detail.payout / o.detail.bet
                    : (LUCKY.find(x => x.key === o.detail.category) || {}).mult || 0);
                const m = stats.mean(payouts);
                const sd = Math.sqrt(stats.variance(payouts));
                const se = n ? sd / Math.sqrt(n) : 0;
                const lo = m - 1.96 * se, hi = m + 1.96 * se;

                wrap.appendChild(card("RTP empirique",
                    kv("Échantillon", n),
                    kv("RTP mesuré", pct(m), m > 0.95 ? "bl-good" : "bl-bad"),
                    kv("IC 95 %", `[${pct(lo)} ; ${pct(hi)}]`),
                    kv("Écart au 95 % documenté", `${((m - 0.95) * 100).toFixed(2)} pts`, Math.abs(m - 0.95) > 0.06 ? "bl-warn" : ""),
                    kv("χ² vs table (df 6)", `${chi.chi2.toFixed(2)} — p = ${pFmt(chi.p)}`, sig(chi.p)),
                    ...LUCKY.map((o, i) => h("div", { class: "bl-kv" },
                        h("span", { text: o.label }),
                        h("b", { text: `${counts[i]} (${pct(observedP[i])})` }),
                        h("span", { class: "bl-muted", text: `attendu ${pct(o.p)}` })
                    )),
                    h("div", { class: "bl-muted", text: "Si l'IC exclut 95 %, le bot ne respecte pas sa documentation : soit un bug, soit un changement non annoncé. Un RTP > 100 % avec un IC serré est une faille exploitable." })
                ));
            } else {
                wrap.appendChild(h("div", { class: "bl-muted", text: "Aucune observation Lucky Block. Lance /luckyblock et collecte." }));
            }

            // Kelly : avec un RTP < 1, la mise optimale est 0.
            const edge = theoretical - 1;
            const kelly = edge > 0 ? edge / (LUCKY.reduce((s, o) => s + o.p * (o.mult - 1) ** 2, 0) || 1) : 0;
            wrap.appendChild(card("Gestion de mise",
                kv("Edge", pct(edge), edge > 0 ? "bl-good" : "bl-bad"),
                kv("Kelly fractionnaire (¼)", `${(Math.max(0, kelly) / 4 * 100).toFixed(2)} % de la bankroll`),
                kv("Mise recommandée", edge > 0 ? "uniquement si l'edge est confirmé" : "0 — le jeu est perdant à long terme"),
                h("div", { class: "bl-muted", text: "Limite quotidienne du bot (par défaut) : 1 500 émeraudes de gains nets aux jeux de hasard (×2 pendant une Gambling Frenzy). Mises : 1 à 200 (300 pour un Gambler). Le Gambler ne change pas l'EV, seulement la variance." })
            ));
            return wrap;
        }

        /* ============================================================== */
        /* Wheel                                                           */
        /* ============================================================== */

        const RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);

        async function wheelTab() {
            const all = await load();
            const obs = all.filter(o => o.game === "wheel").sort((a, b) => a.ts - b.ts);
            const nums = obs.filter(o => Number.isInteger(o.detail?.number)).map(o => o.detail.number);
            const wrap = h("div");

            wrap.appendChild(card("Espérance des paris (roue européenne)",
                kv("Rouge / noir (×2)", "97,30 %", "bl-bad"),
                kv("Numéro plein (×36)", "97,30 %", "bl-bad"),
                kv("Avantage maison", "2,70 % par mise"),
                h("div", { class: "bl-muted", text: "Le 0 (Diamond) fait perdre rouge et noir. Aucune martingale ne change l'EV ; seule une déviation statistique du générateur le peut." })
            ));

            if (nums.length >= 30) {
                const counts = new Array(37).fill(0);
                for (const n of nums) counts[n]++;
                const chi = stats.chiSquareUniform(counts);
                const top = counts.map((c, i) => ({ i, c, z: (c - nums.length / 37) / Math.sqrt(nums.length * (1 / 37) * (36 / 37)) }))
                    .sort((a, b) => Math.abs(b.z) - Math.abs(a.z))[0];

                wrap.appendChild(card("Biais mesuré",
                    kv("Tirages", nums.length),
                    kv("χ² (df 36)", `${chi.chi2.toFixed(2)} — p = ${pFmt(chi.p)}`, sig(chi.p)),
                    kv("Numéro le plus fréquent", `n°${top.i} (${top.c}×, z=${top.z.toFixed(2)})`, Math.abs(top.z) > 2.9 ? "bl-warn" : ""),
                    h("div", { class: "bl-muted", text: "Avec 37 catégories, un |z| > 2,9 est nécessaire pour rester sous 5 % d'erreur globale (Bonferroni). En dessous, c'est du bruit." })
                ));

                // EV conditionnelle d'un pari sur le numéro le plus chaud, avec shrinkage bayésien.
                const pRaw = top.c / nums.length;
                const prior = 1 / 37, strength = 37;
                const pPost = (top.c + prior * strength) / (nums.length + strength);
                const evNumber = 36 * pPost;
                wrap.appendChild(card("Pari sur le numéro le plus chaud",
                    kv("p observé", pct(pRaw)),
                    kv("p posterior (Beta)", pct(pPost)),
                    kv("EV du pari ×36", pct(evNumber), evNumber > 1 ? "bl-good" : "bl-bad"),
                    h("div", { class: "bl-muted", text: "Le shrinkage empêche de surinterpréter un numéro chanceux. Il faut un biais énorme et beaucoup de tirages pour rendre un pari positif." })
                ));
            }

            if (obs.length) {
                let streak = 0, longestRed = 0, longestBlack = 0, curColor = null, curLen = 0;
                const colors = obs.filter(o => o.detail?.color).map(o => o.detail.color);
                for (const c of colors) {
                    if (c === curColor) curLen++;
                    else { curColor = c; curLen = 1; }
                    if (c === "red") longestRed = Math.max(longestRed, curLen);
                    if (c === "black") longestBlack = Math.max(longestBlack, curLen);
                }
                streak = curLen;
                wrap.appendChild(card("Séries en cours",
                    kv("Dernière couleur", curColor || "—"),
                    kv("Longueur", `${streak} (max rouge ${longestRed}, noir ${longestBlack})`),
                    kv("Derniers numéros", colors.length ? nums.slice(-12).join(" · ") : "—"),
                    h("div", { class: "bl-muted", text: "La probabilité de la couleur suivante reste 18/37, indépendamment de la série. Toute stratégie de « rattrapage » augmente seulement la variance." })
                ));
            }

            if (!nums.length) wrap.appendChild(h("div", { class: "bl-muted", text: "Aucun numéro de wheel collecté pour l'instant." }));
            return wrap;
        }

        /* ============================================================== */
        /* Mining                                                          */
        /* ============================================================== */

        async function miningTab() {
            const all = await load();
            const obs = all.filter(o => o.game === "mining" && o.detail?.mining);
            const wrap = h("div");
            if (!obs.length) {
                return h("div", { class: "bl-muted", text: "Aucune récompense de minage reconnue. Vérifie le format dans l'onglet Recon." });
            }

            const piles = new Array(7).fill(0);
            const types = { cobblestone: 0, gravel: 0, deepslate: 0, obsidian: 0, bedrock: 0 };
            let totalBlocks = 0, xpSum = 0, xpN = 0, lapisN = 0;

            for (const o of obs) {
                const m = o.detail.mining;
                if (m.pile >= 1 && m.pile <= 6) piles[m.pile]++;
                for (const [k, n] of Object.entries(m.blocks || {})) {
                    if (types[k] !== undefined) types[k] += n;
                    totalBlocks += n;
                }
                if (Number.isFinite(m.xp)) { xpSum += m.xp; xpN++; }
                if (m.lapis) lapisN++;
            }

            const maxPile = Math.max(1, ...piles);
            const maxType = Math.max(1, ...Object.values(types));
            const n = obs.length;

            wrap.appendChild(card("Récompenses de minage",
                kv("Messages", n),
                kv("Blocs analysés", totalBlocks),
                kv("Taille moyenne de pile", (totalBlocks / n).toFixed(2)),
                kv("XP moyen", xpN ? (xpSum / xpN).toFixed(1) : "—"),
                kv("Lapis", `${lapisN} (${pct(lapisN / n)}) — attendu 2,5 %`, Math.abs(lapisN / n - 0.025) > 0.02 ? "bl-warn" : "")
            ));

            const pileCard = card("Distribution des piles (1–6)",
                h("div", { class: "bl-muted", text: "Chaque récompense est une pile de 1 à 6 blocs. La forme de cette distribution est une empreinte directe du tirage." })
            );
            for (let i = 1; i <= 6; i++) {
                pileCard.appendChild(h("div", { class: "bl-row" }, h("span", { text: `${i} bloc${i > 1 ? "s" : ""}` }), h("span", { class: "bl-spacer" }), h("b", { text: `${piles[i]} (${pct(piles[i] / n)})` })));
                pileCard.appendChild(h("div", { class: "bl-bar" }, h("i", { style: { width: `${Math.round((piles[i] / maxPile) * 100)}%` } })));
            }
            wrap.appendChild(pileCard);

            const typeCard = card("Types de blocs",
                h("div", { class: "bl-muted", text: "Odds réelles du code (overworld, sans talent ni pioche) : pile 6 → terre 50 % / pierre 50 % ; pile 4-5 → 20/50/30 (terre/pierre/gravier) ; pile 2-3 → pierre 70 % / gravier 20 % / ardoise 10 % ; pile 1 → pierre 70 % / gravier 20 % / ardoise 9 % / obsidienne 3 % / bedrock 1 %. La pioche, la pelle et les talents modifient ces poids : mesure avec ton équipement et compares à la config du serveur (config.json → balance mining.odds_*)." })
            );
            for (const [k, v] of Object.entries(types)) {
                typeCard.appendChild(h("div", { class: "bl-row" }, h("span", { text: k }), h("span", { class: "bl-spacer" }), h("b", { text: `${v} (${totalBlocks ? pct(v / totalBlocks) : "—"})` })));
                typeCard.appendChild(h("div", { class: "bl-bar" }, h("i", { style: { width: `${Math.round((v / maxType) * 100)}%`, background: k === "bedrock" ? "#ed4245" : k === "obsidian" ? "#a06af9" : "#5865f2" } })));
            }
            wrap.appendChild(typeCard);

            wrap.appendChild(card("Pourquoi c'est utile pour la seed",
                h("div", { class: "bl-muted", text: "Une seule récompense contient plusieurs tirages (taille de pile + type de chaque bloc + XP + lapis + drop). Si le bot appelle son PRNG dans un ordre fixe, chaque message fournit 3 à 8 sorties consécutives : c'est un bien meilleur échantillon que la wheel. L'onglet Seed ne consomme pour l'instant que les jeux à issue unique ; le JSON brut (option storeRaw) permet d'étendre l'analyse." })
            ));
            return wrap;
        }

        /* ============================================================== */
        /* Mines                                                           */
        /* ============================================================== */

        function survival(safe, total, digs) {
            let p = 1;
            for (let i = 0; i < digs; i++) p *= (safe - i) / (total - i);
            return p;
        }

        async function minesTab() {
            const wrap = h("div");
            const state = { tnt: 1, digs: 1, bet: 10 };

            const out = h("div");
            const grid = h("div", {
                style: {
                    display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: "3px",
                    margin: "8px 0", maxWidth: "230px"
                }
            });

            function compute() {
                const safe = MINES.CELLS - state.tnt;
                const p = minesSurvival(safe, state.digs);
                const mult = minesMult(state.digs, state.tnt);
                const ev = mult * p;
                const kelly = ev > 1 ? (ev - 1) / (mult - 1) : 0;
                // Arrondi réel du bot : floor(mise × mult + 0,5) — sur une petite
                // mise, le +0,5 peut relever le payout d'une émeraude entière.
                const r1 = Math.floor(state.bet * mult + 0.5) / state.bet;

                out.textContent = "";
                out.append(
                    kv("Cellules sûres", `${safe} / ${MINES.CELLS}`),
                    kv("Probabilité de survivre", pct(p)),
                    kv("Multiplicateur affiché", `×${mult.toFixed(2)}`),
                    kv("Espérance théorique (RTP)", pct(ev), "bl-bad"),
                    kv(`RTP avec arrondi (mise ${state.bet})`, pct(r1 * p)),
                    kv("Kelly ¼", kelly ? `${(kelly / 4 * 100).toFixed(2)} %` : "0 %")
                );

                out.appendChild(h("div", { class: "bl-muted", text: `Verdict code : les Mines paient le jeu juste × ${MINES.RETURN} (${MINES.RETURN * 100} %) — le RTP ne dépasse pas ${MINES.RETURN * 100} % (arrondi compris, hors mises minuscules). Il n'y a pas d'edge : la table du wiki (×1,12 après 2 blocs) était fausse.` }));
            }

            function buildGrid() {
                grid.textContent = "";
                for (let i = 0; i < 20; i++) {
                    const cell = h("button", {
                        class: "bl-btn bl-sec",
                        text: "·",
                        style: { padding: "8px 0", borderRadius: "3px" },
                        onclick: () => {
                            const isTnt = cell.dataset.tnt === "1";
                            cell.dataset.tnt = isTnt ? "0" : "1";
                            cell.textContent = isTnt ? "·" : "💥";
                            cell.style.background = isTnt ? "#4e5058" : "#b93838";
                            const tnt = [...grid.children].filter(c => c.dataset.tnt === "1").length;
                            tntInput.value = tnt;
                            state.tnt = Math.max(1, Math.min(10, tnt || 1));
                            compute();
                        }
                    });
                    cell.dataset.tnt = "0";
                    grid.appendChild(cell);
                }
            }

            const tntInput = h("input", { class: "bl-input", type: "number", min: 1, max: 10, value: state.tnt });
            tntInput.addEventListener("change", () => { state.tnt = Math.max(1, Math.min(10, Number(tntInput.value) || 1)); compute(); });
            const digInput = h("input", { class: "bl-input", type: "number", min: 1, max: 20, value: state.digs });
            digInput.addEventListener("change", () => { state.digs = Math.max(1, Math.min(20, Number(digInput.value) || 1)); compute(); });

            buildGrid();
            compute();

            wrap.append(
                card("Calculateur de stop",
                    h("label", { class: "bl-col" }, h("span", { class: "bl-label", text: "TNT dans la grille (1–10)" }), tntInput),
                    h("label", { class: "bl-col" }, h("span", { class: "bl-label", text: "Blocs sûrs creusés avant cash-out" }), digInput),
                    out
                ),
                card("Table calculée (code du bot, mines_return 0,95)",
                    h("table", { class: "bl-table" },
                        h("thead", null, h("tr", null, h("th", { text: "TNT" }), ...[1, 2, 3, 4, 5].map(d => h("th", { text: `${d} bloc${d > 1 ? "s" : ""}` })), h("th", { text: "RTP après 5 blocs" }))),
                        h("tbody", null,
                            ...Array.from({ length: MINES.TNT_MAX }, (_, i) => i + 1).map(tnt =>
                                h("tr", null,
                                    h("td", { text: tnt }),
                                    ...[1, 2, 3, 4, 5].map(d => h("td", { text: "×" + minesMult(d, tnt).toFixed(2) })),
                                    h("td", { text: pct(minesMult(5, tnt) * minesSurvival(MINES.CELLS - tnt, 5)) })
                                )
                            )
                        )
                    ),
                    h("div", { class: "bl-muted", text: "Formule exacte du bot : ×(d, tnt) = Π (20−i)/(20−tnt−i) × 0,95, plafonné à ×25 (auto cash-out). Le RTP vaut exactement 95 % après chaque bloc : c'est le jeu juste moins la part du bot (5 %). Toute valeur observée en jeu supérieure à ce tableau signale un écart à vérifier." })
                ),
                card("Grille observée",
                    h("div", { class: "bl-muted", text: "Clique les cases où le bot a révélé du TNT pour compter la disposition, puis vérifie si les positions sont uniformes sur plusieurs parties." }),
                    grid
                )
            );
            return wrap;
        }

        /* ============================================================== */
        /* Onglet                                                          */
        /* ============================================================== */

        lab.ui.tab({
            id: "games", title: "Jeux",
            render: async () => {
                const wrap = h("div");
                const sub = h("div", { class: "bl-tabs", style: { padding: "0", background: "transparent", marginBottom: "8px" } });
                const body = h("div");
                const views = [
                    ["Lucky Block", luckyTab],
                    ["Wheel", wheelTab],
                    ["Mines", minesTab],
                    ["Minage", miningTab]
                ];
                let active = 0;
                const show = async i => {
                    active = i;
                    [...sub.children].forEach((b, j) => b.classList.toggle("bl-on", j === i));
                    body.textContent = "";
                    body.appendChild(h("div", { class: "bl-muted", text: "Calcul…" }));
                    try {
                        const node = await views[i][1]();
                        if (active !== i) return;
                        body.textContent = "";
                        body.appendChild(node);
                    } catch (e) {
                        body.textContent = "Erreur : " + e.message;
                    }
                };
                views.forEach(([name], i) => sub.appendChild(h("button", {
                    class: "bl-tab" + (i === 0 ? " bl-on" : ""), text: name, onclick: () => show(i)
                })));
                wrap.append(sub, body);
                show(0);
                return wrap;
            }
        });

        console.info("[BlockyLab] jeux prêt");
    }

    boot();
})();
