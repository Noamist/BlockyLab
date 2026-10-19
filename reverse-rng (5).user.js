// ==UserScript==
// @name         Reverse RNG (Userscript)
// @namespace    reverse-rng
// @version      5.0.0
// @description  Surveille les embeds d'un bot Discord, classe gain/perte, envoie des commandes automatiques toutes les X secondes et enregistre les observations.
// @match        https://discord.com/*
// @match        https://*.discord.com/*
// @run-at       document-idle
// @noframes
// @grant        unsafeWindow
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @connect      localhost
// ==/UserScript==

(function () {
    "use strict";
    console.log("%c[Reverse RNG] script chargé", "color:#5865f2;font-weight:bold");

    /* ===================== CONFIG FIXE ===================== */
    const CHANNEL_ID = "1559563030549762098";
    const BOT_ID = "1472309546633531472";
    const EXPORT_URL = "http://127.0.0.1:3210/export";
    const GAMES = ["Mines", "LuckyBlock", "Wheel", "BlackJack"];

    const DEFAULTS = {
        mode: "auto",
        ignoreTimeout: 8,        // s avant ignorance auto d'un embed sans résultat
        notifDuration: 4,        // s d'affichage de la notification de résultat
        amount: "10",            // mise (amount) remplie dans les commandes
        interval: 30,            // X secondes entre deux commandes
        jitter: 20,              // % de variation aléatoire sur l'intervalle
        commands: "/mines\n/luckyblock\n/wheel\n/blackjack",
        random: false,           // ordre aléatoire des commandes
        clickLabels: "",         // boutons à cliquer sur l'embed du bot (un par ligne, ex: Cash Out)
        exportServer: true,      // POST périodique vers EXPORT_URL
        debug: false
    };

    /* ===================== UTILITAIRES ===================== */
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const clamp = (v, min, max, d) => { v = Number(v); return Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : d; };
    const safeStringify = v => { try { return JSON.stringify(v ?? null); } catch (_) { return ""; } };

    const store = {
        get(key, def) {
            try { if (typeof GM_getValue === "function") return GM_getValue(key, def); } catch (_) {}
            try { const raw = localStorage.getItem("reverse-rng:" + key); return raw === null ? def : JSON.parse(raw); } catch (_) { return def; }
        },
        set(key, value) {
            try { if (typeof GM_setValue === "function") return GM_setValue(key, value); } catch (_) {}
            try { localStorage.setItem("reverse-rng:" + key, JSON.stringify(value)); } catch (_) {}
        }
    };

    /* ===================== ÉTAT ===================== */
    let S = { ...DEFAULTS, ...(store.get("settings", {}) || {}) };
    const saveSettings = () => store.set("settings", S);
    // Migration : force la mise à 10 une seule fois (ancienne valeur par défaut : 100).
    if (S.settingsVersion !== 3) { S.amount = "10"; S.settingsVersion = 3; saveSettings(); }

    let running = false;
    let observations = [];
    const seenIds = new Set();
    let pending = [];
    let active = null;
    let focusedMessageId = null;
    const ignoreTimers = new Map();
    const domTimers = new Map();
    const clickState = new Map();
    let observer = null;
    let promptEl = null;
    let noticeEl = null, noticeTimer = null;
    let startedAt = Date.now();

    // Envoi automatique
    let sending = false;
    let sendTimer = null;
    let nextSendAt = 0;
    let cmdIndex = 0;
    let statusText = "Arrêté";
    let exportInterval = null;
    let lastExportOk = null;
    let panelEl = null, statusEl = null;

    const setStatus = t => { statusText = t; if (statusEl) statusEl.textContent = t; };

    /* ===================== TOASTS ===================== */
    function toast(message, type = "info") {
        const colors = { info: "#4752c4", success: "#248046", error: "#b93838" };
        const el = document.createElement("div");
        el.textContent = message;
        el.style.cssText = `position:fixed;left:50%;top:18px;transform:translateX(-50%);z-index:2147483647;max-width:80vw;padding:10px 16px;border-radius:8px;background:${colors[type] || colors.info};color:#fff;font:14px Arial,sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.4);transition:opacity .25s`;
        document.body.appendChild(el);
        setTimeout(() => { el.style.opacity = "0"; setTimeout(() => el.remove(), 300); }, 3500);
    }

    /* ===================== DONNÉES ===================== */
    function loadData() {
        const v = store.get("observations", []);
        observations = Array.isArray(v) ? v : [];
        seenIds.clear();
        observations.forEach(x => seenIds.add(String(x.messageId)));
    }
    function saveData() { store.set("observations", observations); }

    /* ===================== RÈGLES / DÉTECTION (portées du plugin) ===================== */
    function getGameType() {
        return S.mode === "auto" ? "Auto (tous les jeux)" : S.mode === "mines" ? "Mines" : S.mode === "wheel" ? "Wheel" : S.mode === "blackjack" ? "BlackJack" : "LuckyBlock";
    }

    function getModeRules() {
        if (S.mode === "auto") return { modeName: "Auto — tous les jeux", loss: ["BOOM", "💥", "Creeper", "Better", "Lost", "Loss"], win: ["Cashed", "Cashed Out", "Iron", "Gold", "Diamonds", "You win", "Gained", "Won"] };
        if (S.mode === "mines") return { modeName: "Mines", loss: ["BOOM", "💥"], win: ["Cashed", "Cashed Out", "Cash Out"] };
        if (S.mode === "blackjack") return { modeName: "BlackJack", loss: ["dealer wins"], win: ["You win!"] };
        if (S.mode === "wheel") return { modeName: "Wheel", loss: ["Better", "💸", ":money_with_wings:"], win: ["You win", "🎉", ":tada:"] };
        return { modeName: "LuckyBlock", loss: ["Creeper", "Cobblestone"], win: ["Iron", "Gold", "Diamonds", "A pile of"] };
    }

    function normalizeDetectionText(value) {
        return String(value ?? "")
            .normalize("NFKC")
            .replace(/[\u200B-\u200D\uFEFF]/g, "")
            .replace(/<a?:([a-zA-Z0-9_]+):\d+>/g, " :$1: $1 ")
            .replace(/&colon;/gi, ":")
            .replace(/&amp;/gi, "&")
            .replace(/[’‘]/g, "'")
            .replace(/[‐‑‒–—]/g, "-")
            .toLocaleLowerCase()
            .replace(/\s+/g, " ");
    }

    function findMatchedKeyword(text, keywords) {
        const normalized = normalizeDetectionText(text);
        for (const keyword of keywords) {
            const key = normalizeDetectionText(keyword);
            if (!key) continue;
            if (/[\p{Extended_Pictographic}]/u.test(key) || key.startsWith(":")) {
                if (normalized.includes(key)) return keyword;
                continue;
            }
            const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
            if (new RegExp(`(?:^|[^\\p{L}\\p{N}_])${escaped}(?:$|[^\\p{L}\\p{N}_])`, "iu").test(normalized)) return keyword;
        }
        return null;
    }

    function normalizeEmbeds(raw) {
        return (Array.isArray(raw) ? raw : []).map(e => ({
            title: e?.title ?? e?.rawTitle ?? null,
            description: e?.description ?? e?.rawDescription ?? null,
            fields: Array.isArray(e?.fields) ? e.fields.map(f => ({ name: f?.name ?? f?.rawName ?? "", value: f?.value ?? f?.rawValue ?? "" })) : [],
            image: e?.image?.url ?? e?.image?.proxyURL ?? null,
            thumbnail: e?.thumbnail?.url ?? e?.thumbnail?.proxyURL ?? null,
            video: e?.video?.url ?? null,
            url: e?.url ?? null,
            provider: e?.provider?.name ?? null,
            footer: e?.footer?.text ?? null,
            author: e?.author?.name ?? null,
            rawMetadata: safeStringify(e)
        }));
    }

    function getEmbedText(embeds) {
        return (Array.isArray(embeds) ? embeds : []).map(e => [
            e?.title, e?.description, e?.author, e?.footer, e?.url, e?.provider, e?.image, e?.thumbnail, e?.video,
            ...(Array.isArray(e?.fields) ? e.fields.flatMap(f => [f?.name, f?.value]) : []),
            e?.rawMetadata
        ].filter(v => v !== null && v !== undefined && String(v).trim() !== "").map(v => typeof v === "string" ? v : safeStringify(v)).join("\n")).filter(Boolean).join("\n\n");
    }

    function getMetadataOutcomeSignals(embeds) {
        const signals = { win: [], loss: [] };
        const seen = new Set();
        const add = (kind, reason) => { if (!signals[kind].includes(reason)) signals[kind].push(reason); };
        const classifyPhrase = value => {
            const v = normalizeDetectionText(value);
            if (!v) return null;
            if (S.mode === "mines") { if (/\bcashed(?:\s+out)?\b/.test(v)) return "win"; if (/\bboom\b/.test(v)) return "loss"; }
            if (S.mode === "wheel") { if (/\byou\s+win\b/.test(v)) return "win"; if (/\bbetter\b/.test(v)) return "loss"; }
            if (S.mode === "luckyblock") { if (/\bcreeper\b/.test(v)) return "loss"; if (/\b(?:gold|iron|diamonds?)\b/.test(v)) return "win"; }
            if (/^(?:gained?|gain|won|win|received|rewarded|reward|earned|profit|success|victory)$/.test(v) || /\b(?:you\s+)?(?:gained|earned|received|won)\b/.test(v)) return "win";
            if (/^(?:lost|loss|lose|lost coins|defeat|failure|failed)$/.test(v) || /\b(?:you\s+)?(?:lost|lose|loss)\b/.test(v)) return "loss";
            return null;
        };
        const walk = (value, path = "metadata", depth = 0) => {
            if (!value || typeof value !== "object" || depth > 9 || seen.has(value)) return;
            seen.add(value);
            if (Array.isArray(value)) { value.forEach((x, i) => walk(x, `${path}[${i}]`, depth + 1)); return; }
            const label = value.rawName ?? value.fieldName ?? value.label ?? value.name;
            const fieldValue = value.rawValue ?? value.value ?? value.text;
            if (typeof label === "string") {
                const r = classifyPhrase(label);
                if (r) add(r, `${path}.name=${label}`);
                const ln = normalizeDetectionText(label);
                if (/^(?:result|outcome|status|result type|transaction|event)$/.test(ln) && fieldValue != null) {
                    const vr = classifyPhrase(typeof fieldValue === "string" ? fieldValue : safeStringify(fieldValue));
                    if (vr) add(vr, `${path}.${label}=${String(fieldValue)}`);
                }
            }
            for (const [key, child] of Object.entries(value)) {
                const kr = classifyPhrase(key);
                if (kr && (typeof child === "string" || typeof child === "number")) add(kr, `${path}.${key}=${String(child)}`);
                walk(child, `${path}.${key}`, depth + 1);
            }
        };
        for (const [i, e] of (Array.isArray(embeds) ? embeds : []).entries()) {
            if (!e?.rawMetadata) continue;
            try { walk(JSON.parse(e.rawMetadata), `embed[${i}]`); } catch (_) {}
        }
        return signals;
    }

    function detectGameType(embeds, text = "") {
        const parts = [];
        for (const e of (Array.isArray(embeds) ? embeds : [])) {
            parts.push(e?.title, e?.description);
            for (const f of (Array.isArray(e?.fields) ? e.fields : [])) parts.push(f?.name, f?.value);
            parts.push(e?.author, e?.footer, e?.rawMetadata);
        }
        parts.push(text);
        const n = normalizeDetectionText(parts.filter(Boolean).join("\n"));
        const scores = { Mines: 0, LuckyBlock: 0, Wheel: 0, BlackJack: 0 };
        const has = re => re.test(n);
        if (has(/\bcashed(?:\s+out)?\b|\bcash\s*out\b/)) scores.Mines += 5;
        if (has(/\bboom\b/)) scores.Mines += 6;
        if (has(/💥/)) scores.Mines += 2;
        if (has(/\bcreeper\b|minecraft\s*:?\s*creeper/)) scores.LuckyBlock += 7;
        if (has(/\bcobblestone\b/)) scores.LuckyBlock += 7;
        if (has(/\b(?:iron|gold|diamonds?|emeralds?)\b/)) scores.LuckyBlock += 4;
        if (has(/\bbetter\b/)) scores.Wheel += 5;
        if (has(/\byou\s+win\b|:tada:|🎉/)) scores.Wheel += 5;
        if (has(/\bblackjack\b|\bblack\s+jack\b/)) scores.BlackJack += 10;
        if (has(/\bdealer\s+wins\b/)) scores.BlackJack += 10;
        if (has(/\byour\s+bet\s+back\b/)) scores.BlackJack += 10;
        const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
        if (ranked[0][1] === 0 || ranked[0][1] === ranked[1][1]) return null;
        return ranked[0][0];
    }

    function getLuckyBlockCategory(value) {
        const n = normalizeDetectionText(value);
        if (/\bcreeper\b|minecraft\s*:?\s*creeper/.test(n)) return "Creeper";
        if (/\bcobblestone\b/.test(n)) return "Cobblestone";
        if (/\ba pile of?\b/.test(n)) return "Emeralds";
        if (/\bdiamonds?\b/.test(n)) return "Diamonds";
        if (/\bgold(?:\s+ingot)?\b/.test(n)) return "Gold";
        if (/\biron(?:\s+ingot)?\b/.test(n)) return "Iron";
        return null;
    }

    function classifyByGame(gameType, embeds, text) {
        const n = normalizeDetectionText([getEmbedText(embeds), text].filter(Boolean).join("\n\n"));
        if (gameType === "LuckyBlock") {
            const c = getLuckyBlockCategory(n);
            if (c === "Creeper" || c === "Cobblestone") return "loss";
            if (["Iron", "Gold", "Diamonds", "Emeralds"].includes(c)) return "win";
            return null;
        }
        if (gameType === "BlackJack") {
            if (/\byour\s+bet\s+back\b/.test(n)) return "refund";
            const dw = /\bdealer\s+wins\b/.test(n), pw = /\byou\s+win\b!?/.test(n);
            if (dw && pw) return null;
            return dw ? "loss" : pw ? "win" : null;
        }
        let win = false, loss = false;
        if (gameType === "Mines") { win = /\bcashed(?:\s+out)?\b|\bcash\s*out\b/.test(n); loss = /\bboom\b|💥/.test(n); }
        else if (gameType === "Wheel") {
            loss = /\bbetter\b|💸|:money_with_wings:|money[_ -]?with[_ -]?wings/.test(n) || (S.mode === "auto" && /\b(?:lost|loss|lose)\b/.test(n));
            win = /\byou\s+win\b|🎉|:tada:|party[_ -]?popper/.test(n);
        }
        if (S.mode === "auto") {
            const m = getMetadataOutcomeSignals(embeds);
            if (m.win.length) win = true;
            if (m.loss.length) loss = true;
        }
        if (win && loss) return null;
        return loss ? "loss" : win ? "win" : null;
    }

    function classifyEmbed(embeds, messageContent = "") {
        if (S.mode === "auto") {
            const g = detectGameType(embeds, [getEmbedText(embeds), messageContent].join("\n"));
            return g ? classifyByGame(g, embeds, messageContent) : null;
        }
        return classifyByGame(getGameType(), embeds, messageContent);
    }

    function getMatchedKeyword(embeds, label) {
        const text = getEmbedText(embeds);
        const g = detectGameType(embeds, text) || "";
        if (g === "BlackJack") {
            if (/\byour\s+bet\s+back\b/i.test(text)) return "your bet back";
            if (/\bdealer\s+wins\b/i.test(text)) return "dealer wins";
            if (/\byou\s+win\b!?/i.test(text)) return "You win!";
        }
        if (g === "LuckyBlock") return getLuckyBlockCategory(text) || "catégorie LuckyBlock non déterminée";
        const rules = g === "Mines" ? { win: ["Cashed Out", "Cashed", "Gained", "Won"], loss: ["BOOM", "💥", "Lost", "Loss"] }
            : g === "Wheel" ? { win: ["You win", "🎉", "Gained", "Won"], loss: ["Better", "💸", "Lost"] }
            : getModeRules();
        const found = findMatchedKeyword(text, label === "refund" ? ["your bet back"] : label === "win" ? rules.win : rules.loss);
        if (found) return found;
        const sig = (getMetadataOutcomeSignals(embeds)[label] || [])[0];
        if (sig) return sig.split("=").slice(-1)[0].slice(0, 80);
        return label === "win" ? "gain détecté" : "perte détectée";
    }

    /* ===================== TRAITEMENT DES MESSAGES ===================== */
    const snowflakeTs = id => { try { return Number((BigInt(id) >> 22n) + 1420070400000n); } catch (_) { return null; } };
    const findItem = id => pending.find(i => i.messageId === id) ?? (active?.messageId === id ? active : null);

    function getMessageTimestamp(message, id) {
        if (message.timestamp) {
            const t = message.timestamp?.toISOString ? message.timestamp : new Date(message.timestamp);
            if (!Number.isNaN(t.getTime())) return t.toISOString();
        }
        const ts = snowflakeTs(id);
        return ts ? new Date(ts).toISOString() : null;
    }

    function handleMessage(message, dom, source) {
        if (!running || !message) return;
        const channelId = String(message.channel_id ?? message.channelId ?? "");
        const authorId = String(message.author?.id ?? message.author_id ?? "");
        const messageId = String(message.id ?? "");
        if (channelId !== CHANNEL_ID || !messageId) return;
        if (authorId && authorId !== BOT_ID) return;

        const embeds = normalizeEmbeds(message.embeds);
        const messageContent = String(message.content ?? "");
        const domText = dom?.text || "";
        const embedText = [...new Set([getEmbedText(embeds), domText, messageContent].filter(Boolean))].join("\n\n");
        const hasResultEmbed = Boolean(dom?.hasEmbed) || embeds.some(e => e.title || e.description || e.fields.length || e.image || e.thumbnail || e.footer || e.author);
        if (!hasResultEmbed) return;

        const existing = findItem(messageId);
        if (seenIds.has(messageId) && !existing) return;

        const exclusion = /\bsale\b/i.test(embedText) ? "Sale" : /\bleaderboard\b/i.test(embedText) ? "Leaderboard" : /\bachievements\b/i.test(embedText) ? "Achievements" : null;
        if (exclusion) return ignoreByKeyword({ messageId, channelId, embeds, embedText, message, existing, source, keyword: exclusion });

        if (focusedMessageId && focusedMessageId !== messageId) return;
        if (!focusedMessageId) focusedMessageId = messageId;

        const classificationInput = [messageContent, domText].filter(Boolean).join("\n\n");
        const detectedGame = S.mode === "auto" ? detectGameType(embeds, embedText) : getGameType();
        if (S.mode === "auto" && !detectedGame) {
            clearAutoIgnore(messageId);
            pending = pending.filter(c => c.messageId !== messageId);
            if (active?.messageId === messageId) { active = null; removePrompt(); }
            if (focusedMessageId === messageId) focusedMessageId = null;
            return;
        }
        const label = classifyEmbed(embeds, classificationInput);
        if (S.debug) console.debug("[Reverse RNG]", { messageId, detectedGame, label, source, embedText });

        if (existing) {
            existing.content = messageContent;
            existing.embeds = embeds;
            existing.embedText = embedText;
            existing.lastUpdatedAt = new Date().toISOString();
            existing.detectionSource = source;
            if (detectedGame) existing.gameType = detectedGame;
            if (label) return finishAutomatic(existing, label, embedText);
            if (active?.messageId === messageId) renderPrompt();
            return;
        }

        const item = {
            messageId, channelId, botId: BOT_ID,
            gameType: detectedGame || "Unknown",
            detectionMode: S.mode,
            messageTimestamp: getMessageTimestamp(message, messageId),
            receivedAt: new Date().toISOString(),
            content: messageContent, embeds, embedText,
            label: null, status: "pending", detectionSource: source
        };
        if (label) return finishAutomatic(item, label, embedText);

        const rules = getModeRules();
        const hasLoss = Boolean(findMatchedKeyword(embedText, rules.loss));
        const hasWin = Boolean(findMatchedKeyword(embedText, rules.win));
        item.classificationReason = hasLoss && hasWin ? "ambiguous_keywords" : "no_keyword_found";
        pending.push(item);
        scheduleAutoIgnore(item);
        toast(`Embed ${item.gameType} en attente : T = gain, F = perte · délai ${S.ignoreTimeout} s`, "info");
        advanceQueue();
    }

    function ignoreByKeyword({ messageId, channelId, embeds, embedText, message, existing, source, keyword }) {
        const item = existing || {
            messageId, channelId, botId: BOT_ID,
            gameType: S.mode === "auto" ? (detectGameType(embeds, embedText) || "Unknown") : getGameType(),
            detectionMode: S.mode,
            messageTimestamp: getMessageTimestamp(message, messageId),
            receivedAt: new Date().toISOString(),
            detectionSource: source
        };
        clearAutoIgnore(messageId);
        pending = pending.filter(c => c.messageId !== messageId);
        if (active?.messageId === messageId) { active = null; removePrompt(); }
        if (focusedMessageId === messageId) focusedMessageId = null;
        Object.assign(item, {
            content: String(message.content ?? ""), embeds, embedText, label: null, status: "ignored",
            ignoredAt: new Date().toISOString(), ignoreReason: `excluded_keyword_${String(keyword).toLowerCase()}`
        });
        if (!seenIds.has(messageId)) observations.push(item);
        else {
            const i = observations.findIndex(c => c.messageId === messageId);
            if (i >= 0) observations[i] = { ...observations[i], ...item }; else observations.push(item);
        }
        seenIds.add(messageId);
        saveData();
        toast(`Embed ignoré : « ${keyword} » détecté.`, "info");
        advanceQueue();
    }

    function finishAutomatic(item, label, embedText) {
        clearAutoIgnore(item.messageId);
        const inferred = detectGameType(item.embeds || [], embedText || item.embedText || "");
        if (!item.gameType || ["Unknown", "Auto", "Auto (tous les jeux)"].includes(item.gameType)) item.gameType = inferred || getGameType();
        pending = pending.filter(c => c.messageId !== item.messageId);
        if (focusedMessageId === item.messageId) focusedMessageId = null;
        const wasActive = active?.messageId === item.messageId;
        if (wasActive) { active = null; removePrompt(); }
        Object.assign(item, {
            label, status: "labelled", labelSource: "automatic_embed_keyword", automaticallyDetected: true,
            matchedKeyword: getMatchedKeyword(item.embeds || [], label),
            classificationText: embedText,
            classificationMethod: `${String(item.gameType).toLowerCase()}_metadata_text_emoji_match`,
            labelledAt: new Date().toISOString()
        });
        if (!seenIds.has(item.messageId)) observations.push(item);
        else {
            const i = observations.findIndex(x => x.messageId === item.messageId);
            if (i >= 0) observations[i] = { ...observations[i], ...item };
        }
        seenIds.add(item.messageId);
        saveData();
        const txt = label === "refund" ? "RETOUR DE MISE" : label === "win" ? "GAIN" : "PERTE";
        toast(`✓ ${txt} détecté (« ${item.matchedKeyword} »)`, "success");
        showResultNotice(item, label);
        if (panelEl) refreshCounters();
        if (wasActive || !active) advanceQueue();
    }

    /* ===================== IGNORANCE AUTO ===================== */
    function scheduleAutoIgnore(item) {
        if (!item?.messageId) return;
        const id = String(item.messageId);
        clearAutoIgnore(id);
        ignoreTimers.set(id, setTimeout(() => { ignoreTimers.delete(id); autoIgnoreUnclassified(id); }, S.ignoreTimeout * 1000));
    }
    function clearAutoIgnore(id) {
        id = String(id ?? "");
        const t = ignoreTimers.get(id);
        if (t) clearTimeout(t);
        ignoreTimers.delete(id);
    }
    function autoIgnoreUnclassified(id) {
        const item = findItem(id);
        if (!item || item.status !== "pending") return;
        clearAutoIgnore(id);
        Object.assign(item, {
            label: null, status: "ignored", ignoredAt: new Date().toISOString(),
            ignoreReason: `no_result_detected_within_${S.ignoreTimeout}_seconds`,
            gameType: item.gameType || getGameType(), detectionMode: item.detectionMode || S.mode
        });
        pending = pending.filter(c => c.messageId !== id);
        const wasActive = active?.messageId === id;
        if (wasActive) { active = null; removePrompt(); }
        if (focusedMessageId === id) focusedMessageId = null;
        if (!seenIds.has(id)) { observations.push(item); seenIds.add(id); }
        saveData();
        toast(`Embed ignoré : aucun résultat en ${S.ignoreTimeout} s.`, "info");
        if (wasActive || !active) advanceQueue();
    }

    /* ===================== FILE D'ATTENTE / PROMPT T-F ===================== */
    function advanceQueue() {
        if (!running || active || pending.length === 0) return;
        active = pending.shift();
        renderPrompt();
    }
    function removePrompt() { promptEl?.remove(); promptEl = null; }

    function renderPrompt() {
        removePrompt();
        if (!active) return;
        const item = active;
        const root = document.createElement("section");
        root.setAttribute("role", "dialog");
        root.style.cssText = "position:fixed;right:22px;bottom:22px;z-index:2147483647;width:360px;max-width:calc(100vw - 28px);box-sizing:border-box;padding:16px;border-radius:12px;background:#232428;color:#f2f3f5;border:1px solid #555;box-shadow:0 10px 35px rgba(0,0,0,.45);font:14px/1.45 Arial,sans-serif";
        const mk = (tag, css, text) => { const e = document.createElement(tag); if (css) e.style.cssText = css; if (text !== undefined) e.textContent = text; return e; };
        const title = mk("div", "font-size:17px;font-weight:800;margin-bottom:5px", "Reverse RNG");
        const sub = mk("div", "opacity:.75;font-size:12px;margin-bottom:8px", `${item.gameType} · ${pending.length} en attente · ${item.messageTimestamp || ""}`);
        const pre = mk("pre", "white-space:pre-wrap;overflow-wrap:anywhere;max-height:200px;overflow:auto;font:12px/1.45 ui-monospace,Consolas,monospace;margin:0 0 10px;padding:8px;border-radius:7px;background:#2b2d31;user-select:text",
            (item.embedText || item.content || "(embed sans texte lisible)").slice(0, 1500));
        const rules = getModeRules();
        const hint = mk("div", "font-weight:700;margin-bottom:10px;font-size:12px",
            (item.classificationReason === "ambiguous_keywords"
                ? `Mots-clés de perte et de gain présents : vérifie.`
                : `Aucun mot-clé reconnu pour ${rules.modeName}.`) + "\nT = gain · F = perte · Échap = ignorer");
        hint.style.whiteSpace = "pre-line";
        const row = mk("div", "display:flex;gap:8px");
        const btn = (label, color, fn) => { const b = mk("button", `flex:1;padding:10px 8px;border:0;border-radius:7px;background:${color};color:#fff;font-weight:800;cursor:pointer`, label); b.type = "button"; b.addEventListener("click", fn); return b; };
        row.append(btn("T — GAIN", "#248046", () => labelActive("win")), btn("F — PERTE", "#b93838", () => labelActive("loss")), btn("Ignorer", "#555963", ignoreActive));
        root.append(title, sub, pre, hint, row, mk("div", "font-size:10px;opacity:.6;margin-top:9px", `ID : ${item.messageId}`));
        document.body.appendChild(root);
        promptEl = root;
    }

    function onKeyDown(e) {
        if (!running || e.repeat || e.ctrlKey || e.altKey || e.metaKey) return;
        const t = e.target;
        if (t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName))) return;
        if (e.shiftKey && e.altKey) return;
        if (!active) return;
        const act = e.code === "KeyT" ? () => labelActive("win") : e.code === "KeyF" ? () => labelActive("loss") : e.code === "Escape" ? ignoreActive : null;
        if (!act) return;
        e.preventDefault(); e.stopImmediatePropagation(); act();
    }

    function labelActive(label) {
        if (!active) return;
        const item = active;
        clearAutoIgnore(item.messageId);
        Object.assign(item, {
            gameType: item.gameType || getGameType(), detectionMode: item.detectionMode || S.mode,
            label, status: "labelled", labelledAt: new Date().toISOString(), automaticallyDetected: false,
            labelSource: "manual_user", matchedKeyword: "validation manuelle",
            classificationText: item.embedText || getEmbedText(item.embeds || [])
        });
        observations.push(item); seenIds.add(item.messageId); saveData();
        active = null;
        if (focusedMessageId === item.messageId) focusedMessageId = null;
        removePrompt();
        toast(label === "win" ? "Enregistré : GAIN (T)" : "Enregistré : PERTE (F)", "success");
        showResultNotice(item, label);
        if (panelEl) refreshCounters();
        advanceQueue();
    }

    function ignoreActive() {
        if (!active) return;
        const item = active;
        clearAutoIgnore(item.messageId);
        Object.assign(item, { gameType: item.gameType || getGameType(), label: null, status: "ignored", ignoredAt: new Date().toISOString() });
        observations.push(item); seenIds.add(item.messageId); saveData();
        active = null;
        if (focusedMessageId === item.messageId) focusedMessageId = null;
        removePrompt();
        toast("Message ignoré et conservé.", "info");
        advanceQueue();
    }

    function showResultNotice(item, label) {
        noticeEl?.remove();
        if (noticeTimer) clearTimeout(noticeTimer);
        const win = label === "win", refund = label === "refund";
        const card = document.createElement("section");
        card.style.cssText = `position:fixed;right:22px;top:22px;z-index:2147483647;width:340px;max-width:calc(100vw - 28px);box-sizing:border-box;padding:15px 16px;border-radius:12px;background:${refund ? "#3a3548" : win ? "#153d2b" : "#4a2024"};color:#fff;border:1px solid ${refund ? "#a99bd1" : win ? "#39b36b" : "#e35b65"};box-shadow:0 10px 35px rgba(0,0,0,.38);font:14px/1.45 Arial,sans-serif;transition:opacity .2s`;
        const t = document.createElement("div");
        t.style.cssText = "font-weight:800;margin-bottom:5px";
        t.textContent = `${refund ? "↩ RETOUR DE MISE" : win ? "✓ GAIN" : "✕ PERTE"} · ${item.gameType}`;
        const d = document.createElement("div");
        d.style.cssText = "font-size:12px;opacity:.9";
        d.textContent = `Indice : « ${item.matchedKeyword || "validation manuelle"} »`;
        card.append(t, d);
        document.body.appendChild(card);
        noticeEl = card;
        noticeTimer = setTimeout(() => { card.style.opacity = "0"; setTimeout(() => card.remove(), 250); if (noticeEl === card) noticeEl = null; }, S.notifDuration * 1000);
    }

    /* ===================== LECTURE DU DOM DISCORD ===================== */
    function getFiberMessage(root) {
        try {
            const key = Object.keys(root).find(k => k.startsWith("__reactFiber$"));
            if (!key) return null;
            let f = root[key];
            for (let i = 0; f && i < 80; i++, f = f.return) {
                const m = f.memoizedProps?.message;
                if (m && m.id && (m.channel_id || m.channelId)) return m;
            }
        } catch (_) {}
        return null;
    }

    function extractDomEmbedText(root) {
        const candidates = [...root.querySelectorAll('[class*="embedFull"], [class*="embedWrapper"], [class*="embedContainer"], [class*="embed"]')]
            .filter(n => n instanceof HTMLElement && n.textContent?.trim());
        const roots = candidates.filter(n => !candidates.some(o => o !== n && o.contains(n)));
        const blocks = [];
        for (const node of roots) {
            const parts = [node.innerText || node.textContent || ""];
            for (const c of node.querySelectorAll('[aria-label], [title], [alt], [data-name], [data-emoji-name], [role="img"]')) {
                for (const a of ["aria-label", "title", "alt", "data-name", "data-emoji-name"]) {
                    const v = c.getAttribute?.(a);
                    if (v) parts.push(`${a}=${v}`);
                }
            }
            for (const c of node.querySelectorAll("img[src], a[href]")) {
                const src = c.getAttribute("src") || c.getAttribute("href");
                if (src && /emoji|emojis|sticker|media|attachment/i.test(src)) {
                    try { parts.push(decodeURIComponent(src.split("/").pop().split("?")[0])); } catch (_) { parts.push(src.split("/").pop().split("?")[0]); }
                }
            }
            const block = parts.filter(Boolean).join("\n").trim();
            if (block && !blocks.includes(block)) blocks.push(block);
        }
        return { text: blocks.join("\n\n"), hasEmbed: roots.length > 0 };
    }

    function scanMessageRoot(root) {
        if (!running || !(root instanceof HTMLElement)) return;
        const m = root.id.match(/^chat-messages-(\d+)-(\d+)$/);
        if (!m || m[1] !== CHANNEL_ID) return;
        const messageId = m[2];
        // Ignore l'historique chargé avant le démarrage du script.
        const ts = snowflakeTs(messageId);
        if (ts && ts < startedAt - 30000 && !findItem(messageId)) return;

        const dom = extractDomEmbedText(root);
        const fiberMsg = getFiberMessage(root);
        // Sans accès React, on ne connaît pas l'auteur : on exige au moins un embed
        // (les commandes tapées par l'utilisateur n'en ont pas).
        const message = fiberMsg || { id: messageId, channel_id: CHANNEL_ID, embeds: [], content: "" };
        handleMessage(message, dom, fiberMsg ? "react-fiber" : "dom-only");
        maybeClickButtons(root, messageId, Boolean(fiberMsg ? String(fiberMsg.author?.id) === BOT_ID : dom.hasEmbed));
    }

    function scheduleDomScan(root) {
        if (!(root instanceof HTMLElement)) return;
        const m = root.id.match(/^chat-messages-(\d+)-(\d+)$/);
        if (!m || m[1] !== CHANNEL_ID) return;
        const id = m[2];
        const prev = domTimers.get(id);
        if (prev) clearTimeout(prev);
        domTimers.set(id, setTimeout(() => {
            domTimers.delete(id);
            if (running && root.isConnected) scanMessageRoot(root);
        }, 150));
    }

    function startObserver() {
        observer = new MutationObserver(mutations => {
            if (!running) return;
            const roots = new Set();
            for (const mu of mutations) {
                const target = mu.target instanceof HTMLElement ? mu.target : mu.target?.parentElement;
                const r = target?.closest?.('[id^="chat-messages-"]');
                if (r) roots.add(r);
                for (const node of mu.addedNodes || []) {
                    if (!(node instanceof HTMLElement)) continue;
                    const ar = node.matches?.('[id^="chat-messages-"]') ? node : node.closest?.('[id^="chat-messages-"]');
                    if (ar) roots.add(ar);
                    else node.querySelectorAll?.('[id^="chat-messages-"]').forEach(c => roots.add(c));
                }
            }
            roots.forEach(scheduleDomScan);
        });
        observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    }

    /* ===================== CLIC AUTOMATIQUE SUR BOUTONS (optionnel) ===================== */
    function maybeClickButtons(root, messageId, fromBot) {
        const labels = S.clickLabels.split("\n").map(s => s.trim()).filter(Boolean);
        if (!labels.length || !fromBot || seenIds.has(messageId)) return;
        const st = clickState.get(messageId) || { index: 0, busy: false };
        clickState.set(messageId, st);
        if (st.busy || st.index >= labels.length) return;
        const label = labels[st.index].toLowerCase();
        const button = [...root.querySelectorAll("button")].find(b => !b.disabled && b.getAttribute("aria-disabled") !== "true" && (b.innerText || b.getAttribute("aria-label") || "").toLowerCase().includes(label));
        if (!button) return;
        st.busy = true;
        setTimeout(() => { try { button.click(); } catch (_) {} st.index++; st.busy = false; }, 900 + Math.random() * 600);
    }

    /* ===================== ENVOI AUTOMATIQUE DE COMMANDES ===================== */
    function getEditor() { return document.querySelector('div[role="textbox"][data-slate-editor="true"]'); }

    // --- Accès aux modules internes de Discord (envoi réel de message) ---
    let messageActions = null;
    function findMessageActions() {
        if (messageActions) return messageActions;
        try {
            const W = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
            const chunk = W.webpackChunkdiscord_app;
            if (!chunk || typeof chunk.push !== "function") return null;
            let req = null;
            chunk.push([[Symbol("reverse-rng")], {}, r => { req = r; }]);
            if (!req || !req.c) return null;
            for (const mod of Object.values(req.c)) {
                let exp;
                try { exp = mod?.exports; } catch (_) { continue; }
                if (!exp || (typeof exp !== "object" && typeof exp !== "function")) continue;
                let candidates = [exp];
                try { candidates = candidates.concat(Object.values(exp)); } catch (_) {}
                for (const c of candidates) {
                    try {
                        if (c && typeof c.sendMessage === "function" && typeof c.receiveMessage === "function" && typeof c.editMessage === "function") {
                            messageActions = c;
                            console.info("[Reverse RNG] Module d'envoi Discord trouvé.");
                            return c;
                        }
                    } catch (_) {}
                }
            }
        } catch (e) { console.warn("[Reverse RNG] Recherche du module d'envoi impossible", e); }
        return null;
    }

    function pasteInto(editor, text) {
        const dt = new DataTransfer();
        dt.setData("text/plain", text);
        editor.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    }

    async function sendCommand(raw) {
        // 1) Message texte simple : envoi réel via le module interne de Discord.
        if (!raw.startsWith("/")) {
            const actions = findMessageActions();
            if (actions) {
                try {
                    await actions.sendMessage(CHANNEL_ID, { content: raw, tts: false, invalidEmojis: [], validNonShortcutEmojis: [] });
                    return true;
                } catch (e) { console.warn("[Reverse RNG] sendMessage a échoué, repli sur la zone de texte", e); }
            }
        }

        // 2) Repli / slash commands : on pilote la zone de texte (collage reconnu par l'éditeur).
        const editor = getEditor();
        if (!editor) { setStatus("Zone de texte introuvable"); return false; }
        editor.focus();
        await sleep(100);
        if ((editor.textContent || "").trim()) { setStatus("Zone de texte occupée, envoi sauté"); return false; }
        const key = (k, code, kc) => editor.dispatchEvent(new KeyboardEvent("keydown", { key: k, code, keyCode: kc, which: kc, bubbles: true, cancelable: true }));
        const len = () => (editor.textContent || "").length;
        // Place le curseur dans le premier champ d'option vide de la slash command (ex. « amount »).
        const focusFirstEmptyOption = () => {
            try {
                const cands = [...editor.querySelectorAll('[class*="ption"], [class*="Option"]')];
                for (const c of cands) {
                    const leaf = c.querySelector("[data-slate-string], [data-slate-zero-width], [data-slate-leaf]");
                    if (!leaf) continue;
                    const txt = (leaf.textContent || "").replace(/[\u200B\uFEFF]/g, "").trim();
                    if (txt) continue;
                    const target = leaf.querySelector("[data-slate-zero-width]") || leaf;
                    for (const t of ["mousedown", "mouseup", "click"]) target.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true }));
                    const range = document.createRange();
                    range.selectNodeContents(target);
                    range.collapse(true);
                    const sel = window.getSelection();
                    sel.removeAllRanges();
                    sel.addRange(range);
                    document.dispatchEvent(new Event("selectionchange"));
                    return true;
                }
            } catch (e) { console.debug("[Reverse RNG] focusFirstEmptyOption", e); }
            return false;
        };
        // Saisie vérifiée : essaie plusieurs méthodes jusqu'à ce que le texte apparaisse réellement.
        const type = async (t, preferPaste = false) => {
            const before = len();
            const methods = preferPaste ? ["paste", "input", "exec"] : ["input", "paste", "exec"];
            for (const m of methods) {
                if (m === "paste") pasteInto(editor, t);
                else if (m === "input") {
                    for (const ch of t) {
                        editor.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertText", data: ch, bubbles: true, cancelable: true, composed: true }));
                        await sleep(25);
                    }
                } else document.execCommand("insertText", false, t);
                await sleep(120);
                if (len() > before) return true;
            }
            return false;
        };

        if (raw.startsWith("/")) {
            // Commande slash : "/commande arg1 arg2" (args sans espaces, séparés par Tab)
            const m = raw.match(/^(\S+)\s*(.*)$/);
            const cmd = m[1];
            const rest = (m[2] || "").trim();
            // « bet:🟥 Redstone (×2) amount:10 » -> ["🟥 Redstone (×2)", "10"] (ordre conservé).
            // Sans « nom: », les arguments sont séparés par des espaces.
            const args = /^[\w-]+:/.test(rest)
                ? rest.split(/\s+(?=[\w-]+:)/).map(a => a.replace(/^[\w-]+:\s*/, "").trim()).filter(Boolean)
                : rest.split(/\s+/).filter(Boolean);
            await type(cmd, true);
            await sleep(900);          // laisse l'autocomplétion apparaître
            key("Tab", "Tab", 9);      // sélectionne la commande (le curseur passe sur la 1re option)
            await sleep(900);
            for (let i = 0; i < args.length; i++) {
                // Place le curseur dans le prochain champ vide (bet, puis amount…) ; à défaut, Tab.
                const found = focusFirstEmptyOption();
                if (!found && i > 0) key("Tab", "Tab", 9);
                await sleep(250);
                // Option à choix (ex. bet) : on tape un mot-clé court (« Redstone ») pour filtrer l'autocomplétion.
                const isChoice = !/^\d+([.,]\d+)?$/.test(args[i]);
                const typed = isChoice ? (args[i].replace(/[^\p{L}\p{N}\s]/gu, " ").trim().split(/\s+/)[0] || args[i]) : args[i];
                let ok = await type(typed);
                if (!ok) {
                    // 2e essai : on replace explicitement le curseur dans le champ puis on retape.
                    focusFirstEmptyOption();
                    await sleep(250);
                    ok = await type(typed);
                }
                if (!ok) {
                    setStatus(`Argument non saisi : ${args[i]}`);
                    console.warn("[Reverse RNG] Impossible de remplir l'argument", args[i], "\nHTML de la zone de texte (à me transmettre) :\n", editor.outerHTML.slice(0, 3000));
                }
                if (ok && isChoice) {
                    // On clique la proposition d'autocomplétion correspondante ; à défaut (ou si rien n'a changé), Tab.
                    await sleep(900);
                    const lenBefore = len();
                    const want = typed.toLowerCase();
                    const item = [...document.querySelectorAll('[role="option"], [class*="autocompleteRow"], [class*="selectable"]')]
                        .find(el => !editor.contains(el) && (el.textContent || "").toLowerCase().includes(want));
                    if (item) for (const t of ["mousedown", "mouseup", "click"]) item.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true }));
                    await sleep(500);
                    if (len() <= lenBefore) { key("Tab", "Tab", 9); await sleep(500); }
                } else {
                    await sleep(300);
                }
            }
            await sleep(450);
        } else {
            await type(raw, true);
            await sleep(250);
        }
        key("Enter", "Enter", 13);
        await sleep(700);
        const stuck = (editor.textContent || "").trim();
        editor.blur();                 // libère le focus pour que T / F / Échap fonctionnent
        if (stuck) { setStatus(`Non envoyé (texte resté dans la barre) : ${raw}`); return false; }
        return true;
    }

    // {amount} est remplacé par la mise ; une slash command sans argument reçoit la mise automatiquement.
    function resolveCommand(cmd) {
        const amt = String(S.amount ?? "").trim();
        let out = cmd.replace(/\{amount\}/gi, amt);
        if (out.startsWith("/") && amt && !/\s/.test(out.trim()) && !/\{amount\}/i.test(cmd)) out += " " + amt;
        return out.trim();
    }

    function getCommands() { return S.commands.split("\n").map(s => s.trim()).filter(Boolean); }

    async function sendTick(force = false) {
        if (!location.pathname.includes(CHANNEL_ID)) { setStatus("Salon cible non ouvert — envoi sauté"); return; }
        if (!force && (active || pending.length || focusedMessageId)) { setStatus("Résultat précédent en cours — envoi sauté"); return; }
        const cmds = getCommands();
        if (!cmds.length) { setStatus("Aucune commande configurée"); return; }
        const cmd = resolveCommand(S.random ? cmds[Math.floor(Math.random() * cmds.length)] : cmds[cmdIndex++ % cmds.length]);
        setStatus(`Envoi : ${cmd}`);
        const ok = await sendCommand(cmd);
        if (ok) setStatus(`Envoyé : ${cmd}`);
    }

    function scheduleNextSend() {
        clearTimeout(sendTimer);
        if (!sending) return;
        const base = S.interval * 1000;
        const delay = Math.max(2000, base + base * (S.jitter / 100) * (Math.random() * 2 - 1));
        nextSendAt = Date.now() + delay;
        sendTimer = setTimeout(async () => {
            try { await sendTick(); } catch (e) { console.warn("[Reverse RNG] Envoi échoué", e); }
            scheduleNextSend();
        }, delay);
    }

    function startSending() {
        if (sending) return;
        sending = true;
        setStatus("Envoi automatique actif");
        scheduleNextSend();
        refreshSendButton();
    }
    function stopSending() {
        sending = false;
        clearTimeout(sendTimer);
        sendTimer = null;
        setStatus("Envoi arrêté");
        refreshSendButton();
    }

    /* ===================== EXPORT SERVEUR LOCAL ===================== */
    function startAutoExport() {
        stopAutoExport();
        const push = () => {
            if (!S.exportServer) return;
            if (typeof GM_xmlhttpRequest !== "function") {
                // Mode snippet DevTools : pas de GM_xmlhttpRequest, on tente fetch (peut être bloqué par la CSP).
                fetch(EXPORT_URL, { method: "POST", mode: "no-cors", headers: { "Content-Type": "text/plain" }, body: JSON.stringify(observations) })
                    .then(() => { lastExportOk = true; })
                    .catch(() => { if (lastExportOk !== false) console.warn("[Reverse RNG] Export serveur impossible (CSP ou serveur éteint) — utilise « Exporter JSON »."); lastExportOk = false; });
                return;
            }
            try {
                GM_xmlhttpRequest({
                    method: "POST", url: EXPORT_URL, headers: { "Content-Type": "application/json" },
                    data: JSON.stringify(observations),
                    onload: r => { if (r.status >= 200 && r.status < 300) lastExportOk = true; else { if (lastExportOk !== false) console.error("[Reverse RNG] Export HTTP", r.status); lastExportOk = false; } },
                    onerror: () => { if (lastExportOk !== false) console.error("[Reverse RNG] Serveur d'export inaccessible"); lastExportOk = false; }
                });
            } catch (e) { console.error("[Reverse RNG] Export", e); }
        };
        push();
        exportInterval = setInterval(push, 10000);
    }
    function stopAutoExport() { if (exportInterval) clearInterval(exportInterval); exportInterval = null; }

    /* ===================== STATS / EXPORT JSON / RESET ===================== */
    function getStatistics() {
        const labelled = observations.filter(i => i.status === "labelled");
        const by = {};
        for (const g of [...GAMES, "Unknown"]) by[g] = { wins: 0, losses: 0, refunds: 0, total: 0, winRatePercent: null };
        for (const i of labelled) {
            const g = by[i.gameType] ? i.gameType : "Unknown";
            if (i.label === "win") by[g].wins++; else if (i.label === "loss") by[g].losses++; else if (i.label === "refund") by[g].refunds++;
            by[g].total++;
        }
        for (const g of Object.values(by)) g.winRatePercent = (g.wins + g.losses) ? Number((g.wins / (g.wins + g.losses) * 100).toFixed(2)) : null;
        const wins = labelled.filter(i => i.label === "win").length, losses = labelled.filter(i => i.label === "loss").length;
        return {
            total: observations.length, labelled: labelled.length, wins, losses,
            refunds: labelled.filter(i => i.label === "refund").length,
            winRatePercent: (wins + losses) ? Number((wins / (wins + losses) * 100).toFixed(2)) : null,
            ignored: observations.filter(i => i.status === "ignored").length,
            pending: pending.length + (active ? 1 : 0), byGame: by
        };
    }

    function exportJSON() {
        const useful = observations
            .filter(i => i.status === "labelled" && GAMES.includes(i.gameType) && ["win", "loss", "refund"].includes(i.label))
            .map(i => ({
                game: i.gameType, outcome: i.label, timestamp: i.messageTimestamp || i.receivedAt || null,
                messageId: String(i.messageId || ""), keyword: String(i.matchedKeyword || "").slice(0, 80),
                ...(i.gameType === "LuckyBlock" ? { category: getLuckyBlockCategory(i.matchedKeyword) || getLuckyBlockCategory(i.classificationText) || i.matchedKeyword || null } : {}),
                detection: i.labelSource === "automatic_embed_keyword" ? "automatic" : "manual"
            }))
            .sort((a, b) => String(a.timestamp || "").localeCompare(String(b.timestamp || "")));
        const counts = Object.fromEntries(GAMES.map(g => [g, { wins: 0, losses: 0, refunds: 0 }]));
        for (const i of useful) counts[i.game][i.outcome === "win" ? "wins" : i.outcome === "loss" ? "losses" : "refunds"]++;
        const payload = {
            schemaVersion: 6, purpose: "reverse_rng_analysis", exportedAt: new Date().toISOString(),
            source: { channelId: CHANNEL_ID, botId: BOT_ID },
            summary: {
                totalResults: useful.length,
                countsByGame: Object.fromEntries(Object.entries(counts).map(([g, r]) => [g, { ...r, total: r.wins + r.losses + r.refunds, winRatePercent: r.wins + r.losses ? Number((r.wins / (r.wins + r.losses) * 100).toFixed(2)) : null }]))
            },
            results: useful
        };
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = `reverse-rng-clean-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1500);
        toast(`Export JSON : ${useful.length} résultats exploitables.`, "success");
    }

    function showStatistics() {
        const s = getStatistics();
        console.table({ Observations: s.total, Annotées: s.labelled, Gains: s.wins, Pertes: s.losses, "Taux de gain (%)": s.winRatePercent, Ignorées: s.ignored, "En attente": s.pending });
        console.table(s.byGame);
        toast(`${s.labelled} annotés — ${s.wins} gains, ${s.losses} pertes (détails en console F12).`, "info");
    }

    function clearObservations() {
        if (!confirm("Effacer définitivement toutes les observations Reverse RNG ?")) return;
        observations = []; seenIds.clear(); saveData();
        refreshCounters();
        toast("Observations effacées.", "success");
    }

    /* ===================== PANNEAU DE CONTRÔLE ===================== */
    let sendBtn = null, counterEl = null;
    function refreshSendButton() {
        if (!sendBtn) return;
        sendBtn.textContent = sending ? "■ Arrêter l'envoi auto" : "▶ Démarrer l'envoi auto";
        sendBtn.style.background = sending ? "#b93838" : "#248046";
    }
    function refreshCounters() {
        if (!counterEl) return;
        const s = getStatistics();
        counterEl.textContent = `${s.labelled} annotés · ${s.wins} G / ${s.losses} P · ${s.ignored} ignorés`;
    }

    function buildPanel() {
        if (panelEl) return;
        const mk = (tag, css, text) => { const e = document.createElement(tag); if (css) e.style.cssText = css; if (text !== undefined) e.textContent = text; return e; };
        const inputCss = "width:100%;box-sizing:border-box;padding:6px 8px;border-radius:6px;border:1px solid #555;background:#2b2d31;color:#f2f3f5;font:13px Arial,sans-serif";
        const btnCss = "padding:8px 10px;border:0;border-radius:6px;cursor:pointer;background:#5865f2;color:#fff;font-weight:700;font-size:12px";
        const btn = (text, fn, extra = "") => { const b = mk("button", btnCss + ";" + extra, text); b.type = "button"; b.addEventListener("click", fn); return b; };
        const field = (label, input) => { const w = mk("label", "display:flex;flex-direction:column;gap:3px;font-size:12px"); w.append(mk("span", "opacity:.8", label), input); return w; };
        const num = (value, min, max, onChange) => { const i = mk("input", inputCss); i.type = "number"; i.min = min; i.max = max; i.value = value; i.addEventListener("change", () => { onChange(i); }); return i; };

        const panel = mk("section", "position:fixed;left:18px;bottom:60px;z-index:2147483646;width:330px;max-width:calc(100vw - 36px);max-height:80vh;overflow:auto;box-sizing:border-box;padding:14px;border-radius:12px;background:#1e1f22;color:#f2f3f5;border:1px solid #555;box-shadow:0 10px 35px rgba(0,0,0,.5);font:14px/1.4 Arial,sans-serif;display:none;flex-direction:column;gap:9px");

        statusEl = mk("div", "font-size:12px;font-weight:700;padding:6px 8px;border-radius:6px;background:#2b2d31", statusText);
        counterEl = mk("div", "font-size:12px;opacity:.85");

        const mode = mk("select", inputCss);
        [["auto", "Automatique — tous les jeux"], ["mines", "Mines"], ["wheel", "Wheel"], ["luckyblock", "LuckyBlock"], ["blackjack", "BlackJack"]].forEach(([v, l]) => { const o = mk("option", "", l); o.value = v; mode.appendChild(o); });
        mode.value = S.mode;
        mode.addEventListener("change", () => { S.mode = mode.value; saveSettings(); toast(`Mode : ${getModeRules().modeName}`, "success"); });

        const interval = num(S.interval, 3, 3600, i => { S.interval = clamp(i.value, 3, 3600, 30); i.value = S.interval; saveSettings(); if (sending) scheduleNextSend(); });
        const jitter = num(S.jitter, 0, 90, i => { S.jitter = clamp(i.value, 0, 90, 20); i.value = S.jitter; saveSettings(); });
        const amountInput = mk("input", inputCss);
        amountInput.type = "text";
        amountInput.value = S.amount;
        amountInput.addEventListener("change", () => { S.amount = amountInput.value.trim(); saveSettings(); });
        const ignoreT = num(S.ignoreTimeout, 1, 60, i => { S.ignoreTimeout = clamp(i.value, 1, 60, 8); i.value = S.ignoreTimeout; saveSettings(); });
        const notifT = num(S.notifDuration, 1, 60, i => { S.notifDuration = clamp(i.value, 1, 60, 4); i.value = S.notifDuration; saveSettings(); });

        const cmds = mk("textarea", inputCss + ";min-height:80px;resize:vertical;font-family:ui-monospace,Consolas,monospace");
        cmds.value = S.commands;
        cmds.addEventListener("change", () => { S.commands = cmds.value; cmdIndex = 0; saveSettings(); });

        const clicks = mk("textarea", inputCss + ";min-height:46px;resize:vertical;font-family:ui-monospace,Consolas,monospace");
        clicks.placeholder = "ex : Cash Out";
        clicks.value = S.clickLabels;
        clicks.addEventListener("change", () => { S.clickLabels = clicks.value; saveSettings(); });

        const check = (label, prop, after) => {
            const w = mk("label", "display:flex;align-items:center;gap:8px;font-size:12px;cursor:pointer");
            const c = mk("input"); c.type = "checkbox"; c.checked = Boolean(S[prop]);
            c.addEventListener("change", () => { S[prop] = c.checked; saveSettings(); after?.(); });
            w.append(c, mk("span", "", label));
            return w;
        };

        sendBtn = btn("", () => (sending ? stopSending() : startSending()));
        refreshSendButton();

        panel.append(
            mk("div", "font-size:16px;font-weight:800", "Reverse RNG"),
            statusEl, counterEl,
            field("Mode de détection", mode),
            field("Intervalle X entre commandes (secondes)", interval),
            field("Variation aléatoire (%)", jitter),
            field("Mise / amount (remplace {amount}, ajoutée aux slash sans argument)", amountInput),
            field("Commandes (une par ligne, « / » = slash command)", cmds),
            check("Ordre aléatoire", "random"),
            field("Boutons à cliquer sur l'embed du bot (un par ligne, dans l'ordre)", clicks),
            field("Délai d'ignorance auto (s)", ignoreT),
            field("Durée notification résultat (s)", notifT),
            check("Export auto vers le serveur local (127.0.0.1:3210)", "exportServer", () => { lastExportOk = null; }),
            check("Debug console (F12)", "debug"),
            sendBtn,
            btn("Envoyer 1 commande maintenant (test)", () => { sendTick(true); }, "background:#4752c4"),
            btn("Exporter JSON", exportJSON),
            btn("Afficher les statistiques", showStatistics),
            btn("Effacer toutes les observations", clearObservations, "background:#555963"),
            mk("div", "font-size:11px;opacity:.65", "Alt+Maj+R : afficher/masquer ce panneau · T / F / Échap : annoter un embed en attente")
        );
        document.body.appendChild(panel);
        panelEl = panel;
        refreshCounters();

        document.getElementById("reverse-rng-pill")?.remove();
        const pill = mk("button", "position:fixed;left:18px;bottom:18px;z-index:2147483646;padding:8px 14px;border:0;border-radius:20px;cursor:pointer;background:#5865f2;color:#fff;font:700 12px Arial,sans-serif;box-shadow:0 4px 14px rgba(0,0,0,.4)", "RNG");
        pill.type = "button";
        pill.addEventListener("click", togglePanel);
        pill.id = "reverse-rng-pill";
        document.body.appendChild(pill);

        setInterval(() => {
            if (sending && statusEl) {
                const left = Math.max(0, Math.round((nextSendAt - Date.now()) / 1000));
                if (/^(Envoi automatique actif|Envoyé|Envoi arrêté)/.test(statusText) || statusText.startsWith("Prochain")) statusEl.textContent = `Prochain envoi dans ${left} s`;
            }
        }, 1000);
    }

    function togglePanel() { if (panelEl) panelEl.style.display = panelEl.style.display === "none" ? "flex" : "none"; }

    /* ===================== DÉMARRAGE ===================== */
    function safe(name, fn) {
        try { fn(); } catch (e) { console.error(`[Reverse RNG] Erreur dans ${name} :`, e); }
    }

    function start() {
        if (window.__reverseRngLoaded) return;
        window.__reverseRngLoaded = true;
        console.info("[Reverse RNG] Démarrage…");
        running = true;
        startedAt = Date.now();
        // Le panneau d'abord : il doit apparaître même si une autre étape échoue.
        safe("loadData", loadData);
        safe("buildPanel", buildPanel);
        safe("keys", () => {
            document.addEventListener("keydown", onKeyDown, true);
            document.addEventListener("keydown", e => { if (e.altKey && e.shiftKey && e.code === "KeyR") { e.preventDefault(); togglePanel(); } }, true);
        });
        safe("observer", startObserver);
        safe("export", startAutoExport);
        safe("menu", () => {
            if (typeof GM_registerMenuCommand === "function") {
                GM_registerMenuCommand("Afficher/masquer le panneau", togglePanel);
                GM_registerMenuCommand("Exporter JSON", exportJSON);
            }
        });
        safe("scan", () => document.querySelectorAll('[id^="chat-messages-"]').forEach(scheduleDomScan));
        // Discord est une SPA : on s'assure que le bouton RNG reste présent.
        setInterval(() => {
            if (!document.getElementById("reverse-rng-pill") || (panelEl && !panelEl.isConnected)) {
                panelEl = null;
                safe("rebuildPanel", buildPanel);
            }
        }, 2000);
        toast("Reverse RNG activé — bouton RNG en bas à gauche", "success");
        console.info(`[Reverse RNG] Userscript actif. Salon=${CHANNEL_ID}, bot=${BOT_ID}`);
    }

    function boot() {
        if (document.body) start();
        else window.addEventListener("DOMContentLoaded", start, { once: true });
    }
    boot();
})();
