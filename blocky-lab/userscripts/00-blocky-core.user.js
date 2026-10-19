// ==UserScript==
// @name         Blocky Lab · 00 · Core
// @namespace    blocky-lab
// @version      1.4.2
// @description  Noyau partagé du Blocky Lab : capture d'embeds, IndexedDB, accès aux modules Discord, envoi de commandes, panneau à onglets personnalisable, statistiques.
// @match        https://discord.com/*
// @match        https://canary.discord.com/*
// @match        https://ptb.discord.com/*
// @run-at       document-start
// @noframes
// @grant        unsafeWindow
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @connect      localhost
// ==/UserScript==

/* global GM_getValue, GM_setValue, GM_xmlhttpRequest, GM_registerMenuCommand, unsafeWindow */

(function () {
    "use strict";

    const W = (typeof unsafeWindow !== "undefined" && unsafeWindow) ? unsafeWindow : window;
    if (W.BlockyLab && W.BlockyLab.version) {
        console.info("[BlockyLab] core déjà chargé, on ne réinstalle pas.");
        return;
    }

    const VERSION = "1.4.2";
    const PREFIX = "blockylab.";
    const DB_NAME = "blocky-lab";
    const DB_STORE = "obs";
    const NC = "[BlockyLab]";

    /* ------------------------------------------------------------------ */
    /* Utilitaires                                                         */
    /* ------------------------------------------------------------------ */

    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const clamp = (v, lo, hi, def) => {
        const n = Number(v);
        return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : def;
    };
    const num = (v, def = 0) => {
        if (typeof v === "number") return Number.isFinite(v) ? v : def;
        const n = Number(String(v ?? "").replace(/[^\d.,-]/g, "").replace(",", "."));
        return Number.isFinite(n) ? n : def;
    };
    const safe = (fn, def) => { try { return fn(); } catch (e) { console.warn(NC, e); return def; } };
    const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const nowISO = () => new Date().toISOString();
    const jitter = (base, pct) => Math.max(0, base * (1 + (pct / 100) * (Math.random() * 2 - 1)));

    const h = (tag, props, ...kids) => {
        const el = document.createElement(tag);
        if (props) {
            for (const [k, v] of Object.entries(props)) {
                if (v === null || v === undefined || v === false) continue;
                if (k === "class") el.className = v;
                else if (k === "text") el.textContent = String(v);
                else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
                else if (k === "html") el.innerHTML = v;
                else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
                else if (v === true) el.setAttribute(k, "");
                else el.setAttribute(k, String(v));
            }
        }
        for (const kid of kids.flat(4)) {
            if (kid === null || kid === undefined || kid === false) continue;
            el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
        }
        return el;
    };

    /* ------------------------------------------------------------------ */
    /* Stockage / réglages                                                 */
    /* ------------------------------------------------------------------ */

    const hasGM = typeof GM_getValue === "function" && typeof GM_setValue === "function";
    const store = {
        get(key, def) {
            if (hasGM) {
                try { return GM_getValue(PREFIX + key, def); } catch (_) { /* continue */ }
            }
            try {
                const raw = localStorage.getItem(PREFIX + key);
                return raw === null ? def : JSON.parse(raw);
            } catch (_) { return def; }
        },
        set(key, value) {
            if (hasGM) {
                try { GM_setValue(PREFIX + key, value); return; } catch (_) { /* continue */ }
            }
            try { localStorage.setItem(PREFIX + key, JSON.stringify(value)); } catch (_) { /* ignore */ }
        }
    };

    const DEFAULT_UI = {
        theme: "dark",
        accent: "#5865f2",
        width: 430,
        maxHeight: 78,
        opacity: 100,
        font: 13,
        compact: false,
        blur: true,
        dock: "br",
        hiddenTabs: [],
        tabOrder: [],
        tabStyle: "underline",
        // false = une seule ligne avec défilement horizontal (la barre reste
        // toujours visible) ; true = plusieurs lignes.
        tabWrap: false,
        layoutVersion: 2,
        radius: 12,
        fontFamily: "discord",
        panelTitle: "Blocky Lab",
        pillText: "BL",
        lastTab: "",
        toastPos: "top",
        toastMs: 3600,
        x: null,
        y: null,
        collapsed: false
    };

    const DEFAULTS = {
        channelId: "",
        // Salon de drops : la valeur demandée est aussi le défaut, mais elle
        // reste modifiable dans Pilote → Drops.
        dropChannelId: "1557793570243477524",
        botIds: [],
        captureAll: true,
        ingest: true,
        ingestUrl: "http://127.0.0.1:3210/api/ingest",
        panelOpen: true,
        debug: false,
        historyLimit: 500,
        maxText: 6000,
        storeRaw: false,
        ui: {}
    };
    const rawSettings = store.get("settings", {}) || {};
    const settings = Object.assign({}, DEFAULTS, rawSettings);
    const uiNeedsMigration = !rawSettings.ui || rawSettings.ui.layoutVersion !== 2;
    if (!Array.isArray(settings.botIds)) settings.botIds = [];
    settings.ui = Object.assign({}, DEFAULT_UI, settings.ui || {});
    // Migration des deux anciens ancrages vers les quatre coins.
    if (settings.ui.dock === "right") settings.ui.dock = "br";
    if (settings.ui.dock === "left") settings.ui.dock = "bl";
    if (!/^(?:tl|tr|bl|br)$/.test(settings.ui.dock)) settings.ui.dock = "br";
    if (!Array.isArray(settings.ui.tabOrder)) settings.ui.tabOrder = [];
    if (!["underline", "pills", "cards"].includes(settings.ui.tabStyle)) settings.ui.tabStyle = "underline";
    if (!Array.isArray(settings.ui.hiddenTabs)) settings.ui.hiddenTabs = [];
    // « config » ne doit jamais pouvoir être masqué, sinon l'utilisateur n'a
    // plus aucun moyen de rouvrir les réglages depuis le panneau.
    settings.ui.hiddenTabs = settings.ui.hiddenTabs.filter(id => id !== "config");
    const saveSettings = () => store.set("settings", settings);
    // Migration UI : l'ancien mode « plusieurs lignes » pouvait faire défiler
    // verticalement la barre jusqu'à masquer les premiers onglets. On repasse
    // une fois en défilement horizontal, que l'utilisateur peut changer ensuite.
    if (uiNeedsMigration) {
        settings.ui.tabWrap = false;
        settings.ui.layoutVersion = 2;
        saveSettings();
    }

    /* ------------------------------------------------------------------ */
    /* Journal / toasts / bus                                              */
    /* ------------------------------------------------------------------ */

    const logBuffer = [];
    function log(...args) {
        const line = args.map(a => (typeof a === "object" ? safe(() => JSON.stringify(a), String(a)) : String(a))).join(" ");
        logBuffer.push({ t: Date.now(), line });
        if (logBuffer.length > 800) logBuffer.shift();
        if (settings.debug) console.debug(NC, ...args);
    }
    function debug(...args) { if (settings.debug) console.debug(NC, ...args); }

    let toastHost = null;
    function toast(message, type = "info", ms = 0) {
        const colors = { info: "#5865f2", success: "#248046", error: "#b93838", warn: "#c27c0e" };
        if (!document.body) return;
        const p = settings.ui;
        if (!toastHost || !toastHost.isConnected) {
            toastHost = h("div", { id: "bl-toast-host" });
            document.body.appendChild(toastHost);
        }
        toastHost.style.top = p.toastPos === "bottom" ? "auto" : "16px";
        toastHost.style.bottom = p.toastPos === "bottom" ? "16px" : "auto";
        const el = h("div", {
            class: "bl-toast",
            text: message,
            style: { background: colors[type] || colors.info, borderLeft: `3px solid ${p.accent}` }
        });
        toastHost.appendChild(el);
        setTimeout(() => {
            el.style.opacity = "0";
            setTimeout(() => el.remove(), 250);
        }, ms || p.toastMs || 3600);
    }

    const listeners = new Map();
    function on(evt, fn) {
        if (!listeners.has(evt)) listeners.set(evt, new Set());
        listeners.get(evt).add(fn);
        return () => listeners.get(evt)?.delete(fn);
    }
    function emit(evt, payload) {
        for (const fn of listeners.get(evt) || []) {
            try { fn(payload); } catch (e) { console.warn(NC, "listener", evt, e); }
        }
    }

    /* ------------------------------------------------------------------ */
    /* Snowflakes / salon                                                  */
    /* ------------------------------------------------------------------ */

    function snowflake(id) {
        try {
            const n = BigInt(String(id));
            return {
                ts: Number((n >> 22n) + 1420070400000n),
                worker: Number((n >> 17n) & 0x1Fn),
                process: Number((n >> 12n) & 0x1Fn),
                increment: Number(n & 0xFFFn),
                raw: String(id)
            };
        } catch (_) { return null; }
    }

    function channelIdFromUrl() {
        const m = location.pathname.match(/\/channels\/(?:\d+|@me)\/(\d+)/);
        return m ? m[1] : "";
    }
    const channelId = () => settings.channelId || channelIdFromUrl();

    /* ------------------------------------------------------------------ */
    /* IndexedDB                                                           */
    /* ------------------------------------------------------------------ */

    let dbPromise = null;
    function openDB() {
        if (dbPromise) return dbPromise;
        dbPromise = new Promise((resolve, reject) => {
            let req;
            try { req = indexedDB.open(DB_NAME, 1); } catch (e) { return reject(e); }
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(DB_STORE)) {
                    const st = db.createObjectStore(DB_STORE, { keyPath: "id" });
                    st.createIndex("ts", "ts");
                    st.createIndex("game", "game");
                    st.createIndex("label", "label");
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
        return dbPromise;
    }

    async function obsPut(items) {
        const list = (Array.isArray(items) ? items : [items]).filter(x => x && x.id);
        if (!list.length) return 0;
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(DB_STORE, "readwrite");
            const st = tx.objectStore(DB_STORE);
            for (const it of list) { try { st.put(it); } catch (_) { /* ignore */ } }
            tx.oncomplete = () => resolve(list.length);
            tx.onerror = () => reject(tx.error);
        });
    }

    async function obsAll() {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(DB_STORE, "readonly");
            const req = tx.objectStore(DB_STORE).getAll();
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => reject(req.error);
        });
    }

    async function obsCount() {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const req = db.transaction(DB_STORE, "readonly").objectStore(DB_STORE).count();
            req.onsuccess = () => resolve(req.result || 0);
            req.onerror = () => reject(req.error);
        });
    }

    async function obsClear() {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(DB_STORE, "readwrite");
            tx.objectStore(DB_STORE).clear();
            tx.oncomplete = () => resolve(true);
            tx.onerror = () => reject(tx.error);
        });
    }

    /* ------------------------------------------------------------------ */
    /* Texte / embeds                                                      */
    /* ------------------------------------------------------------------ */

    const norm = value => String(value ?? "")
        .normalize("NFKC")
        .replace(/[\u200B-\u200D\uFEFF]/g, "")
        .replace(/<a?:([a-zA-Z0-9_]+):\d+>/g, " :$1: $1 ")
        .replace(/&colon;/gi, ":")
        .replace(/&amp;/gi, "&")
        .replace(/[’‘]/g, "'")
        .replace(/[‐‑‒–—]/g, "-")
        .replace(/\s+/g, " ")
        .trim();

    const lower = value => norm(value).toLocaleLowerCase();

    function embedText(e) {
        if (!e) return "";
        const parts = [e.title, e.description, e.author?.name, e.footer?.text, e.url, e.provider?.name];
        for (const f of Array.isArray(e.fields) ? e.fields : []) parts.push(f?.name, f?.value);
        return parts.filter(x => x !== null && x !== undefined && String(x).trim()).join("\n");
    }

    function componentList(msg) {
        const out = [];
        const walk = (arr, depth = 0) => {
            if (!Array.isArray(arr) || depth > 4) return;
            for (const c of arr) {
                if (!c || typeof c !== "object") continue;
                out.push({
                    type: c.type,
                    label: c.label ?? c.emoji?.name ?? null,
                    customId: c.custom_id ?? c.customId ?? null,
                    disabled: Boolean(c.disabled),
                    url: c.url ?? null
                });
                walk(c.components, depth + 1);
            }
        };
        walk(msg?.components);
        return out;
    }

    function messageText(msg) {
        const parts = [msg?.content || ""];
        for (const e of Array.isArray(msg?.embeds) ? msg.embeds : []) parts.push(embedText(e));
        for (const c of componentList(msg)) if (c.label) parts.push(c.label);
        return parts.filter(Boolean).join("\n\n");
    }

    function money(text) {
        const out = [];
        const re = /(\d{1,3}(?:[ \u00a0,.]\d{3})+|\d+(?:[.,]\d+)?)\s*(?:emeralds?|émeraudes?|emerald|coins?|💎)/gi;
        let m;
        while ((m = re.exec(text))) out.push(Number(String(m[1]).replace(/[ \u00a0]/g, "").replace(",", ".")));
        return out;
    }

    function multipliers(text) {
        const out = [];
        const re = /(?:×|\bx)\s*(\d+(?:[.,]\d+)?)/gi;
        let m;
        while ((m = re.exec(text))) out.push(Number(String(m[1]).replace(",", ".")));
        return out;
    }

    // Ordre des blocs « gagnants ». « emeralds » est aussi la monnaie des mises et
    // des gains : on ne l'accepte que dans une formulation de résultat.
    const LUCKY_ORDER = [
        ["netherite", /\bnetherite\b/i],
        ["diamonds", /\bdiamonds?\b|💎/i],
        ["gold", /\bgold(?:en)?(?:\s+ingot)?\b|🟨/i],
        ["iron", /\biron(?:\s+ingot)?\b|⚙/i],
        ["cobblestone", /\bcobblestone\b|🪨/i]
    ];

    function luckyCategory(text) {
        const t = lower(text);
        const creeper = /\bcreeper\b|💥/.test(t);
        // Un creeper n'est retenu que s'il est l'événement (explosion, perte).
        if (creeper && /💥|\bexplod|\bboom|\blost\b|\bperdu\b|\bappeared\b|\bapparu\b/.test(t)) return "creeper";
        for (const [name, re] of LUCKY_ORDER) if (re.test(t)) return name;
        if (/\b(?:found|trouv[ée]|got|obtenu|won|gagn[ée]|pile)\b[^.]{0,30}\bemeralds?\b/.test(t) || /🟩/.test(t)) return "emeralds";
        if (creeper) return "creeper";
        return null;
    }

    const RED_NUMBERS = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);

    function wheelNumber(text) {
        const t = norm(text);
        let m = t.match(/(?:stopped|stops?|lands?|landed|tomb[ée]e?|result|r[ée]sultat|num[ée]ro|number)\D{0,16}(3[0-6]|[12]?\d)\b/i);
        if (!m) m = t.match(/\b(3[0-6]|[12]?\d)\s*(?:\(|:|$)/);
        if (!m) return null;
        const n = Number(m[1]);
        return Number.isInteger(n) && n >= 0 && n <= 36 ? n : null;
    }

    function wheelColor(text, n) {
        const t = lower(text);
        if (Number.isInteger(n)) return n === 0 ? "green" : RED_NUMBERS.has(n) ? "red" : "black";
        if (/\b(?:green|vert|diamond|diamant)\b/.test(t)) return "green";
        if (/\b(?:red|rouge|redstone)\b/.test(t)) return "red";
        if (/\b(?:black|noir|obsidian)\b/.test(t)) return "black";
        return null;
    }

    const MINING_BLOCKS = [
        ["cobblestone", /cobblestone|pierre/i],
        ["gravel", /gravel|gravier/i],
        ["deepslate", /deepslate|ardoise/i],
        ["obsidian", /obsidian|obsidienne/i],
        ["bedrock", /bedrock/i]
    ];

    function parseMining(text) {
        const t = lower(text);
        const blocks = {};
        for (const [key, re] of MINING_BLOCKS) {
            let count = 0;
            const before = new RegExp(`(\\d+)\\s*(?:x\\s*)?(?:${re.source})`, "g");
            let m;
            while ((m = before.exec(t))) count += Number(m[1]);
            if (!count) {
                const after = new RegExp(`(?:${re.source})\\s*(?:x|×)?\\s*(\\d+)`, "g");
                while ((m = after.exec(t))) count += Number(m[1]);
            }
            if (!count && re.test(t)) count = 1;
            if (count) blocks[key] = count;
        }
        const total = Object.values(blocks).reduce((a, b) => a + b, 0);
        const pileMatch = t.match(/\b(\d+)\s*(?:blocks?|blocs?)\b/);
        const xpMatch = t.match(/(\d+)\s*(?:xp|experience)/);
        const lapisMatch = t.match(/(\d+)\s*lapis/);
        return {
            blocks,
            total,
            pile: pileMatch ? Number(pileMatch[1]) : total,
            xp: xpMatch ? Number(xpMatch[1]) : null,
            lapis: lapisMatch ? Number(lapisMatch[1]) : (/lapis/.test(t) ? 1 : 0)
        };
    }

    const SUIT_MAP = { "♠": "s", "♣": "c", "♥": "h", "♦": "d", "♤": "s", "♧": "c", "♡": "h", "♢": "d" };
    const WORD_RANK = { ace: "A", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10", jack: "J", queen: "Q", king: "K" };
    const suitWords = { spades: "s", hearts: "h", diamonds: "d", clubs: "c" };

    function parseCards(text) {
        const cards = [];
        const re = /(10|[2-9]|[AJQK])\s*([♠♣♥♦♤♧♡♢])|([♠♣♥♦♤♧♡♢])\s*(10|[2-9]|[AJQK])/gi;
        let m;
        while ((m = re.exec(text))) {
            const rank = (m[1] || m[4] || "").toUpperCase();
            const suit = SUIT_MAP[m[2] || m[3]] || "?";
            if (rank) cards.push({ rank, suit, value: rank === "A" ? 11 : "JQK".includes(rank) || rank === "10" ? 10 : Number(rank) });
        }
        const wre = /\b(ace|two|three|four|five|six|seven|eight|nine|ten|jack|queen|king)\s*(?:of\s*)?(spades|hearts|diamonds|clubs)\b/gi;
        while ((m = wre.exec(text))) {
            const rank = WORD_RANK[m[1].toLowerCase()];
            cards.push({ rank, suit: suitWords[m[2].toLowerCase()], value: rank === "A" ? 11 : "JQK".includes(rank) || rank === "10" ? 10 : Number(rank) });
        }
        const nre = /\b(10|[2-9]|[AJQK])\s+of\s+(spades|hearts|diamonds|clubs)\b/gi;
        while ((m = nre.exec(text))) {
            const rank = m[1].toUpperCase();
            cards.push({ rank, suit: suitWords[m[2].toLowerCase()], value: rank === "A" ? 11 : "JQK".includes(rank) || rank === "10" ? 10 : Number(rank) });
        }
        // Certains clients affichent les cartes en emoji Unicode (🂡 … 🃏) ou via
        // une image dont l'alt est un emoji. On les décode aussi.
        const suits = ["s", "h", "d", "c"];
        for (const ch of String(text)) {
            const cp = ch.codePointAt(0);
            if (cp < 0x1F0A1 || cp > 0x1F0DE) continue;
            const offset = cp - 0x1F0A1;
            const rankIdx = offset % 16;
            const suitIdx = Math.floor(offset / 16);
            if (rankIdx > 14 || suitIdx > 3) continue;
            // 0 = As, 1–9 = 2–10, 10–11 = valet/cavalier, 12 = dame,
            // 13 = roi, 14 = As (certains jeux dupliquent l'As).
            const rank = (rankIdx === 0 || rankIdx === 14) ? "A"
                : rankIdx >= 1 && rankIdx <= 9 ? String(rankIdx + 1)
                    : rankIdx === 12 ? "Q" : rankIdx === 13 ? "K" : "J";
            cards.push({ rank, suit: suits[suitIdx], value: rank === "A" ? 11 : "JQK".includes(rank) || rank === "10" ? 10 : Number(rank) });
        }
        return cards;
    }

    function handValue(cards) {
        let total = cards.reduce((s, c) => s + c.value, 0);
        let aces = cards.filter(c => c.rank === "A").length;
        while (total > 21 && aces > 0) { total -= 10; aces--; }
        return { total, soft: aces > 0 };
    }

    /* ------------------------------------------------------------------ */
    /* Détection du jeu et du résultat                                     */
    /* ------------------------------------------------------------------ */

    const GAME_RULES = {
        luckyblock: { win: [/\b(?:netherite|emeralds?|diamonds?|gold|iron)\b/i], loss: [/\b(?:creeper|cobblestone)\b/i] },
        wheel: { win: [/\byou\s+win\b/i, /🎉/, /:tada:/i, /\bgagn[ée]/i], loss: [/\bbetter\b/i, /💸/, /:money_with_wings:/i, /\bperdu\b/i] },
        mines: { win: [/\bcash(?:ed)?\s*out\b/i, /\bcashed\b/i, /\br[ée]cup[ée]r/i], loss: [/\bboom\b/i, /💥/, /\bexplos/i] },
        blackjack: {
            win: [
                /\byou\s+(?:win|won)\b/i, /\byou\s+got\s+(?:a\s+)?blackjack\b/i,
                /\bdealer\s+busts?\b/i, /\bcroupier\s+(?:saute|bust)/i,
                /\bblackjack\s*!\s*(?:you|gagn)/i, /\byou\s+beat\s+the\s+dealer\b/i
            ],
            loss: [
                /\bdealer\s+wins?\b/i, /\bcroupier\s+gagne\b/i,
                /\byou\s+bust(?:ed)?\b/i, /\bdealer\s+has\s+(?:a\s+)?blackjack\b/i,
                /\byou\s+(?:lose|lost)\b/i, /\bperdu\b/i
            ],
            push: [
                /\byour\s+bet\s+back\b/i, /\bpush\b/i, /\bmise\s+rendue\b/i,
                /\bbet\s+(?:is\s+)?returned\b/i, /\brembours/i,
                /match nul/i, /[ée]galit[ée]/i, /it'?s a draw/i
            ]
        },
        blockdl: { win: [/\b(?:correct|found|trouv[ée]|gagn[ée]|solved)\b/i], loss: [/\b(?:wrong|incorrect|perdu|failed)\b/i] },
        dummy: { win: [], loss: [] },
        boss: { win: [/\bdefeated\b|\bvaincu\b/i], loss: [/\bescaped\b|\bfui\b/i] },
        duel: { win: [/\byou\s+win\b|\bwon\b|\bgagn[ée]\b/i], loss: [/\byou\s+lose\b|\blost\b|\bperdu\b/i] },
        pve: { win: [/\bwave\s+cleared\b|\bvague\b.*\btermin/i], loss: [/\byou\s+died\b|\bmort\b/i] },
        drop: { win: [/\b(?:claimed?|received?|got|obtenu|r[ée]cup[ée]r[ée]|won|gagn[ée])\b/i], loss: [] },
        daily: { win: [/\b(?:claimed?|received?|reward|r[ée]compense|streak)\b/i], loss: [] },
        mining: { win: [], loss: [] }
    };

    function detectGame(text) {
        const t = lower(text);
        const score = {};
        const add = (g, n) => { score[g] = (score[g] || 0) + n; };
        // Un message de minage contient « blocks » et « Cobblestone » : il ne doit
        // pas être pris pour un Lucky Block.
        const miningish = /\bmined\b|\bmining\b/.test(t) ||
            (/\b\d+\s*(?:blocks?|blocs?)\b/.test(t) && /\b(?:cobblestone|gravel|deepslate|obsidian|bedrock)\b/.test(t));
        if (/\blucky\s*block\b/.test(t)) add("luckyblock", 8);
        if (/\bcreeper\b/.test(t) && /💥|explo/.test(t)) add("luckyblock", 6);
        if (!miningish && /\bcobblestone\b/.test(t)) add("luckyblock", 5);
        if (/\bwheel\b|\broulette\b/.test(t)) add("wheel", 8);
        if (/\bredstone\b|\bobsidian\b/.test(t) && /\b(?:bet|mise|pari)\b/.test(t)) add("wheel", 4);
        if (/\bblackjack\b|\bblack\s*jack\b/.test(t)) add("blackjack", 12);
        if (/\bdealer\b|\bcroupier\b/.test(t)) add("blackjack", 5);
        if (/\bhit\b/.test(t) && /\bstand\b/.test(t)) add("blackjack", 6);
        if (/\btraining\s+dummy\b|\bdummy\b/.test(t)) add("dummy", 7);
        if (/\b(?:tnt|mines)\b/.test(t) && /\b(?:dig|creus|block|case)\b/.test(t)) add("mines", 6);
        if (/\bboom\b/.test(t) && !/\bcreeper\b/.test(t)) add("mines", 5);
        if (/\bcash(?:ed)?\s*out\b/.test(t)) add("mines", 6);
        if (!miningish && /\b(?:creeper|cobblestone|iron|gold|diamonds?|emeralds?|netherite)\b/.test(t) && /\b(?:block|bet|mise|found|trouv|broke|cass[ée]|pile)\b/.test(t)) add("luckyblock", 4);
        if (/\b(?:dungeon|donjon|wave|vague)\b/.test(t)) add("pve", 5);
        if (/\bduel\b/.test(t)) add("duel", 6);
        if (/\bboss\b/.test(t)) add("boss", 5);
        if (/\bdrop\b/.test(t) && /\b(?:click|clique|claim|r[ée]cup)/.test(t)) add("drop", 7);
        if (/\bblock\s*dl\b|\bblock\s+of\s+the\s+day\b|\bbloc\s+du\s+jour\b/.test(t)) add("blockdl", 10);
        if (/\btrade\b|\b[ée]change\b/.test(t) && /\b(?:offer|offre|accept|accepter|give|donner)\b/.test(t)) add("trade", 5);
        if (/\bdaily\b|\bstreak\b/.test(t)) add("daily", 4);
        if (/\bmined\b|\bmining\b|\bblocs?\b/.test(t) && /\b(?:xp|emerald|émeraude)\b/.test(t)) add("mining", 3);
        if (/\bmined\b|\bblocs?\b/.test(t) && /\b(?:cobblestone|gravel|deepslate|obsidian|bedrock)\b/.test(t)) add("mining", 5);
        const ranked = Object.entries(score).sort((a, b) => b[1] - a[1]);
        if (!ranked.length || ranked[0][1] < 4) return "unknown";
        if (ranked.length > 1 && ranked[0][1] === ranked[1][1]) return "unknown";
        return ranked[0][0];
    }

    function outcomeLabel(game, text) {
        const t = lower(text);
        // Les messages de classement / boutique ne sont pas des parties : ils
        // polluaient les statistiques quand on scannait tout un salon.
        if (/\b(?:leaderboard|classement|achievements?|succ[eè]s|shop|boutique|sale|vente r[ée]ussie)\b/.test(t)) return null;
        const rules = GAME_RULES[game];
        if (game === "luckyblock") {
            const cat = luckyCategory(text);
            if (cat === "creeper" || cat === "cobblestone") return "loss";
            if (cat === "iron") return "push";
            if (cat) return "win";
            return null;
        }
        if (!rules) {
            if (/\byou\s+win\b|\bwon\b|\bgagn[ée]\b/.test(t)) return "win";
            if (/\byou\s+lose\b|\blost\b|\bperdu\b/.test(t)) return "loss";
            return null;
        }
        const hit = arr => arr.some(re => re.test(text));
        const push = rules.push ? hit(rules.push) : false;
        const win = hit(rules.win || []);
        const loss = hit(rules.loss || []);
        // Un remboursement est prioritaire : « your bet back » ne doit jamais
        // être compté comme un gain (c'était le bug de l'ancien classifieur).
        // On priorise aussi le push face à un « blackjack » de titre.
        if (push && (game === "blackjack" || !win)) return "push";
        if (win && loss) return "ambiguous";
        if (win) return "win";
        if (loss) return "loss";
        return null;
    }

    function betAmount(text) {
        const t = norm(text);
        let m = t.match(/(?:bet|mise|wager|parie?)\s*[:=-]?\s*(\d{1,3}(?:[ ,.]\d{3})+|\d+(?:[.,]\d+)?)/i);
        if (m) return Number(m[1].replace(/[ ,]/g, "").replace(",", "."));
        m = t.match(/(\d{1,3}(?:[ ,.]\d{3})+|\d+(?:[.,]\d+)?)\s*(?:emeralds?|émeraudes?|💎)/i);
        return m ? Number(m[1].replace(/[ ,]/g, "").replace(",", ".")) : null;
    }

    function analyzeText(text) {
        const raw = String(text || "");
        if (!raw.trim()) return { game: "unknown", label: null, detail: {}, text: raw };
        const game = detectGame(raw);
        const label = outcomeLabel(game, raw);
        const detail = {
            category: game === "luckyblock" ? luckyCategory(raw) : null,
            multipliers: multipliers(raw),
            amounts: money(raw),
            bet: betAmount(raw),
            cards: game === "blackjack" ? parseCards(raw) : []
        };
        if (game === "wheel") {
            detail.number = wheelNumber(raw);
            detail.color = wheelColor(raw, detail.number);
        }
        if (game === "mining") detail.mining = parseMining(raw);
        if (game === "blackjack" && detail.cards.length) {
            const hv = handValue(detail.cards);
            detail.total = hv.total;
            detail.soft = hv.soft;
        }
        if (game === "blackjack" && label === "push") detail.refund = true;
        if (detail.bet != null && label) {
            detail.net = label === "win" ? detail.bet : label === "loss" ? -detail.bet : 0;
            detail.payout = label === "win" ? detail.bet * 2 : label === "push" ? detail.bet : 0;
        }
        return { game, label, detail, text: raw };
    }

    function analyze(msg) {
        return analyzeText(messageText(msg));
    }

    function reclassify(obs) {
        if (!obs || obs.manual) return obs;
        const next = analyzeText(obs.text || "");
        if (next.game !== "unknown") obs.game = next.game;
        // Corrige aussi les faux positifs : un ancien « gain » qui n'a plus
        // aucun signal de résultat redevient non classé après un nouveau scan.
        if (next.label && next.label !== "ambiguous") obs.label = next.label;
        else if (next.label !== "ambiguous") obs.label = null;
        obs.detail = Object.assign({}, obs.detail || {}, next.detail);
        if (!obs.label) { delete obs.detail.net; delete obs.detail.payout; }
        obs.autoLabel = Boolean(obs.label);
        obs.autoLabelAt = nowISO();
        return obs;
    }

    /* ------------------------------------------------------------------ */
    /* Webpack Discord                                                     */
    /* ------------------------------------------------------------------ */

    let wpRequire = null;
    function getRequire() {
        if (wpRequire) return wpRequire;
        try {
            const chunk = W.webpackChunkdiscord_app;
            if (!chunk || typeof chunk.push !== "function") return null;
            let req = null;
            const token = [[Symbol("blocky-lab")], {}, r => { req = r; }];
            chunk.push(token);
            try { chunk.pop(); } catch (_) { /* ignore */ }
            if (req && req.c) wpRequire = req;
        } catch (e) { debug("webpack indisponible", e); }
        return wpRequire;
    }

    let modulesCache = null;
    let modulesAt = 0;
    function modules() {
        if (modulesCache && Date.now() - modulesAt < 2500) return modulesCache;
        const req = getRequire();
        if (!req || !req.c) return [];
        const out = [];
        for (const id of Object.keys(req.c)) {
            let exp;
            try { exp = req.c[id]?.exports; } catch (_) { continue; }
            if (exp) out.push(exp);
        }
        modulesCache = out;
        modulesAt = Date.now();
        return out;
    }

    function find(predicate, max = 1) {
        const found = [];
        for (const exp of modules()) {
            const candidates = [exp];
            try {
                if (exp && (typeof exp === "object" || typeof exp === "function")) {
                    for (const k of Object.keys(exp)) {
                        let v;
                        try { v = exp[k]; } catch (_) { continue; }
                        if (v && v !== exp) candidates.push(v);
                    }
                }
            } catch (_) { /* ignore */ }
            for (const c of candidates) {
                let ok = false;
                try { ok = Boolean(c && predicate(c)); } catch (_) { ok = false; }
                if (ok) { found.push(c); if (found.length >= max) return found; }
            }
        }
        return found;
    }

    function findByProps(...names) {
        return find(o => names.every(n => typeof o[n] === "function"), 1)[0] || null;
    }
    const storeCache = new Map();
    function findStore(name) {
        const hit = storeCache.get(name);
        if (hit && Date.now() - hit.at < 5000) return hit.store;
        const st = find(o => typeof o.getName === "function" && safe(() => o.getName() === name, false), 1)[0] || null;
        storeCache.set(name, { store: st, at: Date.now() });
        return st;
    }
    let userCache = { user: null, at: 0 };
    function currentUser() {
        if (userCache.user && Date.now() - userCache.at < 5000) return userCache.user;
        const st = findStore("UserStore");
        const user = safe(() => st?.getCurrentUser?.() || null, null);
        if (user) userCache = { user, at: Date.now() };
        return user;
    }

    function commandTokens(rest) {
        const out = [];
        const source = String(rest || "");
        // Les choix Discord peuvent être affichés sous la forme
        // « emeralds (2092) ». Les guillemets restent supportés pour les
        // options texte qui contiennent des espaces.
        let token = "";
        let quote = "";
        let escaped = false;
        let parentheses = 0;
        const flush = () => {
            if (token) out.push(token);
            token = "";
        };
        for (const ch of source) {
            if (quote) {
                if (escaped) {
                    token += ch;
                    escaped = false;
                } else if (ch === "\\") {
                    escaped = true;
                } else if (ch === quote) {
                    quote = "";
                } else {
                    token += ch;
                }
                continue;
            }
            if (ch === "\"" || ch === "'") {
                quote = ch;
                continue;
            }
            if (ch === "(") parentheses++;
            if (ch === ")" && parentheses > 0) parentheses--;
            if (/\s/.test(ch) && parentheses === 0) flush();
            else token += ch;
        }
        flush();
        return out;
    }

    function cleanCommandValue(value) {
        return String(value ?? "")
            .trim()
            .replace(/^\*\*(.*?)\*\*$/s, "$1")
            .replace(/^`(.*?)`$/s, "$1")
            .trim();
    }

    /**
     * Parse une commande slash en conservant l'ordre des options.
     *
     * Exemple :
     * /trade member:<@123> give:emeralds (2092) give_amount:1
     *        get:emeralds (1141) get_amount:1
     * devient [<@123>, emeralds, 1, emeralds, 1].
     * Les nombres entre parenthèses sont les descriptions de l'autocomplete,
     * pas des arguments supplémentaires.
     */
    function parseSlashCommand(raw) {
        const source = String(raw ?? "").trim();
        const m = source.match(/^(\/\S+)(?:\s+([\s\S]*))?$/);
        if (!m) return { raw: source, command: source, name: "", args: [], values: [] };

        const command = m[1];
        const tokens = commandTokens(m[2] || "");
        const args = [];
        let last = null;
        for (const token of tokens) {
            const pair = token.match(/^([A-Za-z][\w-]*):(.*)$/s);
            if (pair) {
                const arg = {
                    name: pair[1],
                    value: cleanCommandValue(pair[2]),
                    raw: token
                };
                args.push(arg);
                last = arg;
                continue;
            }

            // Discord affiche les choix avec une description entre parenthèses
            // (par ex. « emeralds (2092) »). Ne jamais l'envoyer au champ
            // suivant : c'était l'origine du décalage des paramètres de trade.
            if (last?.name && /^\([^\n)]{1,120}\)$/.test(token)) continue;

            // Autorise « member: @user » en plus de « member:@user ».
            if (last && !last.value) {
                last.value = cleanCommandValue(token);
                last.raw += ` ${token}`;
                continue;
            }

            const arg = { name: null, value: cleanCommandValue(token), raw: token };
            args.push(arg);
            last = arg;
        }

        const filtered = args.filter(arg => arg.value !== "");
        return {
            raw: source,
            command,
            name: command.slice(1).toLowerCase(),
            args: filtered,
            values: filtered.map(arg => arg.value)
        };
    }

    async function sendText(content) {
        const cid = channelId();
        if (!cid) throw new Error("Aucun salon ciblé");
        // Les slash commands doivent passer par l'éditeur : le module sendMessage
        // enverrait le texte littéral au lieu d'invoquer la commande.
        if (String(content).trim().startsWith("/")) return sendViaEditor(String(content).trim());
        const actions = findByProps("sendMessage", "receiveMessage", "editMessage");
        if (actions?.sendMessage) {
            await actions.sendMessage(cid, { content, tts: false, invalidEmojis: [], validNonShortcutEmojis: [] });
            emit("sent", { t: Date.now(), content, channelId: cid });
            return true;
        }
        return sendViaEditor(content);
    }

    function getEditor() {
        return document.querySelector('div[role="textbox"][data-slate-editor="true"]');
    }

    function pasteInto(editor, text) {
        const dt = new DataTransfer();
        dt.setData("text/plain", text);
        editor.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    }

    function editorSnapshot(editor) {
        return String(editor?.textContent || "").replace(/[\u200B-\u200D\uFEFF]/g, "");
    }

    function activeEditorTarget(editor) {
        const active = document.activeElement;
        return active && editor.contains(active) ? active : editor;
    }

    async function waitEditorMutation(editor, before, ms = 550) {
        const until = Date.now() + ms;
        while (Date.now() < until) {
            const current = editorSnapshot(editor);
            if (current !== before) return current;
            await sleep(35);
        }
        return editorSnapshot(editor);
    }

    async function typeInEditor(editor, text, preferPaste = false) {
        const value = String(text ?? "");
        if (!value) return true;
        // Une insertion partielle est déjà une mutation valide (notamment
        // lorsqu'une autocomplétion s'ouvre). Il ne faut surtout pas rejouer
        // toute la chaîne ensuite : cela doublait le premier caractère.
        const methods = preferPaste
            ? ["discord", "paste", "input", "exec"]
            : ["discord", "paste", "input", "exec"];
        for (const method of methods) {
            const before = editorSnapshot(editor);
            const target = activeEditorTarget(editor);
            try {
                if (method === "discord") {
                    // Discord expose un dispatcher interne qui maintient l'état
                    // Slate correctement. On ne l'utilise que si l'insertion
                    // est observable, et on s'arrête au premier changement.
                    const dispatchers = find(o => typeof o.dispatchToLastSubscribed === "function", 8);
                    let dispatched = false;
                    for (const dispatcher of dispatchers) {
                        try {
                            dispatcher.dispatchToLastSubscribed("INSERT_TEXT", { plainText: value, rawText: value });
                            dispatched = true;
                            const current = await waitEditorMutation(editor, before, 180);
                            if (current !== before) return true;
                        } catch (_) { /* essayer le dispatcher suivant */ }
                    }
                    if (!dispatched) continue;
                } else if (method === "paste") {
                    pasteInto(target, value);
                } else if (method === "input") {
                    // Un seul beforeinput pour toute la valeur évite que le
                    // premier caractère soit traité deux fois par React/Slate.
                    target.dispatchEvent(new InputEvent("beforeinput", {
                        inputType: "insertText", data: value, bubbles: true, cancelable: true, composed: true
                    }));
                } else {
                    try { document.execCommand("insertText", false, value); } catch (_) { /* ignore */ }
                }
            } catch (_) { /* passer à la méthode suivante */ }

            const current = await waitEditorMutation(editor, before);
            if (current !== before) return true;
        }
        return false;
    }

    function focusFirstEmptyOption(editor) {
        try {
            const candidates = [...editor.querySelectorAll('[class*="ption"], [class*="Option"]')];
            for (const c of candidates) {
                const leaf = c.querySelector("[data-slate-string], [data-slate-zero-width], [data-slate-leaf]");
                if (!leaf) continue;
                const txt = (leaf.textContent || "").replace(/[\u200B\uFEFF]/g, "").trim();
                if (txt) continue;
                const target = leaf.querySelector("[data-slate-zero-width]") || leaf;
                // Mousedown suffit à déplacer le curseur. Le triplet
                // mousedown/mouseup/click pouvait déclencher deux transitions
                // de focus dans Discord et réinsérer le premier caractère.
                target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
                if (typeof target.focus === "function") target.focus({ preventScroll: true });
                const range = document.createRange();
                range.selectNodeContents(target);
                range.collapse(true);
                const sel = window.getSelection();
                sel.removeAllRanges();
                sel.addRange(range);
                document.dispatchEvent(new Event("selectionchange"));
                return true;
            }
        } catch (e) { debug("focus option", e); }
        return false;
    }

    function autocompleteRows(editor) {
        const selectors = '[role="option"], [class*="autocompleteRow"], [class*="selectable"], [id^="autocomplete-"]';
        const all = [...document.querySelectorAll(selectors)]
            .filter(el => !editor?.contains(el))
            .filter(el => {
                try { return el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden"; }
                catch (_) { return true; }
            });
        // Discord rend parfois un conteneur et sa ligne comme deux options.
        // Garder la ligne la plus interne évite de cliquer deux fois le même
        // utilisateur.
        return all.filter(row => !all.some(other => other !== row && row.contains(other)));
    }

    function autocompleteMatches(row, text) {
        const raw = String(text || "").trim().toLocaleLowerCase();
        const withoutAt = raw.replace(/^@/, "");
        if (!withoutAt) return false;
        const label = String(row?.textContent || "").replace(/\s+/g, " ").toLocaleLowerCase();
        return label.includes(raw) || label.includes(withoutAt);
    }

    async function sendViaEditor(raw) {
        const editor = getEditor();
        if (!editor) { toast("Zone de texte Discord introuvable", "error"); return false; }
        if ((editor.textContent || "").trim()) { toast("Zone de texte occupée : envoi annulé", "warn"); return false; }

        const key = (k, code, kc) => editor.dispatchEvent(new KeyboardEvent("keydown", {
            key: k, code, keyCode: kc, which: kc, bubbles: true, cancelable: true
        }));
        const len = () => (editor.textContent || "").length;

        async function selectAutocomplete(text, matcher = row => autocompleteMatches(row, text), timeout = 3000) {
            const until = Date.now() + timeout;
            let row = null;
            while (Date.now() < until) {
                row = autocompleteRows(editor).find(matcher);
                if (row) break;
                await sleep(80);
            }
            if (!row) return false;

            const visibleMatch = () => autocompleteRows(editor).some(matcher);
            const dispatchRowClick = () => {
                try {
                    // Certaines versions de Discord écoutent pointerdown,
                    // d'autres mousedown/click. On vise toujours la ligne
                    // trouvée, jamais le texte brut dans l'éditeur.
                    const Pointer = window.PointerEvent || MouseEvent;
                    row.dispatchEvent(new Pointer("pointerdown", { bubbles: true, cancelable: true, view: window }));
                    row.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
                    row.dispatchEvent(new Pointer("pointerup", { bubbles: true, cancelable: true, view: window }));
                    row.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
                    row.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
                } catch (_) { /* le clavier prendra le relais */ }
            };

            dispatchRowClick();
            await sleep(320);
            if (visibleMatch()) {
                // Repli clavier : après filtrage exact, Discord met normalement
                // la ligne voulue en tête. Tab valide une option sans envoyer
                // prématurément la commande.
                key("Tab", "Tab", 9);
                await sleep(420);
            }
            if (visibleMatch()) {
                dispatchRowClick();
                await sleep(420);
            }
            if (visibleMatch()) {
                // Dernier secours pour les menus qui ne réagissent qu'au
                // clavier. Il n'est tenté qu'après le clic sur la ligne exacte.
                key("Enter", "Enter", 13);
                await sleep(420);
            }
            return !visibleMatch();
        }

        function commandRowMatches(row, command) {
            const wanted = String(command || "").replace(/^\//, "").toLocaleLowerCase();
            if (!wanted) return false;
            const label = String(row?.textContent || "").replace(/\s+/g, " ").toLocaleLowerCase();
            return label.includes(`/${wanted}`) || label.split(/\s+/).some(part => part === wanted);
        }

        async function selectSlashCommand(command) {
            const selectedByRow = await selectAutocomplete(
                command,
                row => commandRowMatches(row, command),
                1000
            );
            if (selectedByRow && focusFirstEmptyOption(editor)) return true;

            // Discord peut accepter le slash command sans clic : une seule
            // tabulation valide alors /trade et ouvre le premier paramètre.
            key("Tab", "Tab", 9);
            await sleep(650);
            if (focusFirstEmptyOption(editor)) return true;

            // Sur certaines versions, la suggestion reste active après Tab et
            // se valide avec Entrée. Ne jamais l'utiliser sans avoir vérifié
            // qu'une option de commande existe encore.
            const hasCommandRow = autocompleteRows(editor).some(row => commandRowMatches(row, command));
            if (hasCommandRow) {
                key("Enter", "Enter", 13);
                await sleep(650);
                if (focusFirstEmptyOption(editor)) return true;
            }
            return false;
        }

        editor.focus();
        await sleep(120);

        if (!raw.startsWith("/")) {
            const ok = await typeInEditor(editor, raw, true);
            if (ok) {
                key("Enter", "Enter", 13);
                await sleep(300);
                editor.blur();
                emit("sent", { t: Date.now(), content: raw, channelId: channelId() });
            }
            return ok;
        }

        const parsed = parseSlashCommand(raw);
        const cmd = parsed.command;
        const args = parsed.args;

        if (!cmd) {
            toast("Commande slash vide", "warn");
            return false;
        }

        const commandTyped = await typeInEditor(editor, cmd, true);
        if (!commandTyped) {
            toast("Commande slash introuvable dans l'éditeur", "error");
            editor.blur();
            return false;
        }
        if (!await selectSlashCommand(cmd)) {
            toast(`Commande ${cmd} non sélectionnée dans Discord`, "warn");
            editor.blur();
            return false;
        }

        for (let i = 0; i < args.length; i++) {
            const found = focusFirstEmptyOption(editor);
            if (!found) key("Tab", "Tab", 9);
            await sleep(220);

            // Les montants signés et la notation scientifique doivent être
            // transmis tels quels : sinon -1 devient 1 et le fuzzer ne teste rien.
            const item = args[i];
            const mention = item.value.match(/^<@!?(\d+)>$/);
            const userOption = /^(?:member|user|target|player)$/i.test(item.name || "");
            const arg = mention && !userOption ? mention[1] : item.value;
            const numeric = !userOption && (/^[+-]?\d+(?:[.,]\d+)?(?:e[+-]?\d+)?$/i.test(arg) || /^(NaN|[-+]?Infinity)$/i.test(arg) || /^#[0-9a-f]{3,8}$/i.test(arg));
            const isChoice = !numeric;
            const text = /^@[\p{L}\p{N}_.-]+$/u.test(arg)
                ? arg
                : isChoice
                ? (arg.replace(/[^\p{L}\p{N}\s]/gu, " ").trim().split(/\s+/)[0] || arg)
                : arg;
            // Le collage reconnu par l'éditeur est prioritaire pour les
            // paramètres : il évite le bug « premier caractère doublé » de la
            // saisie caractère par caractère.
            let ok = await typeInEditor(editor, text, true);
            if (!ok) {
                focusFirstEmptyOption(editor);
                await sleep(220);
                ok = await typeInEditor(editor, text, true);
            }
            if (!ok) log("argument non saisi:", item.raw || item.value);

            if (ok && isChoice) {
                // Toute option de choix (joueur ou item) doit être confirmée
                // par Discord avant de passer au champ suivant. Les nombres
                // passent directement et ne rentrent jamais ici.
                const selected = await selectAutocomplete(text);
                if (!selected) {
                    const kind = userOption ? "utilisateur" : "option";
                    log(`${kind} non sélectionné:`, item.raw || item.value);
                    toast(`${kind} « ${text} » non sélectionné dans Discord`, "warn");
                    editor.blur();
                    return false;
                }
            } else {
                await sleep(250);
            }
        }

        await sleep(350);
        key("Enter", "Enter", 13);
        await sleep(500);
        const stuck = (editor.textContent || "").trim();
        editor.blur();
        if (stuck) { toast("Commande non envoyée (texte resté dans la barre)", "warn"); return false; }
        emit("sent", { t: Date.now(), content: raw, channelId: channelId() });
        return true;
    }

    async function fetchHistory({ limit = 50, max = 1000, before = null, channel = null } = {}) {
        const cid = channel ? String(channel) : channelId();
        const actions = findByProps("fetchMessages", "jumpToMessage") || findByProps("fetchMessages");
        const messageStore = findStore("MessageStore");
        if (!cid) throw new Error("Aucun salon ciblé");

        const loaded = () => {
            try {
                const coll = messageStore?.getMessages?.(cid);
                if (!coll) return [];
                if (typeof coll.toArray === "function") return coll.toArray();
                if (Array.isArray(coll)) return coll;
                return Object.values(coll);
            } catch (_) { return []; }
        };

        const all = new Map();
        const add = m => { if (m?.id) all.set(String(m.id), m); };
        for (const m of loaded()) add(m);
        if (!actions?.fetchMessages) return [...all.values()];

        let cursor = before;
        const maxRounds = Math.ceil(max / Math.max(1, limit)) + 1;
        for (let round = 0; round < maxRounds && all.size < max; round++) {
            const beforeCount = loaded().length;
            let returned = null;
            try {
                returned = await actions.fetchMessages({ channelId: cid, limit, before: cursor });
            } catch (e) {
                debug("fetchMessages", e);
                break;
            }
            // fetchMessages résout parfois avec un tableau/objet de messages :
            // on l'utilise pour ne pas dépendre uniquement de MessageStore.
            const list = Array.isArray(returned) ? returned
                : Array.isArray(returned?.messages) ? returned.messages
                    : Array.isArray(returned?.toArray?.()) ? returned.toArray() : [];
            for (const m of list) add(m);

            // Le store est rempli de façon asynchrone : on attend le rendu
            // (max ~1,2 s) au lieu de lire une seule fois après 650 ms.
            let grew = list.length > 0;
            for (let i = 0; i < 6; i++) {
                if (loaded().length > beforeCount) { grew = true; break; }
                await sleep(200);
            }
            const batch = loaded();
            let oldest = null;
            for (const m of batch) {
                add(m);
                const id = String(m.id);
                if (!oldest || BigInt(id) < BigInt(oldest)) oldest = id;
            }
            if (!oldest || oldest === cursor || !grew) break;
            cursor = oldest;
        }
        return [...all.values()].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
    }

    /* ------------------------------------------------------------------ */
    /* Collecte                                                            */
    /* ------------------------------------------------------------------ */

    const queue = [];
    let flushTimer = null;
    let collected = 0;

    async function flushQueue() {
        flushTimer = null;
        const batch = queue.splice(0, queue.length);
        if (!batch.length) return;
        try { await obsPut(batch); } catch (e) { console.warn(NC, "IndexedDB", e); }
        emit("batch", batch);
    }

    function collect(msg, source = "live", opts = {}) {
        if (!msg || !msg.id) return null;
        const cid = opts.channelId ? String(opts.channelId) : channelId();
        const msgChannel = String(msg.channel_id ?? msg.channelId ?? "");
        const dropChannel = String(settings.dropChannelId || "");
        if (!opts.anyChannel && cid && msgChannel && msgChannel !== cid && msgChannel !== dropChannel) return null;

        const author = msg.author || {};
        const authorId = String(author.id || msg.author_id || "");
        const configured = settings.botIds.map(String).filter(Boolean);
        const isBot = author.bot === true || (msg.webhook_id != null);
        if (configured.length) {
            if (authorId && !configured.includes(authorId)) return null;
        } else if (!isBot) {
            // Sans liste d'IDs, on ne garde que les bots (évite d'aspirer le salon).
            return null;
        }

        const a = analyze(msg);
        // Un drop peut avoir un embed minimal ; le salon configuré suffit à le
        // classer, et le clic de récompense est un gain.
        if (a.game === "unknown" && settings.dropChannelId && msgChannel === String(settings.dropChannelId)) {
            a.game = "drop";
            if (/\b(?:claimed?|received?|got|obtenu|r[ée]cup[ée]r[ée]|won)\b/i.test(a.text || "")) a.label = "win";
        }
        if (!settings.captureAll && a.game === "unknown") return null;

        const sf = snowflake(msg.id);
        const ts = msg.timestamp ? new Date(msg.timestamp).getTime() : (sf?.ts || Date.now());
        const obs = {
            id: String(msg.id),
            channelId: msgChannel || cid,
            guildId: String(msg.guild_id ?? ""),
            authorId,
            authorName: author.username || author.global_name || "",
            ts,
            iso: new Date(ts).toISOString(),
            snowflake: sf,
            game: a.game,
            label: a.label,
            detail: a.detail,
            text: (a.text || "").slice(0, settings.maxText),
            buttons: componentList(msg),
            raw: settings.storeRaw ? safe(() => JSON.stringify(msg.embeds || []).slice(0, 12000), null) : null,
            source,
            collectedAt: nowISO()
        };
        queue.push(obs);
        collected++;
        emit("obs", obs);
        if (!flushTimer) flushTimer = setTimeout(flushQueue, 700);
        return obs;
    }

    /**
     * Scan réel : messages rendus dans le DOM + MessageStore + historique
     * fetchMessages. Ne dépend pas d'un seul chemin, ce qui évite le bouton
     * « scanner » qui ne trouvait rien quand le store n'était pas prêt.
     */
    async function scanChannel({ max = 1000, channel = null, includeRendered = true, onProgress } = {}) {
        const cid = channel ? String(channel) : channelId();
        if (!cid) throw new Error("Aucun salon ciblé");
        const found = new Map();
        const add = m => { if (m?.id) found.set(String(m.id), m); };

        if (includeRendered) {
            for (const root of document.querySelectorAll('[id^="chat-messages-"]')) {
                const m = root.id.match(/^chat-messages-(\d+)-(\d+)$/);
                if (!m) continue;
                if (channel && m[1] !== String(channel)) continue;
                const fm = getFiberMessage(root);
                if (fm?.id) { add(fm); continue; }
                const text = domText(root);
                if (!text) continue;
                add({ id: m[2], channel_id: m[1], content: "", embeds: [{ description: text }], author: { bot: true } });
            }
        }

        const messageStore = findStore("MessageStore");
        try {
            const coll = messageStore?.getMessages?.(cid);
            const list = typeof coll?.toArray === "function" ? coll.toArray() : (Array.isArray(coll) ? coll : (coll ? Object.values(coll) : []));
            for (const m of list) add(m);
        } catch (e) { debug("scan store", e); }

        let history = [];
        try {
            history = await fetchHistory({ max, channel: cid });
            for (const m of history) add(m);
        } catch (e) {
            debug("scan history", e);
        }

        const msgs = [...found.values()].sort((a, b) => {
            try { return BigInt(a.id) < BigInt(b.id) ? -1 : 1; } catch (_) { return 0; }
        });
        let kept = 0;
        const labels = { win: 0, loss: 0, push: 0, unknown: 0 };
        for (const m of msgs) {
            const obs = collect(m, "scan", { channelId: cid, anyChannel: true });
            if (obs) {
                kept++;
                const label = obs.label && labels[obs.label] != null ? obs.label : "unknown";
                labels[label]++;
            }
            if (onProgress && (kept % 40 === 0)) onProgress(kept, msgs.length);
        }
        await flushQueue();
        return { scanned: msgs.length, kept, labels, source: history.length ? "history" : "dom" };
    }

    async function backfill({ max = 1000, channel = null, onProgress } = {}) {
        return scanChannel({ max, channel, onProgress });
    }

    /* ------------------------------------------------------------------ */
    /* Veille DOM                                                          */
    /* ------------------------------------------------------------------ */

    const seenSig = new Map();
    const rootTimers = new Map();
    let observer = null;
    const watchers = new Set();

    function getFiberMessage(root) {
        try {
            const key = Object.keys(root).find(k => k.startsWith("__reactFiber$"));
            if (!key) return null;
            let f = root[key];
            for (let i = 0; f && i < 90; i++, f = f.return) {
                const m = f.memoizedProps?.message;
                if (m && m.id && (m.channel_id || m.channelId)) return m;
            }
        } catch (_) { /* ignore */ }
        return null;
    }

    function domText(root) {
        const blocks = [];
        for (const node of root.querySelectorAll('[class*="embedFull"], [class*="embedWrapper"], [class*="embedContainer"], [class*="embed"]')) {
            if (!(node instanceof HTMLElement) || !node.textContent?.trim()) continue;
            const parts = [node.innerText || node.textContent || ""];
            for (const c of node.querySelectorAll("[aria-label], [title], [alt]")) {
                for (const a of ["aria-label", "title", "alt"]) {
                    const v = c.getAttribute?.(a);
                    if (v) parts.push(v);
                }
            }
            const block = parts.filter(Boolean).join("\n").trim();
            if (block && !blocks.includes(block)) blocks.push(block);
        }
        return blocks.join("\n\n");
    }

    function scanRoot(root) {
        if (!(root instanceof HTMLElement)) return;
        const m = root.id?.match(/^chat-messages-(\d+)-(\d+)$/);
        if (!m) return;
        const id = m[2];

        const fiber = getFiberMessage(root);
        const msg = fiber || { id, channel_id: m[1], content: "", embeds: [], author: { bot: true } };
        if (!fiber) {
            const text = domText(root);
            if (!text) return;
            msg.embeds = [{ description: text }];
        }

        // Les boutons changent d'état sans que le texte bouge : on les inclut dans
        // la signature, et les watchers voient chaque mise à jour.
        const text = fiber ? messageText(msg) : embedText(msg.embeds[0]);
        const disabled = root.querySelectorAll('button[disabled], [aria-disabled="true"]').length;
        const sig = `${text.length}|${text.slice(0, 160)}|${msg.embeds?.length || 0}|${root.querySelectorAll("button").length}|${disabled}`;
        const changed = seenSig.get(id) !== sig;

        for (const fn of watchers) {
            try { fn(msg, root); } catch (e) { console.warn(NC, "watch", e); }
        }

        if (!changed) return;
        seenSig.set(id, sig);
        if (seenSig.size > 8000) seenSig.clear();
        const ch = String(msg.channel_id ?? msg.channelId ?? "");
        if (!settings.channelId || ch === settings.channelId || (settings.dropChannelId && ch === String(settings.dropChannelId))) {
            collect(msg, fiber ? "fiber" : "dom");
        }
    }

    function startObserver() {
        if (observer) return;
        observer = new MutationObserver(muts => {
            const roots = new Set();
            for (const mu of muts) {
                const target = mu.target instanceof HTMLElement ? mu.target : mu.target?.parentElement;
                const r = target?.closest?.('[id^="chat-messages-"]');
                if (r) roots.add(r);
                // Les lignes de boutons peuvent vivre dans #message-accessories…
                // hors du <li> : on retrouve le message par son ID.
                const acc = target?.closest?.('[id^="message-accessories-"]');
                if (acc) {
                    const mid = String(acc.id).split("-").pop();
                    const mr = messageRoot(mid);
                    if (mr) roots.add(mr);
                }
                for (const node of mu.addedNodes || []) {
                    if (!(node instanceof HTMLElement)) continue;
                    const own = node.matches?.('[id^="chat-messages-"]') ? node : null;
                    if (own) roots.add(own);
                    else node.querySelectorAll?.('[id^="chat-messages-"]').forEach(c => roots.add(c));
                }
            }
            for (const r of roots) {
                const id = r.id || String(Math.random());
                const prev = rootTimers.get(id);
                if (prev) clearTimeout(prev);
                rootTimers.set(id, setTimeout(() => {
                    rootTimers.delete(id);
                    if (r.isConnected) scanRoot(r);
                }, 150));
            }
        });
        observer.observe(document.body, { childList: true, subtree: true, characterData: true });
        document.querySelectorAll('[id^="chat-messages-"]').forEach(r => setTimeout(() => scanRoot(r), 50));
    }

    function watch(fn) {
        watchers.add(fn);
        startObserver();
        return () => watchers.delete(fn);
    }

    function rescan(force = true) {
        if (force) seenSig.clear();
        startObserver();
        document.querySelectorAll('[id^="chat-messages-"]').forEach(r => scanRoot(r));
    }

    /* ------------------------------------------------------------------ */
    /* Statistiques                                                        */
    /* ------------------------------------------------------------------ */

    function gammaln(x) {
        const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
        let y = x;
        const tmp = x + 5.5 - (x + 0.5) * Math.log(x + 5.5);
        let ser = 1.000000000190015;
        for (let j = 0; j < 6; j++) ser += c[j] / ++y;
        return -tmp + Math.log(2.5066282746310005 * ser / x);
    }

    function gammaP(a, x) {
        if (x <= 0) return 0;
        if (x < a + 1) {
            let sum = 1 / a, term = sum;
            for (let n = 1; n < 300; n++) {
                term *= x / (a + n);
                sum += term;
                if (Math.abs(term) < Math.abs(sum) * 1e-14) break;
            }
            return sum * Math.exp(-x + a * Math.log(x) - gammaln(a));
        }
        let b = x + 1 - a, c = 1e300, d = 1 / b, h = d;
        for (let i = 1; i < 300; i++) {
            const an = -i * (i - a);
            b += 2;
            d = an * d + b;
            if (Math.abs(d) < 1e-300) d = 1e-300;
            c = b + an / c;
            if (Math.abs(c) < 1e-300) c = 1e-300;
            d = 1 / d;
            const del = d * c;
            h *= del;
            if (Math.abs(del - 1) < 1e-14) break;
        }
        return 1 - Math.exp(-x + a * Math.log(x) - gammaln(a)) * h;
    }

    const chi2P = (x, df) => (df <= 0 || x <= 0) ? 1 : 1 - gammaP(df / 2, x / 2);

    function erf(x) {
        const s = Math.sign(x);
        const ax = Math.abs(x);
        const t = 1 / (1 + 0.3275911 * ax);
        const y = 1 - (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t) * Math.exp(-ax * ax);
        return s * y;
    }
    const pTwoSided = z => 1 - erf(Math.abs(z) / Math.SQRT2);

    function mean(arr) {
        return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
    }
    function variance(arr) {
        if (arr.length < 2) return 0;
        const m = mean(arr);
        return arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1);
    }

    function chiSquare(observed, expected) {
        let chi2 = 0;
        for (let i = 0; i < observed.length; i++) {
            const e = expected[i];
            if (!e) continue;
            chi2 += ((observed[i] - e) ** 2) / e;
        }
        const df = Math.max(1, observed.filter((_, i) => expected[i] > 0).length - 1);
        return { chi2, df, p: chi2P(chi2, df) };
    }

    function chiSquareUniform(counts) {
        const n = counts.reduce((a, b) => a + b, 0);
        const e = n / counts.length;
        return chiSquare(counts, counts.map(() => e));
    }

    function zTest(successes, trials, p0) {
        if (!trials) return { z: 0, p: 1, rate: 0, expected: 0 };
        const rate = successes / trials;
        const se = Math.sqrt(p0 * (1 - p0) / trials);
        const z = se ? (rate - p0) / se : 0;
        return { z, p: pTwoSided(z), rate, expected: p0 * trials };
    }

    function runsTest(seq) {
        // seq: [0/1]
        const n1 = seq.filter(x => x === 1).length;
        const n0 = seq.length - n1;
        if (n1 < 5 || n0 < 5) return null;
        let runs = 1;
        for (let i = 1; i < seq.length; i++) if (seq[i] !== seq[i - 1]) runs++;
        const mu = (2 * n1 * n0) / (n1 + n0) + 1;
        const va = (2 * n1 * n0 * (2 * n1 * n0 - n1 - n0)) / (((n1 + n0) ** 2) * (n1 + n0 - 1));
        const z = va > 0 ? (runs - mu) / Math.sqrt(va) : 0;
        return { runs, expected: mu, z, p: pTwoSided(z) };
    }

    function markov(seq, states = 2) {
        const counts = Array.from({ length: states }, () => new Array(states).fill(0));
        for (let i = 0; i < seq.length - 1; i++) {
            const a = seq[i], b = seq[i + 1];
            if (a >= 0 && a < states && b >= 0 && b < states) counts[a][b]++;
        }
        const rowT = counts.map(r => r.reduce((a, b) => a + b, 0));
        const total = rowT.reduce((a, b) => a + b, 0);
        const colT = counts[0].map((_, j) => counts.reduce((s, r) => s + r[j], 0));
        let chi2 = 0;
        for (let i = 0; i < states; i++) {
            for (let j = 0; j < states; j++) {
                const e = total ? (rowT[i] * colT[j]) / total : 0;
                if (e > 0) chi2 += ((counts[i][j] - e) ** 2) / e;
            }
        }
        const df = (states - 1) ** 2;
        return { counts, chi2, df, p: chi2P(chi2, df) };
    }

    function autocorr(arr, lag = 1) {
        if (arr.length <= lag + 2) return 0;
        const m = mean(arr);
        let num = 0, den = 0;
        for (let i = 0; i < arr.length; i++) {
            den += (arr[i] - m) ** 2;
            if (i >= lag) num += (arr[i] - m) * (arr[i - lag] - m);
        }
        return den ? num / den : 0;
    }

    function entropy(counts) {
        const n = counts.reduce((a, b) => a + b, 0);
        if (!n) return 0;
        let H = 0;
        for (const c of counts) {
            if (!c) continue;
            const p = c / n;
            H -= p * Math.log2(p);
        }
        return H;
    }

    const stats = {
        mean, variance, chi2P, chiSquare, chiSquareUniform, zTest,
        runsTest, markov, autocorr, entropy, pTwoSided, erf
    };

    function selfTest() {
        const out = [];
        const close = (a, b, tol) => Math.abs(a - b) <= tol;
        const p1 = chi2P(3.841458820694124, 1);
        out.push(["chi2 p(3.841,1)≈0.05", p1, close(p1, 0.05, 0.002)]);
        const z = zTest(60, 100, 0.5);
        out.push(["z-test 60/100 p≈0.0455", z.p, close(z.p, 0.0455, 0.005)]);
        const rt = runsTest([1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0]);
        out.push(["runs test alterné z<0", rt.z, rt.z < 0]);
        const unif = chiSquareUniform([10, 10, 10, 10]);
        out.push(["chi2 uniforme p=1", unif.p, close(unif.p, 1, 1e-6)]);
        for (const [name, value, ok] of out) {
            console.log(`${ok ? "✅" : "❌"} ${name} = ${typeof value === "number" ? value.toFixed(6) : value}`);
        }
        return out;
    }

    /* ------------------------------------------------------------------ */
    /* Export local                                                        */
    /* ------------------------------------------------------------------ */

    function download(filename, text, mime = "application/json") {
        const blob = new Blob([text], { type: mime + ";charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const a = h("a", { href: url, download: filename });
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
    }

    function toCSV(rows) {
        if (!rows.length) return "";
        const cols = [...new Set(rows.flatMap(r => Object.keys(r)))];
        const esc = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
        return [cols.join(","), ...rows.map(r => cols.map(c => esc(r[c])).join(","))].join("\n");
    }

    function exportObservations(list, name = "blocky-observations") {
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        download(`${name}-${stamp}.json`, JSON.stringify({
            schema: 2, exportedAt: nowISO(), count: list.length, observations: list
        }, null, 2));
    }

    /* ------------------------------------------------------------------ */
    /* Réseau local                                                        */
    /* ------------------------------------------------------------------ */

    const netQueue = [];
    let netTimer = null;
    function push(items) {
        if (!settings.ingest || !items?.length) return;
        netQueue.push(...items);
        if (netTimer) return;
        netTimer = setTimeout(() => {
            netTimer = null;
            const batch = netQueue.splice(0, netQueue.length);
            const body = JSON.stringify({ source: "blocky-lab", version: VERSION, observations: batch });
            const done = ok => emit("net", { ok, count: batch.length });
            if (typeof GM_xmlhttpRequest === "function") {
                try {
                    GM_xmlhttpRequest({
                        method: "POST",
                        url: settings.ingestUrl,
                        headers: { "Content-Type": "application/json" },
                        data: body,
                        onload: r => done(r.status >= 200 && r.status < 300),
                        onerror: () => done(false)
                    });
                    return;
                } catch (_) { /* fallback */ }
            }
            fetch(settings.ingestUrl, { method: "POST", mode: "no-cors", headers: { "Content-Type": "text/plain" }, body })
                .then(() => done(true)).catch(() => done(false));
        }, 1800);
    }
    on("batch", push);

    /* ------------------------------------------------------------------ */
    /* Interface                                                           */
    /* ------------------------------------------------------------------ */

    const CSS = `
        #bl-panel{position:fixed;right:18px;bottom:18px;z-index:2147483000;width:430px;max-width:calc(100vw - 24px);
            max-height:78vh;display:flex;flex-direction:column;background:#1e1f22;color:#f2f3f5;border:1px solid #3f4147;
            border-radius:12px;box-shadow:0 16px 48px rgba(0,0,0,.55);font:13px/1.45 "gg sans",Arial,sans-serif;overflow:hidden}
        #bl-panel.bl-hidden{display:none}
        .bl-head{display:flex;align-items:center;gap:8px;padding:9px 12px;background:#2b2d31;border-bottom:1px solid #3f4147;flex:0 0 auto;min-height:38px}
        .bl-title{font-weight:800;font-size:14px;letter-spacing:.2px}
        .bl-ver{font-size:10px;opacity:.5}
        .bl-spacer{flex:1}
        .bl-icon{background:transparent;border:0;color:#b5bac1;cursor:pointer;font-size:16px;line-height:1;padding:2px 6px;border-radius:4px}
        .bl-icon:hover{background:#3f4147;color:#fff}
        #bl-tabmenu{position:fixed;z-index:2147483002;min-width:180px;max-width:min(320px,calc(100vw - 20px));max-height:min(420px,70vh);overflow:auto;padding:5px;border:1px solid var(--bl-line,#3f4147);border-radius:8px;background:var(--bl-bg2,#2b2d31);color:var(--bl-text,#f2f3f5);box-shadow:0 12px 32px rgba(0,0,0,.5);font:12px/1.4 "gg sans",Arial,sans-serif}
        #bl-tabmenu button{display:block;width:100%;text-align:left;background:transparent;border:0;border-radius:5px;color:inherit;padding:6px 8px;cursor:pointer;font:inherit}
        #bl-tabmenu button:hover,#bl-tabmenu button.bl-on{background:var(--bl-hover,rgba(255,255,255,.08))}
        .bl-tabs{display:flex;flex-wrap:nowrap;align-items:center;gap:3px;padding:6px 8px 4px;background:#232428;overflow-x:auto;overflow-y:hidden;min-height:38px;flex:0 0 auto;scrollbar-width:thin;overscroll-behavior-x:contain}
        .bl-tab{background:transparent;border:0;border-bottom:2px solid transparent;color:#b5bac1;padding:6px 9px;font:600 12px Arial;cursor:pointer;white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis;border-radius:5px 5px 0 0;flex:0 0 auto}
        .bl-tab:hover{color:#fff;background:rgba(255,255,255,.06)}
        .bl-tab.bl-on{color:#fff;border-bottom-color:#5865f2}
        .bl-body{padding:11px 12px;overflow:auto;flex:1;min-height:120px}
        #bl-pill{position:fixed;left:18px;bottom:18px;z-index:2147483000;width:40px;height:40px;border-radius:50%;border:0;
            background:#5865f2;color:#fff;font:800 12px Arial;cursor:pointer;box-shadow:0 6px 18px rgba(0,0,0,.45)}
        #bl-pill:hover{background:#4752c4}
        .bl-toast{padding:9px 14px;border-radius:8px;color:#fff;font:600 12px Arial;box-shadow:0 8px 24px rgba(0,0,0,.4);
            opacity:1;transition:opacity .25s;max-width:70vw}
        #bl-toast-host{position:fixed;left:50%;top:16px;transform:translateX(-50%);z-index:2147483001;display:flex;flex-direction:column;gap:6px;align-items:center}
        .bl-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:6px 0}
        .bl-col{display:flex;flex-direction:column;gap:4px;margin:6px 0}
        .bl-btn{background:#5865f2;border:0;border-radius:6px;color:#fff;font:700 12px Arial;padding:7px 10px;cursor:pointer}
        .bl-btn:hover{filter:brightness(1.1)}
        .bl-btn.bl-sec{background:#4e5058}
        .bl-btn.bl-danger{background:#da373c}
        .bl-btn:disabled{opacity:.45;cursor:not-allowed}
        .bl-input,.bl-select{background:#111214;border:1px solid #3f4147;border-radius:5px;color:#f2f3f5;padding:5px 7px;font:12px Arial;width:100%;box-sizing:border-box}
        .bl-label{font-size:11px;opacity:.7}
        .bl-card{background:#2b2d31;border:1px solid #3f4147;border-radius:8px;padding:9px 11px;margin:6px 0}
        .bl-kv{display:flex;justify-content:space-between;gap:10px;font-size:12px;padding:2px 0;border-bottom:1px solid rgba(255,255,255,.05)}
        .bl-kv b{font-variant-numeric:tabular-nums}
        .bl-good{color:#57f287}.bl-bad{color:#ed4245}.bl-warn{color:#fee75c}.bl-muted{opacity:.6}
        .bl-table{width:100%;border-collapse:collapse;font-size:11px;font-variant-numeric:tabular-nums}
        .bl-table th,.bl-table td{text-align:left;padding:3px 5px;border-bottom:1px solid rgba(255,255,255,.06)}
        .bl-table th{opacity:.65;font-weight:600}
        .bl-chips{display:flex;flex-wrap:wrap;gap:3px;max-height:76px;overflow:auto;margin-top:4px}
        .bl-chip{width:16px;height:16px;border-radius:3px;font:700 9px/16px Arial;text-align:center;color:#fff}
        .bl-bar{height:6px;background:#111214;border-radius:3px;overflow:hidden;margin-top:3px}
        .bl-bar>i{display:block;height:100%;background:#5865f2}
        .bl-inline{margin-top:8px;padding:9px 11px;border-left:4px solid #5865f2;background:rgba(88,101,242,.12);border-radius:5px;font-size:12px}
        .bl-inline b{font-size:14px}
        .bl-hl{outline:3px solid #57f287 !important;outline-offset:2px !important;box-shadow:0 0 12px rgba(87,242,135,.7) !important}
        .bl-code{font-family:ui-monospace,Consolas,monospace;font-size:11px;white-space:pre-wrap;word-break:break-word;max-height:160px;overflow:auto;background:#111214;padding:7px;border-radius:5px}
    `;

    /* Skin v2 : variables, thèmes, densité, drag & drop. Les règles ci-dessous
       surchargent volontairement le CSS d'origine (même spécificité, feuille
       injectée après) pour ne pas casser les anciens onglets. */
    const CSS_V2 = `
        #bl-panel{
            --bl-accent:#5865f2;--bl-bg:#1e1f22;--bl-bg2:#2b2d31;--bl-bg3:#111214;
            --bl-text:#f2f3f5;--bl-muted:#a3a6ad;--bl-line:#3f4147;--bl-line-soft:rgba(255,255,255,.07);
            --bl-hover:rgba(255,255,255,.06);--bl-good:#57f287;--bl-bad:#ed4245;--bl-warn:#fee75c;
            --bl-radius:12px;--bl-font-family:"gg sans",Arial,sans-serif;
            width:var(--bl-width,430px);max-height:var(--bl-max-h,78vh);font-size:var(--bl-font,13px);
            font-family:var(--bl-font-family);
            background:var(--bl-bg);color:var(--bl-text);border-color:var(--bl-line);border-radius:var(--bl-radius);
            color-scheme:dark;transition:opacity .15s ease
        }
        #bl-panel[data-theme="light"]{
            --bl-bg:#f7f8fa;--bl-bg2:#ffffff;--bl-bg3:#eef0f4;--bl-text:#1b1d21;--bl-muted:#5c6470;
            --bl-line:#d4d8df;--bl-line-soft:rgba(0,0,0,.08);--bl-hover:rgba(0,0,0,.055);color-scheme:light
        }
        #bl-panel[data-theme="midnight"]{
            --bl-bg:#0b0d12;--bl-bg2:#121622;--bl-bg3:#080a0f;--bl-text:#e6e9f2;--bl-muted:#8b93a7;
            --bl-line:#232a3b;--bl-line-soft:rgba(255,255,255,.06);--bl-hover:rgba(255,255,255,.05)
        }
        #bl-panel[data-theme="contrast"]{
            --bl-bg:#000;--bl-bg2:#0a0a0a;--bl-bg3:#000;--bl-text:#fff;--bl-muted:#cfcfcf;
            --bl-line:#7a7a7a;--bl-line-soft:rgba(255,255,255,.25);--bl-hover:rgba(255,255,255,.14)
        }
        #bl-panel.bl-blur{background:color-mix(in srgb,var(--bl-bg) 86%,transparent);backdrop-filter:blur(14px) saturate(1.2)}
        #bl-panel.bl-collapsed{max-height:none}
        #bl-panel.bl-collapsed .bl-tabs,#bl-panel.bl-collapsed .bl-body{display:none}
        #bl-panel .bl-head{background:var(--bl-bg2);border-bottom-color:var(--bl-line);cursor:grab;touch-action:none;user-select:none}
        #bl-panel .bl-head:active{cursor:grabbing}
        #bl-panel .bl-title{color:var(--bl-text)}
        #bl-panel .bl-icon{color:var(--bl-muted)}
        #bl-panel .bl-icon:hover{background:var(--bl-hover);color:var(--bl-text)}
        #bl-panel .bl-tabs{background:color-mix(in srgb,var(--bl-bg2) 70%,var(--bl-bg));border-bottom:1px solid var(--bl-line-soft);scrollbar-width:thin;gap:3px;padding:7px 8px 5px;min-height:40px;overflow-x:auto;overflow-y:hidden;flex:0 0 auto;position:relative;z-index:2}
        #bl-panel .bl-tab{color:var(--bl-muted);min-height:26px;font-size:max(11px,calc(var(--bl-font,13px) - 1px))}
        #bl-panel .bl-tab:hover{color:var(--bl-text);background:var(--bl-hover)}
        #bl-panel .bl-tab.bl-on{color:var(--bl-text);border-bottom-color:var(--bl-accent)}
        #bl-panel[data-tabs="pills"] .bl-tabs{gap:5px;border-bottom:1px solid var(--bl-line-soft)}
        #bl-panel[data-tabs="pills"] .bl-tab{border:1px solid var(--bl-line);border-radius:999px;background:var(--bl-bg3);padding:4px 9px}
        #bl-panel[data-tabs="pills"] .bl-tab.bl-on{border-color:var(--bl-accent);background:color-mix(in srgb,var(--bl-accent) 22%,var(--bl-bg3));color:var(--bl-text)}
        #bl-panel[data-tabs="cards"] .bl-tab{border:1px solid transparent;border-radius:7px;background:var(--bl-bg3);padding:5px 9px}
        #bl-panel[data-tabs="cards"] .bl-tab.bl-on{border-color:var(--bl-accent);background:color-mix(in srgb,var(--bl-accent) 18%,var(--bl-bg3));color:var(--bl-text)}
        #bl-panel[data-tabwrap="scroll"] .bl-tabs{flex-wrap:nowrap;overflow-x:auto;overflow-y:hidden;scrollbar-width:thin}
        #bl-panel[data-tabwrap="scroll"] .bl-tab{flex:0 0 auto}
        #bl-panel[data-tabwrap="wrap"] .bl-tabs{flex-wrap:wrap;align-content:flex-start;overflow-x:hidden;overflow-y:auto;max-height:min(32vh,160px);min-height:40px;scrollbar-gutter:stable}
        #bl-panel[data-tabwrap="wrap"] .bl-tab{flex:0 0 auto;max-width:100%}
        #bl-panel .bl-tabs::-webkit-scrollbar{height:5px;width:5px}
        #bl-panel .bl-tabs::-webkit-scrollbar-thumb{background:var(--bl-line);border-radius:4px}
        #bl-panel .bl-tabs::-webkit-scrollbar{height:6px;width:6px}
        #bl-panel .bl-body{scrollbar-width:thin;scrollbar-color:var(--bl-line) transparent;overflow-wrap:anywhere;overscroll-behavior:contain}
        #bl-panel .bl-table{table-layout:fixed}
        #bl-panel .bl-table td{word-break:break-word;vertical-align:top}
        #bl-panel .bl-table td .bl-select{max-width:100%}
        #bl-panel .bl-card{background:var(--bl-bg2);border-color:var(--bl-line-soft)}
        #bl-panel .bl-kv{border-bottom-color:var(--bl-line-soft);gap:8px}
        #bl-panel .bl-kv>span:first-child{color:var(--bl-muted)}
        #bl-panel .bl-btn{background:var(--bl-accent)}
        #bl-panel .bl-btn.bl-sec{background:var(--bl-bg3);border:1px solid var(--bl-line);color:var(--bl-text)}
        #bl-panel .bl-btn.bl-danger{background:var(--bl-bad)}
        #bl-panel .bl-input,#bl-panel .bl-select,#bl-panel .bl-textarea{
            background:var(--bl-bg3);border-color:var(--bl-line);color:var(--bl-text);border-radius:6px
        }
        #bl-panel .bl-input:focus,#bl-panel .bl-select:focus,#bl-panel .bl-textarea:focus{outline:2px solid var(--bl-accent);outline-offset:0}
        #bl-panel .bl-textarea{width:100%;min-height:64px;box-sizing:border-box;padding:6px 8px;font:12px/1.4 ui-monospace,Consolas,monospace;resize:vertical}
        #bl-panel .bl-label{color:var(--bl-muted)}
        #bl-panel .bl-good{color:var(--bl-good)}#bl-panel .bl-bad{color:var(--bl-bad)}#bl-panel .bl-warn{color:var(--bl-warn)}
        #bl-panel .bl-muted{color:var(--bl-muted);opacity:1}
        #bl-panel .bl-table th,#bl-panel .bl-table td{border-bottom-color:var(--bl-line-soft)}
        #bl-panel .bl-bar{background:var(--bl-bg3)}
        #bl-panel .bl-bar>i{background:var(--bl-accent)}
        #bl-panel .bl-inline{background:color-mix(in srgb,var(--bl-accent) 12%,transparent);border-left-color:var(--bl-accent)}
        #bl-panel .bl-code{background:var(--bl-bg3);color:var(--bl-text);border:1px solid var(--bl-line-soft)}
        #bl-panel .bl-hl{outline-color:var(--bl-good) !important}
        #bl-panel.bl-compact .bl-body{padding:7px 8px}
        #bl-panel.bl-compact .bl-card{padding:6px 8px;margin:4px 0;border-radius:6px}
        #bl-panel.bl-compact .bl-row{margin:3px 0;gap:5px}
        #bl-panel.bl-compact .bl-kv{font-size:11px;padding:1px 0}
        #bl-panel.bl-compact .bl-btn{padding:5px 7px;font-size:11px}
        #bl-panel.bl-compact .bl-head{padding:5px 8px}
        #bl-panel .bl-sub{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--bl-muted);margin:12px 0 4px}
        #bl-panel .bl-sep{height:1px;background:var(--bl-line-soft);margin:10px 0}
        #bl-panel .bl-badge{display:inline-block;padding:1px 6px;border-radius:999px;font:700 10px Arial;background:var(--bl-bg3);border:1px solid var(--bl-line);color:var(--bl-muted)}
        #bl-panel .bl-badge.bl-badge-good{color:var(--bl-good);border-color:var(--bl-good)}
        #bl-panel .bl-badge.bl-badge-bad{color:var(--bl-bad);border-color:var(--bl-bad)}
        #bl-panel .bl-badge.bl-badge-warn{color:var(--bl-warn);border-color:var(--bl-warn)}
        #bl-panel .bl-grid2{display:grid;grid-template-columns:1fr 1fr;gap:8px}
        #bl-panel .bl-grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}
        #bl-panel input[type=range]{accent-color:var(--bl-accent);width:100%}
        #bl-panel input[type=checkbox]{accent-color:var(--bl-accent)}
        #bl-panel input[type=color]{width:34px;height:26px;padding:0;border:1px solid var(--bl-line);border-radius:5px;background:var(--bl-bg3)}
        #bl-panel .bl-list{display:flex;flex-direction:column;gap:3px;max-height:180px;overflow:auto}
        #bl-panel .bl-list label{display:flex;align-items:center;gap:6px;font-size:12px;padding:2px 3px;border-radius:4px}
        #bl-panel .bl-list label:hover{background:var(--bl-hover)}
        #bl-panel .bl-link{color:var(--bl-accent);cursor:pointer;text-decoration:underline;background:none;border:0;font:inherit;padding:0}
        #bl-panel details>summary{list-style:none;cursor:pointer;display:flex;align-items:center;gap:6px;flex-wrap:wrap}
        #bl-panel details>summary::-webkit-details-marker{display:none}
        #bl-panel details>summary::before{content:"▸";color:var(--bl-muted);font-size:11px}
        #bl-panel details[open]>summary::before{content:"▾"}
        #bl-panel details[open]>summary{margin-bottom:6px}
        #bl-panel .bl-toast{border-left:3px solid var(--bl-accent)}
        #bl-bj-badge{position:fixed;z-index:2147483000;pointer-events:none;padding:5px 9px;border-radius:7px;
            font:800 11px/1.3 Arial;color:#fff;box-shadow:0 6px 18px rgba(0,0,0,.5);border:1px solid rgba(255,255,255,.25);
            max-width:190px;white-space:normal}
        @media (max-width:720px){
            #bl-panel{width:calc(100vw - 20px) !important;max-height:72vh}
            #bl-panel .bl-grid2,#bl-panel .bl-grid3{grid-template-columns:1fr}
        }
    `;

    const ui = (() => {
        let panel = null;
        let bodyEl = null;
        let tabsEl = null;
        let current = null;
        let refreshRaf = 0;
        let collapseBtn = null;
        const tabs = [];

        const prefs = () => settings.ui;

        function injectCSS() {
            if (!document.getElementById("bl-style")) {
                document.head?.appendChild(h("style", { id: "bl-style", text: CSS }));
            }
            if (!document.getElementById("bl-style-v2")) {
                document.head?.appendChild(h("style", { id: "bl-style-v2", text: CSS_V2 }));
            }
        }

        function applyPrefs() {
            if (!panel) return;
            const p = prefs();
            panel.dataset.theme = p.theme || "dark";
            panel.style.setProperty("--bl-accent", p.accent || "#5865f2");
            panel.style.setProperty("--bl-width", `${Math.max(300, Number(p.width) || 430)}px`);
            panel.style.setProperty("--bl-max-h", `${clamp(Number(p.maxHeight) || 78, 30, 96)}vh`);
            panel.style.setProperty("--bl-font", `${clamp(Number(p.font) || 13, 10, 18)}px`);
            panel.style.setProperty("--bl-radius", `${clamp(Number(p.radius) || 0, 0, 24)}px`);
            const FONTS = {
                discord: '"gg sans",Arial,sans-serif',
                system: 'system-ui,Segoe UI,Arial,sans-serif',
                mono: 'ui-monospace,Consolas,monospace',
                serif: 'Georgia,"Times New Roman",serif'
            };
            panel.style.setProperty("--bl-font-family", FONTS[p.fontFamily] || FONTS.discord);
            panel.dataset.tabs = p.tabStyle || "underline";
            panel.dataset.tabwrap = p.tabWrap === false ? "scroll" : "wrap";
            panel.style.opacity = String(clamp(Number(p.opacity) || 100, 35, 100) / 100);
            panel.classList.toggle("bl-compact", Boolean(p.compact));
            panel.classList.toggle("bl-blur", Boolean(p.blur));
            panel.classList.toggle("bl-collapsed", Boolean(p.collapsed));
            if (collapseBtn) collapseBtn.textContent = p.collapsed ? "▢" : "–";
            if (p.x != null && p.y != null) {
                const x = Math.max(0, Math.min(Number(p.x) || 0, Math.max(0, window.innerWidth - 160)));
                const y = Math.max(0, Math.min(Number(p.y) || 0, Math.max(0, window.innerHeight - 48)));
                panel.style.left = `${x}px`;
                panel.style.top = `${y}px`;
                panel.style.right = "auto";
                panel.style.bottom = "auto";
            } else {
                const dock = /^(?:tl|tr|bl|br)$/.test(p.dock) ? p.dock : "br";
                const left = dock.endsWith("l");
                const top = dock.startsWith("t");
                panel.style.left = left ? "18px" : "auto";
                panel.style.right = left ? "auto" : "18px";
                panel.style.top = top ? "18px" : "auto";
                panel.style.bottom = top ? "auto" : "18px";
            }
            const pill = document.getElementById("bl-pill");
            if (pill) {
                const dock = /^(?:tl|tr|bl|br)$/.test(p.dock) ? p.dock : "br";
                const left = dock.endsWith("l");
                const top = dock.startsWith("t");
                pill.style.left = left ? "auto" : "18px";
                pill.style.right = left ? "18px" : "auto";
                pill.style.top = top ? "18px" : "auto";
                pill.style.bottom = top ? "auto" : "18px";
                pill.style.background = p.accent || "#5865f2";
                pill.textContent = String(p.pillText || "BL").slice(0, 4) || "BL";
            }
            const titleEl = panel.querySelector(".bl-title");
            if (titleEl) titleEl.textContent = String(p.panelTitle || "Blocky Lab").slice(0, 40);
            if (toastHost) {
                toastHost.style.top = p.toastPos === "bottom" ? "auto" : "16px";
                toastHost.style.bottom = p.toastPos === "bottom" ? "16px" : "auto";
            }
        }

        function startDrag(e) {
            if (!panel || e.button !== 0 || e.target.closest("button,input,select,textarea,a")) return;
            const r = panel.getBoundingClientRect();
            const dx = e.clientX - r.left, dy = e.clientY - r.top;
            const move = ev => {
                const x = clamp(ev.clientX - dx, 0, Math.max(0, window.innerWidth - 140));
                const y = clamp(ev.clientY - dy, 0, Math.max(0, window.innerHeight - 48));
                prefs().x = Math.round(x);
                prefs().y = Math.round(y);
                panel.style.left = `${x}px`;
                panel.style.top = `${y}px`;
                panel.style.right = "auto";
                panel.style.bottom = "auto";
            };
            const up = () => {
                window.removeEventListener("pointermove", move);
                window.removeEventListener("pointerup", up);
                window.removeEventListener("pointercancel", up);
                saveSettings();
            };
            window.addEventListener("pointermove", move);
            window.addEventListener("pointerup", up);
            window.addEventListener("pointercancel", up);
            e.preventDefault();
        }

        function resetPosition() {
            prefs().x = null;
            prefs().y = null;
            prefs().collapsed = false;
            saveSettings();
            applyPrefs();
        }

        function orderedTabs() {
            const order = prefs().tabOrder || [];
            const pos = new Map(order.map((id, i) => [id, i]));
            return [...tabs].sort((a, b) => {
                const ai = pos.has(a.id) ? pos.get(a.id) : 1e6 + tabs.findIndex(t => t.id === a.id);
                const bi = pos.has(b.id) ? pos.get(b.id) : 1e6 + tabs.findIndex(t => t.id === b.id);
                return ai - bi;
            });
        }

        function closeTabMenu() {
            document.getElementById("bl-tabmenu")?.remove();
        }

        function openTabMenu() {
            closeTabMenu();
            if (!panel) return;
            const hidden = prefs().hiddenTabs || [];
            const menu = h("div", { id: "bl-tabmenu" });
            for (const t of orderedTabs()) {
                if (hidden.includes(t.id)) continue;
                menu.appendChild(h("button", {
                    class: current === t.id ? "bl-on" : "",
                    text: (current === t.id ? "● " : "") + t.title,
                    title: t.hint || t.title,
                    onclick: () => { closeTabMenu(); select(t.id); }
                }));
            }
            document.body.appendChild(menu);
            const r = panel.getBoundingClientRect();
            const top = Math.max(8, Math.min(window.innerHeight - menu.offsetHeight - 8, r.top + 40));
            const left = Math.max(8, Math.min(window.innerWidth - menu.offsetWidth - 8, r.right - menu.offsetWidth));
            menu.style.top = `${top}px`;
            menu.style.left = `${left}px`;
            menu.style.setProperty("--bl-line", getComputedStyle(panel).getPropertyValue("--bl-line"));
            menu.style.setProperty("--bl-bg2", getComputedStyle(panel).getPropertyValue("--bl-bg2"));
            menu.style.setProperty("--bl-text", getComputedStyle(panel).getPropertyValue("--bl-text"));
            setTimeout(() => {
                const off = e => { if (!menu.contains(e.target)) { closeTabMenu(); document.removeEventListener("pointerdown", off, true); } };
                document.addEventListener("pointerdown", off, true);
            }, 0);
        }

        function renderTabs() {
            if (!tabsEl) return;
            const keepLeft = tabsEl.scrollLeft;
            const keepTop = tabsEl.scrollTop;
            tabsEl.textContent = "";
            const hidden = prefs().hiddenTabs || [];
            for (const t of orderedTabs()) {
                if (hidden.includes(t.id)) continue;
                const b = h("button", {
                    class: "bl-tab" + (current === t.id ? " bl-on" : ""),
                    text: t.title,
                    title: t.hint || t.title,
                    onclick: () => select(t.id)
                });
                b.dataset.tabId = t.id;
                tabsEl.appendChild(b);
            }
            if (current && hidden.includes(current)) {
                const first = orderedTabs().find(t => !hidden.includes(t.id));
                if (first) select(first.id);
            }
            // On restaure d'abord la position de lecture : la barre ne doit pas
            // sauter au début (ni disparaître) à chaque rafraîchissement.
            tabsEl.scrollLeft = keepLeft;
            tabsEl.scrollTop = keepTop;
            // Puis on révèle l'onglet actif SANS utiliser scrollIntoView : celui-ci
            // pouvait faire défiler la page entière et masquer la barre.
            requestAnimationFrame(() => {
                if (!tabsEl) return;
                const active = tabsEl.querySelector(".bl-tab.bl-on");
                if (!active) return;
                const ar = active.getBoundingClientRect();
                const sr = tabsEl.getBoundingClientRect();
                if (prefs().tabWrap) {
                    if (ar.top < sr.top) tabsEl.scrollTop -= sr.top - ar.top + 4;
                    else if (ar.bottom > sr.bottom) tabsEl.scrollTop += ar.bottom - sr.bottom + 4;
                } else {
                    if (ar.left < sr.left) tabsEl.scrollLeft -= sr.left - ar.left + 8;
                    else if (ar.right > sr.right) tabsEl.scrollLeft += ar.right - sr.right + 8;
                }
            });
        }

        function select(id, keepScroll = false) {
            closeTabMenu();
            const t = tabs.find(x => x.id === id);
            if (!t) return;
            if (!bodyEl || !bodyEl.isConnected) build();
            if (!bodyEl || !bodyEl.isConnected) return;
            if ((prefs().hiddenTabs || []).includes(id) && id !== "config") return;
            if (refreshRaf) { cancelAnimationFrame(refreshRaf); refreshRaf = 0; }
            const scroll = keepScroll ? bodyEl.scrollTop : 0;
            current = id;
            prefs().lastTab = id;
            saveSettings();
            renderTabs();
            bodyEl.textContent = "";
            let settled = false;
            const failed = e => {
                if (settled) return;
                settled = true;
                console.error(NC, "onglet", id, e);
                if (current !== id) return;
                bodyEl.textContent = "";
                bodyEl.appendChild(h("div", { class: "bl-card" },
                    h("div", { class: "bl-bad", text: "Erreur d'affichage : " + (e?.message || e) }),
                    h("button", { class: "bl-btn bl-sec", text: "Réessayer", onclick: () => select(id) })
                ));
            };
            try {
                const result = t.render();
                if (result && typeof result.then === "function") {
                    bodyEl.appendChild(h("div", { class: "bl-muted", text: "Chargement…" }));
                    // Filet de sécurité : un render async bloqué ne doit pas laisser
                    // le panneau sur « Chargement… » indéfiniment.
                    const guard = setTimeout(() => {
                        if (settled || current !== id) return;
                        settled = true;
                        bodyEl.textContent = "";
                        bodyEl.appendChild(h("div", { class: "bl-card" },
                            h("div", { class: "bl-warn", text: "Rendu trop long : l'onglet ne répond pas." }),
                            h("button", { class: "bl-btn bl-sec", text: "Réessayer", onclick: () => select(id) })
                        ));
                    }, 12000);
                    result.then(node => {
                        clearTimeout(guard);
                        if (settled) return;
                        settled = true;
                        if (current !== id) return;
                        bodyEl.textContent = "";
                        if (node) bodyEl.appendChild(node);
                        bodyEl.scrollTop = scroll;
                    }).catch(e => { clearTimeout(guard); failed(e); });
                } else {
                    settled = true;
                    if (result && current === id) {
                        bodyEl.textContent = "";
                        bodyEl.appendChild(result);
                        bodyEl.scrollTop = scroll;
                    }
                }
            } catch (e) { failed(e); }
        }

        function ensurePill() {
            let pill = document.getElementById("bl-pill");
            if (pill) return pill;
            pill = h("button", { id: "bl-pill", text: "BL", title: "Blocky Lab (Alt+Maj+B)", onclick: toggle });
            document.body.appendChild(pill);
            applyPrefs();
            return pill;
        }

        function build() {
            if (!document.body) return;
            closeTabMenu();
            injectCSS();
            if (panel?.isConnected && bodyEl?.isConnected && tabsEl?.isConnected) {
                ensurePill();
                applyPrefs();
                // Sans ce rendu, masquer/déplacer un onglet depuis Interface ne
                // mettait pas la barre à jour (onglet fantôme ou actif masqué).
                renderTabs();
                return;
            }
            if (panel?.isConnected && (!bodyEl?.isConnected || !tabsEl?.isConnected)) {
                // Le corps a été retiré (React, extension, manip DOM) : on
                // reconstruit le panneau au lieu de laisser un cadre vide.
                panel.remove();
                panel = null;
                bodyEl = null;
                tabsEl = null;
            }
            collapseBtn = h("button", {
                class: "bl-icon", title: "Réduire / déployer", text: "–",
                onclick: e => {
                    e.stopPropagation();
                    prefs().collapsed = !prefs().collapsed;
                    saveSettings();
                    applyPrefs();
                }
            });
            panel = h("div", { id: "bl-panel", class: settings.panelOpen ? "" : "bl-hidden" },
                h("div", { class: "bl-head" },
                    h("span", { class: "bl-title", text: "Blocky Lab" }),
                    h("span", { class: "bl-ver", text: "v" + VERSION }),
                    h("span", { class: "bl-spacer" }),
                    h("button", { class: "bl-icon", title: "Tous les onglets", text: "☰", onclick: e => { e.stopPropagation(); openTabMenu(); } }),
                    collapseBtn,
                    h("button", { class: "bl-icon", title: "Diagnostic", text: "🩺", onclick: () => selfTest() }),
                    h("button", {
                        class: "bl-icon", title: "Fermer (Alt+Maj+B pour rouvrir)", text: "✕",
                        onclick: e => {
                            e.stopPropagation();
                            settings.panelOpen = false; saveSettings();
                            closeTabMenu();
                            panel.classList.add("bl-hidden");
                        }
                    })
                ),
                tabsEl = h("div", { class: "bl-tabs" }),
                bodyEl = h("div", { class: "bl-body" })
            );
            panel.querySelector(".bl-head").addEventListener("pointerdown", startDrag);
            // Molette verticale sur la barre = défilement horizontal : sans ça,
            // une barre d'onglets trop longue semblait bloquée.
            tabsEl.addEventListener("wheel", e => {
                if (prefs().tabWrap) return;
                const delta = Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
                if (!delta) return;
                tabsEl.scrollLeft += delta;
                e.preventDefault();
            }, { passive: false });
            document.body.appendChild(panel);
            ensurePill();
            applyPrefs();
            renderTabs();
            if (tabs.length) {
                const hidden = prefs().hiddenTabs || [];
                const remembered = prefs().lastTab;
                const wanted = current && tabs.some(t => t.id === current && !hidden.includes(t.id))
                    ? current
                    : (remembered && tabs.some(t => t.id === remembered && !hidden.includes(t.id))
                        ? remembered
                        : (orderedTabs().find(t => !hidden.includes(t.id)) || tabs[0]).id);
                select(wanted);
            }
        }

        function toggle() {
            if (!panel || !panel.isConnected || !bodyEl?.isConnected) {
                settings.panelOpen = true;
                saveSettings();
                build();
                return;
            }
            panel.classList.toggle("bl-hidden");
            if (panel.classList.contains("bl-hidden")) closeTabMenu();
            settings.panelOpen = !panel.classList.contains("bl-hidden");
            if (settings.panelOpen && prefs().collapsed) {
                prefs().collapsed = false;
                applyPrefs();
            }
            saveSettings();
            if (settings.panelOpen && tabs.length && !bodyEl.childElementCount) select(current || tabs[0].id);
        }

        function tab(def) {
            if (!def?.id || typeof def.render !== "function") return;
            const i = tabs.findIndex(t => t.id === def.id);
            if (i >= 0) tabs[i] = def; else tabs.push(def);
            build();
            renderTabs();
            if (!current && !prefs().hiddenTabs.includes(def.id)) select(def.id);
            else if (current === "config") refresh("config");
        }

        function refresh(id, force = false) {
            if (!panel) return;
            if (id && id !== current) { renderTabs(); return; }
            // Ne jamais reconstruire le panneau pendant qu'un champ texte est
            // édité : c'est la principale cause de perte de focus / de saisie.
            const active = document.activeElement;
            const typing = active && panel.contains(active) && (
                active.tagName === "TEXTAREA" ||
                (active.tagName === "INPUT" && /^(text|number|search|password|email|url|tel)$/.test(active.type || "text"))
            );
            if (!force && typing) return;
            if (refreshRaf) cancelAnimationFrame(refreshRaf);
            refreshRaf = requestAnimationFrame(() => {
                refreshRaf = 0;
                if (current) select(current, true);
            });
        }

        function list() {
            return orderedTabs().map(t => ({ id: t.id, title: t.title, hidden: prefs().hiddenTabs.includes(t.id) }));
        }

        function reorder(ids) {
            if (!Array.isArray(ids)) return;
            prefs().tabOrder = [...new Set(ids.filter(Boolean))];
            saveSettings();
            renderTabs();
        }

        return {
            tab, refresh, toggle, build, select, list, reorder,
            applyPrefs, resetPosition,
            get panel() { return panel; },
            get current() { return current; },
            prefs
        };
    })();

    /* ------------------------------------------------------------------ */
    /* Onglet Interface (skin, disposition, onglets visibles)              */
    /* ------------------------------------------------------------------ */

    function renderConfig() {
        const p = settings.ui;
        const wrap = h("div");
        const saveSoon = (() => {
            let t = 0;
            return () => { clearTimeout(t); t = setTimeout(saveSettings, 250); };
        })();

        const section = title => h("div", { class: "bl-sub", text: title });
        const field = (label, node, hint) => h("div", { class: "bl-col" },
            h("span", { class: "bl-label", text: label }),
            node,
            hint ? h("div", { class: "bl-muted", style: { fontSize: "10px" }, text: hint }) : null
        );
        const selectEl = (options, value, onChange) => {
            const s = h("select", { class: "bl-select" });
            for (const [v, label] of options) s.appendChild(h("option", { value: v, text: label }));
            s.value = value;
            s.addEventListener("change", () => onChange(s.value));
            return s;
        };
        const check = (label, value, onChange) => {
            const input = h("input", { type: "checkbox" });
            input.checked = Boolean(value);
            input.addEventListener("change", () => onChange(input.checked));
            return h("label", { class: "bl-row", style: { margin: "4px 0", gap: "7px", cursor: "pointer" } },
                input, h("span", { text: label })
            );
        };
        const range = (label, key, min, max, step, suffix = "") => {
            const out = h("b", { text: `${p[key]}${suffix}` });
            const input = h("input", { type: "range", min, max, step, value: p[key] });
            input.addEventListener("input", () => {
                p[key] = Number(input.value);
                out.textContent = `${p[key]}${suffix}`;
                ui.applyPrefs();
                saveSoon();
            });
            return h("div", { class: "bl-col" },
                h("div", { class: "bl-row", style: { margin: "0", justifyContent: "space-between" } },
                    h("span", { class: "bl-label", text: label }), out),
                input
            );
        };

        wrap.appendChild(h("div", { class: "bl-muted", text: "Tout est mémorisé localement. Le panneau reste déplaçable par sa barre de titre." }));

        wrap.appendChild(section("Apparence"));
        wrap.appendChild(h("div", { class: "bl-grid2" },
            field("Thème", selectEl([
                ["dark", "Discord sombre"], ["midnight", "Minuit"],
                ["light", "Clair"], ["contrast", "Contraste élevé"]
            ], p.theme, v => { p.theme = v; ui.applyPrefs(); saveSettings(); })),
            field("Accent", (() => {
                const c = h("input", { type: "color", value: p.accent });
                c.addEventListener("input", () => { p.accent = c.value; ui.applyPrefs(); saveSoon(); });
                return c;
            })())
        ));        wrap.appendChild(h("div", { class: "bl-row", style: { gap: "5px" } },
            ...[["#5865f2", "Blurple"], ["#57f287", "Vert"], ["#eb459e", "Rose"], ["#faa61a", "Or"], ["#ed4245", "Rouge"], ["#00b0f4", "Cyan"]].map(([hex, name]) =>
                h("button", {
                    class: "bl-icon", title: name, text: "●",
                    style: { color: hex, fontSize: "18px", padding: "0 4px" },
                    onclick: () => { p.accent = hex; ui.applyPrefs(); saveSettings(); ui.refresh("config"); }
                })
            )
        ));
        wrap.appendChild(range("Largeur", "width", 320, 680, 10, " px"));
        wrap.appendChild(range("Hauteur maximale", "maxHeight", 35, 95, 1, " vh"));
        wrap.appendChild(range("Taille du texte", "font", 10, 17, 1, " px"));
        wrap.appendChild(range("Arrondi", "radius", 0, 24, 1, " px"));
        wrap.appendChild(h("div", { class: "bl-grid2" },
            field("Police", selectEl([
                ["discord", "Discord"], ["system", "Système"], ["mono", "Monospace"], ["serif", "Serif"]
            ], p.fontFamily, v => { p.fontFamily = v; ui.applyPrefs(); saveSettings(); })),
            field("Style des onglets", selectEl([
                ["underline", "Souligné"], ["pills", "Pastilles"], ["cards", "Cartes"]
            ], p.tabStyle, v => { p.tabStyle = v; ui.applyPrefs(); saveSettings(); }))
        ));

        wrap.appendChild(range("Opacité", "opacity", 40, 100, 5, " %"));
        wrap.appendChild(check("Mode compact", p.compact, v => { p.compact = v; ui.applyPrefs(); saveSettings(); }));
        wrap.appendChild(check("Fond translucide (blur)", p.blur, v => { p.blur = v; ui.applyPrefs(); saveSettings(); }));
        wrap.appendChild(check("Onglets sur plusieurs lignes (sinon : défilement horizontal)", p.tabWrap === true, v => { p.tabWrap = v; ui.applyPrefs(); saveSettings(); }));
        wrap.appendChild(h("div", { class: "bl-row" },
            h("button", {
                class: "bl-btn bl-sec", text: "Réparer la barre d'onglets",
                onclick: () => {
                    p.tabWrap = false;
                    p.collapsed = false;
                    settings.ui.hiddenTabs = [];
                    saveSettings();
                    ui.applyPrefs();
                    ui.build();
                    ui.refresh();
                    toast("Barre d'onglets restaurée", "success");
                }
            }),
            h("span", { class: "bl-muted", text: "Réaffiche tous les onglets et remet le défilement horizontal." })
        ));
        wrap.appendChild(h("div", { class: "bl-grid2" },
            field("Titre du panneau", (() => {
                const i = h("input", { class: "bl-input", maxlength: 40, value: p.panelTitle || "Blocky Lab" });
                i.addEventListener("change", () => { p.panelTitle = i.value.trim() || "Blocky Lab"; ui.applyPrefs(); saveSettings(); });
                return i;
            })()),
            field("Texte du bouton flottant", (() => {
                const i = h("input", { class: "bl-input", maxlength: 4, value: p.pillText || "BL" });
                i.addEventListener("change", () => { p.pillText = i.value.trim().slice(0, 4) || "BL"; ui.applyPrefs(); saveSettings(); });
                return i;
            })())
        ));

        wrap.appendChild(section("Disposition"));
        wrap.appendChild(field("Ancrage", selectEl([
            ["br", "Bas droite"], ["bl", "Bas gauche"], ["tr", "Haut droite"], ["tl", "Haut gauche"]
        ], p.dock, v => { p.dock = v; p.x = null; p.y = null; ui.applyPrefs(); saveSettings(); })));
        wrap.appendChild(h("div", { class: "bl-row" },
            h("button", { class: "bl-btn bl-sec", text: "Recentrer / déplier", onclick: () => { ui.resetPosition(); toast("Panneau recentré", "success"); } }),
            h("button", { class: "bl-btn bl-sec", text: "Tester un toast", onclick: () => toast("Aperçu des notifications", "info") })
        ));
        wrap.appendChild(h("div", { class: "bl-grid2" },
            field("Toasts", selectEl([["top", "En haut"], ["bottom", "En bas"]], p.toastPos, v => { p.toastPos = v; ui.applyPrefs(); saveSettings(); })),
            field("Durée des toasts", (() => {
                const i = h("input", { class: "bl-input", type: "number", min: 800, max: 12000, step: 100, value: p.toastMs });
                i.addEventListener("change", () => { p.toastMs = clamp(Number(i.value) || 3600, 800, 12000); saveSettings(); });
                return i;
            })())
        ));

        wrap.appendChild(section("Onglets visibles et ordre"));
        const tabList = h("div", { class: "bl-list" });
        const move = (id, delta) => {
            const ids = ui.list().map(t => t.id);
            const from = ids.indexOf(id);
            const to = Math.max(0, Math.min(ids.length - 1, from + delta));
            if (from < 0 || from === to) return;
            ids.splice(to, 0, ids.splice(from, 1)[0]);
            ui.reorder(ids);
            ui.refresh("config");
        };
        for (const t of ui.list()) {
            const box = h("input", { type: "checkbox" });
            box.checked = !t.hidden;
            box.disabled = t.id === "config";
            box.addEventListener("change", () => {
                const set = new Set(settings.ui.hiddenTabs);
                if (box.checked) set.delete(t.id); else set.add(t.id);
                settings.ui.hiddenTabs = [...set];
                saveSettings();
                ui.build();
                ui.refresh();
            });
            tabList.appendChild(h("label", null, box, h("span", { text: t.title }), h("span", { class: "bl-spacer" }),
                h("button", {
                    class: "bl-icon", title: "Monter", text: "↑",
                    onclick: e => { e.preventDefault(); e.stopPropagation(); move(t.id, -1); }
                }),
                h("button", {
                    class: "bl-icon", title: "Descendre", text: "↓",
                    onclick: e => { e.preventDefault(); e.stopPropagation(); move(t.id, 1); }
                }),
                h("span", { class: "bl-badge", text: t.id })
            ));
        }
        wrap.appendChild(tabList);
        wrap.appendChild(h("div", { class: "bl-muted", style: { fontSize: "10px" }, text: "Un onglet masqué reste chargé et continue de collecter ; il est juste retiré de la barre. « config » ne peut pas être masqué." }));

        wrap.appendChild(section("Sauvegarde"));
        const importFile = h("input", { type: "file", accept: ".json,application/json", style: { display: "none" } });
        importFile.addEventListener("change", async () => {
            const file = importFile.files?.[0];
            if (!file) return;
            try {
                const data = JSON.parse(await file.text());
                const next = data.ui && typeof data.ui === "object" ? data.ui : data;
                settings.ui = Object.assign({}, DEFAULT_UI, next, {
                    hiddenTabs: (Array.isArray(next.hiddenTabs) ? next.hiddenTabs : []).filter(id => id !== "config")
                });
                if (typeof data.dropChannelId === "string") settings.dropChannelId = data.dropChannelId.replace(/[^0-9]/g, "");
                saveSettings();
                ui.applyPrefs();
                ui.build();
                ui.refresh();
                toast("Configuration importée", "success");
            } catch (e) {
                toast("Import impossible : " + e.message, "error");
            } finally {
                importFile.value = "";
            }
        });
        wrap.appendChild(h("div", { class: "bl-row" },
            h("button", {
                class: "bl-btn bl-sec", text: "Exporter la config",
                onclick: () => download("blocky-ui-config.json", JSON.stringify({ ui: settings.ui, dropChannelId: settings.dropChannelId }, null, 2))
            }),
            h("button", { class: "bl-btn bl-sec", text: "Importer", onclick: () => importFile.click() }),
            importFile,
            h("button", {
                class: "bl-btn bl-danger", text: "Réinitialiser l'interface",
                onclick: () => {
                    settings.ui = Object.assign({}, DEFAULT_UI, { hiddenTabs: [] });
                    saveSettings();
                    ui.applyPrefs();
                    ui.build();
                    ui.refresh();
                    toast("Interface réinitialisée", "success");
                }
            })
        ));
        wrap.appendChild(h("div", { class: "bl-muted", style: { fontSize: "10px" }, text: "Raccourci : Alt+Maj+B. La position est conservée après rechargement." }));

        return wrap;
    }

    function boot() {
        ui.build();
        // Après un redimensionnement, un panneau ancré peut se retrouver hors
        // écran (barre d'onglets invisible) : on réapplique les limites.
        window.addEventListener("resize", () => {
            const p = settings.ui;
            if (p.x != null || p.y != null) {
                p.x = Math.max(0, Math.min(Number(p.x) || 0, Math.max(0, window.innerWidth - 160)));
                p.y = Math.max(0, Math.min(Number(p.y) || 0, Math.max(0, window.innerHeight - 48)));
            }
            ui.applyPrefs();
        });
        // Discord est une SPA : on recolle le panneau s'il est démonté.
        setInterval(() => {
            const p = document.getElementById("bl-panel");
            if (!p || !p.querySelector(".bl-body") || !p.querySelector(".bl-tabs")) { ui.build(); return; }
            if (!document.getElementById("bl-pill")) ui.build();
        }, 3000);

        if (typeof GM_registerMenuCommand === "function") {
            GM_registerMenuCommand("Blocky Lab : afficher/masquer", () => ui.toggle());
        }
        document.addEventListener("keydown", e => {
            if (e.altKey && e.shiftKey && e.code === "KeyB") {
                e.preventDefault();
                ui.toggle();
            }
        }, true);

        // Enregistré après les autres scripts pour ne pas voler le premier onglet.
        setTimeout(() => ui.tab({ id: "config", title: "Interface", hint: "Thème, taille, onglets", render: renderConfig }), 1500);
    }

    /* ------------------------------------------------------------------ */
    /* Boutons Discord (partagé par les scripts de test)                   */
    /* ------------------------------------------------------------------ */

    function domButtons(root, msg = null) {
        if (!root?.querySelectorAll) return [];
        const comps = (msg ? componentList(msg) : []).filter(c => c.type === 2 || c.customId || c.url);
        const raw = [...root.querySelectorAll("button, [role='button']")]
            .filter(b => !b.closest("#bl-panel"))
            .filter(b => !(b.getAttribute("role") === "button" && b.querySelector("button")))
            .filter(b => {
                const r = b.getBoundingClientRect();
                return r.width > 2 && r.height > 2;
            });
        const aligned = comps.length === raw.length;
        return raw.map((btn, i) => ({
            btn,
            index: i,
            label: (btn.innerText || btn.textContent || "").trim().replace(/\s+/g, " "),
            aria: btn.getAttribute("aria-label") || "",
            title: btn.getAttribute("title") || "",
            alt: [...btn.querySelectorAll("img[alt]")].map(img => img.alt).filter(Boolean).join(" "),
            customId: aligned ? (comps[i]?.customId || "") : "",
            disabled: Boolean(btn.disabled || btn.getAttribute("aria-disabled") === "true" || (aligned && comps[i]?.disabled))
        }));
    }

    function messageRoot(messageId, channel = "") {
        const id = String(messageId || "");
        if (!id) return null;
        if (channel) {
            const direct = document.getElementById(`chat-messages-${channel}-${id}`);
            if (direct) return direct;
        }
        for (const el of document.querySelectorAll('[id^="chat-messages-"]')) {
            if (el.id.endsWith(`-${id}`)) return el;
        }
        return null;
    }

    function reactProps(el) {
        if (!el) return null;
        for (let node = el, i = 0; node && i < 5; i++, node = node.parentElement) {
            const key = Object.keys(node).find(k => k.startsWith("__reactProps$"));
            if (key) return node[key] || null;
        }
        return null;
    }

    /**
     * Clic volontairement minimal : `.click()` déclenche le handler React de
     * Discord. Les anciens scripts envoyaient aussi pointerdown/mousedown, ce
     * qui pouvait exécuter l'action deux fois (deux tirages au blackjack).
     */
    function pressButton(btn) {
        if (!btn || !btn.isConnected) return false;
        if (btn.disabled || btn.getAttribute("aria-disabled") === "true") return false;
        try { btn.scrollIntoView({ block: "nearest", inline: "nearest" }); } catch (_) { /* ignore */ }
        try { btn.focus({ preventScroll: true }); } catch (_) { /* ignore */ }
        try { btn.click(); } catch (_) { /* ignore */ }
        return true;
    }

    function pointerPress(btn) {
        if (!btn || !btn.isConnected || btn.disabled) return false;
        let r;
        try { r = btn.getBoundingClientRect(); } catch (_) { r = { left: 1, top: 1, width: 2, height: 2 }; }
        const base = {
            bubbles: true, cancelable: true, composed: true, button: 0, buttons: 1,
            clientX: Math.round(r.left + r.width / 2), clientY: Math.round(r.top + r.height / 2),
            pointerId: 1, pointerType: "mouse", isPrimary: true, pressure: 0.5
        };
        for (const type of ["pointerover", "pointerenter", "mouseover", "pointerdown", "mousedown"]) {
            try {
                const Ctor = type.startsWith("pointer") && W.PointerEvent ? W.PointerEvent : W.MouseEvent;
                btn.dispatchEvent(new Ctor(type, base));
            } catch (_) { /* ignore */ }
        }
        for (const type of ["pointerup", "mouseup"]) {
            try {
                const Ctor = type.startsWith("pointer") && W.PointerEvent ? W.PointerEvent : W.MouseEvent;
                btn.dispatchEvent(new Ctor(type, { ...base, buttons: 0 }));
            } catch (_) { /* ignore */ }
        }
        return true;
    }

    function onMessageCreate(fn) {
        if (typeof fn !== "function") return null;
        const dispatcher = findByProps("dispatch", "subscribe") || findByProps("subscribe", "dispatch", "unsubscribe");
        if (!dispatcher) return null;
        const handler = event => {
            try {
                if (event?.type === "MESSAGE_CREATE" && event.message) fn(event.message);
            } catch (e) { console.warn(NC, "messageCreate", e); }
        };
        try {
            dispatcher.subscribe("MESSAGE_CREATE", handler);
            return () => { try { dispatcher.unsubscribe("MESSAGE_CREATE", handler); } catch (_) { /* ignore */ } };
        } catch (_) { return null; }
    }

    function focusChannel(id) {
        const cid = String(id || "");
        if (!cid) return false;
        // 1) Navigation interne Discord : fonctionne même si le salon n'est
        // pas visible dans la barre latérale (salon replié / catégorie fermée).
        try {
            const direct = findByProps("selectChannel") || findByProps("selectChannel", "selectVoiceChannel");
            if (direct?.selectChannel) { direct.selectChannel(cid); return true; }
        } catch (_) { /* continue */ }
        try {
            const channel = findStore("ChannelStore")?.getChannel?.(cid);
            const guild = channel?.guild_id || String(location.pathname.split("/")[2] || "@me");
            const nav = findByProps("transitionTo", "replaceWith") || findByProps("transitionTo");
            if (nav?.transitionTo) {
                nav.transitionTo(`/channels/${guild}/${cid}`);
                return true;
            }
        } catch (_) { /* continue */ }
        // 2) Repli : clic sur le lien du salon.
        const link = document.querySelector(`[data-list-item-id="channels___${cid}"]`)
            || document.querySelector(`a[href$="/channels/${cid}"]`)
            || document.querySelector(`a[href*="/${cid}"]`);
        if (!link) return false;
        try { link.click(); return true; } catch (_) { return false; }
    }

    /* ------------------------------------------------------------------ */
    /* API publique                                                        */
    /* ------------------------------------------------------------------ */

    const lab = {
        version: VERSION,
        W,
        sleep, clamp, num, safe, uid, jitter, h, norm, lower,
        settings, saveSettings, store, log, debug, toast,
        on, emit,
        snowflake, channelId, channelIdFromUrl,
        idb: { put: obsPut, all: obsAll, count: obsCount, clear: obsClear },
        embed: { text: embedText, messageText, components: componentList, money, multipliers },
        analyze: { message: analyze, text: analyzeText, game: detectGame, label: outcomeLabel, reclassify, betAmount, luckyCategory, wheelNumber, wheelColor, parseCards, handValue, parseMining },
        collect, backfill, fetchHistory, scanChannel, watch, startObserver, rescan,
        discord: {
            getRequire, modules, find, findByProps, findStore, currentUser, sendText, sendViaEditor, getEditor,
            parseSlashCommand,
            history: fetchHistory, buttons: domButtons, press: pressButton, pointerPress, reactProps,
            messageRoot, onMessageCreate, focusChannel, fiberMessage: getFiberMessage
        },
        stats, selfTest,
        net: { push },
        export: { download, csv: toCSV, observations: exportObservations },
        ui,
        diagnostics: () => ({
            version: VERSION,
            channel: channelId(),
            url: location.href,
            logged: currentUser()?.username || null,
            webpack: Boolean(getRequire()),
            observer: Boolean(observer),
            collected,
            db: DB_NAME
        })
    };

    W.BlockyLab = lab;

    if (document.body) boot();
    else document.addEventListener("DOMContentLoaded", boot, { once: true });

    console.info(`%c[BlockyLab] core v${VERSION} chargé`, "color:#5865f2;font-weight:bold");
})();
