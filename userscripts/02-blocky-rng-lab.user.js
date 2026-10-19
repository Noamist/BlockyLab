// ==UserScript==
// @name         Blocky Lab · 02 · RNG Lab
// @namespace    blocky-lab
// @version      1.0.1
// @description  Analyse statistique et recherche de seed : biais, indépendance, autocorrélation, familles de PRNG, force brute sur fenêtre temporelle et prédiction en direct.
//               ATTENDU contre Blocky (bot Python) : AUCUN candidat en recherche de seed — le bot tire d'un
//               Mersenne Twister semé par l'OS (random.Random() dans game/db.py), jamais par l'horloge.
//               Voir docs/FINDINGS.md § L4 : un résultat négatif EST la réponse attendue. Les tests
//               statistiques (Biais / Vue d'ensemble) restent la bonne approche.
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

    const LUCKY = ["creeper", "cobblestone", "iron", "gold", "diamonds", "emeralds", "netherite"];
    const LUCKY_P = [0.315, 0.22, 0.18, 0.15, 0.09, 0.04, 0.005];
    const LUCKY_LABEL = {
        creeper: "💥 Creeper", cobblestone: "🪨 Cobble", iron: "⚙️ Fer", gold: "🟨 Or",
        diamonds: "💎 Diamant", emeralds: "🟩 Émeraude", netherite: "⬛ Netherite"
    };

    async function boot() {
        for (let i = 0; i < 200 && !W.BlockyLab; i++) await new Promise(r => setTimeout(r, 100));
        const lab = W.BlockyLab;
        if (!lab) { console.warn("[BlockyLab] RNG lab : noyau absent"); return; }
        if (W.__blockyRngLoaded) return;
        W.__blockyRngLoaded = true;

        const { h, stats, toast } = lab;
        let cache = { at: 0, all: [] };
        let predictor = null;

        async function data(force = false) {
            if (!force && Date.now() - cache.at < 4000 && cache.all.length) return cache.all;
            const all = await lab.idb.all();
            cache = { at: Date.now(), all };
            return all;
        }

        const card = (title, ...kids) => h("div", { class: "bl-card" }, h("b", { text: title }), ...kids);
        const kv = (k, v, cls) => h("div", { class: "bl-kv" },
            h("span", { text: k }),
            h("b", { class: cls || "", text: v })
        );
        const pct = x => `${(x * 100).toFixed(2)} %`;
        const pFmt = p => p < 0.0001 ? "< 0.0001" : p.toFixed(4);
        const sig = p => p < 0.01 ? "bl-bad" : p < 0.05 ? "bl-warn" : "bl-good";

        function bar(value, max, color) {
            return h("div", { class: "bl-bar" },
                h("i", { style: { width: `${max ? Math.round((value / max) * 100) : 0}%`, background: color || "#5865f2" } })
            );
        }

        function chips(seq, limit = 80) {
            const wrap = h("div", { class: "bl-chips" });
            for (const item of seq.slice(-limit)) {
                let bg = "#4e5058";
                let label = "?";
                if (item.label === "win") { bg = "#248046"; label = "G"; }
                else if (item.label === "loss") { bg = "#b93838"; label = "P"; }
                else if (item.label === "push") { bg = "#c27c0e"; label = "="; }
                if (item.number !== undefined && item.number !== null) { label = String(item.number); bg = item.color === "red" ? "#b93838" : item.color === "black" ? "#2b2d31" : "#248046"; }
                if (item.category) { label = item.category.slice(0, 2); }
                wrap.appendChild(h("span", { class: "bl-chip", style: { background: bg }, title: String(item.label ?? item.number ?? ""), text: label }));
            }
            return wrap;
        }

        /* -------------------------------------------------------------- */
        /* Statistiques                                                    */
        /* -------------------------------------------------------------- */

        function summarise(all, game) {
            const obs = all.filter(o => o.game === game);
            const wins = obs.filter(o => o.label === "win").length;
            const losses = obs.filter(o => o.label === "loss").length;
            const pushes = obs.filter(o => o.label === "push").length;
            const n = wins + losses;
            const rate = n ? wins / n : 0;
            const wilson = (() => {
                if (!n) return [0, 0];
                const z = 1.96, p = rate, d = 1 + z * z / n;
                const c = p + z * z / (2 * n);
                const m = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
                return [Math.max(0, (c - m) / d), Math.min(1, (c + m) / d)];
            })();
            const zt = stats.zTest(wins, n, 0.5);
            const seq = obs.filter(o => o.label === "win" || o.label === "loss").sort((a, b) => a.ts - b.ts).map(o => o.label === "win" ? 1 : 0);
            return { obs, wins, losses, pushes, n, rate, wilson, zt, seq };
        }

        function renderStats(all) {
            const wrap = h("div");
            const games = [...new Set(all.map(o => o.game))].filter(g => g !== "unknown");
            if (!games.length) return h("div", { class: "bl-muted", text: "Aucune donnée. Utilise l'onglet Collecte." });

            for (const game of games) {
                const s = summarise(all, game);
                if (!s.obs.length) continue;
                if (!s.n && !s.pushes) continue;
                const runs = stats.runsTest(s.seq);
                const mk = stats.markov(s.seq, 2);
                const block = card(`Vue d'ensemble · ${game}`,
                    kv("Observations", s.obs.length),
                    kv("Gains / pertes / push", `${s.wins} / ${s.losses} / ${s.pushes}`),
                    kv("Taux de gain", s.n ? `${pct(s.rate)} [${pct(s.wilson[0])} – ${pct(s.wilson[1])}]` : "—"),
                    kv("z vs 50 %", s.n ? `${s.zt.z.toFixed(2)} (p = ${pFmt(s.zt.p)})` : "—", s.n ? sig(s.zt.p) : ""),
                    runs ? kv("Runs test (indépendance)", `z = ${runs.z.toFixed(2)} (p = ${pFmt(runs.p)})`, sig(runs.p)) : null,
                    mk.chi2 ? kv("Markov gain→gain", `χ² = ${mk.chi2.toFixed(1)} (p = ${pFmt(mk.p)})`, sig(mk.p)) : null,
                    h("div", { class: "bl-label", text: "Séquence (G = gain, P = perte)" }),
                    chips(s.obs.slice(-100).map(o => ({ label: o.label, number: o.detail?.number, color: o.detail?.color, category: o.detail?.category })))
                );
                wrap.appendChild(block);
            }

            wrap.appendChild(card("Méthode",
                h("div", { class: "bl-muted", text: "z et χ² mesurent l'écart au hasard attendu. p < 0,05 = signal à confirmer sur un nouvel échantillon ; p < 0,01 = anomalie sérieuse. Le runs test détecte les séries (trop ou pas assez alternées) ; Markov détecte une dépendance entre deux résultats consécutifs." })
            ));
            return wrap;
        }

        /* -------------------------------------------------------------- */
        /* Biais                                                           */
        /* -------------------------------------------------------------- */

        function renderBias(all) {
            const wrap = h("div");

            // Lucky Block
            const lb = all.filter(o => o.game === "luckyblock" && o.detail?.category);
            if (lb.length) {
                const counts = LUCKY.map(c => lb.filter(o => o.detail.category === c).length);
                const n = counts.reduce((a, b) => a + b, 0);
                const expected = LUCKY_P.map(p => p * n);
                const chi = stats.chiSquare(counts, expected);
                const max = Math.max(...counts, 1);
                const block = card("Lucky Block — distribution des 7 issues",
                    kv("Échantillon", n),
                    kv("χ² (df 6)", `${chi.chi2.toFixed(2)} — p = ${pFmt(chi.p)}`, sig(chi.p)),
                    ...LUCKY.map((c, i) => {
                        const obsP = counts[i] / n;
                        const z = Math.sqrt(n * LUCKY_P[i] * (1 - LUCKY_P[i])) ? (obsP - LUCKY_P[i]) / Math.sqrt(LUCKY_P[i] * (1 - LUCKY_P[i]) / n) : 0;
                        return h("div", null,
                            h("div", { class: "bl-row" },
                                h("span", { text: LUCKY_LABEL[c] }),
                                h("span", { class: "bl-spacer" }),
                                h("b", { text: `${counts[i]} (${pct(obsP)})` }),
                                h("span", { class: "bl-muted", text: `attendu ${pct(LUCKY_P[i])}` }),
                                h("span", { class: Math.abs(z) > 2.5 ? "bl-warn" : "bl-muted", text: `z=${z.toFixed(2)}` })
                            ),
                            bar(counts[i], max, c === "creeper" ? "#b93838" : "#5865f2")
                        );
                    }),
                    h("div", { class: "bl-muted", text: "RTP théorique de la table : 95 %. Un χ² significatif signifie que les probabilités réelles diffèrent de la documentation." })
                );
                wrap.appendChild(block);
            }

            // Wheel
            const wh = all.filter(o => o.game === "wheel" && Number.isInteger(o.detail?.number));
            if (wh.length) {
                const counts = new Array(37).fill(0);
                for (const o of wh) counts[o.detail.number]++;
                const n = wh.length;
                const chi = stats.chiSquareUniform(counts);
                const max = Math.max(...counts, 1);
                const mean = counts.reduce((s, c, i) => s + c * i, 0) / n;
                const top = counts.map((c, i) => ({ i, c, z: (c - n / 37) / Math.sqrt(n * (1 / 37) * (36 / 37)) }))
                    .sort((a, b) => Math.abs(b.z) - Math.abs(a.z)).slice(0, 6);

                const grid = h("div", { style: { display: "grid", gridTemplateColumns: "repeat(10, 1fr)", gap: "2px", marginTop: "6px" } });
                counts.forEach((c, i) => {
                    const z = (c - n / 37) / Math.sqrt(n * (1 / 37) * (36 / 37));
                    const bg = i === 0 ? "#248046" : [1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36].includes(i) ? "#7d2b2e" : "#2b2d31";
                    grid.appendChild(h("div", {
                        style: { background: bg, padding: "3px 2px", borderRadius: "3px", textAlign: "center", fontSize: "10px", outline: Math.abs(z) > 2.9 ? "2px solid #fee75c" : "none" },
                        title: `${c} sorties, z=${z.toFixed(2)}`,
                        html: `<b>${i}</b><br>${c}`
                    }));
                });

                wrap.appendChild(card("Wheel — uniformité des 37 numéros",
                    kv("Échantillon", n),
                    kv("χ² (df 36)", `${chi.chi2.toFixed(2)} — p = ${pFmt(chi.p)}`, sig(chi.p)),
                    kv("Moyenne empirique", mean.toFixed(2), Math.abs(mean - 18) > 1 ? "bl-warn" : ""),
                    kv("Entropie", `${stats.entropy(counts).toFixed(3)} / 5.209 bits`),
                    grid,
                    h("div", { class: "bl-label", text: "Numéros les plus déviants (|z|)" }),
                    ...top.map(t => h("div", { class: "bl-kv" },
                        h("span", { text: `n°${t.i} — ${t.c} sorties` }),
                        h("b", { class: Math.abs(t.z) > 2.9 ? "bl-warn" : "bl-muted", text: `z = ${t.z.toFixed(2)}` })
                    )),
                    h("div", { class: "bl-muted", text: "Seuil de Bonferroni à 5 % pour 37 tests : |z| > 2,9. Un numéro au-delà est un candidat sérieux à un biais exploitable (mise numéro = ×36)." })
                ));
            }

            if (!lb.length && !wh.length) {
                wrap.appendChild(h("div", { class: "bl-muted", text: "Pas encore assez de données Lucky Block / Wheel. Collecte d'abord." }));
            }
            return wrap;
        }

        /* -------------------------------------------------------------- */
        /* Séquences & corrélations temporelles                            */
        /* -------------------------------------------------------------- */

        function renderSeq(all) {
            const wrap = h("div");
            const wheel = all.filter(o => o.game === "wheel" && Number.isInteger(o.detail?.number)).sort((a, b) => a.ts - b.ts);
            if (wheel.length >= 20) {
                const nums = wheel.map(o => o.detail.number);
                const lags = [1, 2, 3, 5, 10].map(l => [l, stats.autocorr(nums, l)]);
                wrap.appendChild(card("Autocorrélation des numéros",
                    ...lags.map(([l, r]) => kv(`lag ${l}`, r.toFixed(4), Math.abs(r) > 0.15 ? "bl-warn" : "")),
                    h("div", { class: "bl-muted", text: "Une autocorrélation significative trahit un générateur qui réutilise son état (LCG, xorshift) plutôt qu'une source cryptographique." })
                ));
            }

            const labelled = all.filter(o => o.label === "win" || o.label === "loss").sort((a, b) => a.ts - b.ts);
            if (labelled.length >= 20) {
                const rows = [];
                for (const k of [2, 3, 4, 5, 7, 10, 37]) {
                    const bins = Array.from({ length: k }, () => ({ w: 0, l: 0 }));
                    for (const o of labelled) {
                        const b = Math.floor((o.ts / 1000) % k);
                        if (o.label === "win") bins[b].w++; else bins[b].l++;
                    }
                    let chi2 = 0, df = 0;
                    for (const b of bins) {
                        const n = b.w + b.l;
                        if (!n) continue;
                        for (const val of [b.w, b.l]) {
                            const e = n * 0.5;
                            if (e > 0) chi2 += ((val - e) ** 2) / e;
                        }
                        df += 1;
                    }
                    rows.push([k, chi2, Math.max(1, df), stats.chi2P(chi2, Math.max(1, df))]);
                }
                wrap.appendChild(card("Résultat vs horloge",
                    ...rows.map(([k, c, df, p]) => kv(`ts / 1000 mod ${k}`, `χ²=${c.toFixed(1)} df=${df} p=${pFmt(p)}`, sig(p))),
                    h("div", { class: "bl-muted", text: "Si un découpage temporel est significatif, le tirage dépend de l'heure : c'est le premier indice d'une seed temporelle." })
                ));
            }

            const wh2 = all.filter(o => o.game === "wheel" && Number.isInteger(o.detail?.number));
            if (wh2.length >= 10) {
                const direct = wh2.map(o => {
                    const ts = o.ts;
                    return {
                        id: o.id.slice(-6),
                        n: o.detail.number,
                        ms: ts % 37,
                        s: Math.floor(ts / 1000) % 37,
                        min: Math.floor(ts / 60000) % 37
                    };
                });
                const hit = (k) => direct.filter(d => d.n === d[k]).length / direct.length;
                wrap.appendChild(card("Corrélation directe horloge → numéro",
                    kv("n = numéro (ms mod 37)", `${pct(hit("ms"))} (attendu 2,7 %)`, hit("ms") > 0.08 ? "bl-warn" : ""),
                    kv("n = (s) mod 37", `${pct(hit("s"))} (attendu 2,7 %)`, hit("s") > 0.08 ? "bl-warn" : ""),
                    kv("n = (min) mod 37", `${pct(hit("min"))} (attendu 2,7 %)`, hit("min") > 0.08 ? "bl-warn" : ""),
                    h("div", { class: "bl-muted", text: "Test trivial : si le bot renvoyait directement l'heure modulo 37, ce taux exploserait. C'est rare, mais gratuit à vérifier." })
                ));
            }

            const lb = all.filter(o => o.game === "luckyblock" && o.detail?.category).sort((a, b) => a.ts - b.ts);
            if (lb.length) {
                wrap.appendChild(card("Lucky Block — dernières issues",
                    chips(lb.slice(-120).map(o => ({ category: o.detail.category, label: o.label }))),
                    h("div", { class: "bl-muted", text: "C = Creeper, Co = Cobble, Fe = Fer, Or = Or, Di = Diamant, Em = Émeraude, Ne = Netherite." })
                ));
            }

            const wh3 = all.filter(o => o.game === "wheel").sort((a, b) => a.ts - b.ts);
            if (wh3.length) {
                wrap.appendChild(card("Wheel — dernières sorties",
                    chips(wh3.slice(-120).map(o => ({ number: o.detail?.number, color: o.detail?.color, label: o.label })))
                ));
            }
            return wrap;
        }

        /* -------------------------------------------------------------- */
        /* Générateurs                                                     */
        /* -------------------------------------------------------------- */

        const prngList = [
            ["mulberry32", "Mulberry32 (JS, 32 bits)"],
            ["xorshift32", "xorshift32"],
            ["splitmix32", "SplitMix32"],
            ["lcg-nr", "LCG Numerical Recipes"],
            ["lcg-glibc", "LCG glibc (ANSI)"],
            ["lcg-msvc", "LCG MSVC / rand()"],
            ["parkmiller", "Park–Miller (MINSTD)"],
            ["java", "java.util.Random (LCG 48 bits)"],
            ["mt19937", "MT19937 (Mersenne Twister)"]
        ];

        function makeGen(name, seed) {
            let next;
            switch (name) {
                case "mulberry32": {
                    let a = seed | 0;
                    next = () => {
                        a = (a + 0x6D2B79F5) | 0;
                        let t = Math.imul(a ^ (a >>> 15), 1 | a);
                        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
                        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
                    };
                    break;
                }
                case "xorshift32": {
                    let x = seed | 0;
                    if (!x) x = 0x9E3779B9;
                    next = () => {
                        x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
                        return (x >>> 0) / 4294967296;
                    };
                    break;
                }
                case "splitmix32": {
                    let s = seed | 0;
                    next = () => {
                        s = (s + 0x9E3779B9) | 0;
                        let t = s;
                        t = Math.imul(t ^ (t >>> 16), 0x21f0aaad);
                        t = Math.imul(t ^ (t >>> 15), 0x735a2d97);
                        t ^= t >>> 15;
                        return (t >>> 0) / 4294967296;
                    };
                    break;
                }
                case "lcg-nr": {
                    let s = seed >>> 0;
                    next = () => {
                        s = (Math.imul(1664525, s) + 1013904223) >>> 0;
                        return s / 4294967296;
                    };
                    break;
                }
                case "lcg-glibc": {
                    let s = seed & 0x7fffffff;
                    next = () => {
                        s = (Math.imul(1103515245, s) + 12345) & 0x7fffffff;
                        return s / 2147483648;
                    };
                    break;
                }
                case "lcg-msvc": {
                    let s = seed >>> 0;
                    next = () => {
                        s = (Math.imul(214013, s) + 2531011) >>> 0;
                        return ((s >>> 16) & 0x7fff) / 32768;
                    };
                    break;
                }
                case "parkmiller": {
                    let s = Math.abs(seed) % 2147483647 || 1;
                    next = () => {
                        s = (16807 * s) % 2147483647;
                        return s / 2147483647;
                    };
                    break;
                }
                case "java": {
                    let s = (BigInt(seed) ^ 0x5DEECE66Dn) & ((1n << 48n) - 1n);
                    const nextBits = bits => {
                        s = (s * 0x5DEECE66Dn + 0xBn) & ((1n << 48n) - 1n);
                        return Number(s >> BigInt(48 - bits));
                    };
                    return n => {
                        if (n <= 0) return 0;
                        if ((n & -n) === n) return Math.floor(n * nextBits(31) / 2147483648);
                        let bits, val;
                        do {
                            bits = nextBits(31);
                            val = bits % n;
                        } while (bits - val + (n - 1) >= 2147483648);
                        return val;
                    };
                }
                case "mt19937": {
                    const mt = new Uint32Array(624);
                    let idx = 624;
                    mt[0] = seed >>> 0;
                    for (let i = 1; i < 624; i++) {
                        const prev = mt[i - 1] ^ (mt[i - 1] >>> 30);
                        mt[i] = (Math.imul(1812433253, prev) + i) >>> 0;
                    }
                    const gen = () => {
                        if (idx >= 624) {
                            for (let i = 0; i < 624; i++) {
                                const y = (mt[i] & 0x80000000) | (mt[(i + 1) % 624] & 0x7fffffff);
                                mt[i] = mt[(i + 397) % 624] ^ (y >>> 1) ^ ((y & 1) ? 0x9908b0df : 0);
                            }
                            idx = 0;
                        }
                        let y = mt[idx++];
                        y ^= y >>> 11;
                        y ^= (y << 7) & 0x9d2c5680;
                        y ^= (y << 15) & 0xefc60000;
                        y ^= y >>> 18;
                        return y >>> 0;
                    };
                    next = () => gen() / 4294967296;
                    break;
                }
                default:
                    return null;
            }
            return n => Math.floor(next() * n);
        }

        /* -------------------------------------------------------------- */
        /* Extraction de séquence                                          */
        /* -------------------------------------------------------------- */

        function sequence(all, game) {
            const sorted = all.filter(o => o.game === game).sort((a, b) => a.ts - b.ts);
            const out = [];
            for (const o of sorted) {
                if (game === "wheel") {
                    if (Number.isInteger(o.detail?.number)) out.push({ v: o.detail.number, ts: o.ts, id: o.id });
                } else if (game === "luckyblock") {
                    const i = LUCKY.indexOf(o.detail?.category);
                    if (i >= 0) out.push({ v: i, ts: o.ts, id: o.id });
                } else if (game === "mines") {
                    const m = (o.detail?.multipliers || [])[0];
                    if (Number.isFinite(m)) out.push({ v: Math.round(m * 100), ts: o.ts, id: o.id });
                }
            }
            return out;
        }

        const modOf = game => game === "wheel" ? 37 : game === "luckyblock" ? 7 : 100;

        async function bruteForce({ game, prng, windowMs, unit, offset, seq, onProgress }) {
            const mod = modOf(game);
            const first = seq[0];
            const factor = unit === "s" ? 1000 : unit === "min" ? 60000 : 1;
            // La seed est exprimée dans l'unité choisie : ms, secondes ou minutes.
            const base = Math.floor(first.ts / factor);
            const span = Math.max(unit === "ms" ? 0 : 1, Math.round(windowMs / factor));
            const start = base - span;
            const end = base + span;
            const target = seq.slice(0, 6).map(s => s.v);
            if (!makeGen(prng, 0)) return { tested: 0, hits: [] };
            const totalSeeds = end - start + 1;
            if (totalSeeds > 400000 && !confirm(`Cette recherche va tester ${totalSeeds.toLocaleString()} seeds (${prng}). Cela peut prendre plusieurs minutes et figer l'onglet par moments. Continuer ?`)) {
                return { tested: 0, hits: [], aborted: true };
            }

            const hits = [];
            let tested = 0;
            const startedAt = performance.now();

            for (let seed = start; seed <= end; seed++) {
                const next = makeGen(prng, seed);
                let ok = true;
                for (let k = 0; k < offset; k++) next(mod);
                for (let k = 0; k < target.length; k++) {
                    if (next(mod) !== target[k]) { ok = false; break; }
                }
                tested++;
                if (ok) hits.push(seed);
                if ((tested & 16383) === 0) {
                    onProgress?.({ tested, total: end - start + 1, hits: hits.length, elapsed: performance.now() - startedAt });
                    await new Promise(r => setTimeout(r, 0));
                    if (hits.length > 40) break;
                }
            }
            onProgress?.({ tested, total: end - start + 1, hits: hits.length, elapsed: performance.now() - startedAt });
            return { tested, hits, mod, target };
        }

        /* -------------------------------------------------------------- */
        /* Onglet Seed                                                     */
        /* -------------------------------------------------------------- */

        function renderSeed(all) {
            const wrap = h("div");
            const available = [...new Set(all.map(o => o.game))]
                .filter(g => (g === "wheel" || g === "luckyblock") && sequence(all, g).length >= 4);

            if (!available.length) {
                return h("div", { class: "bl-muted", text: "Il faut au moins 4 issues numériques (wheel ou luckyblock) pour tenter une récupération de seed." });
            }

            let game = available.includes("wheel") ? "wheel" : available[0];
            let prng = "mulberry32";
            let windowMs = 5000;
            let unit = "ms";
            let offset = 0;

            const seqInfo = h("div", { class: "bl-muted", text: "" });
            const progress = h("div", { class: "bl-muted", text: "Prêt." });
            const results = h("div");
            const predictBox = h("div");

            const refreshSeqInfo = () => {
                const seq = sequence(all, game);
                seqInfo.textContent = `${seq.length} valeurs · mod ${modOf(game)} · première : ${seq[0] ? new Date(seq[0].ts).toLocaleString() : "—"}`;
            };

            const gameSel = h("select", { class: "bl-select" });
            for (const g of available) {
                const opt = h("option", { value: g, text: `${g} (${sequence(all, g).length} valeurs)` });
                if (g === game) opt.selected = true;
                gameSel.appendChild(opt);
            }
            gameSel.addEventListener("change", () => { game = gameSel.value; refreshSeqInfo(); });

            const prngSel = h("select", { class: "bl-select" });
            for (const [v, l] of prngList) prngSel.appendChild(h("option", { value: v, text: l }));
            prngSel.addEventListener("change", () => { prng = prngSel.value; });

            const unitSel = h("select", { class: "bl-select" },
                h("option", { value: "ms", text: "milliseconde" }),
                h("option", { value: "s", text: "seconde" }),
                h("option", { value: "min", text: "minute" })
            );
            unitSel.addEventListener("change", () => { unit = unitSel.value; });

            const winInput = h("input", { class: "bl-input", type: "number", value: 5000, min: 0, max: 86400000 });
            winInput.addEventListener("change", () => { windowMs = Math.max(0, Number(winInput.value) || 0); });

            const offInput = h("input", { class: "bl-input", type: "number", value: 0, min: 0, max: 50 });
            offInput.addEventListener("change", () => { offset = Math.max(0, Math.min(50, Number(offInput.value) || 0)); });

            const sweepBtn = h("button", { class: "bl-btn bl-sec", text: "Tester les 9 familles" });
            sweepBtn.addEventListener("click", async () => {
                const seq = sequence(all, game);
                if (seq.length < 4) { toast("Pas assez de valeurs", "warn"); return; }
                sweepBtn.disabled = true;
                results.textContent = "";
                progress.textContent = "Balayage des familles…";
                const found = [];
                for (const [name, label] of prngList) {
                    progress.textContent = `Test ${label}…`;
                    const res = await bruteForce({
                        game, prng: name, windowMs: Math.min(windowMs, 12000), unit, offset, seq,
                        onProgress: p => { progress.textContent = `${label} : ${p.tested.toLocaleString()} seeds · ${p.hits} hit(s)`; }
                    });
                    if (res.hits?.length) found.push({ name, label, seeds: res.hits.slice(0, 5) });
                    await new Promise(r => setTimeout(r, 0));
                }
                results.textContent = "";
                if (!found.length) {
                    progress.textContent = "Aucune famille ne reproduit la séquence.";
                    results.appendChild(card("Balayage terminé",
                        h("div", { class: "bl-muted", text: "Les 9 familles ont été éliminées sur cette fenêtre. Cela ne prouve pas que la RNG est sûre : cela prouve qu'elle n'est pas un PRNG faible seedé sur l'horloge dans cette fenêtre." })
                    ));
                } else {
                    progress.textContent = `${found.length} famille(s) candidate(s).`;
                    for (const f of found) {
                        results.appendChild(card(`Candidat · ${f.label}`,
                            h("div", { class: "bl-code", text: f.seeds.map(String).join("\n") }),
                            h("div", { class: "bl-muted", text: "Confirme avec de nouvelles sorties avant d'utiliser le prédicteur." })
                        ));
                    }
                }
                sweepBtn.disabled = false;
            });

            const searchBtn = h("button", { class: "bl-btn", text: "Chercher la seed" });
            searchBtn.addEventListener("click", async () => {
                const seq = sequence(all, game);
                if (seq.length < 4) { toast("Pas assez de valeurs", "warn"); return; }
                searchBtn.disabled = true;
                results.textContent = "";
                predictBox.textContent = "";
                const t0 = performance.now();
                try {
                    const res = await bruteForce({
                        game, prng, windowMs, unit, offset, seq,
                        onProgress: p => {
                            progress.textContent = `${p.tested.toLocaleString()} seeds testées · ${p.hits} candidat(s) · ${(p.elapsed / 1000).toFixed(1)} s`;
                        }
                    });
                    const dt = ((performance.now() - t0) / 1000).toFixed(1);
                    if (res.aborted) { progress.textContent = "Recherche annulée."; return; }
                    if (!res.hits.length) {
                        results.appendChild(card("Aucun candidat",
                            kv("Seeds testées", res.tested.toLocaleString()),
                            kv("Famille", prngList.find(x => x[0] === prng)?.[1] || prng),
                            kv("Durée", dt + " s"),
                            h("div", { class: "bl-muted", text: "Ce n'est pas une preuve d'absence de faille : cela élimine seulement une seed temporelle directe sur cette famille et cette fenêtre. Élargis la fenêtre, change d'unité, ou teste l'offset (tirages consommés avant l'issue)." })
                        ));
                        return;
                    }
                    progress.textContent = `${res.hits.length} candidat(s) en ${dt} s`;
                    const list = h("div");
                    for (const seed of res.hits.slice(0, 20)) {
                        const row = h("div", { class: "bl-row" },
                            h("code", { class: "bl-code", text: String(seed) }),
                            h("span", { class: "bl-muted", text: new Date(seed).toISOString() }),
                            h("span", { class: "bl-spacer" }),
                            h("button", {
                                class: "bl-btn", text: "Vérifier",
                                onclick: () => {
                                    const next = makeGen(prng, seed);
                                    let ok = 0;
                                    for (let k = 0; k < offset; k++) next(res.mod);
                                    for (const s of seq) if (next(res.mod) === s.v) ok++;
                                    toast(`Seed ${seed} : ${ok}/${seq.length} valeurs reproduites`, ok === seq.length ? "success" : "warn");
                                }
                            }),
                            h("button", {
                                class: "bl-btn bl-sec", text: "Prédire",
                                onclick: () => {
                                    predictor = { game, prng, seed, offset, consumed: seq.length, mod: res.mod, hits: 0, tries: 0 };
                                    renderPredict();
                                    toast("Prédicteur armé : les prochaines sorties seront comparées.", "info");
                                }
                            })
                        );
                        list.appendChild(row);
                    }
                    results.appendChild(card("Candidats trouvés",
                        list,
                        h("div", { class: "bl-muted", text: "Un candidat sur une fenêtre de plusieurs milliers de seeds peut être un faux positif. Confirme-le avec 3-4 nouvelles sorties avant d'en tirer quoi que ce soit." })
                    ));
                } finally {
                    searchBtn.disabled = false;
                }
            });

            function renderPredict() {
                predictBox.textContent = "";
                if (!predictor) return;
                const p = predictor;
                const nextVals = [];
                const next = makeGen(p.prng, p.seed);
                for (let k = 0; k < p.offset + p.consumed; k++) next(p.mod);
                for (let k = 0; k < 5; k++) nextVals.push(next(p.mod));
                predictBox.appendChild(card("Prédiction en direct",
                    kv("Modèle", `${p.prng} · seed ${p.seed}`),
                    kv("Déjà consommé", p.consumed),
                    kv("Prochaines valeurs", nextVals.join(" · ")),
                    kv("Score", `${p.hits}/${p.tries}`),
                    h("button", {
                        class: "bl-btn bl-sec", text: "Désarmer",
                        onclick: () => { predictor = null; predictBox.textContent = ""; }
                    })
                ));
            }

            refreshSeqInfo();
            renderPredict();

            // test rapide de seed = timestamp exact
            wrap.append(
                card("Récupération de seed",
                    h("div", { class: "bl-muted", text: "Hypothèse testée : le bot initialise son générateur avec l'horloge (Date.now, secondes, minutes) au moment du tirage. On rejoue chaque seed candidate et on compare la séquence observée." }),
                    h("label", { class: "bl-col" }, h("span", { class: "bl-label", text: "Jeu" }), gameSel),
                    h("label", { class: "bl-col" }, h("span", { class: "bl-label", text: "Famille de PRNG" }), prngSel),
                    h("label", { class: "bl-col" }, h("span", { class: "bl-label", text: "Unité de seed" }), unitSel),
                    h("label", { class: "bl-col" }, h("span", { class: "bl-label", text: "Fenêtre autour de la première observation (±)" }), winInput),
                    h("label", { class: "bl-col" }, h("span", { class: "bl-label", text: "Tirages consommés avant l'issue (offset)" }), offInput),
                    seqInfo,
                    h("div", { class: "bl-row" }, searchBtn, sweepBtn),
                    progress,
                    results,
                    predictBox
                )
            );
            return wrap;
        }

        lab.on("obs", o => {
            if (!predictor || o.game !== predictor.game) return;
            const v = predictor.game === "wheel" ? o.detail?.number : LUCKY.indexOf(o.detail?.category);
            if (!Number.isInteger(v)) return;
            const next = makeGen(predictor.prng, predictor.seed);
            for (let k = 0; k < predictor.offset + predictor.consumed; k++) next(predictor.mod);
            const predicted = next(predictor.mod);
            predictor.consumed++;
            predictor.tries++;
            if (predicted === v) predictor.hits++;
            toast(`Prédiction ${predicted} / réel ${v} — ${predicted === v ? "HIT" : "miss"} (${predictor.hits}/${predictor.tries})`,
                predicted === v ? "success" : "warn");
        });

        /* -------------------------------------------------------------- */
        /* Onglet                                                          */
        /* -------------------------------------------------------------- */

        lab.ui.tab({
            id: "rng", title: "RNG",
            render: async () => {
                const all = await data();
                const wrap = h("div");
                const btn = h("button", { class: "bl-btn bl-sec", text: "Rafraîchir les données" });
                btn.addEventListener("click", () => { cache.at = 0; lab.ui.refresh("rng"); });
                wrap.append(h("div", { class: "bl-row" }, btn, h("span", { class: "bl-muted", text: `${all.length} observations` })));

                const sub = h("div", { class: "bl-tabs", style: { padding: "0", background: "transparent", margin: "4px 0 8px" } });
                const body = h("div");
                const views = [
                    ["Vue d'ensemble", () => renderStats(all)],
                    ["Biais", () => renderBias(all)],
                    ["Séquences", () => renderSeq(all)],
                    ["Seed", () => renderSeed(all)]
                ];
                let active = 0;
                const show = i => {
                    active = i;
                    [...sub.children].forEach((b, j) => b.classList.toggle("bl-on", j === i));
                    body.textContent = "";
                    body.appendChild(views[i][1]());
                };
                views.forEach(([name], i) => sub.appendChild(h("button", {
                    class: "bl-tab" + (i === 0 ? " bl-on" : ""), text: name, onclick: () => show(i)
                })));
                wrap.append(sub, body);
                show(active);
                return wrap;
            }
        });

        console.info("[BlockyLab] RNG lab prêt");
    }

    boot();
})();
