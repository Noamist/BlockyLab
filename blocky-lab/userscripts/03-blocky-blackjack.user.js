// ==UserScript==
// @name         Blocky Lab · 03 · Blackjack
// @namespace    blocky-lab
// @version      5.2.0
// @description  Conseiller blackjack Blocky : stratégie complète, Hi-Lo, déviations, autoplay fiabilisé (embed, emojis, custom_id, position, clic React) et calibration visuelle.
// @match        https://discord.com/*
// @match        https://canary.discord.com/*
// @match        https://ptb.discord.com/*
// @run-at       document-idle
// @noframes
// @grant        unsafeWindow
// ==/UserScript==

/* Stratégie de base : 4-8 jeux, croupier reste sur 17 (S17), double autorisé sur 2 cartes. */

(function () {
    "use strict";

    const W = typeof unsafeWindow !== "undefined" && unsafeWindow ? unsafeWindow : window;

    const DEFAULTS = {
        amount: 10,
        intervalSec: 12,
        autoPlay: true,
        maxHands: 0,
        stopLoss: 0,
        stopWin: 0,
        decks: 6,
        penetration: 0.75,
        myName: "",
        onlyMine: true,
        clickDelayMs: 900,
        showInline: true,
        badge: true,
        retryClick: true,
        positionFallback: true,
        positionOrder: "HIT,STAND,DOUBLE",
        mapHit: "hit,tirer,piocher,draw,attack,attaquer,➕,👊,🗡,⚔,🃏",
        mapStand: "stand,rester,rest,stay,passer,stop,✋,🛑,🖐,🤚,🚫",
        mapDouble: "double,doubler,x2,2x,💰,💎,💵",
        btnOverride: {},
        debugButtons: false,
        settingsVersion: 6,
        reliableClick: true,
        clickStrategies: 3,
        actionTimeoutMs: 8000
    };

    async function boot() {
        for (let i = 0; i < 200 && !W.BlockyLab; i++) await new Promise(r => setTimeout(r, 100));
        const lab = W.BlockyLab;
        if (!lab) { console.warn("[BlockyLab] blackjack : noyau absent"); return; }
        if (W.__blockyBlackjackLoaded) return;
        W.__blockyBlackjackLoaded = true;

        const { h, toast } = lab;
        // Nouvelle clé : les overrides de l'ancienne version pouvaient forcer un
        // bouton sur la mauvaise action et bloquer l'autoplay sans explication.
        const saved = lab.store.get("bj.settings.v5", null) || lab.store.get("bj.settings", {}) || {};
        const settings = Object.assign({}, DEFAULTS, saved);
        settings.settingsVersion = 6;
        if (!settings.btnOverride || typeof settings.btnOverride !== "object") settings.btnOverride = {};
        for (const [key, value] of Object.entries(settings.btnOverride)) {
            if (!["HIT", "STAND", "DOUBLE", "IGNORE"].includes(value)) delete settings.btnOverride[key];
        }
        const save = () => lab.store.set("bj.settings.v5", settings);

        const state = {
            shoe: { size: settings.decks * 52, seen: 0, rc: 0, cards: 0, shuffledAt: 0 },
            handOpen: false,
            handKey: "",
            awaitingUntil: 0,
            lastActionKey: "",
            lastActionAt: 0,
            session: { hands: 0, wins: 0, losses: 0, pushes: 0, net: 0, start: 0 },
            table: [],
            resultIds: new Set(),
            lastResult: null,
            run: { active: false, timer: null, sent: 0, lastSent: 0, lastError: "", fails: 0 },
            current: null,
            lastCands: [],
            lastComps: [],
            lastMap: new Map(),
            clickError: "",
            clickLog: [],
            pressSeq: 0,
            lastPress: null,
            handBet: 0,
            clickSuccesses: 0,
            clickMisses: 0,
            clickInFlight: false,
            clickAttemptKey: "",
            clickAttempts: 0,
            clickFailedAt: 0
        };

        /* -------------------------------------------------------------- */
        /* Comptage Hi-Lo                                                  */
        /* -------------------------------------------------------------- */

        function hiLo(card) {
            if (!card) return 0;
            if (card.rank === "A" || card.value === 10) return -1;
            if (card.value >= 2 && card.value <= 6) return 1;
            return 0;
        }

        function shoeReset(reason) {
            state.shoe = { size: settings.decks * 52, seen: 0, rc: 0, cards: 0, shuffledAt: Date.now() };
            lab.log("shoe reset", reason);
        }

        function countCards(cards) {
            for (const c of cards) {
                state.shoe.seen++;
                state.shoe.cards++;
                state.shoe.rc += hiLo(c);
            }
        }

        // Ne compte que les cartes nouvellement apparues par rapport à l'état précédent.
        function deltaCards(prev, next) {
            const pool = new Map();
            for (const c of prev) {
                const k = c.rank + c.suit;
                pool.set(k, (pool.get(k) || 0) + 1);
            }
            const delta = [];
            for (const c of next) {
                const k = c.rank + c.suit;
                const n = pool.get(k) || 0;
                if (n > 0) pool.set(k, n - 1);
                else delta.push(c);
            }
            return delta;
        }

        function syncTable(playerCards, dealerCards) {
            const target = [...playerCards, ...dealerCards];
            const prev = state.table;
            const isSuperset = target.length >= prev.length && deltaCards(prev, target).length === 0;
            if (isSuperset) {
                const added = deltaCards(prev, target);
                countCards(added);
            } else {
                countCards(target);
            }
            state.table = target;
        }

        function trueCount() {
            const remaining = Math.max(1, state.shoe.size - state.shoe.seen);
            return state.shoe.rc / (remaining / 52);
        }

        function penetration() {
            return state.shoe.seen / state.shoe.size;
        }

        /* -------------------------------------------------------------- */
        /* Parsing de la table                                             */
        /* -------------------------------------------------------------- */

        const DEALER_LABEL = /\b(dealer|croupier|banque)\b/i;
        const PLAYER_LABEL = /\b(your hand|your cards|your total|votre main|ta main|vous|player|joueur|you)\b/i;
        const HIDDEN = /🂠|🎴|🃏|❓|\[\?\]|hidden|cach[ée]e|face\s*down/i;

        function splitTable(text) {
            const re = new RegExp(`(${DEALER_LABEL.source}|${PLAYER_LABEL.source})`, "gi");
            const marks = [];
            let m;
            while ((m = re.exec(text))) {
                const word = m[0].toLowerCase();
                marks.push({
                    pos: m.index,
                    end: m.index + m[0].length,
                    side: /dealer|croupier|banque/.test(word) ? "dealer" : "player"
                });
            }
            const segments = marks.map((mark, i) => ({
                side: mark.side,
                text: text.slice(mark.end, i + 1 < marks.length ? marks[i + 1].pos : text.length)
            }));
            return segments;
        }

        function displayedTotal(segText) {
            // Formats observés : « You — 2♠ 4♣ · 6 » et « Dealer — 8♥ 🂠 · 8 + ? ».
            const m = String(segText || "").match(/(?:·|•|\b(?:total|score)\b\s*[:=]?)\s*(\d{1,2})(?!\s*(?:emerald|émeraude|💎|%))/i);
            const n = m ? Number(m[1]) : null;
            return n != null && n >= 2 && n <= 31 ? n : null;
        }

        function parseTable(text) {
            let dealer = null, player = null;
            for (const seg of splitTable(text)) {
                const cards = lab.analyze.parseCards(seg.text);
                const shown = displayedTotal(seg.text);
                if (!cards.length && shown == null) continue;
                const hv = lab.analyze.handValue(cards);
                const total = shown != null ? shown : hv.total;
                const entry = { cards, total, soft: hv.soft || (/\b(?:soft|souple)\b/i.test(seg.text) && total < 21), hidden: HIDDEN.test(seg.text) || /\+\s*\?/.test(seg.text) };
                if (seg.side === "dealer" && !dealer) dealer = entry;
                if (seg.side === "player" && !player) player = entry;
            }
            // Repli : certaines mises en page affichent « Cartes » sans libellé.
            if (!dealer || !player) {
                const all = lab.analyze.parseCards(text);
                if (all.length >= 4) {
                    const half = Math.floor(all.length / 2);
                    if (!player) {
                        const p = all.slice(0, half);
                        const hv = lab.analyze.handValue(p);
                        player = { cards: p, total: hv.total, soft: hv.soft, hidden: false };
                    }
                    if (!dealer) {
                        const d = all.slice(half);
                        const hv = lab.analyze.handValue(d);
                        dealer = { cards: d, total: hv.total, soft: hv.soft, hidden: HIDDEN.test(text) };
                    }
                }
            }

            // Dernier repli : le bot donne parfois les totaux sans les cartes
            // (ou avec des images qui ne portent pas de rang lisible).
            if (!player) {
                const m = text.match(/(?:your (?:total|hand|score)|votre (?:total|main|score)|ta main|total|you\b)[^\d]{0,30}(\d{1,2})(?:\s*\+\s*\?)?/i);
                if (m) {
                    const total = Number(m[1]);
                    if (total >= 2 && total <= 21) {
                        player = { cards: [], total, soft: /\b(soft|souple)\b/i.test(text), hidden: false };
                    }
                }
            }
            if (!dealer) {
                const m = text.match(/(?:dealer|croupier|banque)[^\dAJQK]{0,24}(A|10|[2-9])/i);
                if (m) {
                    const rank = m[1].toUpperCase();
                    const value = rank === "A" ? 11 : Number(rank);
                    dealer = {
                        cards: [{ rank, value, suit: "?" }],
                        total: value, soft: value === 11, hidden: true
                    };
                }
            }
            return { dealer, player };
        }

        /* -------------------------------------------------------------- */
        /* Stratégie                                                       */
        /* -------------------------------------------------------------- */

        function basic(cards, total, soft, up, canDouble) {
            if (total >= 21) return "STAND"; // 21 ou bust
            // Si les cartes ne sont pas lisibles mais que le bouton Double est
            // actif, on suppose une main à deux cartes : c'est le seul cas où
            // le bot propose Double.
            const two = cards.length === 2 || (cards.length === 0 && canDouble);
            const dbl = two && canDouble;
            const upA = up === 11;

            if (soft) {
                if (total >= 20) return "STAND";
                if (total === 19) return "STAND";
                if (total === 18) {
                    if (up >= 3 && up <= 6) return dbl ? "DOUBLE" : "STAND";
                    if (up === 2 || up === 7 || up === 8) return "STAND";
                    return "HIT";
                }
                if (total === 17) return dbl && up >= 3 && up <= 6 ? "DOUBLE" : "HIT";
                if (total === 16 || total === 15) return dbl && up >= 4 && up <= 6 ? "DOUBLE" : "HIT";
                if (total === 14 || total === 13) return dbl && up >= 5 && up <= 6 ? "DOUBLE" : "HIT";
                return "HIT";
            }

            if (total >= 17) return "STAND";
            if (total >= 13) return up >= 2 && up <= 6 ? "STAND" : "HIT";
            if (total === 12) return up >= 4 && up <= 6 ? "STAND" : "HIT";
            if (total === 11) return dbl && !upA ? "DOUBLE" : "HIT";
            if (total === 10) return dbl && up <= 9 ? "DOUBLE" : "HIT";
            if (total === 9) return dbl && up >= 3 && up <= 6 ? "DOUBLE" : "HIT";
            return "HIT";
        }

        // Illustrious 18 (S17) : déviations les plus rentables, true count Hi-Lo.
        function deviation(cards, total, soft, up, tc) {
            const two = cards.length === 2;
            if (!soft && total === 16 && up === 10 && tc >= 0) return "STAND";
            if (!soft && total === 15 && up === 10 && tc >= 4) return "STAND";
            if (!soft && total === 15 && up === 9 && tc >= 5) return "STAND";
            if (!soft && total === 12 && up === 4 && tc < 0) return "HIT";
            if (!soft && total === 12 && up === 3 && tc < -1) return "HIT";
            if (!soft && total === 12 && up === 2 && tc < -2) return "HIT";
            if (!soft && total === 11 && up === 11 && tc >= 1 && two) return "DOUBLE";
            if (!soft && total === 10 && up === 10 && tc >= 4 && two) return "DOUBLE";
            if (!soft && total === 10 && up === 11 && tc >= 3 && two) return "DOUBLE";
            if (!soft && total === 9 && up === 2 && tc >= 1 && two) return "DOUBLE";
            if (!soft && total === 8 && up === 6 && tc >= 2 && two) return "DOUBLE";
            if (!soft && total === 13 && up === 2 && tc < -1) return "HIT";
            return null;
        }

        function choose(cards, total, soft, up, canDouble, usedTC) {
            const base = basic(cards, total, soft, up, canDouble);
            const dev = deviation(cards, total, soft, up, usedTC ? trueCount() : 0);
            if (!dev) return { action: base, deviated: false };
            if (dev === "DOUBLE" && !canDouble) return { action: "HIT", deviated: true };
            return { action: dev, deviated: true };
        }

        /* -------------------------------------------------------------- */
        /* Actions / boutons                                               */
        /* -------------------------------------------------------------- */

        function normLabel(s) {
            return String(s || "")
                .toLowerCase()
                .normalize("NFD")
                .replace(/[\u0300-\u036f]/g, "")
                .replace(/[^a-z0-9]+/g, " ")
                .trim();
        }

        function hasKeyword(raw, norm, kw) {
            const k = String(kw || "").trim();
            if (!k) return false;
            const kn = normLabel(k);
            if (kn) return (` ${norm} `).includes(` ${kn} `);
            return raw.includes(k);
        }

        function buttonKey(c) {
            // Certains bots suffixent le custom_id avec un identifiant de partie :
            // on le retire pour que l'override survive à la main suivante.
            const id = String(c.customId || "").trim().replace(/[:|_-]?\d{5,}$/, "");
            if (id) return `id:${id}`;
            const label = normLabel(c.compLabel || c.label || c.aria || c.title || c.alt);
            return label ? `label:${label}` : `idx:${c.index}`;
        }

        function classifyButton(c) {
            const override = settings.btnOverride?.[buttonKey(c)];
            if (override === "IGNORE") return null;
            if (override === "HIT" || override === "STAND" || override === "DOUBLE") return override;

            const labelRaw = [c.label, c.aria, c.title, c.alt, c.compLabel, c.dataId]
                .filter(Boolean).join(" ").toLowerCase();
            const idRaw = String(c.customId || "").toLowerCase();
            const raw = `${labelRaw} ${idRaw}`;
            const norm = normLabel(raw);

            // 1) Les mots-clés explicites du libellé. On teste DOUBLE d'abord :
            //    un bouton « Double » ne doit jamais être pris pour « Hit ».
            const maps = [
                ["DOUBLE", settings.mapDouble],
                ["STAND", settings.mapStand],
                ["HIT", settings.mapHit]
            ];
            for (const [action, list] of maps) {
                for (const kw of String(list || "").split(/[,;|]/)) {
                    if (hasKeyword(labelRaw, normLabel(labelRaw), kw)) return action;
                }
            }

            // 2) Emojis seuls (alt/text) : la table par défaut les couvre déjà,
            //    ce filet attrape les variantes de main / pièce.
            if (/[💰💵💎🪙]/u.test(labelRaw)) return "DOUBLE";
            if (/[✋🖐🤚🛑🚫]/u.test(labelRaw)) return "STAND";
            if (/[👊👊🏻👊🏼👊🏽👊🏾👊🏿➕🗡⚔🃏]/u.test(labelRaw)) return "HIT";

            // 3) custom_id (bj_hit, blackjack:stand:123, action_double…).
            if (/(?:^|[:_\-\s])(double|dbl|x2)(?:$|[:_\-\s])/.test(idRaw)) return "DOUBLE";
            if (/(?:^|[:_\-\s])(stand|stay|rester|pass)(?:$|[:_\-\s])/.test(idRaw)) return "STAND";
            if (/(?:^|[:_\-\s])(hit|draw|tirer|pioche)(?:$|[:_\-\s])/.test(idRaw)) return "HIT";

            // 4) Texte normalisé, moins strict que les mots-clés configurés.
            if (/\b(double|dbl)\b/.test(norm)) return "DOUBLE";
            if (/\b(stand|stay|rester|stop|pass)\b/.test(norm)) return "STAND";
            if (/\b(hit|draw|tirer|pioche|card)\b/.test(norm)) return "HIT";
            return null;
        }

        const NOISE_BUTTON = /(reply|r[ée]pondre|add reaction|ajouter une r[ée]action|reaction|emoji|sticker|gif|more|plus|share|partager|edit|modifier|delete|supprimer|pin|épingler|thread|fil|report|signaler|download|t[ée]l[ée]charger|copy|copier|open in|ouvrir dans|forward|transf[ée]rer|mark unread|non lu|save|sauvegarder|bookmark|favori)/i;

        function collectCandidates(root, msg) {
            if (!root?.querySelectorAll) return { dom: [], comps: [], entries: [] };
            // Discord peut rendre la ligne de composants dans
            // #message-accessories-…, parfois en dehors du <li> message. On
            // interroge donc aussi ce conteneur, sinon l'auto-play voit la main
            // mais aucun bouton.
            const msgId = String(msg?.id || "");
            const channel = String(msg?.channel_id ?? msg?.channelId ?? "");
            const extra = msgId ? (document.getElementById(`message-accessories-${channel}-${msgId}`)
                || [...document.querySelectorAll('[id^="message-accessories-"]')].find(el => el.id.endsWith(`-${msgId}`))) : null;
            const roots = [root, extra].filter(r => r && r.querySelectorAll);
            const seen = new Set();
            const all = [];
            for (const r of roots) {
                for (const b of r.querySelectorAll("button, [role='button']")) {
                    if (seen.has(b)) continue;
                    seen.add(b);
                    if (!b.matches("button, [role='button']")) continue;
                    if (b.closest("#bl-panel") || b.closest("#bl-bj-badge")) continue;
                    if (b.matches("a[href]") || b.closest("a[href]")) continue;
                    if (b.getAttribute("role") === "button" && b.querySelector("button")) continue;
                    const rect = b.getBoundingClientRect();
                    if (rect.width < 4 || rect.height < 4) continue;
                    const alt = [...b.querySelectorAll("img[alt]")].map(i => i.alt).filter(Boolean).join(" ");
                    const name = [b.innerText, b.getAttribute("aria-label"), b.getAttribute("title"), alt]
                        .filter(Boolean).join(" ");
                    if (!name && !b.closest('[id^="message-accessories-"], [class*="component"], [class*="actionRow"]')) continue;
                    if (b.closest('[class*="hoverBar"], [class*="messageAction"], [class*="toolbar"]')) continue;
                    if (NOISE_BUTTON.test(name) && !/hit|stand|tirer|rester|double|doubler/i.test(name)) continue;
                    all.push(b);
                }
            }

            // Les composants du bot sont regroupés dans un conteneur accessoires.
            // On prend le plus grand groupe de boutons, mais on garde tous les
            // boutons du message en repli : Discord déplace parfois cette ligne.
            const scopes = roots.flatMap(r => [...r.querySelectorAll('[class*="accessories"], [class*="component"], [class*="buttons"], [class*="actionRow"]')]);
            let scopedCands = [];
            for (const scope of scopes) {
                const inside = all.filter(b => scope.contains(b));
                if (inside.length > scopedCands.length) scopedCands = inside;
            }
            // On ne garde le groupe « composants » que s'il contient vraiment
            // les boutons d'action. Sinon on revient à tous les boutons du
            // message, sinon une barre de survol vide masquait les vrais boutons.
            const ACTION_HINT = /hit|stand|tirer|rester|double|doubler|👊|✋|💰|🪙|🖐|🤚|🛑|🚫|➕|🗡|⚔|🃏|💵|💎/i;
            const looksLikeActions = scopedCands.some(b => ACTION_HINT.test([b.innerText, b.getAttribute("aria-label"), b.getAttribute("title")].filter(Boolean).join(" ")));
            const dom = (scopedCands.length === 3 || (scopedCands.length >= 2 && looksLikeActions)) ? scopedCands : all;

            const comps = (lab.embed.components(msg) || [])
                .filter(c => c.type === 2 || c.type === "2" || c.customId || c.url);
            const aligned = comps.length === dom.length;
            const normC = s => normLabel(s);
            const used = new Set();
            const entries = dom.map((btn, index) => {
                const alt = [...btn.querySelectorAll("img[alt]")].map(i => i.alt).filter(Boolean).join(" ");
                const label = (btn.innerText || btn.textContent || "").trim().replace(/\s+/g, " ");
                const aria = btn.getAttribute("aria-label") || "";
                const title = btn.getAttribute("title") || "";
                const dataId = btn.getAttribute("data-list-item-id") || "";
                const props = lab.discord?.reactProps?.(btn) || {};
                const propId = String(props.customId || props.custom_id || "");
                const visible = [label, aria, alt, title].filter(Boolean);
                let c = null;
                let byIndex = false;
                if (propId) c = comps.find((x, i) => !used.has(i) && String(x.customId || x.custom_id || "") === propId) || null;
                if (!c) {
                    c = comps.find((x, i) => {
                        if (used.has(i)) return false;
                        const l = normC(x.label || "");
                        return l && visible.some(v => normC(v) === l || normC(v).includes(l));
                    }) || null;
                }
                if (!c && aligned && !used.has(index)) { c = comps[index] || null; byIndex = Boolean(c); }
                if (c) used.add(comps.indexOf(c));
                return {
                    index,
                    btn,
                    label,
                    aria,
                    title,
                    alt,
                    dataId,
                    compLabel: c?.label || (typeof props.label === "string" ? props.label : "") || "",
                    customId: c?.customId || c?.custom_id || propId || "",
                    // Le disabled du composant n'est fiable que s'il est apparié
                    // par index/custom_id ; un mauvais alignement pouvait
                    // déclarer « Double » désactivé et fausser la stratégie.
                    disabled: Boolean(
                        btn.disabled
                        || btn.getAttribute("aria-disabled") === "true"
                        || (c && (byIndex || propId) && c.disabled)
                    )
                };
            });
            return { dom, comps, entries };
        }

        /**
         * Détecte les boutons d'action. Combine quatre signaux : texte visible,
         * aria-label/title, alt des emojis, custom_id du composant Discord. Si
         * les libellés sont inconnus (emojis seuls, français, changement du bot),
         * l'ordre standard des trois boutons sert de repli — c'est ce qui rend
         * l'autoplay utilisable même quand le bot change ses labels.
         */
        function actionButtons(root, msg) {
            const { entries, dom, comps } = collectCandidates(root, msg);
            const found = new Map();
            for (const c of entries) {
                const action = classifyButton(c);
                if (!action) continue;
                const prev = found.get(action);
                if (!prev || (prev.disabled && !c.disabled)) found.set(action, { ...c, action });
            }

            const missing = ["HIT", "STAND", "DOUBLE"].filter(a => !found.has(a));
            const ignored = new Set(entries
                .filter(c => settings.btnOverride?.[buttonKey(c)] === "IGNORE")
                .map(c => c.index));
            if (settings.positionFallback && (entries.length === 2 || entries.length === 3) && missing.length) {
                const order = String(settings.positionOrder || "HIT,STAND,DOUBLE")
                    .split(",").map(s => s.trim().toUpperCase());
                const used = new Set([...found.values()].map(v => v.index));
                const free = entries.filter(c => !used.has(c.index) && !ignored.has(c.index));
                order.forEach((action, i) => {
                    if (!["HIT", "STAND", "DOUBLE"].includes(action)) return;
                    if (found.has(action)) return;
                    const target = free.shift();
                    if (target) found.set(action, { ...target, action, byPosition: true });
                });
            }
            return { map: found, entries, dom, comps };
        }

        function rootSignature(root) {
            if (!root?.isConnected) return "disconnected";
            const text = (root.innerText || root.textContent || "").replace(/\s+/g, " ").slice(0, 240);
            const disabled = root.querySelectorAll('button[disabled], [aria-disabled="true"]').length;
            return `${text}|${root.querySelectorAll("button").length}|${disabled}`;
        }

        function logClick(line) {
            state.clickLog.unshift(`${new Date().toLocaleTimeString()} · ${line}`);
            state.clickLog = state.clickLog.slice(0, 40);
        }

        /**
         * Plusieurs stratégies, dans l'ordre, sans jamais cliquer deux fois avec
         * la même : le clic natif, puis les événements pointeur, puis le handler
         * React. On vérifie le DOM entre chaque pour éviter un double tirage.
         */
        async function press(btn, opts = {}) {
            if (!btn || !btn.isConnected) return { ok: false, reason: "bouton déconnecté" };
            if (btn.disabled || btn.getAttribute("aria-disabled") === "true") return { ok: false, reason: "bouton désactivé" };
            const root = opts.root?.isConnected ? opts.root : btn.closest('[id^="chat-messages-"]');
            const before = rootSignature(root);
            try { btn.scrollIntoView({ block: "nearest", inline: "nearest" }); } catch (_) { /* ignore */ }
            try { btn.focus({ preventScroll: true }); } catch (_) { /* ignore */ }

            const wait = ms => new Promise(r => setTimeout(r, ms));
            const changed = () => rootSignature(root) !== before || !btn.isConnected;
            // Le bot met souvent 0,5 à 1,5 s à répondre. Attendre trop peu ici
            // déclenchait un deuxième clic (double tirage) avant la mise à jour.
            const waitChange = async timeout => {
                const end = Date.now() + timeout;
                do {
                    if (changed()) return true;
                    await wait(120);
                } while (Date.now() < end);
                return changed();
            };

            try { btn.click(); } catch (_) { /* ignore */ }
            if (await waitChange(2200)) return { ok: true, strategy: "click" };

            if (settings.reliableClick) {
                // Certains composants écoutent pointerdown/up et ignorent click().
                if (btn.isConnected && root?.isConnected) lab.discord?.pointerPress?.(btn);
                if (await waitChange(900)) return { ok: true, strategy: "pointer" };

                if (btn.isConnected) {
                    const props = lab.discord?.reactProps?.(btn);
                    if (typeof props?.onClick === "function") {
                        try {
                            props.onClick({
                                type: "click", button: 0, buttons: 1, bubbles: true, cancelable: true,
                                preventDefault() {}, stopPropagation() {}, persist() {}, nativeEvent: { button: 0 }
                            });
                        } catch (_) { /* ignore */ }
                        if (await waitChange(900)) return { ok: true, strategy: "react" };
                    }
                }
            }
            return { ok: false, reason: "aucun changement du message" };
        }

        /* -------------------------------------------------------------- */
        /* Détection de « ma » main                                        */
        /* -------------------------------------------------------------- */

        function myNames() {
            const names = new Set();
            if (settings.myName) settings.myName.split(",").forEach(n => names.add(n.trim().toLowerCase()));
            const u = lab.discord.currentUser();
            for (const v of [u?.username, u?.globalName, u?.global_name]) if (v) names.add(String(v).toLowerCase());
            return [...names].filter(Boolean);
        }

        function isMine(msg, text) {
            if (!settings.onlyMine) return true;
            const me = lab.discord.currentUser();
            const iu = msg?.interaction?.user || msg?.interactionMetadata?.user;
            if (iu?.id && me?.id) return String(iu.id) === String(me.id);
            if (me?.id && (msg?.mentions || []).some(u => String(u?.id) === String(me.id))) return true;
            if (me?.id && String(msg?.content || "").includes(`<@${me.id}>`)) return true;
            const t = text.toLowerCase();
            const names = myNames();
            if (names.some(n => t.includes(n))) return true;
            // Si on connaît le pseudo et qu'il n'apparaît pas, c'est la main d'un
            // autre joueur : ne jamais la jouer. Le repli « You » ne sert que
            // lorsque Discord ne fournit aucun nom (mode anonyme).
            if (names.length) return false;
            return /\b(?:you|your hand|your total|your cards|votre main|votre total|ta main)\b/i.test(text);
        }

        /* -------------------------------------------------------------- */
        /* Analyse d'un message                                            */
        /* -------------------------------------------------------------- */

        function resultOf(text) {
            const t = String(text || "").toLowerCase();
            // Le noyau partage le classifieur le plus large avec les autres
            // jeux. On le consulte d'abord pour couvrir les variantes du bot,
            // puis on garde les motifs locaux comme filet de sécurité.
            try {
                const detected = lab.analyze?.text?.(text);
                if (detected?.game === "blackjack" && ["win", "loss", "push"].includes(detected.label)) {
                    return detected.label;
                }
            } catch (_) { /* motifs locaux ci-dessous */ }
            // « your bet back » / « push » / « égalité » = retour de mise. Ce
            // signal doit rester prioritaire, même si le titre contient
            // « Blackjack » ou « win ».
            const push = /your bet back|\bpush\b|tie|mise rendue|bet (?:is )?returned|rembours|match nul|[ée]galit[ée]|it'?s a draw|égalité/.test(t);
            const win = /you (?:win|won)|you got (?:a )?blackjack|dealer bust|dealer busts|dealer is busted|croupier (?:bust|saute|perd)|you beat the dealer|player wins?|house loses?|\bgagn(?:e|é|ée|ent)\b|victoire|bravo/.test(t);
            const loss = /dealer wins?|dealer has blackjack|croupier (?:gagne|a gagné)|house wins?|you bust|you busted|tu bust|you (?:lose|lost)|\b(?:loss|lost|defeat|défaite|perdu)\b/.test(t);
            if (push) return "push";
            if (win && !loss) return "win";
            if (loss && !win) return "loss";
            return null;
        }

        function registerResult(label, amount, msgId, text = "") {
            if (!label) return;
            const readBet = Number(lab.analyze.betAmount?.(text));
            // La mise du message peut rester celle d'origine après un double.
            // La valeur suivie localement est donc prioritaire dès qu'une main
            // a été envoyée par l'autoplay.
            if (state.handBet > 0) amount = state.handBet;
            else if (Number.isFinite(readBet) && readBet > 0) amount = readBet;
            if (msgId) {
                if (state.resultIds.has(msgId)) return;
                state.resultIds.add(msgId);
                if (state.resultIds.size > 2000) state.resultIds.clear();
            }
            const s = state.session;
            if (!s.start) s.start = Date.now();
            s.hands++;
            let net = 0;
            if (label === "win") {
                s.wins++;
                // Un blackjack naturel paie 3:2 ; sinon 1:1 sur la mise.
                const natural = /you (?:got|have) (?:a )?blackjack|blackjack!/i.test(text) && !/dealer has blackjack/i.test(text);
                net = natural ? amount * 1.5 : amount;
                s.net += net;
            } else if (label === "loss") {
                s.losses++;
                net = -amount;
                s.net += net;
            } else {
                s.pushes++;
            }
            state.lastResult = { label, net, at: Date.now() };
            state.handBet = 0;
            lab.emit("blackjack:result", { label, amount, net, session: { ...s } });
            if (settings.stopLoss && s.net <= -Math.abs(settings.stopLoss)) stop("stop-loss atteint");
            if (settings.stopWin && s.net >= Math.abs(settings.stopWin)) stop("objectif atteint");
            if (settings.maxHands && s.hands >= settings.maxHands) stop("nombre de mains atteint");
            // Le sabot est mélangé après la pénétration configurée.
            if (penetration() >= settings.penetration) shoeReset("pénétration atteinte");
        }

        function analyseMessage(msg, root) {
            // Les cartes peuvent être des images sans texte : on ajoute les alt
            // des emojis/cartes du message avant le parsing.
            const imgAlts = root?.querySelectorAll
                ? [...root.querySelectorAll("img[alt]")].map(img => img.alt).filter(Boolean).join(" ")
                : "";
            const text = `${lab.embed.messageText(msg)} ${imgAlts}`.replace(/\s+/g, " ");
            if (!/blackjack|dealer|croupier|your hand|votre main|hit|stand|tirer|rester|doubler/i.test(text)) return null;
            if (msg.author && msg.author.bot === false) return null;
            if (!isMine(msg, text)) return null;

            const detected = actionButtons(root, msg);
            const buttons = detected.map;
            state.lastCands = detected.entries;
            state.lastComps = detected.comps;
            state.lastMap = buttons;
            const hasAction = [...buttons.values()].some(b => !b.disabled);
            const prompt = /\bhit\b.*\bstand\b|\bstand\b.*\bdouble\b|tirer.*rester/i.test(text);
            if (!hasAction && !prompt) return null;

            const { dealer, player } = parseTable(text);
            if (!dealer || !player || !dealer.total || !player.total) return null;
            if (player.total >= 21) return null;

            // Le comptage doit inclure les cartes de la main courante avant de
            // calculer le true count utilisé par les déviations.
            syncTable(player.cards, dealer.cards);
            // La carte visible du croupier est la première carte NON cachée. Si
            // le parseur n'a lu que le total, on l'utilise comme valeur.
            const visible = (dealer.cards || []).find(c => c && c.rank && c.value);
            const up = visible?.value || (dealer.total >= 2 && dealer.total <= 11 ? dealer.total : 10);
            const canDouble = buttons.size ? Boolean(buttons.get("DOUBLE") && !buttons.get("DOUBLE").disabled) : player.cards.length === 2;
            const choice = choose(player.cards, player.total, player.soft, up, canDouble, true);
            const tc = trueCount();

            // Si l'action conseillée n'existe pas dans cette mise en page, on
            // cherche une action disponible équivalente avant de renoncer.
            let action = choice.action;
            const usable = a => Boolean(buttons.get(a) && !buttons.get(a).disabled);
            if (action === "DOUBLE" && !usable("DOUBLE")) {
                action = basic(player.cards, player.total, player.soft, up, false);
            }
            // Ne jamais remplacer un STAND manquant par un HIT : cela ferait
            // tirer une main qui devait rester. Si l'action n'existe pas, le
            // panneau l'affiche et l'autoplay s'arrête proprement.

            return {
                msg, root, text, dealer, player, up, tc, canDouble,
                action, base: choice.action, deviated: choice.deviated && action === choice.action,
                buttons, entries: detected.entries,
                available: ["HIT", "STAND", "DOUBLE"].filter(x => usable(x))
            };
        }

        /* -------------------------------------------------------------- */
        /* Affichage dans le message                                       */
        /* -------------------------------------------------------------- */

        const LABELS = { HIT: "TIRER", STAND: "RESTER", DOUBLE: "DOUBLER" };
        const ACTION_COLORS = { HIT: "#5865f2", STAND: "#248046", DOUBLE: "#c27c0e" };

        let badgeEl = null;
        let badgeRaf = 0;
        let badgeUntil = 0;

        function showBadge(a) {
            if (!settings.badge || !a.root?.isConnected || !document.body) return;
            if (!badgeEl || !badgeEl.isConnected) {
                badgeEl = h("div", { id: "bl-bj-badge" });
                document.body.appendChild(badgeEl);
            }
            badgeEl.style.background = ACTION_COLORS[a.action] || "#5865f2";
            badgeEl.textContent = `${LABELS[a.action]} · ${a.player.total}${a.player.soft ? " souple" : ""} vs ${a.up === 11 ? "As" : a.up}`;
            badgeEl.title = `${a.deviated ? "Déviation" : "Stratégie de base"} · TC ${a.tc.toFixed(1)}`;
            badgeEl.style.display = "block";
            badgeUntil = Date.now() + 15000;
            cancelAnimationFrame(badgeRaf);
            const tick = () => {
                if (!badgeEl || !a.root.isConnected || Date.now() > badgeUntil) {
                    if (badgeEl) badgeEl.style.display = "none";
                    return;
                }
                const r = a.root.getBoundingClientRect();
                if (r.bottom < 0 || r.top > window.innerHeight) {
                    badgeEl.style.display = "none";
                } else {
                    badgeEl.style.display = "block";
                    const left = Math.max(8, Math.min(window.innerWidth - 200, r.right + 8));
                    const top = Math.max(8, Math.min(window.innerHeight - 44, r.top + 8));
                    badgeEl.style.left = `${left}px`;
                    badgeEl.style.top = `${top}px`;
                }
                badgeRaf = requestAnimationFrame(tick);
            };
            tick();
        }

        function annotate(a) {
            if (!a.root) return;
            for (const el of document.querySelectorAll(".bl-hl")) el.classList.remove("bl-hl");
            const target = a.buttons.get(a.action);
            if (target && !target.disabled) target.btn.classList.add("bl-hl");
            if (settings.showInline) showBadge(a);
        }

        async function clickNow(a) {
            if (!settings.autoPlay || !a.root?.isConnected) return { ok: false, reason: "racine absente" };
            const live = actionButtons(a.root, a.msg).map.get(a.action);
            if (!live || live.disabled) return { ok: false, reason: `bouton ${a.action} ${live ? "désactivé" : "absent"}` };
            state.lastPress = { action: a.action, label: live.label, customId: live.customId, at: Date.now() };
            const res = await press(live.btn, { root: a.root, msg: a.msg });
            if (res.ok) {
                if (a.action === "DOUBLE") {
                    state.handBet = Math.max(1, Number(settings.amount) || 10) * 2;
                }
                state.clickSuccesses++;
                logClick(`${a.action} via ${res.strategy} (${live.label || live.customId || "?"})`);
            } else {
                state.clickMisses++;
                logClick(`${a.action} échec : ${res.reason}`);
            }
            return res;
        }

        async function autoClick(a) {
            if (!settings.autoPlay || state.clickInFlight) return;
            const hand = a.player.cards.map(c => c.rank + c.suit).join(",");
            const key = `${a.msg.id}|${a.action}|${a.player.total}|${hand}|${a.up}`;
            // Verrou court : évite deux clics pendant que le DOM se met à jour.
            if (key === state.lastActionKey && Date.now() - state.lastActionAt < 2400) return;
            if (key !== state.clickAttemptKey) {
                state.clickAttemptKey = key;
                state.clickAttempts = 0;
            }
            const maxTries = Math.max(1, Math.min(3, Number(settings.clickStrategies) || 2));
            if (state.clickAttempts >= maxTries) return;
            state.clickAttempts++;
            state.lastActionKey = key;
            state.lastActionAt = Date.now();
            state.clickInFlight = true;
            const seq = ++state.pressSeq;

            const release = () => { state.clickInFlight = false; };
            // Filet de sécurité : un clic bloqué ne doit jamais geler l'autoplay.
            const safety = setTimeout(release, 14000);

            const attempt = async n => {
                if (!settings.autoPlay || seq !== state.pressSeq) { clearTimeout(safety); release(); return; }
                if (state.current?.msg?.id !== a.msg.id) { clearTimeout(safety); release(); return; }
                // L'action conseillée peut avoir changé après un premier clic :
                // on ne rejoue que si le bouton est toujours le bon.
                const live = actionButtons(a.root, a.msg).map.get(a.action);
                if (!live || live.disabled) { clearTimeout(safety); release(); return; }
                const res = await clickNow({ ...a, action: a.action });
                if (res.ok) {
                    state.clickAttempts = 0;
                    clearTimeout(safety);
                    release();
                    return;
                }
                if (n + 1 < maxTries) {
                    // Une seule nouvelle tentative, espacée : le bot a peut-être
                    // simplement mis plus de temps que la stratégie précédente.
                    setTimeout(() => attempt(n + 1), 1600);
                } else {
                    state.lastActionAt = 0; // autorise un nouvel essai au prochain scan
                    state.clickFailedAt = Date.now();
                    state.clickError = `${a.action} non cliqué : ${res.reason}`;
                    lab.log("blackjack", state.clickError, a.entries.map(e => `${e.label || "?"}[${e.customId || e.index}]`).join(" | "));
                    clearTimeout(safety);
                    release();
                    lab.ui.refresh("bj");
                }
            };
            setTimeout(() => attempt(0), Math.max(250, Number(settings.clickDelayMs) || 900));
        }

        /* -------------------------------------------------------------- */
        /* Boucle d'envoi                                                  */
        /* -------------------------------------------------------------- */

        function stop(reason) {
            if (state.run.timer) clearInterval(state.run.timer);
            state.run.timer = null;
            state.run.active = false;
            if (reason) toast(`Blackjack arrêté : ${reason}`, "warn");
            lab.ui.refresh("bj");
        }

        async function sendHand() {
            if (state.handOpen) return;
            const baseBet = Math.max(10, Number(settings.amount) || 10);
            const cmd = `/blackjack ${baseBet}`;
            try {
                const ok = await lab.discord.sendText(cmd);
                if (!ok) throw new Error("envoi refusé (éditeur occupé ?)");
                state.handBet = baseBet;
                state.run.sent++;
                state.run.lastSent = Date.now();
                state.run.fails = 0;
                state.awaitingUntil = Date.now() + 20000;
                state.run.lastError = "";
                lab.log("blackjack envoyé", cmd);
            } catch (e) {
                state.run.fails++;
                state.run.lastError = e.message;
                // Backoff exponentiel borné : évite de marteler l'éditeur Discord
                // quand la fenêtre de saisie est occupée par une autre commande.
                const wait = Math.min(45000, 4000 * (2 ** Math.min(3, state.run.fails)));
                state.awaitingUntil = Date.now() + wait;
                toast(`Blackjack : ${e.message} (nouvel essai dans ${Math.round(wait / 1000)} s)`, "error");
            }
            lab.ui.refresh("bj");
        }

        function start() {
            if (state.run.active) return;
            if (!settings.autoPlay) {
                toast("Active d'abord « Jeu automatique »", "warn");
                return;
            }
            if (settings.maxHands && state.session.hands >= settings.maxHands) {
                state.session.hands = 0;
                state.session.net = 0;
                state.session.start = Date.now();
            }
            state.run.active = true;
            state.run.fails = 0;
            state.run.timer = setInterval(() => {
                if (!state.run.active) return;
                if (state.handOpen) return;
                if (Date.now() < state.awaitingUntil) return;
                sendHand();
            }, Math.max(5, settings.intervalSec) * 1000);
            toast(`Blackjack auto : ${settings.amount} / main, toutes les ${settings.intervalSec} s`, "success");
            sendHand();
            lab.ui.refresh("bj");
        }

        /* -------------------------------------------------------------- */
        /* Onglet                                                          */
        /* -------------------------------------------------------------- */

        let countEl = null;
        let resultEl = null;

        function render() {
            const wrap = h("div");
            const tc = trueCount();
            const s = state.session;
            const netCls = s.net > 0 ? "bl-good" : s.net < 0 ? "bl-bad" : "";

            countEl = h("div", { class: "bl-muted", text: "" });
            resultEl = h("div");

            const field = (label, key, opts = {}) => {
                const input = h("input", {
                    class: "bl-input",
                    type: opts.type || "number",
                    value: settings[key],
                    min: opts.min,
                    max: opts.max,
                    step: opts.step
                });
                input.addEventListener("change", () => {
                    settings[key] = opts.type === "text" ? input.value : Number(input.value) || 0;
                    save();
                    if (key === "decks") shoeReset("changement du nombre de jeux");
                    countEl.textContent = `Shoe ${settings.decks} jeux · TC ${trueCount().toFixed(2)}`;
                });
                return h("label", { class: "bl-col" }, h("span", { class: "bl-label", text: label }), input);
            };

            const toggle = (label, key) => {
                const cb = h("input", { type: "checkbox" });
                cb.checked = Boolean(settings[key]);
                cb.addEventListener("change", () => { settings[key] = cb.checked; save(); });
                return h("label", { class: "bl-row" }, cb, h("span", { text: label }));
            };

            const startBtn = h("button", {
                class: "bl-btn " + (state.run.active ? "bl-danger" : ""),
                text: state.run.active ? "Arrêter" : "Démarrer",
                onclick: () => state.run.active ? stop() : start()
            });

            function detectionTable() {
                const box = h("div");
                const map = state.lastMap || new Map();
                const summary = h("div", { class: "bl-row" });
                for (const action of ["HIT", "STAND", "DOUBLE"]) {
                    const hit = map.get(action);
                    summary.appendChild(h("span", {
                        class: "bl-badge " + (hit && !hit.disabled ? "bl-badge-good" : "bl-badge-warn"),
                        text: `${LABELS[action]} → ${hit ? (hit.label || hit.customId || "?" ) + (hit.byPosition ? " (position)" : "") : "absent"}`
                    }));
                }
                box.appendChild(summary);
                if (!state.lastCands.length) {
                    box.appendChild(h("div", { class: "bl-muted", text: "Aucun bouton détecté pour l'instant. Ouvre une main, puis clique sur Rescanner. Si le bot utilise des images pures, active le repli par position." }));
                    return box;
                }
                const table = h("table", { class: "bl-table" },
                    h("thead", null, h("tr", null,
                        h("th", { text: "#" }), h("th", { text: "Libellé" }),
                        h("th", { text: "custom_id" }), h("th", { text: "Forcer" })
                    ))
                );
                const body = h("tbody");
                for (const c of state.lastCands) {
                    const key = buttonKey(c);
                    const sel = h("select", { class: "bl-select", style: { width: "88px", padding: "2px 4px", fontSize: "10px" } });
                    for (const [v, t] of [["", "Auto"], ["HIT", "Tirer"], ["STAND", "Rester"], ["DOUBLE", "Doubler"], ["IGNORE", "Ignorer"]]) {
                        sel.appendChild(h("option", { value: v, text: t }));
                    }
                    sel.value = settings.btnOverride[key] || "";
                    sel.addEventListener("change", () => {
                        if (sel.value) settings.btnOverride[key] = sel.value;
                        else delete settings.btnOverride[key];
                        save();
                        lab.ui.refresh("bj");
                    });
                    body.appendChild(h("tr", null,
                        h("td", { text: String(c.index) }),
                        h("td", null,
                            h("div", { text: c.label || c.compLabel || "—" }),
                            c.disabled ? h("span", { class: "bl-badge bl-badge-warn", text: "off" }) : null
                        ),
                        h("td", { class: "bl-muted", text: (c.customId || "—").slice(0, 22) }),
                        h("td", null, sel)
                    ));
                }
                table.appendChild(body);
                box.appendChild(table);
                if (settings.debugButtons) {
                    box.appendChild(h("div", { class: "bl-code", text: JSON.stringify(state.lastCands.map(c => ({
                        i: c.index, label: c.label, aria: c.aria, alt: c.alt, id: c.customId, off: c.disabled
                    })), null, 2) }));
                }
                return box;
            }

            wrap.append(
                h("div", { class: "bl-card" },
                    h("b", { text: "Session" }),
                    h("div", { class: "bl-kv" }, h("span", { text: "Mains" }), h("b", { text: s.hands })),
                    h("div", { class: "bl-kv" }, h("span", { text: "G / P / push" }), h("b", { text: `${s.wins} / ${s.losses} / ${s.pushes}` })),
                    h("div", { class: "bl-kv" }, h("span", { text: "Net (unités)" }), h("b", { class: netCls, text: (s.net > 0 ? "+" : "") + s.net })),
                    h("div", { class: "bl-kv" }, h("span", { text: "Taux de gain" }), h("b", { text: s.wins + s.losses ? `${((s.wins / (s.wins + s.losses)) * 100).toFixed(1)} %` : "—" })),
                    h("div", { class: "bl-kv" }, h("span", { text: "Dernier résultat" }), h("b", { text: state.lastResult ? `${state.lastResult.label} · ${state.lastResult.net >= 0 ? "+" : ""}${state.lastResult.net}` : "en attente" }))
                ),
                h("div", { class: "bl-card" },
                    h("b", { text: "Comptage Hi-Lo" }),
                    h("div", { class: "bl-row" }, field("Jeux dans le sabot", "decks", { min: 1, max: 8 }), field("Pénétration (0–1)", "penetration", { min: 0.5, max: 1, step: 0.05 })),
                    countEl,
                    h("div", { class: "bl-kv" }, h("span", { text: "Running count" }), h("b", { text: (state.shoe.rc >= 0 ? "+" : "") + state.shoe.rc })),
                    h("div", { class: "bl-kv" }, h("span", { text: "True count" }), h("b", { class: tc >= 0 ? "bl-good" : "bl-bad", text: (tc >= 0 ? "+" : "") + tc.toFixed(2) })),
                    h("div", { class: "bl-kv" }, h("span", { text: "Cartes vues" }), h("b", { text: `${state.shoe.seen} / ${state.shoe.size} (${Math.round(penetration() * 100)} %)` })),
                    h("div", { class: "bl-kv" }, h("span", { text: "Sabot" }), h("b", { text: `${settings.decks} jeux` })),
                    h("div", { class: "bl-row" },
                        h("button", {
                            class: "bl-btn bl-sec", text: "Nouveau sabot",
                            onclick: () => { shoeReset("manuel"); lab.ui.refresh("bj"); }
                        }),
                        h("span", { class: "bl-muted", text: "à utiliser si le bot mélange sans le dire" })
                    )
                ),
                h("div", { class: "bl-card" },
                    h("b", { text: "Automatisation" }),
                    h("div", { class: "bl-row" }, field("Mise", "amount", { min: 1 }), field("Intervalle (s)", "intervalSec", { min: 5 })),
                    h("div", { class: "bl-row" }, field("Mains max (0 = ∞)", "maxHands", { min: 0 }), field("Stop-loss (0 = off)", "stopLoss", { min: 0 })),
                    h("div", { class: "bl-row" }, field("Objectif (0 = off)", "stopWin", { min: 0 }), field("Délai clic (ms)", "clickDelayMs", { min: 200 })),
                    toggle("Jeu automatique (clique l'action conseillée)", "autoPlay"),
                    toggle("Clic fiable (natif → pointeur → React)", "reliableClick"),
                    toggle("N'annoter que mes mains", "onlyMine"),
                    toggle("Afficher le badge de conseil", "showInline"),
                    field("Mon pseudo (si détection auto insuffisante)", "myName", { type: "text" }),
                    h("div", { class: "bl-row" },
                        startBtn,
                        h("button", { class: "bl-btn bl-sec", text: "Une main", onclick: () => sendHand() }),
                        h("button", {
                            class: "bl-btn bl-sec", text: "Débloquer",
                            onclick: () => {
                                state.handOpen = false;
                                state.awaitingUntil = Date.now();
                                state.lastActionAt = 0;
                                toast("Verrou de main libéré", "info");
                                lab.ui.refresh("bj");
                            }
                        }),
                        h("button", {
                            class: "bl-btn bl-sec", text: "Reset session",
                            onclick: () => {
                                state.session = { hands: 0, wins: 0, losses: 0, pushes: 0, net: 0, start: 0 };
                                state.resultIds.clear();
                                lab.ui.refresh("bj");
                            }
                        })
                    ),
                    state.run.lastError ? h("div", { class: "bl-bad", text: state.run.lastError }) : null,
                    h("div", { class: "bl-muted", text: `${state.run.sent} mains envoyées · ${state.clickSuccesses} clics OK · ${state.clickMisses} échecs · l'envoi attend la fin de la main.` })
                    ,h("div", { class: "bl-row" },
                        h("button", {
                            class: "bl-btn", text: "Forcer l'action conseillée",
                            onclick: async () => {
                                const a = state.current;
                                if (!a) { toast("Aucune main détectée", "warn"); return; }
                                const live = actionButtons(a.root, a.msg).map.get(a.action);
                                if (!live) { toast(`Bouton ${a.action} introuvable`, "warn"); return; }
                                const r = await press(live.btn, { root: a.root, msg: a.msg });
                                if (r.ok) { toast(`${a.action} cliqué (${r.strategy})`, "success"); lab.ui.refresh("bj"); }
                                else toast(`Échec : ${r.reason}`, "error");
                            }
                        }),
                        h("button", {
                            class: "bl-btn bl-sec", text: "Test clic STAND",
                            onclick: async () => {
                                const a = state.current;
                                const live = a && actionButtons(a.root, a.msg).map.get("STAND");
                                if (!live) { toast("Bouton STAND introuvable", "warn"); return; }
                                const r = await press(live.btn, { root: a.root });
                                toast(r.ok ? "STAND cliqué" : "Échec : " + r.reason, r.ok ? "success" : "error");
                            }
                        })
                    )
                ),
                h("div", { class: "bl-card" },
                    h("b", { text: "Boutons & calibration" }),
                    h("div", { class: "bl-muted", text: "L'autoplay combine le texte, l'aria-label, l'alt des emojis et le custom_id. Si le bot change ses libellés, le repli par position prend le relais. Tu peux forcer chaque bouton ci-dessous." }),
                    toggle("Repli par position si 3 boutons", "positionFallback"),
                    toggle("Réessayer le clic si le message ne change pas", "retryClick"),
                    toggle("Journaliser la détection des boutons", "debugButtons"),
                    h("div", { class: "bl-row" },
                        field("Mots-clés TIRER", "mapHit", { type: "text" }),
                        field("Mots-clés RESTER", "mapStand", { type: "text" })
                    ),
                    h("div", { class: "bl-row" },
                        field("Mots-clés DOUBLER", "mapDouble", { type: "text" }),
                        field("Ordre (2–3 boutons)", "positionOrder", { type: "text" })
                    ),
                    h("div", { class: "bl-row" },
                        h("button", { class: "bl-btn bl-sec", text: "Rescanner", onclick: () => { lab.rescan(true); toast("Analyse relancée", "info"); } }),
                        h("button", {
                            class: "bl-btn bl-sec", text: "Effacer les overrides",
                            onclick: () => { settings.btnOverride = {}; save(); lab.ui.refresh("bj"); }
                        }),
                        h("button", {
                            class: "bl-btn bl-sec", text: "Exporter le diagnostic",
                            onclick: () => lab.export.download("blocky-bj-buttons.json", JSON.stringify({
                                detected: state.lastCands.map(c => ({
                                    index: c.index, label: c.label, aria: c.aria, alt: c.alt,
                                    customId: c.customId, disabled: c.disabled, key: buttonKey(c)
                                })),
                                components: state.lastComps,
                                overrides: settings.btnOverride,
                                recommendation: state.current?.action || null
                            }, null, 2))
                        })
                    ),
                    state.clickError ? h("div", { class: "bl-bad", text: state.clickError }) : null,
                    state.clickLog.length ? h("div", { class: "bl-code", text: state.clickLog.slice(0, 10).join("\n") }) : null,
                    detectionTable()
                ),
                h("div", { class: "bl-card" },
                    h("b", { text: "Dernière main" }),
                    resultEl
                )
            );
            updateLast();
            return wrap;
        }

        function updateLast() {
            if (!resultEl) return;
            const a = state.current;
            if (!a) {
                resultEl.textContent = "Aucune main analysée pour l'instant.";
                resultEl.className = "bl-muted";
                return;
            }
            resultEl.className = "";
            resultEl.textContent = "";
            resultEl.append(
                h("div", { class: "bl-kv" }, h("span", { text: "Joueur" }), h("b", { text: `${a.player.total}${a.player.soft ? " souple" : ""} (${a.player.cards.map(c => c.rank + c.suit).join(" ")})` })),
                h("div", { class: "bl-kv" }, h("span", { text: "Croupier" }), h("b", { text: `${a.up === 11 ? "As" : a.up}${a.dealer.hidden ? " + cachée" : ""}` })),
                h("div", { class: "bl-kv" }, h("span", { text: "Action" }), h("b", { text: LABELS[a.action] + (a.deviated ? " (déviation)" : "") })),
                h("div", { class: "bl-kv" }, h("span", { text: "Boutons dispo" }), h("b", { text: (a.available || []).join(" · ") || "aucun" })),
                h("div", { class: "bl-kv" }, h("span", { text: "True count" }), h("b", { text: a.tc.toFixed(2) })),
                state.lastPress ? h("div", { class: "bl-kv" }, h("span", { text: "Dernier clic" }), h("b", { text: `${state.lastPress.action} · ${state.lastPress.label || "?"}` })) : null
            );
        }

        lab.ui.tab({ id: "bj", title: "Blackjack", render });

        // Surface de test (harnais hors ligne) : ne modifie pas le comportement.
        W.__blockyBjTest = {
            settings, state, actionButtons, classifyButton, buttonKey,
            collectCandidates, parseTable, basic, choose, resultOf, analyseMessage, press
        };

        /* -------------------------------------------------------------- */
        /* Écoute                                                          */
        /* -------------------------------------------------------------- */

        function scanRoot(msg, root) {
            const text = lab.embed.messageText(msg);
            // Ne jamais rejouer une main ancienne après un rescan de l'historique.
            const sf = lab.snowflake(msg.id);
            if (sf && Date.now() - sf.ts > 5 * 60 * 1000) return;
            // Ignore les messages d'autres joueurs : ils ne doivent ni compter les cartes
            // ni armer une main, ni fausser les statistiques de session.
            if (msg.author && msg.author.bot === false) return;
            if (!isMine(msg, text)) return;
            const res = resultOf(text);
            if (res && (state.handOpen || /blackjack|dealer|croupier/i.test(text))) {
                registerResult(res, Number(settings.amount) || 0, msg.id, text);
                if (state.handOpen) {
                    state.handOpen = false;
                    state.awaitingUntil = Date.now() + 1500;
                }
                lab.ui.refresh("bj");
                return; // un message de résultat n'est pas une main à jouer
            }
            if (/\bshuffl|m[ée]lang|nouveau sabot|new shoe\b/i.test(text)) shoeReset("message");

            const a = analyseMessage(msg, root);
            if (!a) return;

            state.current = a;
            state.handOpen = true;
            state.awaitingUntil = 0;
            state.clickError = "";
            annotate(a);
            autoClick(a);
            lab.ui.refresh("bj");
        }

        lab.watch((msg, root) => {
            try { scanRoot(msg, root); } catch (e) { lab.log("blackjack scan", e.message); }
        });

        // Filet de sécurité indépendant des mutations DOM : certaines mises à
        // jour React ne déclenchent aucun observer exploitable. Toutes les
        // 1,5 s, on réanalyse la main visible et on reclique l'action si elle
        // est toujours disponible (sans jamais cliquer deux fois de suite).
        setInterval(() => {
            if (!settings.autoPlay || !state.handOpen || state.clickInFlight) return;
            if (Date.now() - state.lastActionAt < 2600) return;
            const a = state.current;
            if (!a?.msg?.id) return;
            if (state.clickAttempts >= Math.max(1, Math.min(3, Number(settings.clickStrategies) || 2))) {
                if (!state.clickFailedAt || Date.now() - state.clickFailedAt < 9000) return;
                state.clickAttempts = 0;
                state.clickFailedAt = 0;
            }
            try {
                let root = a.root?.isConnected ? a.root : lab.discord.messageRoot?.(a.msg.id, a.msg.channel_id);
                if (!root) return;
                const liveMsg = lab.discord.fiberMessage?.(root) || a.msg;
                const fresh = analyseMessage(liveMsg, root);
                if (!fresh) return;
                state.current = fresh;
                annotate(fresh);
                autoClick(fresh);
            } catch (e) { lab.log("blackjack watchdog", e.message); }
        }, 1500);

        setInterval(() => {
            if (state.handOpen && Date.now() - state.lastActionAt > 45000) {
                state.handOpen = false;
                state.awaitingUntil = Date.now();
            }
        }, 5000);

        console.info("[BlockyLab] blackjack prêt");
    }

    boot();
})();
