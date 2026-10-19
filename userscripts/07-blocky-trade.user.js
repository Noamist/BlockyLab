// ==UserScript==
// @name         Blocky Lab · 07 · Trade Lab
// @namespace    blocky-lab
// @version      1.2.0
// @description  Composeur de trade, acceptation automatique contrôlée, tests de double acceptation, de course et de validation des montants.
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
        if (!lab) { console.warn("[BlockyLab] trade : noyau absent"); return; }
        if (W.__blockyTradeLoaded) return;
        W.__blockyTradeLoaded = true;

        const { h, toast } = lab;
        const KEY = "trade.v1";
        const saved = lab.store.get(KEY, {}) || {};
        const TRADE_TYPES = [
            ["emeralds", "Émeraudes", "monnaie"],
            ["cobblestone", "Cobblestone", "blocs"],
            ["gravel", "Gravier", "blocs"],
            ["deepslate", "Deepslate", "blocs"],
            ["obsidian", "Obsidienne", "blocs"],
            ["bedrock", "Bedrock", "blocs"],
            ["sticks", "Bâtons", "objets"],
            ["gold", "Lingots d'or", "lingots"],
            ["iron", "Lingots de fer", "lingots"],
            ["diamond", "Lingots de diamant", "lingots"],
            ["netherite", "Lingots de netherite", "lingots"],
            ["gear", "Équipement", "équipement"]
        ];
        const cfg = Object.assign({
            target: "",
            give: "100",
            want: "",
            template: "/trade member:{target} give:{give_type} give_amount:{give_amount} get:{get_type} get_amount:{get_amount}",
            commandMode: "structured",
            tradeMode: "trade",
            giveType: "emeralds",
            giveAmount: 1,
            getType: "emeralds",
            getAmount: 1,
            acceptDelayMs: 120,
            autoAccept: false,
            armSeconds: 5,
            clickCount: 2,
            clickGapMs: 80,
            scenario: "double",
            scenarioDryRun: true,
            testAmount: 10,
            replayWaitMs: 4000
        }, saved.cfg || {});
        // Migration douce des anciennes versions : les champs libres restent
        // utilisables, mais le composeur structuré reçoit un montant cohérent.
        if (!(saved.cfg && Object.prototype.hasOwnProperty.call(saved.cfg, "giveAmount"))) {
            const legacyGive = Number(String(cfg.give).replace(/[^\d]/g, ""));
            cfg.giveAmount = Number.isSafeInteger(legacyGive) && legacyGive > 0 ? legacyGive : 1;
        }
        if (!TRADE_TYPES.some(([value]) => value === cfg.giveType)) cfg.giveType = "emeralds";
        if (!TRADE_TYPES.some(([value]) => value === cfg.getType)) cfg.getType = "emeralds";
        if (!/^(?:structured|custom)$/.test(cfg.commandMode)) cfg.commandMode = "structured";
        if (!/^(?:trade|gift)$/.test(cfg.tradeMode)) cfg.tradeMode = "trade";
        if (saved.cfg && !Object.prototype.hasOwnProperty.call(saved.cfg, "commandMode")
            && saved.cfg.template && saved.cfg.template !== "/trade {target}") cfg.commandMode = "custom";

        const state = {
            offer: null,
            log: [],
            busy: false,
            armAt: 0,
            armTimer: null,
            autoDone: new Set(),
            lastSent: 0,
            lastBot: "",
            balance: null,
            balanceHistory: [],
            scenarioRunning: false,
            scenarioResult: null,
            offerSnapshot: null
        };
        const save = () => lab.store.set(KEY, { cfg });
        if (cfg.autoAccept) {
            setTimeout(() => toast("Trade : auto-accept actif (cible requise)", "warn", 6000), 1200);
        }

        function sameChannel(id) {
            const current = lab.channelId?.();
            return !current || !id || String(id) === String(current);
        }

        function log(kind, text) {
            state.log.unshift({ at: Date.now(), kind, text: String(text || "").slice(0, 1500) });
            state.log = state.log.slice(0, 60);
            if (lab.ui.current === "trade") lab.ui.refresh("trade");
        }

        function now() {
            return new Date().toLocaleTimeString();
        }

        function normalizeTarget(v) {
            const raw = String(v || "").trim();
            const mention = raw.match(/^<@!?(\d+)>$/);
            if (mention) return mention[1];
            return raw.replace(/^@/, "").trim();
        }

        function memberToken() {
            const target = normalizeTarget(cfg.target);
            if (!target) return "@cible";
            return /^\d+$/.test(target) ? `<@${target}>` : `@${target}`;
        }

        function positiveAmount(value, fallback = 1) {
            const n = Number(String(value ?? "").replace(/[, ]/g, ""));
            // 0 reste représentable pour les scénarios de validation (le bot
            // doit le refuser côté serveur) ; les valeurs non entières ou trop
            // grandes retombent sur le montant sûr de l'interface.
            return Number.isSafeInteger(n) && n >= 0 ? String(n) : String(fallback);
        }

        function choiceValue(value, fallback) {
            const v = String(value || "").trim().toLowerCase();
            return TRADE_TYPES.some(([key]) => key === v) ? v : fallback;
        }

        function structuredTradeCommand() {
            const parts = [
                "/trade",
                `member:${memberToken()}`,
                `give:${choiceValue(cfg.giveType, "emeralds")}`,
                `give_amount:${positiveAmount(cfg.giveAmount, 1)}`
            ];
            if (cfg.tradeMode !== "gift") {
                parts.push(`get:${choiceValue(cfg.getType, "emeralds")}`);
                parts.push(`get_amount:${positiveAmount(cfg.getAmount, 1)}`);
            }
            return parts.join(" ");
        }

        function commandText() {
            return cfg.commandMode === "structured" ? structuredTradeCommand() : fill(cfg.template);
        }

        function fill(cmd) {
            const target = memberToken();
            return String(cmd)
                .replace(/\{target\}/g, target)
                .replace(/\{member\}/g, target)
                .replace(/\{give\}/g, cfg.give)
                .replace(/\{want\}/g, cfg.want)
                .replace(/\{give_type\}/g, choiceValue(cfg.giveType, "emeralds"))
                .replace(/\{give_amount\}/g, positiveAmount(cfg.giveAmount, 1))
                .replace(/\{get_type\}/g, choiceValue(cfg.getType, "emeralds"))
                .replace(/\{get_amount\}/g, positiveAmount(cfg.getAmount, 1))
                .replace(/\{self\}/g, lab.discord.currentUser()?.id ? `<@${lab.discord.currentUser().id}>` : "@moi");
        }

        /* ------------------------------------------------------------------ */
        /* Détection des offres                                                */
        /* ------------------------------------------------------------------ */

        const TRADE_TEXT = /(trade|échange|echange|offre|offer|donner|recevoir|give|want|get_amount|give_amount)/i;
        const ACCEPT = /(accept|accepter|confirm|confirmer|validate|valider|✅)/i;
        const DECLINE = /(decline|refuser|reject|cancel|annuler|❌)/i;
        const ADD = /(add|ajouter|edit|modifier)/i;

        function classify(entry) {
            const raw = [entry.label, entry.aria, entry.title, entry.alt, entry.customId].filter(Boolean).join(" ");
            if (ACCEPT.test(raw)) return "accept";
            if (DECLINE.test(raw)) return "decline";
            if (ADD.test(raw)) return "add";
            return null;
        }

        function mapButtons(root, msg) {
            const map = new Map();
            if (typeof lab.discord.buttons !== "function") return map;
            for (const entry of lab.discord.buttons(root, msg)) {
                const action = classify(entry);
                if (!action) continue;
                const prev = map.get(action);
                if (!prev || (prev.disabled && !entry.disabled)) map.set(action, entry);
            }
            return map;
        }

        function targetMatches(msg, text) {
            const want = normalizeTarget(cfg.target).toLowerCase();
            if (!want) return true;
            const iu = msg?.interaction?.user;
            if (iu?.id && String(iu.id) === want) return true;
            const haystack = String(text || "").toLowerCase();
            return haystack.includes(want) || haystack.includes(`<@${want}>`) || haystack.includes(`@${want}`);
        }

        function captureOffer(msg, root) {
            const text = lab.embed.messageText(msg);
            if (!TRADE_TEXT.test(text)) return;
            const buttons = mapButtons(root, msg);
            if (!buttons.size && !/trade|offre|offer/i.test(text)) return;
            const id = String(msg.id);
            const details = offerDetails(text);
            state.offer = { msg, root, text, buttons, id, at: Date.now(), details };
            state.offerSnapshot = { id, at: Date.now(), text, details, buttons: [...buttons.entries()].map(([k, v]) => ({ action: k, label: v.label, customId: v.customId, disabled: v.disabled })) };
            log("offer", `Offre ${id} · ${details.give ? `donne « ${details.give} »` : "?"} · ${details.want ? `veut « ${details.want} »` : "?"} · boutons : ${[...buttons.keys()].join(", ") || "aucun"}`);
            if (cfg.autoAccept && cfg.target && targetMatches(msg, text) && !state.autoDone.has(id)) {
                state.autoDone.add(id);
                if (state.autoDone.size > 500) state.autoDone.clear();
                setTimeout(() => {
                    if (state.offer?.id === id) accept({ reason: "auto" });
                }, Math.max(50, cfg.acceptDelayMs));
            }
            if (lab.ui.current === "trade") lab.ui.refresh("trade");
        }

        function parseBalance(text) {
            const t = lab.norm(text || "");
            const m = t.match(/(?:balance|solde|portefeuille|wallet)\s*[:=]?\s*(\d{1,3}(?:[ ,.]\d{3})+|\d+(?:[.,]\d+)?)/i)
                || t.match(/(\d{1,3}(?:[ ,.]\d{3})+|\d+(?:[.,]\d+)?)\s*(?:emeralds?|émeraudes?|💎)/i);
            if (!m) return null;
            const n = Number(m[1].replace(/[ ,]/g, "").replace(",", "."));
            return Number.isFinite(n) ? n : null;
        }

        function noteBalance(text) {
            const n = parseBalance(text);
            if (n == null) return;
            if (state.balance !== n) {
                state.balanceHistory.unshift({ at: Date.now(), balance: n });
                state.balanceHistory = state.balanceHistory.slice(0, 30);
            }
            state.balance = n;
        }

        function offerDetails(text) {
            const t = lab.norm(text || "");
            const give = t.match(/(?:give|donne|donner|offre|offering)\s*[:=]?\s*([^\n·]{1,60})/i);
            const want = t.match(/(?:get|want|receive|recevoir|demande|requesting)\s*[:=]?\s*([^\n·]{1,60})/i);
            const target = t.match(/<@!?(\d{15,25})>/);
            return {
                give: give ? give[1].trim() : "",
                want: want ? want[1].trim() : "",
                target: target ? target[1] : "",
                empty: /\b(?:nothing|vide|aucun|0)\b/i.test(t) && /\b(?:give|donne|offre)\b/i.test(t)
            };
        }

        function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

        async function waitFor(fn, ms = 10000, step = 100) {
            const t0 = Date.now();
            while (Date.now() - t0 < ms) {
                const value = fn();
                if (value) return value;
                await sleep(step);
            }
            return null;
        }

        lab.watch((msg, root) => {
            try {
                if (msg?.author && msg.author.bot === false) return;
                if (!sameChannel(msg?.channel_id)) return;
                const sf = lab.snowflake(msg?.id);
                if (sf && Date.now() - sf.ts > 10 * 60 * 1000) return;
                const text = lab.embed.messageText(msg);
                state.lastBot = text;
                noteBalance(text);
                captureOffer(msg, root);
            } catch (e) { lab.log("trade scan", e.message); }
        });

        lab.on("obs", o => {
            if (o?.game === "unknown" && TRADE_TEXT.test(o.text || "")) {
                log("obs", (o.text || "").slice(0, 300));
            }
        });

        /* ------------------------------------------------------------------ */
        /* Actions                                                             */
        /* ------------------------------------------------------------------ */

        function modalOffer() {
            if (typeof lab.discord.buttons !== "function") return null;
            const scopes = [...document.querySelectorAll('[role="dialog"], [class*="modal"]')];
            if (!scopes.length) return null;
            for (const scope of scopes) {
                const map = new Map();
                for (const entry of lab.discord.buttons(scope, null)) {
                    const action = classify(entry);
                    if (!action) continue;
                    const prev = map.get(action);
                    if (!prev || (prev.disabled && !entry.disabled)) map.set(action, entry);
                }
                if (map.has("accept")) {
                    return { msg: null, root: scope, text: "(dialogue / modal)", buttons: map, id: "modal", at: Date.now() };
                }
            }
            return null;
        }

        function freshOffer() {
            // Beaucoup de bots ouvrent un trade dans une modale plutôt que dans
            // un message : le dialogue visible est prioritaire.
            const modal = modalOffer();
            if (modal) return modal;
            if (state.offer?.root?.isConnected) {
                return { ...state.offer, buttons: mapButtons(state.offer.root, state.offer.msg) };
            }
            return null;
        }

        function pressAction(action, gapMs = 0, count = 1, reason = "") {
            const offer = freshOffer();
            if (!offer) { toast("Aucune offre active détectée", "warn"); return false; }
            const entry = offer.buttons.get(action);
            if (!entry) { toast(`Bouton « ${action} » introuvable`, "warn"); log("error", `bouton ${action} absent`); return false; }
            if (entry.disabled) { toast("Bouton désactivé", "warn"); return false; }
            let i = 0;
            const click = () => {
                const live = freshOffer();
                const b = live?.buttons.get(action);
                if (!b || b.disabled) { log("error", `bouton ${action} disparu/désactivé`); return; }
                lab.discord.press(b.btn);
                i++;
                log("click", `${action} #${i}${reason ? " (" + reason + ")" : ""}`);
                if (i < count) setTimeout(click, Math.max(20, gapMs));
            };
            click();
            return true;
        }

        function accept(opts = {}) {
            return pressAction("accept", 0, 1, opts.reason || "");
        }

        async function sendOffer() {
            if (state.busy) return false;
            const cmd = commandText().trim();
            if (!cmd) { toast("Modèle de commande vide", "warn"); return false; }
            if (cfg.commandMode === "structured" && !normalizeTarget(cfg.target)) {
                toast("Renseigne une cible avant l'envoi", "warn");
                return false;
            }
            state.busy = true;
            state.lastSent = Date.now();
            log("send", cmd);
            try {
                const ok = await lab.discord.sendText(cmd);
                if (!ok) throw new Error("éditeur occupé");
                toast("Offre envoyée", "success");
                state.busy = false;
                return true;
            } catch (e) {
                state.busy = false;
                log("error", e.message);
                toast("Trade : " + e.message, "error");
                return false;
            } finally {
                if (lab.ui.current === "trade") lab.ui.refresh("trade");
            }
        }

        function copyCmd() {
            const cmd = commandText();
            navigator.clipboard?.writeText(cmd).then(
                () => toast("Commande copiée", "success"),
                () => lab.export.download("blocky-trade.txt", cmd, "text/plain")
            );
        }

        /* ------------------------------------------------------------------ */
        /* Course synchronisée                                                 */
        /* ------------------------------------------------------------------ */

        function arm(seconds, acceptAfter = true) {
            cancelArm();
            const s = Math.max(1, Math.min(120, Number(seconds) || 5));
            state.armAt = Date.now() + s * 1000;
            log("arm", `Envoi armé dans ${s} s`);
            state.armTimer = setTimeout(async () => {
                state.armTimer = null;
                log("race", "Départ");
                const ok = await sendOffer();
                if (ok && acceptAfter) {
                    setTimeout(() => {
                        const tryAccept = (n) => {
                            if (freshOffer()?.buttons.get("accept")) { accept({ reason: "course" }); return; }
                            if (n < 12) setTimeout(() => tryAccept(n + 1), 400);
                            else log("error", "course : aucun bouton accepter détecté");
                        };
                        tryAccept(0);
                    }, Math.max(150, cfg.acceptDelayMs));
                }
            }, s * 1000);
            if (lab.ui.current === "trade") lab.ui.refresh("trade");
        }

        function cancelArm() {
            if (state.armTimer) clearTimeout(state.armTimer);
            state.armTimer = null;
            state.armAt = 0;
        }

        /* ------------------------------------------------------------------ */
        /* Scénarios automatisés                                               */
        /* ------------------------------------------------------------------ */

        const SCENARIOS = [
            { id: "double", label: "Double accept", desc: "Deux clics sur Accepter. Le serveur doit refuser le second." },
            { id: "accept-cancel", label: "Accepter puis annuler", desc: "Vérifie si l'annulation après acceptation rend l'offre ou crée un objet fantôme." },
            { id: "zero", label: "Offre à 0", desc: "Envoie give=0 puis accepte : un transfert vide ne doit rien valider." },
            { id: "self", label: "Auto-trade", desc: "S'échange avec soi-même : doit être refusé sans mutation de solde." },
            { id: "fast", label: "Acceptation la plus rapide", desc: "Mesure la latence entre l'apparition de l'offre et le clic Accepter." },
            { id: "replay", label: "Rejouer un vieux bouton", desc: "Clique à nouveau l'acceptation après un délai : doit renvoyer « interaction expirée »." },
            { id: "race", label: "Course synchronisée", desc: "Arme l'envoi et l'acceptation au même instant (deux clients)." },
            { id: "balance", label: "Lire le solde", desc: "Ne clique rien : force la lecture du dernier message de solde." }
        ];

        function scenarioById(id) {
            return SCENARIOS.find(s => s.id === id) || SCENARIOS[0];
        }

        async function runScenario(id = cfg.scenario) {
            if (state.scenarioRunning) return;
            const scenario = scenarioById(id);
            if (!cfg.scenarioDryRun && !window.confirm(`Scénario réel « ${scenario.label} » sur le compte connecté ?\n\nUtilise deux comptes de test et des montants minimaux.`)) return;
            state.scenarioRunning = true;
            state.scenarioResult = null;
            const before = state.balance;
            const t0 = performance.now();
            log("test", `Scénario « ${scenario.label} »${cfg.scenarioDryRun ? " (simulation)" : ""}`);
            lab.ui.refresh("trade");
            try {
                if (!cfg.target && ["zero", "self", "race"].includes(id)) {
                    throw new Error("cible manquante");
                }
                if (cfg.scenarioDryRun) {
                    log("test", `[SIMU] ${scenario.desc}`);
                    state.scenarioResult = { id, label: scenario.label, dryRun: true, before, after: before, delta: 0, ms: 0 };
                    return;
                }

                if (id === "balance") {
                    log("test", `solde lu : ${state.balance ?? "inconnu"}`);
                } else if (id === "double") {
                    if (!freshOffer()) await sendOffer();
                    await waitFor(() => freshOffer()?.buttons.get("accept"), 12000);
                    pressAction("accept", Math.max(20, cfg.clickGapMs), Math.max(2, Math.min(10, cfg.clickCount)), "scénario double");
                } else if (id === "accept-cancel") {
                    if (!freshOffer()) await sendOffer();
                    await waitFor(() => freshOffer()?.buttons.get("accept"), 12000);
                    pressAction("accept", 0, 1, "scénario accept");
                    await sleep(260);
                    pressAction("decline", 0, 1, "scénario cancel");
                } else if (id === "zero") {
                    const old = { give: cfg.give, giveAmount: cfg.giveAmount };
                    cfg.give = "0";
                    cfg.giveAmount = 0;
                    try {
                        await sendOffer();
                        await waitFor(() => freshOffer()?.buttons.get("accept"), 12000);
                        pressAction("accept", 0, 1, "scénario zéro");
                    } finally { cfg.give = old.give; cfg.giveAmount = old.giveAmount; save(); }
                } else if (id === "self") {
                    const me = lab.discord.currentUser()?.id;
                    if (!me) throw new Error("utilisateur Discord introuvable");
                    const old = cfg.target;
                    cfg.target = me;
                    try {
                        await sendOffer();
                        await waitFor(() => freshOffer()?.buttons.get("accept"), 12000);
                        pressAction("accept", 0, 1, "scénario auto-trade");
                    } finally { cfg.target = old; save(); }
                } else if (id === "fast") {
                    const appearedAt = { at: 0 };
                    const found = waitFor(() => {
                        const o = freshOffer();
                        if (o?.buttons.get("accept")) { appearedAt.at = performance.now(); return o; }
                        return null;
                    }, 15000, 50);
                    await sendOffer();
                    await found;
                    acceptedLatency = appearedAt.at ? Math.round(performance.now() - appearedAt.at) : null;
                    pressAction("accept", 0, 1, "scénario rapide");
                } else if (id === "replay") {
                    if (!freshOffer()) await sendOffer();
                    await waitFor(() => freshOffer()?.buttons.get("accept"), 12000);
                    pressAction("accept", 0, 1, "premier clic");
                    await sleep(Math.max(1000, cfg.replayWaitMs));
                    pressAction("accept", 0, 1, "rejeu");
                } else if (id === "race") {
                    arm(Math.max(1, cfg.armSeconds), true);
                }
            } catch (e) {
                log("error", `scénario ${id} : ${e.message}`);
                state.scenarioResult = { id, label: scenario.label, error: e.message };
            } finally {
                const after = state.balance;
                if (!state.scenarioResult) {
                    state.scenarioResult = {
                        id, label: scenario.label, dryRun: false, before, after,
                        delta: before != null && after != null ? after - before : null,
                        ms: Math.round(performance.now() - t0), acceptedLatency: id === "fast" ? acceptedLatency : undefined
                    };
                }
                state.scenarioRunning = false;
                log("test", `fin ${scenario.label} · ${state.scenarioResult.ms ?? "?"} ms · delta ${state.scenarioResult.delta ?? "?"}`);
                lab.ui.refresh("trade");
            }
        }

        let acceptedLatency = null;

        /* ------------------------------------------------------------------ */
        /* Onglet                                                              */
        /* ------------------------------------------------------------------ */

        function render() {
            const wrap = h("div");
            const offer = freshOffer();

            const field = (label, key, opts = {}) => {
                const input = h("input", {
                    class: "bl-input",
                    type: opts.type || "text",
                    value: cfg[key],
                    placeholder: opts.placeholder || ""
                });
                input.addEventListener("change", () => {
                    cfg[key] = opts.type === "number" ? Number(input.value) || 0 : input.value;
                    save();
                    input.blur();
                    if (lab.ui.current === "trade") lab.ui.refresh("trade");
                });
                return h("label", { class: "bl-col" }, h("span", { class: "bl-label", text: label }), input);
            };

            const selectField = (label, key, values) => {
                const select = h("select", { class: "bl-select" });
                for (const [value, text] of values) select.appendChild(h("option", { value, text }));
                select.value = cfg[key];
                select.addEventListener("change", () => {
                    cfg[key] = select.value;
                    save();
                    lab.ui.refresh("trade");
                });
                return h("label", { class: "bl-col" }, h("span", { class: "bl-label", text: label }), select);
            };

            const tradeTypeValues = TRADE_TYPES.map(([value, label, kind]) => [value, `${label} · ${kind}`]);
            const structuredFields = h("div", { class: "bl-col", style: { gap: "8px" } },
                h("div", { class: "bl-grid2" },
                    selectField("Je donne", "giveType", tradeTypeValues),
                    field("Quantité donnée", "giveAmount", { type: "number", placeholder: "1", min: 1 })
                ),
                cfg.tradeMode === "trade" ? h("div", { class: "bl-grid2" },
                    selectField("Je reçois", "getType", tradeTypeValues),
                    field("Quantité demandée", "getAmount", { type: "number", placeholder: "1", min: 1 })
                ) : h("div", { class: "bl-muted", text: "Mode cadeau : les options get/get_amount ne seront pas envoyées." })
            );
            const customFields = h("div", { class: "bl-col", style: { gap: "8px" } },
                h("div", { class: "bl-grid2" },
                    field("Donner (texte libre)", "give", { placeholder: "100" }),
                    field("Demander (texte libre)", "want", { placeholder: "1 diamant" })
                ),
                field("Modèle de commande", "template", { placeholder: "/trade member:{target} give:{give_type} give_amount:{give_amount}" }),
                h("div", { class: "bl-muted", style: { fontSize: "10px" }, text: "Placeholders : {target}, {member}, {give}, {want}, {give_type}, {give_amount}, {get_type}, {get_amount}." })
            );
            const parsed = typeof lab.discord.parseSlashCommand === "function"
                ? lab.discord.parseSlashCommand(commandText())
                : { args: [] };
            const argsPreview = parsed.args.length
                ? parsed.args.map((arg, i) => `${i + 1}. ${arg.name || "argument"} = ${arg.value}`).join("\n")
                : "Aucun paramètre";

            wrap.appendChild(h("div", { class: "bl-card" },
                h("b", { text: "Composeur Trade" }),
                h("div", { class: "bl-grid2" },
                    field("Membre cible (ID ou @nom)", "target", { placeholder: "@Noamis ou 123456789012345678" }),
                    selectField("Format", "commandMode", [["structured", "Trade structuré"], ["custom", "Modèle libre"]])
                ),
                h("div", { class: "bl-muted", style: { fontSize: "10px" }, text: "Pour un pseudo, saisis Noamis ou @Noamis : l'envoi attend puis valide la suggestion Discord. Si aucune suggestion n'est sélectionnée, la commande est annulée." }),
                cfg.commandMode === "structured"
                    ? h("div", { class: "bl-grid2" },
                        selectField("Opération", "tradeMode", [["trade", "Échange (give + get)"], ["gift", "Cadeau (give seul)"]]),
                        field("Délai d'acceptation (ms)", "acceptDelayMs", { type: "number", placeholder: "120" })
                    )
                    : field("Délai d'acceptation (ms)", "acceptDelayMs", { type: "number", placeholder: "120" }),
                cfg.commandMode === "structured" ? structuredFields : customFields,
                h("div", { class: "bl-muted", style: { fontSize: "10px" }, text: "Les valeurs entre parenthèses affichées par Discord (ex. emeralds (2092)) sont des descriptions d'aide : elles ne sont jamais envoyées comme arguments." }),
                h("div", { class: "bl-label", text: "Commande prête à envoyer" }),
                h("div", { class: "bl-code", text: commandText() }),
                h("div", { class: "bl-label", text: "Paramètres détectés" }),
                h("pre", { class: "bl-code", style: { whiteSpace: "pre-wrap", margin: "0" }, text: argsPreview }),
                h("div", { class: "bl-row" },
                    h("button", { class: "bl-btn", text: "Envoyer", disabled: cfg.commandMode === "structured" && !normalizeTarget(cfg.target), onclick: sendOffer }),
                    h("button", { class: "bl-btn bl-sec", text: "Copier", onclick: copyCmd }),
                    h("button", {
                        class: "bl-btn bl-sec", text: "Cibler mon compte",
                        onclick: () => {
                            const id = lab.discord.currentUser()?.id;
                            if (!id) { toast("Utilisateur Discord introuvable", "warn"); return; }
                            cfg.target = id;
                            save();
                            lab.ui.refresh("trade");
                        }
                    }),
                    h("button", {
                        class: "bl-btn bl-sec", text: "Vérifier",
                        onclick: () => toast(`${parsed.args.length} paramètre(s) · ordre conservé`, "info")
                    })
                )
            ));

            const buttons = offer ? [...offer.buttons.entries()].map(([k, v]) => `${k}: ${v.label || v.customId || "?"}`).join(" · ") : "aucune offre";
            wrap.appendChild(h("div", { class: "bl-card" },
                h("b", { text: "Dernière offre" }),
                h("div", { class: "bl-kv" }, h("span", { text: "ID" }), h("b", { text: offer?.id || "—" })),
                h("div", { class: "bl-kv" }, h("span", { text: "Boutons" }), h("b", { text: buttons })),
                offer ? h("div", { class: "bl-chip", style: { width: "auto", padding: "2px 6px", background: "#4e5058" }, text: `donne: ${offer.details?.give || "?"} · veut: ${offer.details?.want || "?"}` }) : null,
                offer ? h("div", { class: "bl-code", text: offer.text.slice(0, 1200) }) : h("div", { class: "bl-muted", text: "Aucune offre détectée. Ouvre un trade ou envoie-en un." }),
                h("div", { class: "bl-row" },
                    h("button", { class: "bl-btn", text: "Accepter", onclick: () => accept({ reason: "manuel" }) }),
                    h("button", { class: "bl-btn bl-sec", text: "Refuser", onclick: () => pressAction("decline", 0, 1, "manuel") }),
                    h("button", { class: "bl-btn bl-sec", text: "Modifier", disabled: !offer?.buttons.has("add"), onclick: () => pressAction("add", 0, 1, "modifier") }),
                    h("button", { class: "bl-btn bl-sec", text: "Rescanner", onclick: () => { lab.rescan(true); toast("Scan relancé", "info"); } })
                )
            ));

            const auto = h("input", { type: "checkbox" });
            auto.checked = cfg.autoAccept;
            auto.addEventListener("change", () => {
                cfg.autoAccept = auto.checked;
                save();
                if (cfg.autoAccept) toast("Auto-accept activé : uniquement les offres correspondant à la cible", "warn");
            });

            wrap.appendChild(h("div", { class: "bl-card" },
                h("b", { text: "Scénarios" }),
                h("label", { class: "bl-row", style: { cursor: "pointer" } }, auto,
                    h("span", { text: "Accepter automatiquement l'offre de la cible" })),
                h("div", { class: "bl-grid2" },
                    field("Nombre de clics", "clickCount", { type: "number" }),
                    field("Écart entre clics (ms)", "clickGapMs", { type: "number" })
                ),
                h("div", { class: "bl-row" },
                    h("button", {
                        class: "bl-btn", text: "Double accept",
                        onclick: () => pressAction("accept", cfg.clickGapMs, Math.max(2, Math.min(10, Number(cfg.clickCount) || 2)), "double")
                    }),
                    h("button", {
                        class: "bl-btn bl-sec", text: "Accepter puis annuler",
                        onclick: () => {
                            if (!pressAction("accept", 0, 1, "puis annuler")) return;
                            setTimeout(() => pressAction("decline", 0, 1, "après accept"), 300);
                        }
                    })
                ),
                h("div", { class: "bl-row" },
                    h("button", {
                        class: "bl-btn bl-sec", text: "Accept x5 (spam)",
                        onclick: () => pressAction("accept", 60, 5, "spam")
                    }),
                    h("button", {
                        class: "bl-btn bl-sec", text: "Mettre give=0",
                        onclick: () => {
                            cfg.give = "0";
                            cfg.giveAmount = 0;
                            save();
                            toast(cfg.commandMode === "structured"
                                ? "give_amount=0 : envoie puis accepte pour vérifier le refus"
                                : (cfg.template.includes("{give}") ? "give=0 : envoie puis accepte" : "give=0 (ajoute {give} au modèle pour l'utiliser)"), "warn");
                            lab.ui.refresh("trade");
                        }
                    })
                ),
                h("div", { class: "bl-muted", text: "Le double accept doit renvoyer une erreur côté serveur. Si les deux clics créditent, c'est une faille critique : exporte le journal et les soldes avant/après." })
            ));

            const scenarioSelect = h("select", { class: "bl-select" });
            for (const s of SCENARIOS) scenarioSelect.appendChild(h("option", { value: s.id, text: s.label }));
            scenarioSelect.value = cfg.scenario;
            scenarioSelect.addEventListener("change", () => { cfg.scenario = scenarioSelect.value; save(); lab.ui.refresh("trade"); });
            const dry = h("input", { type: "checkbox" });
            dry.checked = cfg.scenarioDryRun;
            dry.addEventListener("change", () => { cfg.scenarioDryRun = dry.checked; save(); });

            wrap.appendChild(h("div", { class: "bl-card" },
                h("b", { text: "Auto-tests de failles" }),
                h("div", { class: "bl-muted", text: scenarioById(cfg.scenario).desc }),
                scenarioSelect,
                h("label", { class: "bl-row" }, dry, h("span", { text: "Simulation (aucun envoi, aucun clic)" })),
                h("div", { class: "bl-row" },
                    h("button", {
                        class: "bl-btn", text: state.scenarioRunning ? "En cours…" : "Lancer le scénario",
                        disabled: state.scenarioRunning,
                        onclick: () => runScenario()
                    }),
                    h("button", {
                        class: "bl-btn bl-sec", text: "Tout le journal",
                        onclick: () => lab.export.download("blocky-trade-evidence.json", JSON.stringify({
                            generatedAt: new Date().toISOString(), cfg, balance: state.balance,
                            history: state.balanceHistory, offer: state.offerSnapshot, log: state.log
                        }, null, 2))
                    })
                ),
                h("div", { class: "bl-kv" }, h("span", { text: "Solde lu" }), h("b", { text: state.balance ?? "—" })),
                state.scenarioResult ? h("div", { class: "bl-code", text: JSON.stringify(state.scenarioResult, null, 2) }) : null,
                h("div", { class: "bl-muted", style: { fontSize: "10px" }, text: "Un delta de solde différent de 0 après un double accept ou un auto-trade est un signal fort. Un refus propre n'est pas une faille." })
            ));

            wrap.appendChild(h("div", { class: "bl-card" },
                h("b", { text: "Course synchronisée" }),
                h("div", { class: "bl-muted", text: "Ouvre deux clients (deux comptes de test), règle la cible de chacun, puis arme le même délai. Chaque client envoie son offre et accepte l'autre au même instant." }),
                h("div", { class: "bl-grid2" },
                    field("Départ dans (s)", "armSeconds", { type: "number" })
                ),
                h("div", { class: "bl-row" },
                    h("button", { class: "bl-btn", text: "Armer l'envoi", onclick: () => arm(cfg.armSeconds, true) }),
                    h("button", { class: "bl-btn bl-sec", text: "Envoyer + accepter", onclick: () => arm(1, true) }),
                    h("button", { class: "bl-btn bl-danger", text: "Annuler", onclick: () => { cancelArm(); toast("Course annulée", "info"); lab.ui.refresh("trade"); } })
                ),
                h("div", { class: "bl-kv" }, h("span", { text: "Armé" }),
                    h("b", { text: state.armAt ? new Date(state.armAt).toLocaleTimeString() : "—" }))
            ));

            wrap.appendChild(h("div", { class: "bl-card" },
                h("b", { text: "Journal" }),
                state.log.length ? h("div", { class: "bl-code", text: state.log.map(x => `[${new Date(x.at).toLocaleTimeString()}] ${x.kind.padEnd(6)} ${x.text}`).join("\n") })
                    : h("div", { class: "bl-muted", text: "Rien pour l'instant." }),
                h("div", { class: "bl-row" },
                    h("button", {
                        class: "bl-btn bl-sec", text: "Exporter",
                        onclick: () => lab.export.download("blocky-trade-log.json", JSON.stringify({ cfg, log: state.log, offer: state.offer ? { id: state.offer.id, text: state.offer.text } : null }, null, 2))
                    }),
                    h("button", { class: "bl-btn bl-danger", text: "Vider", onclick: () => { state.log = []; lab.ui.refresh("trade"); } })
                )
            ));

            if (state.armAt) {
                const left = Math.max(0, (state.armAt - Date.now()) / 1000);
                wrap.appendChild(h("div", { class: "bl-inline" },
                    h("b", { text: `Départ dans ${left.toFixed(1)} s` }),
                    h("div", { class: "bl-muted", text: "Ne change plus la cible ni le modèle." })
                ));
            }

            wrap.appendChild(h("div", { class: "bl-muted", style: { fontSize: "10px" }, text: "Les trades ne concernent que des comptes de test. Un double crédit doit être signalé, pas répété." }));
            return wrap;
        }

        lab.ui.tab({ id: "trade", title: "Trade", hint: "Composeur et tests de course", render });
        console.info("[BlockyLab] trade prêt");
    }

    boot();
})();
