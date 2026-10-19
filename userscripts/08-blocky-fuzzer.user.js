// ==UserScript==
// @name         Blocky Lab · 08 · Fuzzer
// @namespace    blocky-lab
// @version      1.2.0
// @description  Fuzzer de commandes Blocky : valeurs limites, file contrôlée, exécution temporisée et classification des réponses.
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
        if (!lab) { console.warn("[BlockyLab] fuzzer : noyau absent"); return; }
        if (W.__blockyFuzzLoaded) return;
        W.__blockyFuzzLoaded = true;

        const { h, toast } = lab;
        const KEY = "fuzz.v1";
        const saved = lab.store.get(KEY, {}) || {};
        const cfg = Object.assign({
            template: "pay",
            custom: "/pay user:{u} amount:{v}",
            target: "",
            delayMs: 3200,
            maxRuns: 8,
            allowSend: false,
            doubleSend: false,
            burstCount: 2,
            burstGapMs: 80,
            customValues: "0\n-1\n1e9\nNaN"
        }, saved.cfg || {});
        // L'autorisation d'envoi n'est jamais restaurée automatiquement :
        // un rechargement de page doit forcer une nouvelle confirmation.
        cfg.allowSend = false;
        const save = () => lab.store.set(KEY, { cfg });

        const TEMPLATES = [
            { id: "pay", label: "Pay", cmd: "/pay user:{u} amount:{v}" },
            { id: "trade", label: "Trade (cible)", cmd: "/trade member:{u} give:emeralds give_amount:{v} get:emeralds get_amount:1" },
            { id: "auction", label: "Auction (prix)", cmd: "/auction start price:{v}" },
            { id: "buy", label: "Auction buy (ID)", cmd: "/auction buy id:{v}" },
            { id: "wheel", label: "Wheel (numéro)", cmd: "/wheel number:{v} amount:10" },
            { id: "mines", label: "Mines (TNT)", cmd: "/mines amount:10 tnt:{v}" },
            { id: "luckyblock", label: "Lucky Block (mise)", cmd: "/luckyblock amount:{v}" },
            { id: "blackjack", label: "Blackjack (mise)", cmd: "/blackjack amount:{v}" },
            { id: "loan", label: "Loan (montant)", cmd: "/loan offer amount:{v} interest:10 days:3" },
            { id: "loan-int", label: "Loan (intérêt)", cmd: "/loan offer amount:10 interest:{v} days:3" },
            { id: "team", label: "Team (nom)", cmd: "/team create name:{v}" },
            { id: "customize", label: "Customize (couleur)", cmd: "/customize color:{v}" },
            { id: "rob", label: "Rob (montant)", cmd: "/rob user:{u} amount:{v}" },
            { id: "duel", label: "Duel (mise)", cmd: "/duel user:{u} amount:{v}" },
            { id: "sell", label: "Sell", cmd: "/sell" },
            { id: "daily", label: "Daily", cmd: "/daily" },
            { id: "custom", label: "Commande libre…", cmd: "" }
        ];
        const PRESETS = {
            numbers: ["-1", "0", "1", "1.5", "2", "10", "999999", "9007199254740991", "NaN", "Infinity", "1e309", "-0", "1e3"],
            amounts: ["-10", "0", "1", "5", "10", "99", "1000", "1000000", "1e9"],
            strings: ["", " ", "a", "test", "x".repeat(200), "é", "😀", "\u202Eabc", "@everyone", "<@123>", "' OR 1=1 --"]
        };

        const state = {
            queue: [],
            results: [],
            running: false,
            recent: [],
            stop: false
        };

        function sameChannel(id) {
            const current = lab.channelId?.();
            return !current || !id || String(id) === String(current);
        }
        lab.on("obs", o => {
            if (o?.text && sameChannel(o.channelId)) state.recent.push({ id: o.id, text: o.text, at: Date.now(), game: o.game });
            if (state.recent.length > 200) state.recent.shift();
        });
        lab.watch((msg) => {
            if (!(msg?.author?.bot === true || msg?.webhook_id)) return;
            if (!sameChannel(msg?.channel_id)) return;
            const text = lab.embed.messageText(msg);
            if (text) state.recent.push({ id: msg.id, text, at: Date.now(), game: "unknown" });
            if (state.recent.length > 200) state.recent.shift();
        });

        function tpl() {
            return cfg.template === "custom"
                ? (cfg.custom || "")
                : (TEMPLATES.find(t => t.id === cfg.template)?.cmd || "");
        }

        function targetMention() {
            const raw = String(cfg.target || "").trim();
            const mention = raw.match(/^<@!?(\d+)>$/);
            if (mention) return `<@${mention[1]}>`;
            const name = raw.replace(/^@/, "").trim();
            return name ? `@${name}` : "@cible";
        }

        function buildCommand(value) {
            return tpl()
                .replace(/\{v\}/g, value)
                .replace(/\{u\}/g, targetMention());
        }

        function generate() {
            const values = cfg.preset === "custom"
                ? String(cfg.customValues || "").split(/\r?\n/).map(v => v.trim()).filter(Boolean)
                : (PRESETS[cfg.preset || "numbers"] || PRESETS.numbers);
            const command = tpl();
            if (!command.trim()) { toast("Modèle de commande vide", "warn"); return; }
            if (!command.includes("{v}")) { toast("Le modèle doit contenir {v}", "warn"); return; }
            state.queue = values.slice(0, 40).map((value, i) => ({
                id: `${Date.now()}-${i}`,
                value,
                cmd: buildCommand(value),
                checked: i < Math.max(1, cfg.maxRuns)
            }));
            lab.ui.refresh("fuzz");
        }

        function classify(text) {
            const t = String(text || "");
            if (/rate.?limit|too many|slow down|trop de requ|calme/i.test(t)) return "ratelimit";
            if (/\b(invalid|must be|between|cannot|can't|not enough|impossible|doit être|doit etre|pas assez|refus|erreur de validation)\b/i.test(t)) return "rejected";
            if (/\b(error|exception|traceback|stack|undefined|NaN|Internal Server)\b/i.test(t)) return "error";
            if (/\b(success|created|sent|bought|placed|done|succès|envoyé|acheté|réussi|validé)\b/i.test(t)) return "accepted";
            return "unknown";
        }

        function waitBot(afterIndex, ms = 8000) {
            return new Promise(resolve => {
                const t0 = Date.now();
                const tick = () => {
                    const found = state.recent.slice(afterIndex).find(m => m.text && !m.text.includes("Blocky Lab"));
                    if (found) return resolve(found);
                    if (Date.now() - t0 > ms) return resolve(null);
                    setTimeout(tick, 200);
                };
                tick();
            });
        }

        async function runQueue() {
            if (state.running) return;
            const items = state.queue.filter(q => q.checked);
            if (!items.length) { toast("Aucune commande sélectionnée", "warn"); return; }
            if (!cfg.allowSend) { toast("Active « Autoriser l'envoi »", "warn"); return; }
            if (targetMention() === "@cible" && /\{u\}/.test(tpl())) {
                toast("Renseigne une cible valide", "warn");
                return;
            }
            if (!window.confirm(`Envoyer ${items.length} commande(s) avec ${cfg.delayMs} ms entre chaque ?\n\nUtilise un compte de test et des montants minimaux.`)) return;

            state.running = true;
            state.stop = false;
            state.results = [];
            lab.ui.refresh("fuzz");
            let errors = 0;

            for (const item of items) {
                if (state.stop) break;
                const before = state.recent.length;
                const t0 = performance.now();
                let status = "send-failed";
                let response = "";
                try {
                    const ok = await lab.discord.sendText(item.cmd);
                    if (!ok) throw new Error("envoi refusé (éditeur occupé)");
                    if (cfg.doubleSend) {
                        // Envoi en rafale : révèle les courses et les cooldowns
                        // vérifiés par message plutôt que par joueur.
                        const count = Math.max(2, Math.min(8, Number(cfg.burstCount) || 2));
                        for (let i = 1; i < count; i++) {
                            await new Promise(r => setTimeout(r, Math.max(20, cfg.burstGapMs)));
                            await lab.discord.sendText(item.cmd).catch(() => false);
                        }
                    }
                    const msg = await waitBot(before, Math.max(4000, cfg.delayMs));
                    response = msg?.text || "";
                    status = msg ? classify(response) : "timeout";
                } catch (e) {
                    response = e.message;
                    status = "send-failed";
                }
                const ms = Math.round(performance.now() - t0);
                state.results.unshift({ cmd: item.cmd, value: item.value, status, response: response.slice(0, 3000), ms, at: new Date().toISOString() });
                if (status === "error" || status === "send-failed") errors++;
                if (status === "ratelimit" || errors >= 3) {
                    toast("Fuzzer arrêté : rate limit ou 3 erreurs", "warn");
                    break;
                }
                lab.ui.refresh("fuzz");
                await new Promise(r => setTimeout(r, Math.max(1500, cfg.delayMs)));
            }
            state.running = false;
            toast("Campagne terminée", "success");
            lab.ui.refresh("fuzz");
        }

        function exportResults() {
            const data = {
                generatedAt: new Date().toISOString(),
                template: tpl(),
                target: cfg.target,
                delayMs: cfg.delayMs,
                results: state.results
            };
            lab.export.download("blocky-fuzz.json", JSON.stringify(data, null, 2));
        }

        /* ------------------------------------------------------------------ */
        /* Onglet                                                              */
        /* ------------------------------------------------------------------ */

        function render() {
            const wrap = h("div");
            const field = (label, key, opts = {}) => {
                const input = h("input", {
                    class: "bl-input",
                    type: opts.type || "text",
                    value: cfg[key],
                    min: opts.min,
                    max: opts.max
                });
                input.addEventListener("change", () => {
                    cfg[key] = opts.type === "number" ? Number(input.value) || 0 : input.value;
                    save();
                });
                return h("label", { class: "bl-col" }, h("span", { class: "bl-label", text: label }), input);
            };

            const tplSelect = h("select", { class: "bl-select" });
            for (const t of TEMPLATES) tplSelect.appendChild(h("option", { value: t.id, text: t.label }));
            tplSelect.value = cfg.template;
            tplSelect.addEventListener("change", () => { cfg.template = tplSelect.value; save(); lab.ui.refresh("fuzz"); });

            const preset = h("select", { class: "bl-select" });
            for (const [k, v] of [["numbers", "Nombres limites"], ["amounts", "Montants"], ["strings", "Textes / injections"], ["custom", "Personnalisées"]]) {
                preset.appendChild(h("option", { value: k, text: v }));
            }
            preset.value = cfg.preset || "numbers";
            preset.addEventListener("change", () => { cfg.preset = preset.value; save(); lab.ui.refresh("fuzz"); });

            const allow = h("input", { type: "checkbox" });
            allow.checked = cfg.allowSend;
            allow.addEventListener("change", () => { cfg.allowSend = allow.checked; save(); });
            const doubleSend = h("input", { type: "checkbox" });
            doubleSend.checked = cfg.doubleSend;
            doubleSend.addEventListener("change", () => { cfg.doubleSend = doubleSend.checked; save(); lab.ui.refresh("fuzz"); });

            const preview = h("div", { class: "bl-code", text: buildCommand("10") });
            const custom = h("textarea", { class: "bl-textarea", placeholder: "/commande option:{v} user:{u}" });
            custom.value = cfg.custom;
            custom.addEventListener("change", () => { cfg.custom = custom.value; save(); preview.textContent = buildCommand("10"); });
            const customValues = h("textarea", { class: "bl-textarea", placeholder: "Une valeur par ligne" });
            customValues.value = cfg.customValues;
            customValues.addEventListener("change", () => { cfg.customValues = customValues.value; save(); });

            wrap.appendChild(h("div", { class: "bl-card" },
                h("b", { text: "Campagne" }),
                h("div", { class: "bl-muted", text: "Une valeur limite par commande. L'objectif est de voir si le bot accepte silencieusement, refuse proprement, ou renvoie une erreur interne." }),
                h("div", { class: "bl-grid2" },
                    h("label", { class: "bl-col" }, h("span", { class: "bl-label", text: "Commande" }), tplSelect),
                    h("label", { class: "bl-col" }, h("span", { class: "bl-label", text: "Jeu de valeurs" }), preset)
                ),
                cfg.template === "custom" ? custom : null,
                cfg.preset === "custom" ? customValues : null,
                h("div", { class: "bl-grid2" },
                    field("Cible (ID ou @)", "target"),
                    field("Délai (ms)", "delayMs", { type: "number", min: 1500 })
                ),
                h("div", { class: "bl-grid2" },
                    field("Max par campagne", "maxRuns", { type: "number", min: 1, max: 40 }),
                    h("label", { class: "bl-col" }, h("span", { class: "bl-label", text: "Aperçu" }), preview)
                ),
                h("label", { class: "bl-row", style: { cursor: "pointer" } }, allow,
                    h("span", { text: "Autoriser l'envoi réel (compte de test uniquement)" })),
                h("label", { class: "bl-row", style: { cursor: "pointer" } }, doubleSend,
                    h("span", { text: "Envoyer en rafale (test d'idempotence / cooldown)" })),
                cfg.doubleSend ? h("div", { class: "bl-grid2" },
                    field("Nombre d'envois", "burstCount", { type: "number", min: 2 }),
                    field("Écart (ms)", "burstGapMs", { type: "number", min: 20 })
                ) : null,
                h("div", { class: "bl-row" },
                    h("button", { class: "bl-btn", text: "Générer la file", onclick: generate }),
                    h("button", { class: "bl-btn", text: state.running ? "En cours…" : "Exécuter", disabled: state.running, onclick: runQueue }),
                    h("button", { class: "bl-btn bl-danger", text: "Stop", disabled: !state.running, onclick: () => { state.stop = true; } })
                )
            ));

            if (state.queue.length) {
                const table = h("table", { class: "bl-table" },
                    h("thead", null, h("tr", null,
                        h("th", { text: "" }), h("th", { text: "Valeur" }), h("th", { text: "Commande" })
                    ))
                );
                const body = h("tbody");
                for (const q of state.queue) {
                    const cb = h("input", { type: "checkbox" });
                    cb.checked = q.checked;
                    cb.addEventListener("change", () => { q.checked = cb.checked; });
                    body.appendChild(h("tr", null,
                        h("td", null, cb),
                        h("td", { text: q.value === "" ? "∅" : q.value }),
                        h("td", { class: "bl-muted", text: q.cmd })
                    ));
                }
                table.appendChild(body);
                wrap.appendChild(h("div", { class: "bl-card" },
                    h("b", { text: `File (${state.queue.length})` }),
                    table,
                    h("div", { class: "bl-row" },
                        h("button", { class: "bl-btn bl-sec", text: "Tout cocher", onclick: () => { state.queue.forEach(q => q.checked = true); lab.ui.refresh("fuzz"); } }),
                        h("button", { class: "bl-btn bl-sec", text: "Tout décocher", onclick: () => { state.queue.forEach(q => q.checked = false); lab.ui.refresh("fuzz"); } }),
                        h("button", { class: "bl-btn bl-sec", text: "Copier", onclick: () => navigator.clipboard?.writeText(state.queue.filter(q => q.checked).map(q => q.cmd).join("\n")).then(() => toast("Commandes copiées", "success"), () => toast("Copie refusée", "warn")) })
                    )
                ));
            }

            if (state.results.length) {
                const counts = {};
                for (const r of state.results) counts[r.status] = (counts[r.status] || 0) + 1;
                const table = h("table", { class: "bl-table" },
                    h("thead", null, h("tr", null,
                        h("th", { text: "Commande" }), h("th", { text: "Statut" }), h("th", { text: "ms" })
                    ))
                );
                const body = h("tbody");
                for (const r of state.results) {
                    const cls = r.status === "accepted" ? "bl-bad" : r.status === "error" || r.status === "ratelimit" ? "bl-bad" : r.status === "rejected" ? "bl-good" : "bl-muted";
                    body.appendChild(h("tr", null,
                        h("td", { class: "bl-muted", text: r.cmd }),
                        h("td", { class: cls, title: r.response, text: r.status }),
                        h("td", { text: String(r.ms) })
                    ));
                }
                table.appendChild(body);
                wrap.appendChild(h("div", { class: "bl-card" },
                    h("b", { text: "Résultats" }),
                    h("div", { class: "bl-row", text: Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join(" · ") }),
                    table,
                    h("div", { class: "bl-row" },
                        h("button", { class: "bl-btn bl-sec", text: "Exporter JSON", onclick: exportResults }),
                        h("button", {
                            class: "bl-btn bl-sec", text: "Exporter CSV",
                            onclick: () => lab.export.download("blocky-fuzz.csv", lab.export.csv(state.results), "text/csv")
                        })
                    )
                ));
            }

            wrap.appendChild(h("div", { class: "bl-muted", style: { fontSize: "10px" }, text: "Les payloads avec @ ou caractères spéciaux peuvent être normalisés par le sélecteur d'options de Discord. Les réponses affichées dans une modale ne sont pas capturées. Ne teste jamais sur un compte principal." }));
            return wrap;
        }

        lab.ui.tab({ id: "fuzz", title: "Fuzz", hint: "Valeurs limites de commandes", render });
        console.info("[BlockyLab] fuzzer prêt");
    }

    boot();
})();
