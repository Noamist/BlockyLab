// ==UserScript==
// @name         Blocky Lab · 01 · Collecteur / Recon
// @namespace    blocky-lab
// @version      1.2.0
// @description  Collecte en masse les messages de Blocky (live + historique), normalise les résultats et expose la reconnaissance du bot (IDs, latence, boutons, schémas d'embeds).
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
    const h = (t, p, ...k) => (W.BlockyLab ? W.BlockyLab.h(t, p, ...k) : null);

    async function boot() {
        for (let i = 0; i < 200 && !W.BlockyLab; i++) await new Promise(r => setTimeout(r, 100));
        const lab = W.BlockyLab;
        if (!lab) { console.warn("[BlockyLab] collecteur : noyau absent"); return; }
        if (W.__blockyCollectorLoaded) return;
        W.__blockyCollectorLoaded = true;

        const { settings, saveSettings, toast, h: el } = lab;
        const recent = [];
        let live = { messages: 0, game: 0, last: null };
        let countEl = null;
        let summaryEl = null;
        let tableEl = null;
        let scanEl = null;
        let lastScan = null;

        /* -------------------------------------------------------------- */
        /* Réglages                                                        */
        /* -------------------------------------------------------------- */

        function bindField(label, key, opts = {}) {
            const input = el("input", {
                class: "bl-input",
                type: opts.type || "text",
                value: Array.isArray(settings[key]) ? settings[key].join(",") : (settings[key] ?? ""),
                placeholder: opts.placeholder || ""
            });
            input.addEventListener("change", () => {
                if (opts.array) settings[key] = input.value.split(",").map(x => x.trim()).filter(Boolean);
                else if (opts.number) settings[key] = lab.clamp(input.value, opts.min ?? 0, opts.max ?? 1e9, settings[key]);
                else settings[key] = input.value.trim();
                input.value = Array.isArray(settings[key]) ? settings[key].join(",") : settings[key];
                saveSettings();
            });
            return el("label", { class: "bl-col" }, el("span", { class: "bl-label", text: label }), input);
        }

        function toggle(label, key, after) {
            const cb = el("input", { type: "checkbox" });
            cb.checked = Boolean(settings[key]);
            cb.addEventListener("change", () => {
                settings[key] = cb.checked;
                saveSettings();
                after?.(cb.checked);
            });
            return el("label", { class: "bl-row" }, cb, el("span", { text: label }));
        }

        /* -------------------------------------------------------------- */
        /* Onglet Collecte                                                 */
        /* -------------------------------------------------------------- */

        const LABEL_TEXT = { win: "gain", loss: "perte", push: "retour", ignored: "ignoré" };

        function netOf(o) {
            if (!o || !o.label) return 0;
            const bet = Number(o.detail?.bet ?? o.detail?.amounts?.[0] ?? 0);
            if (!Number.isFinite(bet) || bet <= 0) return 0;
            if (o.label === "win") return bet;
            if (o.label === "loss") return -bet;
            return 0;
        }

        function reclassifyAll() {
            return lab.idb.all().then(async all => {
                let changed = 0;
                for (const o of all) {
                    if (o.manual) continue;
                    const before = `${o.game}|${o.label}`;
                    lab.analyze.reclassify(o);
                    if (`${o.game}|${o.label}` !== before) changed++;
                }
                await lab.idb.put(all);
                recent.length = 0;
                recent.push(...all.sort((a, b) => a.ts - b.ts).slice(-400));
                rebuildTable();
                if (countEl) {
                    const labelled = recent.filter(o => o.label === "win" || o.label === "loss" || o.label === "push");
                    countEl.textContent = `${all.length} observations en base · ${recent.length} en mémoire · ${labelled.length} classées`;
                }
                return { total: all.length, changed };
            });
        }

        function renderCollect() {
            const wrap = el("div");
            countEl = el("div", { class: "bl-muted", text: "—" });
            summaryEl = el("div");

            const refreshCount = async () => {
                const n = await lab.idb.count();
                const byGame = {};
                for (const o of recent) byGame[o.game] = (byGame[o.game] || 0) + 1;
                countEl.textContent = `${n} observations en base · ${recent.length} en mémoire · ${live.messages} messages vus` +
                    (live.last ? ` · dernier : ${live.last.game}/${live.last.label || "?"}` : "");
                if (summaryEl) {
                    const labelled = recent.filter(o => o.label === "win" || o.label === "loss" || o.label === "push");
                    const wins = labelled.filter(o => o.label === "win").length;
                    const losses = labelled.filter(o => o.label === "loss").length;
                    const refunds = labelled.filter(o => o.label === "push").length;
                    const net = recent.reduce((s, o) => s + netOf(o), 0);
                    summaryEl.textContent = "";
                    summaryEl.append(
                        el("div", { class: "bl-kv" }, el("span", { text: "Gains / pertes / retours" }), el("b", { text: `${wins} / ${losses} / ${refunds}` })),
                        el("div", { class: "bl-kv" }, el("span", { text: "Net connu (mises lues)" }), el("b", { class: net > 0 ? "bl-good" : net < 0 ? "bl-bad" : "", text: (net > 0 ? "+" : "") + net })),
                        el("div", { class: "bl-kv" }, el("span", { text: "Auto-classés" }), el("b", { text: `${recent.filter(o => o.autoLabel).length} / ${recent.length}` }))
                    );
                }
            };

            const backfillBtn = el("button", { class: "bl-btn", text: "Récupérer l'historique" });
            backfillBtn.addEventListener("click", async () => {
                backfillBtn.disabled = true;
                backfillBtn.textContent = "Récupération…";
                try {
                    const res = await lab.scanChannel({
                        max: settings.historyLimit,
                        onProgress: (n, total) => { backfillBtn.textContent = `${n}/${total}…`; }
                    });
                    lastScan = { ...res, at: Date.now() };
                    if (scanEl) scanEl.textContent = `Dernier scan : ${res.scanned} messages lus · ${res.kept} conservés · G ${res.labels?.win || 0} / P ${res.labels?.loss || 0} / R ${res.labels?.push || 0}`;
                    toast(`Historique : ${res.scanned} messages lus, ${res.kept} conservés`, "success");
                } catch (e) {
                    toast("Échec historique : " + e.message, "error");
                }
                backfillBtn.disabled = false;
                backfillBtn.textContent = "Récupérer l'historique";
                refreshCount();
                rebuildTable();
            });

            // Scan complet : DOM + MessageStore + historique, puis reclassement.
            const scanBtn = el("button", { class: "bl-btn", text: "Scan complet + classement auto" });
            scanBtn.addEventListener("click", async () => {
                scanBtn.disabled = true;
                const old = scanBtn.textContent;
                scanBtn.textContent = "Scan en cours…";
                try {
                    const res = await lab.scanChannel({
                        max: settings.historyLimit,
                        onProgress: (n, total) => { scanBtn.textContent = `${n}/${total}…`; }
                    });
                    lastScan = { ...res, at: Date.now() };
                    const re = await reclassifyAll();
                    await refreshCount();
                    if (scanEl) {
                        scanEl.textContent = `Dernier scan : ${res.scanned} messages lus · ${res.kept} conservés · G ${res.labels?.win || 0} / P ${res.labels?.loss || 0} / R ${res.labels?.push || 0}`;
                    }
                    toast(`Scan : ${res.scanned} lus, ${res.kept} analysés · ${re.changed} reclassés`, res.scanned ? "success" : "warn");
                } catch (e) {
                    toast("Scan impossible : " + e.message, "error");
                }
                scanBtn.disabled = false;
                scanBtn.textContent = old;
            });

            scanEl = el("div", { class: "bl-muted", text: "Aucun scan complet pour l'instant." });

            const exportBtn = el("button", { class: "bl-btn bl-sec", text: "Exporter JSON" });
            exportBtn.addEventListener("click", async () => {
                const all = await lab.idb.all();
                lab.export.observations(all.sort((a, b) => a.ts - b.ts), "blocky-observations");
                toast(`${all.length} observations exportées`, "success");
            });

            const csvBtn = el("button", { class: "bl-btn bl-sec", text: "Exporter CSV" });
            csvBtn.addEventListener("click", async () => {
                const all = await lab.idb.all();
                const rows = all.map(o => ({
                    id: o.id, iso: o.iso, game: o.game, label: o.label,
                    category: o.detail?.category || "", number: o.detail?.number ?? "",
                    color: o.detail?.color || "", timestamp: o.ts,
                    worker: o.snowflake?.worker ?? "", process: o.snowflake?.process ?? "",
                    increment: o.snowflake?.increment ?? "", text: (o.text || "").replace(/\s+/g, " ").slice(0, 200)
                }));
                lab.export.download(`blocky-observations-${Date.now()}.csv`, lab.export.csv(rows), "text/csv");
            });

            const clearBtn = el("button", { class: "bl-btn bl-danger", text: "Vider la base" });
            clearBtn.addEventListener("click", async () => {
                if (!confirm("Effacer toutes les observations Blocky Lab ?")) return;
                await lab.idb.clear();
                recent.length = 0;
                refreshCount();
                rebuildTable();
                toast("Base vidée", "success");
            });

            tableEl = el("div");

            wrap.append(
                el("div", { class: "bl-card" },
                    el("div", { class: "bl-row" }, el("b", { text: "Collecte en direct" }), el("span", { class: "bl-spacer" })),
                    el("div", { class: "bl-muted", text: "Le collecteur écoute tous les messages du salon en cours et normalise chaque embed : jeu, résultat, catégorie, numéro, cartes, montants." }),
                    countEl,
                    summaryEl,
                    scanEl,
                    el("div", { class: "bl-row" },
                        scanBtn,
                        el("button", {
                            class: "bl-btn bl-sec", text: "Scanner seulement l'écran",
                            onclick: () => {
                                lab.rescan(true);
                                toast("Messages affichés relancés", "info");
                                setTimeout(refreshCount, 800);
                            }
                        }),
                        el("button", {
                            class: "bl-btn bl-sec", text: "Reclasser tout",
                            onclick: async e => {
                                e.target.disabled = true;
                                try {
                                    const r = await reclassifyAll();
                                    refreshCount();
                                    toast(`${r.total} observations vérifiées · ${r.changed} corrigée(s)`, "success");
                                } catch (err) { toast("Reclassement : " + err.message, "error"); }
                                e.target.disabled = false;
                            }
                        })
                    )
                ),
                el("div", { class: "bl-card" },
                    el("b", { text: "Salon & bot" }),
                    bindField("ID du salon (vide = salon ouvert)", "channelId", { placeholder: "ex. 1559563030549762098" }),
                    bindField("IDs des bots, séparés par des virgules (vide = tout bot)", "botIds", { array: true, placeholder: "1472309546633531472" }),
                    toggle("Capturer aussi les messages non reconnus", "captureAll"),
                    toggle("Stocker le JSON brut des embeds (volumineux)", "storeRaw"),
                    toggle("Envoyer au serveur d'analyse local", "ingest"),
                    bindField("URL d'ingestion", "ingestUrl"),
                    toggle("Journal debug (console)", "debug")
                ),
                el("div", { class: "bl-card" },
                    el("b", { text: "Historique" }),
                    bindField("Nombre de messages à remonter", "historyLimit", { number: true, min: 50, max: 20000 }),
                    el("div", { class: "bl-row" }, backfillBtn),
                    el("div", { class: "bl-muted", text: "Le scan lit le DOM, le MessageStore et fetchMessages du client : aucun token, aucune requête forgée. Les résultats sont reclassés automatiquement en gain / perte / retour." })
                ),
                el("div", { class: "bl-card" },
                    el("b", { text: "Données" }),
                    el("div", { class: "bl-row" }, exportBtn, csvBtn, clearBtn)
                ),
                el("div", { class: "bl-card" },
                    el("b", { text: "Dernières observations" }),
                    el("div", { class: "bl-muted", style: { fontSize: "10px" }, text: "Le classement automatique utilise les mots-clés du résultat (You win / Dealer wins / bet back), les catégories Lucky Block et les montants lus. Les boutons G / P / ∅ forcent un classement manuel." }),
                    tableEl
                )
            );

            refreshCount();
            rebuildTable();
            return wrap;
        }

        function rebuildTable() {
            if (!tableEl) return;
            tableEl.textContent = "";
            const rows = recent.slice(-25).reverse();
            if (!rows.length) {
                tableEl.appendChild(el("div", { class: "bl-muted", text: "Aucune observation pour l'instant." }));
                return;
            }
            const table = el("table", { class: "bl-table" },
                el("thead", null, el("tr", null,
                    el("th", { text: "Heure" }), el("th", { text: "Jeu" }), el("th", { text: "Résultat" }),
                    el("th", { text: "Détail" }), el("th", { text: "Source" }), el("th", { text: "Corriger" })
                ))
            );
            const body = el("tbody");
            for (const o of rows) {
                const detail = o.detail?.category
                    || (o.detail?.number !== undefined && o.detail?.number !== null ? `n°${o.detail.number} ${o.detail.color || ""}` : "")
                    || (o.detail?.bet ? `mise ${o.detail.bet}` : "")
                    || "";
                const fix = label => {
                    o.label = label;
                    o.manual = true;
                    o.labelledAt = new Date().toISOString();
                    lab.idb.put(o).catch(() => { });
                    rebuildTable();
                    toast(`Observation ${o.id.slice(-6)} → ${label}`, "success");
                };
                body.appendChild(el("tr", null,
                    el("td", { text: new Date(o.ts).toLocaleTimeString() }),
                    el("td", { text: o.game }),
                    el("td", { class: o.label === "win" ? "bl-good" : o.label === "loss" ? "bl-bad" : o.label === "push" ? "bl-warn" : "bl-muted" },
                        el("span", { text: LABEL_TEXT[o.label] || o.label || "—" }),
                        o.autoLabel ? el("span", { class: "bl-badge", style: { marginLeft: "4px" }, text: "auto", title: "Classement automatique" }) : null
                    ),
                    el("td", { text: detail }),
                    el("td", { class: "bl-muted", text: o.source }),
                    el("td", null,
                        el("button", { class: "bl-btn", text: "G", title: "Marquer gain", style: { padding: "2px 6px" }, onclick: () => fix("win") }),
                        el("button", { class: "bl-btn bl-danger", text: "P", title: "Marquer perte", style: { padding: "2px 6px" }, onclick: () => fix("loss") }),
                        el("button", { class: "bl-btn bl-sec", text: "∅", title: "Ignorer", style: { padding: "2px 6px" }, onclick: () => fix("ignored") })
                    )
                ));
            }
            table.appendChild(body);
            tableEl.appendChild(table);
        }

        /* -------------------------------------------------------------- */
        /* Onglet Recon                                                    */
        /* -------------------------------------------------------------- */

        function bar(value, max) {
            return el("div", { class: "bl-bar" },
                el("i", { style: { width: `${max ? Math.round((value / max) * 100) : 0}%` } })
            );
        }

        async function renderRecon() {
            const wrap = el("div");
            const all = await lab.idb.all();
            const botMsgs = all.filter(o => o.game !== "unknown" || o.buttons?.length);

            const games = {};
            const labels = {};
            const workers = {};
            const processes = {};
            const increments = [];
            const customIds = {};
            const fieldsByGame = {};
            const commandHits = {};

            for (const o of all) {
                games[o.game] = (games[o.game] || 0) + 1;
                if (o.label) labels[`${o.game}:${o.label}`] = (labels[`${o.game}:${o.label}`] || 0) + 1;
                if (o.snowflake) {
                    workers[o.snowflake.worker] = (workers[o.snowflake.worker] || 0) + 1;
                    processes[o.snowflake.process] = (processes[o.snowflake.process] || 0) + 1;
                    increments.push(o.snowflake.increment);
                }
                for (const b of o.buttons || []) {
                    if (!b.customId) continue;
                    const key = b.customId.replace(/\d{3,}/g, "{n}");
                    customIds[key] = (customIds[key] || 0) + 1;
                }
                const t = o.text || "";
                for (const m of t.matchAll(/\/([a-z][a-z_0-9]{2,30})/g)) {
                    commandHits[m[1]] = (commandHits[m[1]] || 0) + 1;
                }
                if (o.game !== "unknown") {
                    fieldsByGame[o.game] = fieldsByGame[o.game] || new Set();
                    for (const line of t.split("\n")) {
                        const name = line.split(":")[0].trim();
                        if (name && name.length < 40 && !/^\d/.test(name)) fieldsByGame[o.game].add(name);
                    }
                }
            }

            const sorted = obj => Object.entries(obj).sort((a, b) => b[1] - a[1]);
            const maxGame = Math.max(1, ...Object.values(games));
            const maxWorker = Math.max(1, ...Object.values(workers));

            const top = sorted(games).slice(0, 8);

            wrap.append(
                el("div", { class: "bl-card" },
                    el("b", { text: "Volume capturé" }),
                    el("div", { class: "bl-kv" }, el("span", { text: "Observations" }), el("b", { text: all.length })),
                    el("div", { class: "bl-kv" }, el("span", { text: "Messages avec boutons" }), el("b", { text: botMsgs.filter(o => o.buttons?.length).length })),
                    el("div", { class: "bl-kv" }, el("span", { text: "Custom IDs distincts" }), el("b", { text: Object.keys(customIds).length })),
                    el("div", { class: "bl-kv" }, el("span", { text: "Commandes citées" }), el("b", { text: Object.keys(commandHits).length }))
                ),
                el("div", { class: "bl-card" },
                    el("b", { text: "Répartition par jeu" }),
                    ...top.flatMap(([g, n]) => [
                        el("div", { class: "bl-row" }, el("span", { text: g }), el("span", { class: "bl-spacer" }), el("b", { text: n })),
                        bar(n, maxGame)
                    ])
                ),
                el("div", { class: "bl-card" },
                    el("b", { text: "Snowflakes (canal d'information)" }),
                    el("div", { class: "bl-muted", text: "Les IDs de messages exposent un compteur d'incrément et l'ID du process Discord. Un incrément régulier permet de dater précisément les événements et de vérifier une seed temporelle." }),
                    ...sorted(workers).slice(0, 6).flatMap(([w, n]) => [
                        el("div", { class: "bl-row" }, el("span", { text: "worker " + w }), el("span", { class: "bl-spacer" }), el("b", { text: n })),
                        bar(n, maxWorker)
                    ]),
                    el("div", { class: "bl-kv" }, el("span", { text: "process IDs" }), el("b", { text: sorted(processes).map(([p, n]) => `${p}×${n}`).join(" ") }))
                ),
                el("div", { class: "bl-card" },
                    el("b", { text: "Boutons / custom_id" }),
                    el("div", { class: "bl-muted", text: "Un custom_id qui contient un identifiant de session, de joueur ou de partie est rejouable. Les IDs dupliqués sont normaux (boutons statiques) ; les IDs uniques sont à inspecter." }),
                    ...sorted(customIds).slice(0, 12).map(([id, n]) =>
                        el("div", { class: "bl-kv" }, el("span", { class: "bl-code", text: id }), el("b", { text: `${n}×` }))
                    )
                ),
                el("div", { class: "bl-card" },
                    el("b", { text: "Commandes observées" }),
                    el("div", { class: "bl-chips" },
                        ...sorted(commandHits).slice(0, 60).map(([c, n]) =>
                            el("span", { class: "bl-chip", style: { width: "auto", padding: "0 5px", background: "#4e5058" }, text: `/${c} ${n}` })
                        )
                    )
                ),
                el("div", { class: "bl-card" },
                    el("b", { text: "Champs d'embeds par jeu" }),
                    ...Object.entries(fieldsByGame).map(([g, set]) =>
                        el("div", { class: "bl-col" },
                            el("span", { class: "bl-label", text: g }),
                            el("div", { class: "bl-code", text: [...set].slice(0, 30).join(" · ") })
                        )
                    )
                ),
                el("div", { class: "bl-card" },
                    el("b", { text: "Diagnostic du noyau" }),
                    el("div", { class: "bl-code", text: JSON.stringify(lab.diagnostics(), null, 2) })
                )
            );
            return wrap;
        }

        /* -------------------------------------------------------------- */
        /* Enregistrement des onglets                                      */
        /* -------------------------------------------------------------- */

        lab.ui.tab({ id: "collect", title: "Collecte", render: renderCollect });
        lab.ui.tab({ id: "recon", title: "Recon", render: renderRecon });

        /* -------------------------------------------------------------- */
        /* Écoute live                                                     */
        /* -------------------------------------------------------------- */

        lab.on("obs", o => {
            live.messages++;
            if (o.game !== "unknown") live.game++;
            live.last = o;
            recent.push(o);
            if (recent.length > 400) recent.splice(0, recent.length - 400);
            if (countEl) countEl.textContent = `${recent.length} capturés · dernier : ${o.game}/${o.label || "?"}`;
            if (tableEl && recent.length % 3 === 0) rebuildTable();
        });

        lab.on("net", r => {
            if (!r.ok) lab.debug("ingestion locale échouée", r.count);
        });

        // Recharge les dernières observations de la base et scanne les messages déjà affichés.
        lab.idb.all().then(async all => {
            // Les anciennes observations ont pu être classées avec l'ancien
            // parseur : on les repasse toutes dans le classifieur courant.
            for (const o of all) if (!o.manual) lab.analyze.reclassify(o);
            all.sort((a, b) => a.ts - b.ts);
            await lab.idb.put(all).catch(() => { });
            recent.length = 0;
            recent.push(...all.slice(-200));
            const last = recent[recent.length - 1];
            if (last) { live.last = last; live.messages = recent.length; }
            rebuildTable();
            if (countEl) countEl.textContent = `${recent.length} observations chargées`;
        }).catch(() => { /* base vide */ });
        setTimeout(() => lab.rescan(false), 600);

        console.info("[BlockyLab] collecteur prêt");
    }

    boot();
})();
