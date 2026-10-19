// ==UserScript==
// @name         Blocky Lab · 05 · Pilote
// @namespace    blocky-lab
// @version      1.2.0
// @description  Automatisation contrôlée de Blocky : minage, daily, vente, dummy, boss, drops. Planificateur avec jitter, mode simulation, limites et journal.
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

    const DEFAULTS = {
        dryRun: true,
        enabled: false,
        maxActions: 500,
        maxMinutes: 60,
        pauseMs: 700,
        mine: false, mineEvery: 16,
        daily: false, dailyEvery: 3600,
        sell: false, sellEvery: 900,
        dummy: false, dummyEvery: 90,
        boss: false, bossEvery: 65,
        drops: true,
        dropChannelId: "1557793570243477524",
        dropOnlyButton: true,
        // Le clic nécessite que Discord rende le message : on ouvre le salon
        // de drops quand un drop arrive. Désactivable si tu veux rester sur
        // ton salon courant.
        dropFocus: true,
        // Les commandes peuvent rester en simulation sans empêcher le sniper
        // de cliquer réellement les drops. Active cette option pour tester les
        // drops sans les réclamer.
        dropDryRun: false,
        settingsVersion: 3,
        dropMaxAgeSec: 120,
        wheel: false, wheelEvery: 30, wheelBet: "Redstone", wheelAmount: 10,
        lucky: false, luckyEvery: 30, luckyAmount: 10,
        sniperDelay: 220
    };

    const MINE_LINES = [
        "⛏️", "mining", "gg", "encore un bloc", "let's mine", "🪨", "allez", "on creuse",
        "back to the mines", "⛏", "hop", "et un de plus", "minage", "🥶", "yes"
    ];

    async function boot() {
        for (let i = 0; i < 200 && !W.BlockyLab; i++) await new Promise(r => setTimeout(r, 100));
        const lab = W.BlockyLab;
        if (!lab) { console.warn("[BlockyLab] pilote : noyau absent"); return; }
        if (W.__blockyPilotLoaded) return;
        W.__blockyPilotLoaded = true;

        const { h, toast, sleep } = lab;
        const settings = Object.assign({}, DEFAULTS, lab.store.get("pilot.settings", {}) || {});
        const save = () => lab.store.set("pilot.settings", settings);
        // v2 : le sniper ouvre désormais le salon pour pouvoir cliquer l'embed.
        if (!settings.settingsVersion || settings.settingsVersion < 2) {
            settings.dropFocus = true;
            settings.settingsVersion = 3;
            if (typeof settings.dropDryRun !== "boolean") settings.dropDryRun = false;
            save();
        } else if (settings.settingsVersion < 3) {
            settings.settingsVersion = 3;
            if (typeof settings.dropDryRun !== "boolean") settings.dropDryRun = false;
            save();
        }

        const state = {
            startedAt: 0,
            actions: 0,
            errors: 0,
            sent: [],
            clicks: 0,
            lastClickAt: 0,
            lastClickText: "",
            dropDone: new Set(),
            dropSeen: 0,
            dropLast: null,
            dropPollBusy: false,
            busy: false,
            taskAt: {},
            running: false,
            timer: null,
            lastError: ""
        };

        const logEl = h("div", { class: "bl-code", text: "Journal vide." });
        const statusEl = h("div", { class: "bl-muted", text: "Arrêté." });

        function addLog(line) {
            state.sent.unshift(`${new Date().toLocaleTimeString()} · ${line}`);
            if (state.sent.length > 120) state.sent.pop();
            if (logEl) logEl.textContent = state.sent.join("\n") || "Journal vide.";
        }

        /* -------------------------------------------------------------- */
        /* Envoi                                                           */
        /* -------------------------------------------------------------- */

        async function act(cmd, label) {
            if (!state.running) return false;
            if (state.actions >= settings.maxActions) { stop("limite d'actions atteinte"); return false; }
            if (settings.maxMinutes && Date.now() - state.startedAt > settings.maxMinutes * 60000) { stop("durée atteinte"); return false; }
            if (state.busy) return false;
            state.busy = true;
            try {
                if (settings.dryRun) {
                    addLog(`[SIMU] ${label || cmd}`);
                    state.actions++;
                    return true;
                }
                await sleep(250 + Math.random() * 700);
                const ok = await lab.discord.sendText(cmd);
                if (!ok) throw new Error("envoi refusé");
                state.actions++;
                addLog(`${label || ""} ${cmd}`.trim());
                return true;
            } catch (e) {
                state.errors++;
                state.lastError = e.message;
                addLog(`ERREUR ${e.message}`);
                if (state.errors >= 5) stop("trop d'erreurs consécutives");
                return false;
            } finally {
                state.busy = false;
                updateStatus();
            }
        }

        /* -------------------------------------------------------------- */
        /* Tâches                                                          */
        /* -------------------------------------------------------------- */

        const TASKS = [
            {
                key: "mine", label: "Minage (message toutes les X s)",
                run: () => act(MINE_LINES[Math.floor(Math.random() * MINE_LINES.length)], "mine")
            },
            { key: "daily", label: "Daily", run: () => act("/daily", "daily") },
            { key: "sell", label: "Vendre les blocs", run: () => act("/sell", "sell") },
            { key: "dummy", label: "Training dummy", run: () => act("/dummy hit", "dummy") },
            { key: "boss", label: "Attaquer le boss", run: () => act("/attack", "boss") },
            { key: "wheel", label: "Wheel", run: () => act(`/wheel ${settings.wheelBet} ${settings.wheelAmount}`, "wheel") },
            { key: "lucky", label: "Lucky Block", run: () => act(`/luckyblock ${settings.luckyAmount}`, "lucky") }
        ];

        const INTERVAL_KEY = {
            mine: "mineEvery", daily: "dailyEvery", sell: "sellEvery",
            dummy: "dummyEvery", boss: "bossEvery", wheel: "wheelEvery", lucky: "luckyEvery"
        };

        function due(task) {
            if (!settings[task.key]) return false;
            const every = Math.max(5, Number(settings[INTERVAL_KEY[task.key]]) || 30) * 1000;
            const jittered = lab.jitter(every, 12);
            return Date.now() >= (state.taskAt[task.key] || 0) + jittered;
        }

        async function tick() {
            if (!state.running || state.busy) return;
            for (const task of TASKS) {
                if (!due(task)) continue;
                state.taskAt[task.key] = Date.now();
                await task.run();
                break; // une action à la fois
            }
        }

        function start() {
            if (state.running) return;
            if (!settings.dryRun && !confirm("Le pilote va envoyer de vraies commandes à Blocky. Continuer ?")) return;
            state.running = true;
            state.startedAt = Date.now();
            state.actions = 0;
            state.errors = 0;
            state.taskAt = {};
            state.timer = setInterval(tick, 800);
            addLog(settings.dryRun ? "Démarrage en simulation" : "Démarrage réel");
            toast(settings.dryRun ? "Pilote en simulation" : "Pilote actif", "success");
            updateStatus();
        }

        function stop(reason) {
            if (state.timer) clearInterval(state.timer);
            state.timer = null;
            state.running = false;
            addLog("Arrêt" + (reason ? " : " + reason : ""));
            if (reason) toast("Pilote arrêté : " + reason, "warn");
            updateStatus();
        }

        function updateStatus() {
            if (!statusEl) return;
            const mins = state.startedAt ? Math.round((Date.now() - state.startedAt) / 60000) : 0;
            statusEl.textContent = state.running
                ? `Actif · ${state.actions} actions · ${state.errors} erreurs · ${mins} min${settings.dryRun ? " · SIMULATION" : ""}`
                : `Arrêté · ${state.actions} actions · ${state.errors} erreurs${settings.dryRun ? " · simulation" : ""}`;
        }

        /* -------------------------------------------------------------- */
        /* Drop sniper                                                     */
        /* -------------------------------------------------------------- */

        const CLAIM_RE = /\b(?:claim|r[ée]cup[ée]rer|prendre|take|grab|open|ouvrir|click|clique|collect)\b/i;
        const DROP_NOISE = /(reply|r[ée]pondre|reaction|emoji|sticker|gif|more|plus|share|partager|edit|modifier|delete|supprimer|pin|épingler|thread|fil|report|signaler|download|t[ée]l[ée]charger|copy|copier|open in|ouvrir dans|forward|transf[ée]rer|save|sauvegarder|bookmark|mark unread|non lu)/i;

        function dropChannel() {
            return String(settings.dropChannelId || "").trim();
        }

        function isDropChannel(id) {
            const wanted = dropChannel();
            return Boolean(wanted) && String(id || "") === wanted;
        }

        function findDropButton(root, msg) {
            const all = lab.discord.buttons?.(root, msg) || [];
            const entries = all.filter(e => !e.disabled && !DROP_NOISE.test([e.label, e.aria, e.title].filter(Boolean).join(" ")));
            const comps = (lab.embed.components(msg) || [])
                .filter(c => c.type === 2 || c.type === "2");

            // Le bot n'a qu'un bouton dans son embed : on prend le PREMIER
            // composant du message, jamais un bouton de l'interface Discord.
            if (comps.length) {
                const comp = comps[0];
                if (comp.disabled || comp.url) return null;
                if (comp.customId) {
                    const byId = entries.find(e => e.customId && e.customId === comp.customId);
                    if (byId) return byId;
                }
                if (comp.label) {
                    const wanted = lab.norm(comp.label).toLowerCase();
                    const byLabel = entries.find(e => lab.norm(e.label || e.aria || "").toLowerCase().includes(wanted));
                    if (byLabel) return byLabel;
                }
                // Composant connu mais DOM pas encore aligné : on ne clique pas
                // au hasard, on laisse le prochain scan réessayer.
                return null;
            }

            // Repli sans métadonnées : uniquement les boutons réellement dans
            // la zone de composants du message (pas « Répondre », « Plus »…).
            const scoped = entries.filter(e => e.btn?.closest?.('[id^="message-accessories-"], [class*="actionRow"], [class*="component"]'));
            const pool = scoped.length ? scoped : entries;
            if (!pool.length) return null;
            const claim = pool.find(e => CLAIM_RE.test([e.label, e.aria, e.title].filter(Boolean).join(" ")));
            if (settings.dropOnlyButton && pool.length > 1) {
                // Plusieurs boutons sans métadonnées : on ne devine pas, sinon
                // on risquait de cliquer « Répondre » au lieu du drop.
                return claim || null;
            }
            return claim || pool[0];
        }

        function tryClaim(msg, root = null) {
            if (!settings.drops) return;
            if (!isDropChannel(msg?.channel_id ?? msg?.channelId)) return;
            if (msg?.author && msg.author.bot === false) return;
            const id = String(msg?.id || "");
            if (!id || state.dropDone.has(id) || state.lastClickText === id) return;

            const sf = lab.snowflake(id);
            const age = sf ? Date.now() - sf.ts : 0;
            if (settings.dropMaxAgeSec && age > settings.dropMaxAgeSec * 1000) return;

            const text = lab.embed.messageText(msg);
            const comps = (lab.embed.components(msg) || []).filter(c => c.type === 2 || c.type === "2" || c.customId);
            if (!comps.length && !root && !/\bdrop\b|butin|loot|treasure|🎁|📦|claim/i.test(text)) return;

            state.dropDone.add(id);
            if (state.dropDone.size > 1000) state.dropDone.clear();
            state.lastClickText = id;
            state.dropSeen++;
            const delay = Math.max(0, Number(settings.sniperDelay) || 0);
            addLog(`drop repéré ${id.slice(-6)} · ${comps.length} composant(s) · clic dans ${delay} ms`);

            setTimeout(async () => {
                if (!settings.drops) return;
                let liveRoot = root?.isConnected ? root : lab.discord.messageRoot?.(id, msg.channel_id);
                if (!liveRoot && settings.dropFocus) {
                    lab.discord.focusChannel?.(msg.channel_id);
                }
                // Le message Flux arrive souvent avant le rendu React : on attend
                // le DOM au lieu d'abandonner (c'était la cause du « rien ne se passe »).
                for (let i = 0; i < 90 && !liveRoot; i++) {
                    await sleep(100);
                    liveRoot = root?.isConnected ? root : lab.discord.messageRoot?.(id, msg.channel_id);
                }
                if (!liveRoot && settings.dropFocus) {
                    // Deuxième tentative : la navigation Discord peut être
                    // asynchrone (SPA) et le premier focus arriver trop tôt.
                    lab.discord.focusChannel?.(msg.channel_id);
                    for (let i = 0; i < 40 && !liveRoot; i++) {
                        await sleep(100);
                        liveRoot = lab.discord.messageRoot?.(id, msg.channel_id);
                    }
                }
                if (!liveRoot) {
                    state.dropDone.delete(id);
                    state.lastClickText = "";
                    addLog(`drop ${id.slice(-6)} : message non rendu (ouvre le salon ou active « aller au salon »)`);
                    return;
                }
                // Le message peut être rendu avant sa ligne de composants.
                // Attendre le bouton lui-même, pas seulement le conteneur du
                // message, surtout après une navigation automatique.
                let target = null;
                for (let i = 0; i < 80 && !target; i++) {
                    target = findDropButton(liveRoot, msg);
                    if (target) break;
                    await sleep(100);
                }
                if (!target) {
                    state.dropDone.delete(id);
                    state.lastClickText = "";
                    addLog(`drop ${id.slice(-6)} : aucun bouton cliquable`);
                    return;
                }
                state.dropLast = { id, at: Date.now(), label: target.label || target.customId || "?" };
                if (settings.dropDryRun) {
                    addLog(`[SIMU] clic drop ${id.slice(-6)} → ${target.label || target.customId || "bouton"}`);
                    state.clicks++;
                    updateStatus();
                    return;
                }
                lab.discord.press?.(target.btn);
                state.clicks++;
                state.lastClickAt = Date.now();
                addLog(`drop ${id.slice(-6)} cliqué → ${target.label || target.customId || "bouton"}`);
                updateStatus();
            }, delay);
        }

        lab.watch((msg, root) => {
            try { tryClaim(msg, root); } catch (e) { lab.log("sniper", e.message); }
        });

        // Flux Discord : reçoit un drop même si le message n'est pas encore dans
        // le DOM (ou si un autre salon est ouvert). Le clic attend ensuite le DOM.
        let fluxOff = null;
        let fluxTries = 0;
        const attachFlux = () => {
            try {
                fluxOff = lab.discord.onMessageCreate?.(msg => tryClaim(msg, null));
            } catch (_) { /* ignore */ }
            // Webpack peut ne pas être prêt au boot : on réessaie sans doublon.
            if (!fluxOff && fluxTries++ < 12) setTimeout(attachFlux, 5000);
        };
        attachFlux();

        // Filet de sécurité si le dispatcher Webpack n'est pas disponible : on
        // relit périodiquement le MessageStore du salon de drops. Cela permet
        // de repérer un drop même si le salon n'est pas ouvert au moment T.
        setInterval(async () => {
            if (!settings.drops || state.dropPollBusy) return;
            const cid = dropChannel();
            if (!cid) return;
            // Le DOM/observer couvre déjà le salon affiché. L'historique
            // interne est utilisé quand l'utilisateur est ailleurs.
            const current = String(lab.channelId?.() || "");
            if (current === cid) return;
            state.dropPollBusy = true;
            try {
                const store = lab.discord.findStore?.("MessageStore");
                const coll = store?.getMessages?.(cid);
                const list = typeof coll?.toArray === "function" ? coll.toArray()
                    : Array.isArray(coll) ? coll : (coll ? Object.values(coll) : []);
                for (const m of list.slice(-25)) {
                    if (!m?.id) continue;
                    const author = m.author || {};
                    if (author.bot === false) continue;
                    tryClaim(m, null);
                }
                // Si le salon n'a pas été ouvert depuis le chargement de
                // Discord, MessageStore peut être vide : recharge les derniers
                // messages via le module Discord puis traite les drops.
                if (typeof lab.discord.history === "function") {
                    const recent = await lab.discord.history({ channel: cid, limit: 25, max: 25 });
                    for (const m of (recent || []).slice(-25)) {
                        if (!m?.id || m.author?.bot === false) continue;
                        tryClaim(m, null);
                    }
                }
            } catch (e) { lab.debug?.("drop store", e); }
            finally { state.dropPollBusy = false; }
        }, 3500);

        /* -------------------------------------------------------------- */
        /* UI                                                              */
        /* -------------------------------------------------------------- */

        function toggle(label, key, after) {
            const cb = h("input", { type: "checkbox" });
            cb.checked = Boolean(settings[key]);
            cb.addEventListener("change", () => { settings[key] = cb.checked; save(); after?.(); });
            return h("label", { class: "bl-row" }, cb, h("span", { text: label }));
        }

        function number(label, key, min, max) {
            const input = h("input", { class: "bl-input", type: "number", value: settings[key], min, max });
            input.addEventListener("change", () => {
                settings[key] = Math.max(min, Math.min(max, Number(input.value) || min));
                input.value = settings[key];
                save();
            });
            return h("label", { class: "bl-col" }, h("span", { class: "bl-label", text: label }), input);
        }

        function textField(label, key, placeholder) {
            const input = h("input", { class: "bl-input", value: settings[key] || "", placeholder: placeholder || "" });
            input.addEventListener("change", () => {
                settings[key] = String(input.value || "").replace(/[^0-9]/g, "");
                input.value = settings[key];
                save();
                if (key === "dropChannelId") {
                    lab.settings.dropChannelId = settings[key];
                    lab.saveSettings?.();
                }
            });
            return h("label", { class: "bl-col" }, h("span", { class: "bl-label", text: label }), input);
        }

        function taskRow(task) {
            const iv = INTERVAL_KEY[task.key];
            return h("div", { class: "bl-row" },
                toggle(task.label, task.key),
                number("toutes les (s)", iv, 5, 86400)
            );
        }

        lab.ui.tab({
            id: "pilot", title: "Pilote",
            render: () => {
                updateStatus();
                const startBtn = h("button", { class: "bl-btn", text: "Démarrer" });
                startBtn.addEventListener("click", () => { start(); lab.ui.refresh("pilot"); });
                const stopBtn = h("button", { class: "bl-btn bl-danger", text: "Arrêter" });
                stopBtn.addEventListener("click", () => { stop(); lab.ui.refresh("pilot"); });

                return h("div", null,
                    h("div", { class: "bl-card" },
                        h("b", { text: "État" }),
                        statusEl,
                        h("div", { class: "bl-row" }, startBtn, stopBtn),
                        h("div", { class: "bl-muted", text: `${state.clicks} clics de drop · dernier envoi : ${state.sent[0] || "—"}` })
                    ),
                    h("div", { class: "bl-card" },
                        h("b", { text: "Sécurité" }),
                        toggle("Mode simulation des commandes", "dryRun"),
                        number("Actions maximum", "maxActions", 1, 100000),
                        number("Durée maximum (minutes, 0 = illimité)", "maxMinutes", 0, 1440),
                        h("div", { class: "bl-muted", text: "Le mode simulation concerne les commandes planifiées. Les clics de drops se règlent séparément dans la section Drops. Au démarrage réel, une confirmation est demandée." })
                    ),
                    h("div", { class: "bl-card" },
                        h("b", { text: "Drops" }),
                        toggle("Sniper les drops (veille même sans Démarrer)", "drops"),
                        textField("ID du salon de drops", "dropChannelId", "1557793570243477524"),
                        h("div", { class: "bl-muted", text: "L'observateur combine MESSAGE_CREATE, MessageStore (même salon fermé) et le DOM. Il clique uniquement le premier bouton de l'embed du bot, sans toucher aux boutons Discord (Répondre, Réaction…)." }),
                        toggle("Sécurité : ne pas deviner si plusieurs boutons ambigus", "dropOnlyButton"),
                        toggle("Aller au salon si le message n'est pas rendu", "dropFocus"),
                        toggle("Simulation des clics de drops", "dropDryRun"),
                        number("Délai de clic (ms)", "sniperDelay", 0, 5000),
                        number("Âge maximum du drop (s)", "dropMaxAgeSec", 5, 3600),
                        h("div", { class: "bl-muted", text: `${state.dropSeen} drops vus · ${state.clicks} clics · dernier : ${state.dropLast ? `${state.dropLast.label} (${new Date(state.dropLast.at).toLocaleTimeString()})` : "—"}` }),
                        h("div", { class: "bl-row" },
                            h("button", {
                                class: "bl-btn bl-sec", text: "Ouvrir le salon de drops",
                                onclick: () => {
                                    const ok = lab.discord.focusChannel?.(dropChannel());
                                    toast(ok ? "Salon de drops ouvert" : "Salon introuvable : vérifie l'ID", ok ? "success" : "warn");
                                }
                            }),
                            h("button", {
                                class: "bl-btn bl-sec", text: "Scanner les messages affichés",
                                onclick: () => {
                                    let n = 0;
                                    for (const root of document.querySelectorAll('[id^="chat-messages-"]')) {
                                        const id = root.id.split("-").pop();
                                        const sf = lab.snowflake(id);
                                        if (!sf) continue;
                                        const channel = root.id.split("-")[2];
                                        if (!isDropChannel(channel)) continue;
                                        tryClaim({ id, channel_id: channel, author: { bot: true }, embeds: [], components: [] }, root);
                                        n++;
                                    }
                                    toast(n ? `${n} message(s) du salon de drops scanné(s)` : "Aucun message du salon de drops affiché", n ? "info" : "warn");
                                }
                            })
                        ),
                        h("div", { class: "bl-muted", text: "Le premier clic gagne : le sniper réagit à l'insertion du message, avant un humain. Active « Mode simulation » pour vérifier sans cliquer." })
                    ),
                    h("div", { class: "bl-card" },
                        h("b", { text: "Tâches" }),
                        ...TASKS.map(taskRow)
                    ),
                    h("div", { class: "bl-card" },
                        h("b", { text: "Paris" }),
                        h("label", { class: "bl-col" },
                            h("span", { class: "bl-label", text: "Couleur wheel" }),
                            (() => {
                                const sel = h("select", { class: "bl-select" },
                                    h("option", { value: "Redstone", text: "🟥 Redstone (×2)" }),
                                    h("option", { value: "Obsidian", text: "⬛ Obsidian (×2)" })
                                );
                                sel.value = settings.wheelBet;
                                sel.addEventListener("change", () => { settings.wheelBet = sel.value; save(); });
                                return sel;
                            })()
                        ),
                        number("Mise wheel", "wheelAmount", 10, 450),
                        number("Mise Lucky Block", "luckyAmount", 10, 450)
                    ),
                    h("div", { class: "bl-card" },
                        h("b", { text: "Journal" }),
                        logEl,
                        h("div", { class: "bl-muted", text: "Les commandes passent par l'éditeur Discord (comme un humain), jamais par un token." })
                    )
                );
            }
        });

        setInterval(updateStatus, 2000);
        console.info("[BlockyLab] pilote prêt");
    }

    boot();
})();
