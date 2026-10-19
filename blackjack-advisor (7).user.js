// ==UserScript==
// @name         BlackjackAdvisor
// @namespace    https://discord.com/
// @version      3.7.0
// @description  Conseiller Blackjack pour les embeds de Noamis : stratégie de base, détection, clic automatique et envoi périodique de /blackjack.
// @match        https://discord.com/channels/*
// @match        https://canary.discord.com/channels/*
// @match        https://ptb.discord.com/channels/*
// @run-at       document-start
// @grant        unsafeWindow
// ==/UserScript==

/*
 * IMPORTANT : "@grant unsafeWindow" donne accès à la vraie fenêtre de la page
 * (webpack de Discord), même quand Tampermonkey isole le script.
 *
 * Avertissement : automatiser un compte utilisateur Discord (envoi automatique
 * de commandes, clics automatiques) est contraire aux conditions d'utilisation
 * de Discord et peut entraîner la suspension du compte. À utiliser à vos risques.
 */

(function () {
    "use strict";

    const VERSION = "3.7.0";

    // Prise de contrôle : si une ancienne copie du script tourne déjà, on l'arrête et on la remplace.
    try {
        for (const g of [window, typeof unsafeWindow !== "undefined" ? unsafeWindow : null]) {
            if (g && g.__blackjackAdvisor && typeof g.__blackjackAdvisor.stop === "function") g.__blackjackAdvisor.stop();
        }
    } catch { /* ignore */ }
    window.__blackjackAdvisorLoaded = true;

    const DEFAULTS = {
        botName: "Blocky,Noamis", // noms séparés par des virgules
        sendMode: "ui",         // ui = tape la commande dans le chat, api = appel direct, auto = api puis ui
        command: "blackjack",
        optionName: "amount",   // nom de l'option de la commande
        amount: 10,
        intervalSec: 15,        // intervalle entre deux tentatives d'envoi
        count: 0,               // nombre de parties à lancer (0 = illimité)
        autoPlay: false,        // clique automatiquement sur l'action recommandée
        clickDelayMs: 900,
        responseTimeoutSec: 20  // attente max d'une réponse du bot après l'envoi
    };

    const STORAGE_KEY = "BlackjackAdvisor_settings";

    // Vraie fenêtre de la page (nécessaire pour webpack, même si le script est isolé).
    const W = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;

    const TOKEN_RE = /^(mfa\.[\w-]{20,}|[\w-]{15,}\.[\w-]{4,}\.[\w-]{20,})$/;

    /* Écoute passive : mémorise l'en-tête Authorization des requêtes que Discord
       envoie lui-même (secours si webpack ne donne rien). Installé dès document-start. */
    let sniffedToken = null;
    (function installSniffer() {
        const grab = v => { if (typeof v === "string" && TOKEN_RE.test(v)) sniffedToken = v; };
        try {
            const proto = W.XMLHttpRequest.prototype;
            const orig = proto.setRequestHeader;
            proto.setRequestHeader = function (n, v) {
                try { if (String(n).toLowerCase() === "authorization") grab(v); } catch { /* ignore */ }
                return orig.apply(this, arguments);
            };
        } catch { /* ignore */ }
        try {
            const origFetch = W.fetch;
            W.fetch = function (input, init) {
                try {
                    const h = (init && init.headers) || (input && input.headers);
                    if (h) {
                        if (typeof h.get === "function") grab(h.get("Authorization"));
                        else if (!Array.isArray(h)) grab(h.Authorization || h.authorization);
                        else for (const [k, v] of h) if (String(k).toLowerCase() === "authorization") grab(v);
                    }
                } catch { /* ignore */ }
                return origFetch.apply(this, arguments);
            };
        } catch { /* ignore */ }
    })();

    /* ------------------------------------------------------------------ */
    /* Remplacements de BdApi : stockage et notifications                  */
    /* ------------------------------------------------------------------ */

    let _storage = null;
    function getStorage() {
        if (_storage) return _storage;
        const test = ls => { ls.setItem("__bja_t", "1"); ls.removeItem("__bja_t"); return ls; };
        try { _storage = test(window.localStorage); return _storage; } catch { /* suite */ }
        // Discord supprime parfois window.localStorage : on le récupère via une iframe.
        try {
            const f = document.createElement("iframe");
            f.style.display = "none";
            document.body.appendChild(f);
            _storage = test(f.contentWindow.localStorage);
            return _storage;
        } catch { /* suite */ }
        const mem = {};
        _storage = {
            getItem: k => (k in mem ? mem[k] : null),
            setItem: (k, v) => { mem[k] = String(v); }
        };
        return _storage;
    }

    function toast(message, type = "info") {
        try {
            const colors = { info: "#5865f2", success: "#23a55a", error: "#da373c", warning: "#f0b232" };
            let host = document.getElementById("bja-toast-host");
            if (!host) {
                host = document.createElement("div");
                host.id = "bja-toast-host";
                document.body.appendChild(host);
            }
            const t = document.createElement("div");
            t.className = "bja-toast";
            t.style.background = colors[type] || colors.info;
            t.textContent = message;
            host.appendChild(t);
            setTimeout(() => t.remove(), 4000);
        } catch { /* ignore */ }
    }

    /* ------------------------------------------------------------------ */
    /* Accès aux modules webpack de Discord (remplace BdApi.Webpack)       */
    /* ------------------------------------------------------------------ */

    let _req = null;
    function getWebpackRequire() {
        if (_req) return _req;
        try {
            const chunk = W.webpackChunkdiscord_app;
            if (!chunk) return null;
            let req = null;
            chunk.push([[Symbol("bja")], {}, r => { req = r; }]);
            chunk.pop();
            if (req && req.c) _req = req;
        } catch { /* ignore */ }
        return _req;
    }

    /** Parcourt les modules en protégeant chaque accès (certains exports lèvent des erreurs). */
    function findAll(predicate, max = 12) {
        const found = [];
        const cache = getWebpackRequire()?.c;
        if (!cache) return found;

        const safe = obj => {
            try { return !!obj && (typeof obj === "object" || typeof obj === "function") && predicate(obj); }
            catch { return false; }
        };

        for (const id in cache) {
            let exp;
            try { exp = cache[id]?.exports; } catch { continue; }
            if (!exp) continue;

            if (safe(exp)) found.push(exp);

            let keys = [];
            try { keys = Object.keys(exp); } catch { continue; }
            if (keys.length <= 40) {
                for (const k of keys) {
                    let candidate;
                    try { candidate = exp[k]; } catch { continue; }
                    if (candidate !== exp && safe(candidate)) found.push(candidate);
                }
            }
            if (found.length >= max) break;
        }
        return found;
    }

    const findAllByMethods = (methods, max) =>
        findAll(o => methods.every(m => typeof o[m] === "function"), max);

    const findStores = (storeName, max = 4) =>
        findAll(o => typeof o.getName === "function" && o.getName() === storeName, max);

    const sleep = ms => new Promise(r => setTimeout(r, ms));

    /* ------------------------------------------------------------------ */
    /* Plugin                                                              */
    /* ------------------------------------------------------------------ */

    class BlackjackAdvisor {
        constructor() {
            this.settings = { ...DEFAULTS };
            this.observer = null;
            this.styleId = "blackjack-advisor-style";
            this.widgetId = "blackjack-advisor-widget";
            this.scanTimer = null;
            this.results = new WeakMap();

            this.activeRound = false;
            this.sawRound = false;
            this.lastClickKey = "";
            this.lastClickAt = 0;

            this.run = { active: false, sent: 0, total: 0 };
            this.runTimer = null;
            this.sending = false;
            this.lastSend = 0;

            this.lock = null;              // embed verrouillé : { id, strict, signature, changedAt, missingSince }
            this.ignored = new Set();      // embeds abandonnés (expirés)
            this.seenIds = new Set();
            this.preSendIds = null;
            this.learnedForSend = false;
            this.learnedOwners = new Set();
            this._storeNames = null;
            this._storeTries = 0;
            this.holdTimer = null;
        }

        /* ---------------------------- Cycle de vie ---------------------------- */

        start() {
            this.loadSettings();
            this.addStyles();
            this.buildWidget();
            this.scan();

            this.observer = new MutationObserver(mutations => {
                const relevant = mutations.some(m => {
                    const t = m.target.nodeType === 1 ? m.target : m.target.parentElement;
                    return !t?.closest?.(".bja-result, .bja-widget, #bja-toast-host");
                });
                if (!relevant || this.scanTimer) return;
                this.scanTimer = setTimeout(() => {
                    this.scanTimer = null;
                    this.scan();
                }, 200);
            });

            this.observer.observe(document.body, {
                childList: true,
                subtree: true,
                characterData: true,
                attributes: true,
                attributeFilter: ["disabled", "aria-disabled"]
            });
        }

        stop() {
            this.stopRun(true);
            this.observer?.disconnect();
            this.observer = null;
            clearTimeout(this.scanTimer);
            this.scanTimer = null;

            document.querySelectorAll(".bja-result").forEach(el => el.remove());
            document.querySelectorAll(".bja-recommended").forEach(el => el.classList.remove("bja-recommended"));
            document.getElementById(this.styleId)?.remove();
            document.getElementById(this.widgetId)?.remove();
            window.__blackjackAdvisorLoaded = false;
        }

        loadSettings() {
            try {
                const saved = JSON.parse(getStorage().getItem(STORAGE_KEY) || "{}") || {};
                if (saved._v !== 2) { delete saved.botName; delete saved.sendMode; }
                this.settings = { ...DEFAULTS, ...saved, _v: 2 };
            } catch {
                this.settings = { ...DEFAULTS };
            }
        }

        saveSettings() {
            try { getStorage().setItem(STORAGE_KEY, JSON.stringify(this.settings)); } catch { /* ignore */ }
        }

        toast(message, type) { toast(message, type); }

        /* ------------------------------ Interface ------------------------------ */

        addStyles() {
            document.getElementById(this.styleId)?.remove();
            const style = document.createElement("style");
            style.id = this.styleId;
            style.textContent = `
                .bja-result {
                    margin-top: 8px; padding: 10px 12px;
                    border-left: 4px solid #5865f2; border-radius: 5px;
                    background: var(--background-secondary, #2b2d31);
                    color: var(--text-normal, #eee);
                    font-size: 13px; line-height: 1.5;
                }
                .bja-result strong { font-size: 15px; }
                .bja-result small { display: block; opacity: .8; margin-top: 4px; }
                .bja-recommended {
                    outline: 3px solid #57f287 !important;
                    outline-offset: 3px !important;
                    box-shadow: 0 0 10px #57f287 !important;
                }
                .bja-widget {
                    position: fixed; right: 16px; bottom: 90px; z-index: 9999;
                    padding: 8px 10px; border-radius: 8px;
                    background: var(--background-floating, #111214);
                    color: var(--text-normal, #eee);
                    font-size: 12px; box-shadow: 0 2px 10px rgba(0,0,0,.5);
                    display: flex; flex-direction: column; gap: 6px; min-width: 200px;
                    max-width: 260px;
                }
                .bja-widget button {
                    border: 0; border-radius: 4px; padding: 5px 8px; cursor: pointer;
                    background: #5865f2; color: #fff; font-size: 12px;
                }
                .bja-widget button.bja-stop { background: #da373c; }
                .bja-widget button.bja-gear { background: #4e5058; }
                .bja-widget label { display: flex; gap: 6px; align-items: center; cursor: pointer; }
                .bja-settings { display: none; flex-direction: column; gap: 2px; margin-top: 4px;
                    padding-top: 6px; border-top: 1px solid rgba(255,255,255,.12); }
                .bja-settings.bja-open { display: flex; }
                .bja-settings label { display: block; margin: 6px 0 2px; color: var(--header-primary, #fff); }
                .bja-settings input[type=text], .bja-settings input[type=password], .bja-settings input[type=number] {
                    width: 100%; box-sizing: border-box; padding: 5px 7px; border-radius: 4px; border: 0;
                    background: var(--input-background, #1e1f22); color: var(--text-normal, #eee);
                }
                #bja-toast-host {
                    position: fixed; top: 20px; left: 50%; transform: translateX(-50%);
                    z-index: 100000; display: flex; flex-direction: column; gap: 8px; align-items: center;
                    pointer-events: none;
                }
                .bja-toast {
                    color: #fff; padding: 10px 16px; border-radius: 6px; font-size: 14px;
                    box-shadow: 0 2px 10px rgba(0,0,0,.4);
                }
            `;
            document.head.appendChild(style);
        }

        buildWidget() {
            document.getElementById(this.widgetId)?.remove();
            const w = document.createElement("div");
            w.id = this.widgetId;
            w.className = "bja-widget";

            const status = document.createElement("div");
            status.className = "bja-status";

            const auto = document.createElement("label");
            const cb = document.createElement("input");
            cb.type = "checkbox";
            cb.checked = !!this.settings.autoPlay;
            cb.addEventListener("change", () => {
                this.settings.autoPlay = cb.checked;
                this.saveSettings();
                this.scan();
            });
            auto.append(cb, document.createTextNode("Jeu automatique"));

            const btn = document.createElement("button");
            btn.className = "bja-toggle";
            btn.addEventListener("click", () => {
                if (this.run.active) this.stopRun();
                else this.startRun();
            });

            const gear = document.createElement("button");
            gear.className = "bja-gear";
            gear.textContent = "⚙ Réglages";
            const panel = this.getSettingsPanel();
            gear.addEventListener("click", () => panel.classList.toggle("bja-open"));

            const ver = document.createElement("div");
            ver.style.cssText = "opacity:.5;font-size:10px;text-align:right";
            ver.textContent = "BlackjackAdvisor v" + VERSION;

            const dbg = document.createElement("button");
            dbg.className = "bja-gear";
            dbg.textContent = "🐞 Copier le diagnostic";
            dbg.addEventListener("click", () => this.debugDump());

            w.append(status, auto, btn, gear, dbg, panel, ver);
            document.body.appendChild(w);
            this.updateWidget();
        }

        updateWidget() {
            const w = document.getElementById(this.widgetId);
            if (!w) return;
            const status = w.querySelector(".bja-status");
            const btn = w.querySelector(".bja-toggle");
            const cb = w.querySelector("input[type=checkbox]");
            if (cb) cb.checked = !!this.settings.autoPlay;

            if (this.run.active) {
                status.textContent = `Auto : ${this.run.sent}${this.run.total ? "/" + this.run.total : ""} parties envoyées`;
                btn.textContent = "Arrêter l'envoi";
                btn.classList.add("bja-stop");
            } else {
                status.textContent = this.run.total && this.run.sent >= this.run.total
                    ? `Terminé : ${this.run.sent}/${this.run.total}`
                    : "Envoi automatique à l'arrêt";
                btn.textContent = `Lancer ${this.settings.count || "∞"}× /${this.settings.command} ${this.settings.amount}`;
                btn.classList.remove("bja-stop");
            }
            if (this.lock) status.textContent += " 🔒 partie verrouillée";
        }

        getSettingsPanel() {
            const panel = document.createElement("div");
            panel.className = "bja-settings";

            const addField = (label, key, type) => {
                const l = document.createElement("label");
                l.textContent = label;
                const input = document.createElement("input");
                input.type = type;
                input.value = this.settings[key] ?? "";
                input.addEventListener("change", () => {
                    this.settings[key] = type === "number"
                        ? Math.max(0, Number(input.value) || 0)
                        : input.value.trim();
                    this.saveSettings();
                    this.updateWidget();
                });
                panel.append(l, input);
            };

            addField("Nom(s) du bot (séparés par des virgules)", "botName", "text");
            addField("Ton pseudo (optionnel, pour reconnaître ta partie)", "myName", "text");
            addField("Commande (sans /)", "command", "text");
            addField("Nom de l'option du montant", "optionName", "text");
            addField("Montant", "amount", "number");
            addField("Intervalle entre deux envois (secondes, min. 3)", "intervalSec", "number");
            addField("Nombre de parties (0 = illimité)", "count", "number");
            addField("Délai avant clic automatique (ms)", "clickDelayMs", "number");
            addField("Attente max de réponse du bot (secondes)", "responseTimeoutSec", "number");
            addField("Méthode d'envoi : ui / api / auto", "sendMode", "text");
            addField("Token (optionnel, si détection auto impossible)", "manualToken", "password");
            return panel;
        }

        /* ------------------------------ Détection ------------------------------ */

        scan() {
            const items = [...document.querySelectorAll('li[id^="chat-messages-"], [class*="messageListItem"]')]
                .slice(-60);

            const active = [];
            const nowSeen = new Set();

            for (const message of items) {
                const raw = message.textContent || "";
                if (!/blackjack|dealer|croupier/i.test(raw)) {
                    message.querySelector(".bja-result")?.remove();
                    continue;
                }
                if (message.id) nowSeen.add(message.id);

                const entry = this.analyzeMessage(message);
                if (entry) { entry.id = message.id || ""; active.push(entry); }
            }

            this.learnOwner(active);
            for (const id of nowSeen) this.seenIds.add(id);

            const chosen = this.chooseLocked(active);
            this.activeRound = !!chosen;
            if (chosen && this.lastSend) this.sawRound = true;
            if (chosen && chosen !== "hold" && this.settings.autoPlay) this.autoClick(chosen);
            this.updateWidget();
        }

        botNameList() {
            return String(this.settings.botName || "")
                .split(",").map(x => x.trim().toLowerCase()).filter(Boolean);
        }

        /** Pseudos du joueur : réglage manuel, compte Discord, pseudos déjà repérés sur ses parties. */
        getMyNames() {
            const names = new Set();
            String(this.settings.myName || "").split(",").map(x => x.trim().toLowerCase()).filter(Boolean)
                .forEach(n => names.add(n));
            this.learnedOwners.forEach(n => names.add(n));

            if (!(this._storeNames && this._storeNames.length) && this._storeTries < 5) {
                this._storeTries++;
                const found = [];
                try {
                    for (const st of findStores("UserStore", 2)) {
                        const u = st.getCurrentUser && st.getCurrentUser();
                        if (u) for (const v of [u.username, u.globalName, u.global_name]) if (v) found.push(String(v).toLowerCase());
                        if (found.length) break;
                    }
                } catch { /* ignore */ }
                this._storeNames = found;
            }
            (this._storeNames || []).forEach(n => names.add(n));
            return [...names];
        }

        /** Pseudo du joueur qui a lancé la partie (en-tête « X a utilisé /blackjack »), sinon null. */
        ownerOf(message) {
            if (!/\s(?:a utilisé|used)\s/i.test(message.textContent || "")) return null;
            const bots = this.botNameList();
            const names = [...message.querySelectorAll('[class*="username"]')]
                .map(e => (e.textContent || "").trim().toLowerCase()).filter(Boolean);
            return names.find(n => !bots.some(b => n.includes(b))) || null;
        }

        /** true = ma partie, false = celle d'un autre joueur, null = inconnu. */
        mineState(message) {
            const owner = this.ownerOf(message);
            const names = this.getMyNames();
            if (!owner || !names.length) return null;
            return names.some(n => owner.includes(n) || n.includes(owner));
        }

        /** Après un envoi, le premier nouvel embed du bot est le nôtre : on retient son pseudo. */
        learnOwner(active) {
            if (!this.run.active || !this.preSendIds || this.learnedForSend) return;
            if (Date.now() - this.lastSend > 60000) return;
            const fresh = active.filter(e => e.id && !this.preSendIds.has(e.id));
            if (!fresh.length) return;
            if (fresh.some(e => this.mineState(e.message) === true)) { this.learnedForSend = true; return; }
            const owner = this.ownerOf(fresh[fresh.length - 1].message);
            if (owner) {
                this.learnedOwners.add(owner);
                this.learnedForSend = true;
                console.debug("[BlackjackAdvisor] pseudo de joueur repéré :", owner);
            }
        }

        acquireLock(entry, strict) {
            this.lock = { id: entry.id, strict, signature: entry.signature, changedAt: Date.now(), missingSince: 0 };
            console.debug("[BlackjackAdvisor] embed verrouillé :", entry.id, strict ? "(ma partie)" : "(propriétaire inconnu)");
            if (this.settings.autoPlay) {
                try { entry.message.scrollIntoView({ block: "end", behavior: "smooth" }); } catch { /* ignore */ }
            }
        }

        releaseLock(reason) {
            console.debug("[BlackjackAdvisor] verrou levé :", reason);
            this.lock = null;
        }

        /** Garde l'attention sur UN seul embed jusqu'à la fin de la partie. */
        chooseLocked(active) {
            const now = Date.now();

            if (this.lock) {
                const lock = this.lock;
                const cur = active.find(e => e.id === lock.id);
                const strictOther = active.some(e => e.id !== lock.id && !this.ignored.has(e.id) && this.mineState(e.message) === true);

                if (cur && (lock.strict || !strictOther)) {
                    lock.missingSince = 0;
                    if (cur.signature !== lock.signature) { lock.signature = cur.signature; lock.changedAt = now; }
                    if (now - lock.changedAt < 120000) return cur;
                    this.ignored.add(lock.id);              // bloqué trop longtemps : on abandonne cet embed
                    this.releaseLock("expiré (aucun changement depuis 2 min)");
                } else if (cur) {
                    // Ma propre partie est apparue : elle prend la priorité sur un embed au propriétaire incertain.
                    this.releaseLock("remplacé par ma partie");
                } else {
                    // Plus actif : partie terminée, ou simple re-rendu de Discord (courte tolérance).
                    const el = lock.id && document.getElementById(lock.id);
                    if (!lock.missingSince) lock.missingSince = now;
                    if (el && now - lock.missingSince < 2500) {
                        if (!this.holdTimer) {
                            this.holdTimer = setTimeout(() => { this.holdTimer = null; this.scan(); }, 1200);
                        }
                        return "hold";
                    }
                    this.releaseLock(el ? "partie terminée" : "message disparu");
                }
            }

            const alive = active.filter(e => !this.ignored.has(e.id));
            const mine = alive.filter(e => this.mineState(e.message) === true);
            const unknown = alive.filter(e => this.mineState(e.message) === null);
            const pick = mine.length ? mine[mine.length - 1] : (unknown.length ? unknown[unknown.length - 1] : null);
            if (pick) this.acquireLock(pick, mine.includes(pick));
            return pick;
        }

        isBotAuthor(message) {
            const names = this.botNameList();
            if (!names.length) return true;

            // Les messages groupés n'ont pas d'en-tête : remonter aux frères précédents.
            // Une réponse de commande contient aussi le pseudo du joueur : on accepte si UN des noms est celui du bot.
            let node = message;
            for (let i = 0; node && i < 25; i++, node = node.previousElementSibling) {
                const found = [...node.querySelectorAll('[class*="username"], [class*="headerText"], [class*="messageAuthor"]')]
                    .map(el => (el.textContent || "").trim().toLowerCase()).filter(Boolean);
                if (found.length) return found.some(name => names.some(n => name.includes(n)));
            }
            return false;
        }

        analyzeMessage(message) {
            if (!this.isBotAuthor(message)) {
                message.querySelector(".bja-result")?.remove();
                return null;
            }

            const text = this.extractText(message);
            const buttons = this.findActionButtons(message);
            const result = this.analyze(text, buttons);

            if (!result) {
                message.querySelector(".bja-result")?.remove();
                message.querySelectorAll(".bja-recommended").forEach(b => b.classList.remove("bja-recommended"));
                return null;
            }

            const signature = JSON.stringify([result.actionCode, result.playerTotal, result.dealerUp, result.cardsKey]);

            if (this.results.get(message) !== signature || !message.querySelector(".bja-result")) {
                this.results.set(message, signature);
                message.querySelector(".bja-result")?.remove();

                const panel = document.createElement("div");
                panel.className = "bja-result";

                const heading = document.createElement("div");
                const strong = document.createElement("strong");
                strong.textContent = `🎴 ${result.action}`;
                heading.appendChild(strong);

                const detail = document.createElement("div");
                detail.textContent = result.reason;

                const totals = document.createElement("small");
                totals.textContent =
                    `Joueur : ${result.playerTotal}${result.soft ? " (souple)" : ""}` +
                    ` | Croupier visible : ${result.dealerUp === 11 ? "As" : result.dealerUp}` +
                    (result.hiddenDealer ? " + carte cachée" : "");

                panel.append(heading, detail, totals);
                message.appendChild(panel);
            }

            const button = this.highlightRecommended(buttons, result.actionCode);
            return { message, result, button, signature };
        }

        /** Texte du message, avec les alt des images et sauts de ligne sur les blocs. */
        extractText(root) {
            let out = "";
            const walk = n => {
                if (n.nodeType === 3) { out += n.nodeValue; return; }
                if (n.nodeType !== 1) return;
                if (n.classList?.contains("bja-result")) return;
                const tag = n.tagName;
                if (tag === "IMG") { out += ` ${n.alt || n.getAttribute("aria-label") || ""} `; return; }
                if (tag === "BUTTON" || tag === "STYLE" || tag === "SCRIPT") return;
                if (tag === "BR") { out += "\n"; return; }
                const block = /^(DIV|P|LI|SECTION|ARTICLE|H\d|TR)$/.test(tag);
                if (block) out += "\n";
                for (const c of n.childNodes) walk(c);
                if (block) out += "\n";
            };
            walk(root);
            return out.replace(/[ \t\u00a0]+/g, " ").replace(/\n\s*/g, "\n");
        }

        analyze(text, buttons) {
            const hasButtons = buttons.some(b => !b.disabled);
            const hasPrompt = /hit,?\s*stand|stand\s*or\s*double|tirer|rester|doubler/i.test(text);
            if (!hasButtons && !hasPrompt) return null;

            const { dealer, player } = this.parseTable(text);
            if (!dealer || !player || !player.cards.length || !dealer.cards.length) return null;
            if (player.total >= 21) return null; // 21 ou bust : rien à décider

            const dealerUp = dealer.cards[0].value;

            const byAction = Object.fromEntries(buttons.map(b => [b.action, b]));
            const canDouble = buttons.length
                ? !!byAction.DOUBLE && !byAction.DOUBLE.disabled
                : player.cards.length === 2;

            const code = this.chooseAction(player.cards, player.total, player.soft, dealerUp, canDouble);

            const labels = {
                HIT: "HIT — Tirer une carte",
                STAND: "STAND — Rester",
                DOUBLE: "DOUBLE — Doubler la mise"
            };

            return {
                action: labels[code],
                actionCode: code,
                playerTotal: player.total,
                dealerUp,
                soft: player.soft,
                hiddenDealer: dealer.hidden,
                cardsKey: player.cards.map(c => c.rank).join(""),
                reason: this.explain(code, player, dealerUp, canDouble)
            };
        }

        parseTable(text) {
            const labelRe = /\b(dealer|croupier|banque|your hand|your cards|you|vous|player|joueur|ta main|votre main)\b/gi;
            const cardRe = /(10|[2-9]|[AJQK])\s*([♠♥♦♣♤♡♢♧])|([♠♥♦♣♤♡♢♧])\s*(10|[2-9]|[AJQK])/g;
            const hiddenRe = /🂠|🎴|🃏|❓|\[\?\]|\?|hidden|cachée/i;

            const events = [];
            let m;
            while ((m = labelRe.exec(text)) !== null) {
                const word = m[1].toLowerCase();
                const side = /dealer|croupier|banque/.test(word) ? "dealer" : "player";
                events.push({ pos: m.index, end: m.index + m[0].length, side });
            }

            const segments = [];
            for (let i = 0; i < events.length; i++) {
                const e = events[i];
                const segText = text.slice(e.end, i + 1 < events.length ? events[i + 1].pos : text.length);
                const cards = [];
                let c;
                cardRe.lastIndex = 0;
                while ((c = cardRe.exec(segText)) !== null) {
                    const rank = (c[1] || c[4]).toUpperCase();
                    cards.push({ rank, value: this.rankValue(rank) });
                }
                segments.push({ side: e.side, cards, hidden: hiddenRe.test(segText) });
            }

            const pick = side => {
                const seg = segments.find(s => s.side === side && s.cards.length);
                if (!seg) return null;
                const hv = this.handValue(seg.cards);
                return { cards: seg.cards, total: hv.total, soft: hv.soft, hidden: seg.hidden };
            };

            return { dealer: pick("dealer"), player: pick("player") };
        }

        rankValue(rank) {
            if (rank === "A") return 11;
            if (["K", "Q", "J", "10"].includes(rank)) return 10;
            return Number(rank);
        }

        handValue(cards) {
            let total = cards.reduce((s, c) => s + c.value, 0);
            let aces = cards.filter(c => c.rank === "A").length;
            while (total > 21 && aces > 0) { total -= 10; aces--; }
            return { total, soft: aces > 0 };
        }

        /* ------------- Stratégie de base (croupier reste sur 17, sans split) ------------- */

        chooseAction(cards, total, soft, dealer, canDouble) {
            const two = cards.length === 2;
            const dbl = two && canDouble;
            const inRange = (lo, hi) => dealer >= lo && dealer <= hi;

            if (soft) {
                if (total >= 19) return "STAND";
                if (total === 18) {
                    if (inRange(3, 6)) return dbl ? "DOUBLE" : "STAND";
                    if (dealer === 2 || dealer === 7 || dealer === 8) return "STAND";
                    return "HIT"; // 9, 10, As
                }
                if (total === 17) return dbl && inRange(3, 6) ? "DOUBLE" : "HIT";
                if (total === 15 || total === 16) return dbl && inRange(4, 6) ? "DOUBLE" : "HIT";
                if (total === 13 || total === 14) return dbl && inRange(5, 6) ? "DOUBLE" : "HIT";
                return "HIT";
            }

            if (total >= 17) return "STAND";
            if (total >= 13) return inRange(2, 6) ? "STAND" : "HIT";
            if (total === 12) return inRange(4, 6) ? "STAND" : "HIT";
            if (total === 11) return dbl && dealer <= 10 ? "DOUBLE" : "HIT";
            if (total === 10) return dbl && dealer <= 9 ? "DOUBLE" : "HIT";
            if (total === 9) return dbl && inRange(3, 6) ? "DOUBLE" : "HIT";
            return "HIT";
        }

        explain(action, player, dealer, canDouble) {
            const up = dealer === 11 ? "As" : String(dealer);
            const kind = player.soft ? "souple" : "dur";
            const base = `Main ${kind} ${player.total} contre ${up} : `;

            if (action === "DOUBLE") return base + "situation favorable, doubler maximise l'espérance.";
            if (action === "HIT") {
                const note = !canDouble && player.cards.length === 2 && [9, 10, 11].includes(player.total) && !player.soft
                    ? " (Double indisponible)" : "";
                return base + "tirer est recommandé." + note;
            }
            return base + "rester est recommandé.";
        }

        debugDump() {
            const items = [...document.querySelectorAll('li[id^="chat-messages-"]')].slice(-25)
                .filter(m => /blackjack|dealer|croupier|hit|stand/i.test(m.textContent || ""));
            const msgs = items.slice(-3).map(m => ({
                id: m.id,
                botAuthor: this.isBotAuthor(m),
                owner: this.ownerOf(m),
                mine: this.mineState(m),
                text: this.extractText(m).slice(0, 900),
                buttons: [...m.querySelectorAll("button, [role='button']")].map(b => ({
                    label: (b.innerText || b.textContent || "").trim(),
                    aria: b.getAttribute("aria-label"),
                    disabled: !!(b.disabled || b.getAttribute("aria-disabled") === "true")
                })),
                analysis: (() => {
                    try {
                        const r = this.analyze(this.extractText(m), this.findActionButtons(m));
                        return r && { action: r.actionCode, player: r.playerTotal, dealer: r.dealerUp };
                    } catch { return null; }
                })()
            }));
            const dump = JSON.stringify({ version: VERSION, myNames: this.getMyNames(), lock: this.lock, messages: msgs }, null, 1);
            console.log("[BlackjackAdvisor diagnostic]", dump);
            try {
                navigator.clipboard.writeText(dump).then(
                    () => this.toast("Diagnostic copié dans le presse-papiers", "success"),
                    () => this.toast("Copie impossible : voir la console (F12)", "warning")
                );
            } catch { this.toast("Copie impossible : voir la console (F12)", "warning"); }
        }

        /* ------------------------------- Boutons ------------------------------- */

        findActionButtons(message) {
            const found = new Map();

            for (const button of message.querySelectorAll("button, [role='button']")) {
                const label = [
                    button.innerText || button.textContent,
                    button.getAttribute("aria-label"),
                    button.getAttribute("title"),
                    ...[...button.querySelectorAll("img[alt]")].map(i => i.alt)
                ].filter(Boolean).join(" ").trim().toLowerCase();

                let action = null;
                if (/\b(double|doubler)\b/.test(label)) action = "DOUBLE";
                else if (/\b(hit|tirer|piocher|draw)\b/.test(label)) action = "HIT";
                else if (/\b(stand|rester|rest|stay|garder)\b/.test(label)) action = "STAND";
                if (!action) continue;

                const disabled = button.disabled || button.getAttribute("aria-disabled") === "true";
                found.set(action, { action, button, disabled });
            }

            return [...found.values()];
        }

        highlightRecommended(buttons, action) {
            buttons.forEach(({ button }) => button.classList.remove("bja-recommended"));
            const match = buttons.find(b => b.action === action && !b.disabled);
            if (match) match.button.classList.add("bja-recommended");
            return match?.button || null;
        }

        autoClick({ message, result, signature }) {
            const key = `${message.id || ""}|${signature}`;
            const now = Date.now();
            if (key === this.lastClickKey && now - this.lastClickAt < 6000) return;

            this.lastClickKey = key;
            this.lastClickAt = now;

            setTimeout(() => {
                if (!this.settings.autoPlay) return;
                // Discord remplace souvent les boutons à chaque mise à jour : on les retrouve au moment du clic.
                const msg = (message.id && document.getElementById(message.id)) || message;
                const target = this.findActionButtons(msg).find(b => b.action === result.actionCode && !b.disabled);
                if (!target) { this.lastClickKey = ""; return; }   // nouvelle tentative au prochain scan
                this.pressButton(target.button);
            }, Math.max(200, Number(this.settings.clickDelayMs) || 900));
        }

        pressButton(btn) {
            try { btn.scrollIntoView({ block: "nearest" }); } catch { /* ignore */ }
            const r = btn.getBoundingClientRect();
            const base = {
                bubbles: true, cancelable: true, composed: true, button: 0,
                clientX: Math.round(r.left + r.width / 2), clientY: Math.round(r.top + r.height / 2)
            };
            for (const type of ["pointerover", "mouseover", "pointerdown", "mousedown", "pointerup", "mouseup"]) {
                try {
                    const Ctor = type.startsWith("pointer") ? W.PointerEvent : W.MouseEvent;
                    btn.dispatchEvent(new Ctor(type, { ...base, isPrimary: true, pointerType: "mouse" }));
                } catch { /* ignore */ }
            }
            btn.click();
        }

        /* ------------------------ Envoi périodique de la commande ------------------------ */

        startRun() {
            const total = Math.max(0, Math.floor(Number(this.settings.count) || 0)); // 0 = illimité
            const interval = Math.max(3, Number(this.settings.intervalSec) || 15);

            this.stopRun(true);
            this.run = { active: true, sent: 0, total };
            this.sawRound = false;
            this.lastSend = 0;

            if (!this.settings.autoPlay) {
                this.settings.autoPlay = true;
                this.saveSettings();
            }

            this.runTimer = setInterval(() => this.tick(), interval * 1000);
            this.updateWidget();
            this.toast(`Envoi automatique lancé : ${total || "∞"} × /${this.settings.command} ${this.settings.amount}`, "success");
            this.tick();
        }

        stopRun(silent = false) {
            clearInterval(this.runTimer);
            this.runTimer = null;
            if (this.run.active && !silent) this.toast("Envoi automatique arrêté", "info");
            this.run.active = false;
            this.updateWidget();
        }

        async tick() {
            if (!this.run.active || this.sending) return;

            if (this.run.total && this.run.sent >= this.run.total) { this.stopRun(); return; }

            // Une main est en cours : on attend qu'elle soit terminée.
            if (this.activeRound) return;

            // Commande envoyée récemment, pas encore de réponse du bot.
            const timeout = Math.max(5, Number(this.settings.responseTimeoutSec) || 20) * 1000;
            if (this.lastSend && !this.sawRound && Date.now() - this.lastSend < timeout) return;

            this.sending = true;
            try {
                this.preSendIds = new Set(this.seenIds);
                this.learnedForSend = false;
                await this.sendCommand();
                this.run.sent++;
                this.lastSend = Date.now();
                this.sawRound = false;
                if (this.run.total && this.run.sent >= this.run.total) {
                    clearInterval(this.runTimer);
                    this.runTimer = null;
                    this.run.active = false;
                    this.toast("Toutes les parties ont été lancées", "success");
                }
            } catch (err) {
                this.toast(`Envoi interrompu : ${err.message}`, "error");
                this.stopRun(true);
            } finally {
                this.sending = false;
                this.updateWidget();
            }
        }

        /* -------------------- Exécution de la commande slash (API) -------------------- */

        resolveString(candidates, method, minLength) {
            for (const c of candidates) {
                try {
                    const v = c[method]();
                    if (typeof v === "string" && v.length >= minLength) return v;
                } catch { /* candidat suivant */ }
            }
            return null;
        }

        getToken() {
            const valid = v => typeof v === "string" && TOKEN_RE.test(v);

            // 0. Token saisi à la main dans les réglages.
            const manual = String(this.settings.manualToken || "").trim().replace(/^"|"$/g, "");
            if (valid(manual)) return manual;

            if (valid(this._token)) return this._token;

            // 1. Modules webpack : tout objet exposant getToken() qui renvoie un vrai token.
            const cands = [...findStores("AuthenticationStore"), ...findAll(o => typeof o.getToken === "function", 30)];
            for (const c of cands) {
                try { const v = c.getToken(); if (valid(v)) return (this._token = v); } catch { /* suivant */ }
            }

            // 2. En-tête Authorization capté sur une requête de Discord.
            if (valid(sniffedToken)) return (this._token = sniffedToken);

            // 3. localStorage via une iframe (Discord le retire de la fenêtre principale).
            try {
                const f = document.createElement("iframe");
                f.style.display = "none";
                document.body.appendChild(f);
                const raw = f.contentWindow.localStorage.getItem("token");
                f.remove();
                const v = raw && raw.replace(/^"|"$/g, "");
                if (valid(v)) return (this._token = v);
            } catch { /* ignore */ }

            throw new Error("token Discord introuvable : change de salon ou envoie un message à la main puis relance, ou colle ton token dans ⚙ Réglages");
        }

        getSessionId() {
            const sources = [
                ...findStores("AuthenticationStore"),
                ...findStores("SessionsStore"),
                ...findStores("SessionStore")
            ];
            let id = this.resolveString(sources, "getSessionId", 16);
            if (id) return id;

            const sockets = [
                ...findStores("GatewayConnectionStore"),
                ...findAllByMethods(["getSocket"], 4)
            ];
            for (const st of sockets) {
                try {
                    const sock = st.getSocket();
                    const sid = sock?.sessionId || sock?.session_id;
                    if (typeof sid === "string" && sid.length >= 16) return sid;
                } catch { /* suivant */ }
            }

            return this.resolveString(findAllByMethods(["getSessionId"]), "getSessionId", 16);
        }

        /** Dernier recours : identifiant de session généré localement. */
        fallbackSessionId() {
            if (!this._fakeSession) {
                const bytes = new Uint8Array(16);
                crypto.getRandomValues(bytes);
                this._fakeSession = [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
                this.toast("Session Discord introuvable : identifiant de session généré localement.", "warning");
            }
            return this._fakeSession;
        }

        /** Salon et serveur lus directement dans l'URL. */
        getLocation() {
            const m = location.pathname.match(/^\/channels\/(@me|\d+)\/(\d+)/);
            if (!m) return null;
            return { guildId: m[1] === "@me" ? null : m[1], channelId: m[2] };
        }

        async api(method, path, body) {
            const res = await fetch(`${location.origin}/api/v9${path}`, {
                method,
                headers: { Authorization: this.getToken() },
                body
            });

            if (res.status === 204) return null;

            let data = null;
            try { data = await res.json(); } catch { /* corps vide */ }

            if (!res.ok) {
                if (res.status === 401) this._token = null;
                if (res.status === 429) {
                    const wait = data?.retry_after ? ` (réessayer dans ${Math.ceil(data.retry_after)} s)` : "";
                    throw new Error(`limite de débit Discord${wait}`);
                }
                throw new Error(data?.message ? `${data.message} [${res.status}]` : `HTTP ${res.status}`);
            }
            return data;
        }

        async findCommands(channelId, guildId, name) {
            const botNames = String(this.settings.botName || "")
                .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
            const cacheKey = `${channelId}|${name}|${botNames.join(",")}`;

            this.cmdCache = this.cmdCache || new Map();
            if (this.cmdCache.has(cacheKey)) return this.cmdCache.get(cacheKey);

            let data = null;
            const paths = [`/channels/${channelId}/application-command-index`];
            if (guildId) paths.push(`/guilds/${guildId}/application-command-index`);

            let lastErr = null;
            for (const p of paths) {
                try { data = await this.api("GET", p); if (data) break; } catch (e) { lastErr = e; }
            }
            if (!data) throw lastErr || new Error("index des commandes indisponible");

            const apps = new Map((data.applications || []).filter(Boolean).map(a => [a.id, a]));
            const appName = c => String(apps.get(c.application_id)?.name || "");

            const commands = (data.application_commands || [])
                .filter(c => c && c.name === name && (c.type == null || c.type === 1) && c.application_id);

            if (!commands.length) throw new Error(`commande /${name} introuvable dans ce salon`);

            const score = c => {
                const n = appName(c).toLowerCase();
                return botNames.some(b => n.includes(b)) ? 0 : 1;
            };

            const ordered = commands
                .map((c, i) => ({ c, i }))
                .sort((a, b) => score(a.c) - score(b.c) || a.i - b.i)
                .map(x => ({ cmd: x.c, app: appName(x.c) || x.c.application_id }));

            this.cmdCache.set(cacheKey, ordered);
            return ordered;
        }

        makeNonce() {
            return ((BigInt(Date.now()) - 1420070400000n) << 22n).toString();
        }

        buildPayload(cmd, loc, sessionId) {
            const optionName = String(this.settings.optionName || "amount");
            const option = (cmd.options || []).find(o => o && o.name === optionName);
            const optionType = option && option.type != null ? option.type : 4; // 3 texte, 4 entier, 10 nombre
            const value = optionType === 3 ? String(this.settings.amount) : Number(this.settings.amount);

            const payload = {
                type: 2,
                application_id: cmd.application_id,
                channel_id: loc.channelId,
                session_id: sessionId,
                nonce: this.makeNonce(),
                analytics_location: "slash_ui",
                data: {
                    version: cmd.version,
                    id: cmd.id,
                    name: cmd.name,
                    type: cmd.type == null ? 1 : cmd.type,
                    options: [{ type: optionType, name: optionName, value }],
                    application_command: cmd,
                    attachments: []
                }
            };
            if (loc.guildId) payload.guild_id = loc.guildId;
            return payload;
        }

        /* ---------------- Envoi : choix de la méthode ---------------- */

        async sendCommand() {
            const mode = String(this.settings.sendMode || "ui").trim().toLowerCase();
            if (mode === "api") return this.sendViaApi();
            if (mode === "auto") {
                try { return await this.sendViaApi(); }
                catch (e) { console.warn("[BlackjackAdvisor] API refusée, bascule sur l'interface :", e.message); }
            }
            return this.sendViaUI();
        }

        /* ------- Envoi via l'interface : tape /commande comme un humain ------- */

        async waitFor(fn, timeout = 3000, step = 100) {
            const end = Date.now() + timeout;
            while (Date.now() < end) {
                let v = null;
                try { v = fn(); } catch { /* ignore */ }
                if (v) return v;
                await sleep(step);
            }
            return null;
        }

        getEditor() {
            return document.querySelector('form [role="textbox"][contenteditable="true"]')
                || document.querySelector('[role="textbox"][data-slate-editor="true"]')
                || document.querySelector('div[class*="slateTextArea"]');
        }

        pressKey(el, key, code, keyCode) {
            for (const type of ["keydown", "keyup"]) {
                const ev = new W.KeyboardEvent(type, { key, code, keyCode, which: keyCode, bubbles: true, cancelable: true, composed: true });
                try {
                    Object.defineProperty(ev, "keyCode", { get: () => keyCode });
                    Object.defineProperty(ev, "which", { get: () => keyCode });
                } catch { /* ignore */ }
                el.dispatchEvent(ev);
            }
        }

        clickEl(el) {
            for (const type of ["mousedown", "mouseup", "click"]) {
                el.dispatchEvent(new W.MouseEvent(type, { bubbles: true, cancelable: true }));
            }
        }

        clearEditor() {
            try { document.execCommand("selectAll"); document.execCommand("delete"); } catch { /* ignore */ }
        }

        /**
         * Saisie reconnue par l'éditeur de Discord (Slate). Un simple execCommand modifie le DOM
         * sans mettre à jour l'état de l'éditeur : l'autocomplétion ne s'ouvre pas.
         * Stratégies : 1) bus interne de Discord (INSERT_TEXT), 2) événements beforeinput
         * caractère par caractère, 3) execCommand en dernier recours.
         */
        async typeText(editor, text, verify) {
            const activeTarget = () => {
                const a = document.activeElement;
                return a && editor.contains(a) ? a : editor;
            };
            const ok = () => { try { return !verify || verify(); } catch { return false; } };

            // 1. Bus d'événements interne de Discord
            try {
                const dispatchers = findAll(o => typeof o.dispatchToLastSubscribed === "function", 6);
                for (const cd of dispatchers) {
                    try {
                        cd.dispatchToLastSubscribed("INSERT_TEXT", { plainText: text, rawText: text });
                        await sleep(250);
                        if (ok()) return "discord";
                    } catch { /* suivant */ }
                }
            } catch { /* ignore */ }

            // 2. beforeinput caractère par caractère (géré nativement par Slate)
            try {
                for (const ch of text) {
                    const ev = new W.InputEvent("beforeinput", {
                        inputType: "insertText", data: ch, bubbles: true, cancelable: true, composed: true
                    });
                    activeTarget().dispatchEvent(ev);
                    await sleep(45);
                }
                await sleep(200);
                if (ok()) return "beforeinput";
            } catch { /* ignore */ }

            // 3. execCommand
            try {
                document.execCommand("insertText", false, text);
                await sleep(200);
                if (ok()) return "execCommand";
            } catch { /* ignore */ }

            return null;
        }

        async sendViaUI() {
            if (!this.getLocation()) throw new Error("ouvre le salon du blackjack (aucun salon détecté dans l'URL)");

            const name = String(this.settings.command || "blackjack").replace(/^\//, "").toLowerCase();
            const botNames = String(this.settings.botName || "")
                .split(",").map(x => x.trim().toLowerCase()).filter(Boolean);

            const editor = await this.waitFor(() => this.getEditor(), 3000);
            if (!editor) throw new Error("interface : zone de texte introuvable");
            const editorText = () => (editor.textContent || "").trim();

            editor.focus();
            this.clearEditor();
            await sleep(200);

            const how = await this.typeText(editor, "/" + name, () => editorText().toLowerCase().includes(name));
            if (!how) throw new Error("interface : impossible de saisir du texte dans la zone de message");

            // Attendre la liste d'autocomplétion.
            const rowSelector = '[role="option"], [class*="autocompleteRow"], [id^="autocomplete-"]';
            const getRows = () => {
                const rows = [...document.querySelectorAll(rowSelector)]
                    .filter(o => o.offsetParent !== null && (o.textContent || "").toLowerCase().includes(name));
                // Garder les lignes les plus internes (évite de compter conteneur + ligne).
                return rows.filter(r => !rows.some(o => o !== r && r.contains(o)));
            };
            const rows = await this.waitFor(() => { const r = getRows(); return r.length ? r : null; }, 5000);

            if (!rows) {
                const seen = document.querySelectorAll(rowSelector).length;
                const txt = editorText().slice(0, 40);
                this.clearEditor();
                throw new Error(`interface : autocomplétion de /${name} introuvable (saisie « ${txt} » via ${how}, ${seen} suggestion(s) visibles)`);
            }

            // Sélection au clavier : la première suggestion est surlignée par défaut.
            // Si une suggestion du bot voulu est plus bas, on descend jusqu'à elle.
            const wanted = rows.findIndex(o => botNames.some(b => (o.textContent || "").toLowerCase().includes(b)));
            const downs = wanted > 0 ? wanted : 0;
            const kb = () => document.activeElement && editor.contains(document.activeElement) ? document.activeElement : editor;
            for (let i = 0; i < downs; i++) {
                this.pressKey(kb(), "ArrowDown", "ArrowDown", 40);
                await sleep(120);
            }
            this.pressKey(kb(), "Enter", "Enter", 13);

            // Attendre que la liste se ferme (commande sélectionnée).
            const closed = await this.waitFor(() => getRows().length === 0, 3000, 100);
            if (!closed) {
                // Secours : clic sur la suggestion choisie.
                const target = rows[wanted > 0 ? wanted : 0];
                for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
                    const Ctor = type.startsWith("pointer") ? W.PointerEvent : W.MouseEvent;
                    target.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true }));
                }
            }
            await sleep(600);

            // Le champ d'option doit maintenant exister : saisir le montant.
            if (!editor.contains(document.activeElement)) editor.focus();
            const amount = String(this.settings.amount);
            const typed = await this.typeText(editor, amount, () => editorText().includes(amount));
            if (!typed) {
                this.clearEditor();
                throw new Error(`interface : impossible de saisir le montant ${amount} (la commande n'a pas été sélectionnée ?)`);
            }
            await sleep(300);

            const press = el => this.pressKey(el, "Enter", "Enter", 13);
            const target = document.activeElement && editor.contains(document.activeElement) ? document.activeElement : editor;
            press(target);

            let sent = await this.waitFor(() => !editorText(), 2500, 150);
            if (!sent) {
                // Deuxième tentative sur la racine de l'éditeur.
                press(editor);
                sent = await this.waitFor(() => !editorText(), 2500, 150);
            }
            if (!sent) {
                const txt = editorText().slice(0, 60);
                this.clearEditor();
                throw new Error(`interface : la commande n'a pas été validée (contenu restant : « ${txt} »)`);
            }
        }

        /* ------------------- Envoi via l'API (mode api / auto) ------------------- */

        async sendViaApi() {
            let step = "salon";
            try {
                const loc = this.getLocation();
                if (!loc) throw new Error("ouvre le salon du blackjack (aucun salon détecté dans l'URL)");

                step = "session";
                let sessionId = this.getSessionId();
                const realSession = !!sessionId;
                if (!sessionId) sessionId = this.fallbackSessionId();

                step = "commande";
                const name = String(this.settings.command || "blackjack").replace(/^\//, "");
                let candidates;
                try {
                    candidates = await this.findCommands(loc.channelId, loc.guildId, name);
                } catch (err) {
                    this.cmdCache?.clear();
                    throw err;
                }

                this.goodCommand = this.goodCommand || new Map();
                const goodKey = `${loc.channelId}|${name}`;
                const good = this.goodCommand.get(goodKey);
                if (good) {
                    const idx = candidates.findIndex(x => x.cmd.id === good);
                    if (idx > 0) candidates = [candidates[idx], ...candidates.filter((_, i) => i !== idx)];
                }

                step = "envoi";
                const failures = [];
                for (const { cmd, app } of candidates) {
                    const variants = [
                        payload => payload,
                        payload => { delete payload.data.application_command; return payload; }
                    ];
                    for (const variant of variants) {
                        try {
                            const payload = variant(this.buildPayload(cmd, loc, sessionId));
                            const form = new FormData();
                            form.append("payload_json", JSON.stringify(payload));
                            await this.api("POST", "/interactions", form);
                            this.goodCommand.set(goodKey, cmd.id);
                            return;
                        } catch (err) {
                            failures.push(`${app} : ${err.message}`);
                            if (/limite de débit/.test(err.message)) break;
                        }
                    }
                    if (failures.some(f => /limite de débit/.test(f))) break;
                }

                failures.push(realSession ? "(session réelle)" : "(session générée : introuvable)");
                this.cmdCache?.clear();
                this.goodCommand.delete(goodKey);
                throw new Error(failures.join(" | "));
            } catch (err) {
                throw new Error(`${step} : ${err?.message || err}`);
            }
        }
    }

    /* ------------------------------------------------------------------ */
    /* Démarrage : attendre que l'interface Discord soit chargée           */
    /* ------------------------------------------------------------------ */

    async function boot() {
        for (let i = 0; i < 120; i++) {
            if (document.body && W.webpackChunkdiscord_app &&
                document.querySelector('[class*="app"], #app-mount')) break;
            await sleep(500);
        }
        const plugin = new BlackjackAdvisor();
        W.__blackjackAdvisor = plugin; // pour debug : __blackjackAdvisor.stop()
        plugin.start();
        toast(`BlackjackAdvisor v${VERSION} actif`, "success");
    }

    boot();
})();
