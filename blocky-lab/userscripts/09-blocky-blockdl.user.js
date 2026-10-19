// ==UserScript==
// @name         Blocky Lab · 09 · BlockDL
// @namespace    blocky-lab
// @version      1.1.0
// @description  Solveur BlockDL : lit les indices du bloc du jour, estime les probabilités, recommande le pari qui élimine le plus de blocs et joue automatiquement en attendant chaque réponse.
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

    /*
     * Base locale volontairement compacte mais sufficiente pour éliminer vite.
     * c = couleur dominante, t = outil, h = dureté, g = gravité,
     * tr = transparent, r = renouvelable, l = lumière, b = blast resistance,
     * m = matériau, d = dimension.
     */
    const BLOCKS = [
        ["Stone", "stone", "gray", "pickaxe", 1.5, false, false, false, 0, 6, "stone", "overworld"],
        ["Cobblestone", "cobblestone", "gray", "pickaxe", 2, false, false, false, 0, 6, "stone", "overworld"],
        ["Deepslate", "deepslate", "gray", "pickaxe", 3, false, false, false, 0, 6, "stone", "overworld"],
        ["Granite", "granite", "pink", "pickaxe", 1.5, false, false, false, 0, 6, "stone", "overworld"],
        ["Diorite", "diorite", "white", "pickaxe", 1.5, false, false, false, 0, 6, "stone", "overworld"],
        ["Andesite", "andesite", "gray", "pickaxe", 1.5, false, false, false, 0, 6, "stone", "overworld"],
        ["Tuff", "tuff", "gray", "pickaxe", 1.5, false, false, false, 0, 6, "stone", "overworld"],
        ["Calcite", "calcite", "white", "pickaxe", 0.75, false, false, false, 0, 0.75, "stone", "overworld"],
        ["Dripstone Block", "dripstone", "brown", "pickaxe", 1.5, false, false, false, 0, 1, "stone", "overworld"],
        ["Dirt", "dirt", "brown", "shovel", 0.5, false, false, false, 0, 0.5, "earth", "overworld"],
        ["Grass Block", "grass", "green", "shovel", 0.6, false, false, false, 0, 0.6, "earth", "overworld"],
        ["Mud", "mud", "brown", "shovel", 0.5, false, false, false, 0, 0.5, "earth", "overworld"],
        ["Sand", "sand", "yellow", "shovel", 0.5, true, false, false, 0, 0.5, "earth", "overworld"],
        ["Gravel", "gravel", "gray", "shovel", 0.6, true, false, false, 0, 0.6, "earth", "overworld"],
        ["Clay", "clay", "gray", "shovel", 0.6, false, false, false, 0, 0.6, "earth", "overworld"],
        ["Sandstone", "sandstone", "yellow", "pickaxe", 0.8, false, false, false, 0, 0.8, "stone", "overworld"],
        ["Bedrock", "bedrock", "gray", "pickaxe", 99, false, false, false, 0, 3600000, "stone", "overworld"],
        ["Obsidian", "obsidian", "black", "pickaxe", 50, false, false, false, 0, 1200, "stone", "overworld"],
        ["Netherite Block", "netherite", "black", "pickaxe", 50, false, false, false, 0, 1200, "metal", "nether"],
        ["Ancient Debris", "debris", "brown", "pickaxe", 30, false, false, false, 0, 1200, "ore", "nether"],
        ["Coal Ore", "coal_ore", "black", "pickaxe", 3, false, false, false, 0, 3, "ore", "overworld"],
        ["Iron Ore", "iron_ore", "gray", "pickaxe", 3, false, false, false, 0, 3, "ore", "overworld"],
        ["Gold Ore", "gold_ore", "yellow", "pickaxe", 3, false, false, false, 0, 3, "ore", "overworld"],
        ["Diamond Ore", "diamond_ore", "blue", "pickaxe", 3, false, false, false, 0, 3, "ore", "overworld"],
        ["Emerald Ore", "emerald_ore", "green", "pickaxe", 3, false, false, false, 0, 3, "ore", "overworld"],
        ["Redstone Ore", "redstone_ore", "red", "pickaxe", 3, false, false, false, 0, 3, "ore", "overworld"],
        ["Lapis Ore", "lapis_ore", "blue", "pickaxe", 3, false, false, false, 0, 3, "ore", "overworld"],
        ["Copper Ore", "copper_ore", "orange", "pickaxe", 3, false, false, false, 0, 3, "ore", "overworld"],
        ["Nether Quartz Ore", "quartz_ore", "white", "pickaxe", 3, false, false, false, 0, 3, "ore", "nether"],
        ["Iron Block", "iron_block", "gray", "pickaxe", 5, false, false, false, 0, 6, "metal", "overworld"],
        ["Gold Block", "gold_block", "yellow", "pickaxe", 3, false, false, false, 0, 6, "metal", "overworld"],
        ["Diamond Block", "diamond_block", "blue", "pickaxe", 5, false, false, false, 0, 6, "metal", "overworld"],
        ["Emerald Block", "emerald_block", "green", "pickaxe", 5, false, false, false, 0, 6, "metal", "overworld"],
        ["Redstone Block", "redstone_block", "red", "pickaxe", 5, false, false, false, 0, 6, "metal", "overworld"],
        ["Lapis Block", "lapis_block", "blue", "pickaxe", 3, false, false, false, 0, 3, "stone", "overworld"],
        ["Copper Block", "copper_block", "orange", "pickaxe", 3, false, false, false, 0, 6, "metal", "overworld"],
        ["Amethyst Block", "amethyst", "purple", "pickaxe", 1.5, false, false, false, 0, 1.5, "crystal", "overworld"],
        ["Quartz Block", "quartz", "white", "pickaxe", 0.8, false, false, false, 0, 0.8, "stone", "nether"],
        ["Oak Log", "oak_log", "brown", "axe", 2, false, false, true, 0, 2, "wood", "overworld"],
        ["Birch Log", "birch_log", "white", "axe", 2, false, false, true, 0, 2, "wood", "overworld"],
        ["Spruce Log", "spruce_log", "brown", "axe", 2, false, false, true, 0, 2, "wood", "overworld"],
        ["Jungle Log", "jungle_log", "brown", "axe", 2, false, false, true, 0, 2, "wood", "overworld"],
        ["Acacia Log", "acacia_log", "orange", "axe", 2, false, false, true, 0, 2, "wood", "overworld"],
        ["Dark Oak Log", "dark_oak_log", "brown", "axe", 2, false, false, true, 0, 2, "wood", "overworld"],
        ["Oak Planks", "oak_planks", "brown", "axe", 2, false, false, true, 0, 3, "wood", "overworld"],
        ["Crafting Table", "crafting_table", "brown", "axe", 2.5, false, false, true, 0, 2.5, "wood", "overworld"],
        ["Chest", "chest", "brown", "axe", 2.5, false, false, true, 0, 2.5, "wood", "overworld"],
        ["Bookshelf", "bookshelf", "brown", "axe", 1.5, false, false, true, 0, 1.5, "wood", "overworld"],
        ["Glass", "glass", "white", "pickaxe", 0.3, false, true, false, 0, 0.3, "glass", "overworld"],
        ["Bricks", "bricks", "red", "pickaxe", 2, false, false, false, 0, 6, "stone", "overworld"],
        ["Stone Bricks", "stone_bricks", "gray", "pickaxe", 1.5, false, false, false, 0, 6, "stone", "overworld"],
        ["Mossy Cobblestone", "mossy_cobblestone", "gray", "pickaxe", 2, false, false, false, 0, 6, "stone", "overworld"],
        ["Snow Block", "snow", "white", "shovel", 0.1, false, false, false, 0, 0.1, "earth", "overworld"],
        ["Ice", "ice", "blue", "pickaxe", 0.5, false, true, false, 0, 0.5, "ice", "overworld"],
        ["Packed Ice", "packed_ice", "blue", "pickaxe", 0.5, false, false, false, 0, 0.5, "ice", "overworld"],
        ["Soul Sand", "soul_sand", "brown", "shovel", 0.5, false, false, false, 0, 0.5, "earth", "nether"],
        ["Netherrack", "netherrack", "red", "pickaxe", 0.4, false, false, false, 0, 0.4, "stone", "nether"],
        ["Nether Bricks", "nether_bricks", "red", "pickaxe", 2, false, false, false, 0, 6, "stone", "nether"],
        ["Glowstone", "glowstone", "yellow", "pickaxe", 0.3, false, false, false, 15, 0.3, "glass", "nether"],
        ["Sea Lantern", "sea_lantern", "white", "pickaxe", 0.3, false, true, false, 15, 0.3, "glass", "overworld"],
        ["Shroomlight", "shroomlight", "orange", "pickaxe", 1, false, false, true, 15, 1, "plant", "nether"],
        ["Magma Block", "magma", "orange", "pickaxe", 0.5, false, false, false, 3, 0.5, "stone", "nether"],
        ["Basalt", "basalt", "black", "pickaxe", 1.25, false, false, false, 0, 4.2, "stone", "nether"],
        ["Blackstone", "blackstone", "black", "pickaxe", 1.5, false, false, false, 0, 6, "stone", "nether"],
        ["End Stone", "end_stone", "yellow", "pickaxe", 3, false, false, false, 0, 9, "stone", "end"],
        ["Purpur Block", "purpur", "purple", "pickaxe", 1.5, false, false, false, 0, 6, "stone", "end"],
        ["Prismarine", "prismarine", "green", "pickaxe", 1.5, false, false, false, 0, 6, "stone", "overworld"],
        ["Sponge", "sponge", "yellow", "hoe", 0.6, false, false, false, 0, 0.6, "plant", "overworld"],
        ["Wool", "wool", "white", "shears", 0.8, false, false, true, 0, 0.8, "wool", "overworld"],
        ["Melon", "melon", "green", "axe", 1, false, false, true, 0, 1, "plant", "overworld"],
        ["Pumpkin", "pumpkin", "orange", "axe", 1, false, false, true, 0, 1, "plant", "overworld"],
        ["Hay Block", "hay", "yellow", "hoe", 0.5, false, false, true, 0, 0.5, "plant", "overworld"],
        ["Bamboo Block", "bamboo", "green", "axe", 1, false, false, true, 0, 1, "plant", "overworld"],
        ["Cactus", "cactus", "green", "axe", 0.4, false, false, true, 0, 0.4, "plant", "overworld"],
        ["Cobweb", "cobweb", "white", "shears", 4, false, true, true, 0, 4, "plant", "overworld"],
        ["TNT", "tnt", "red", "hoe", 0, false, false, true, 0, 0, "plant", "overworld"],
        ["Beacon", "beacon", "blue", "pickaxe", 3, false, true, false, 15, 3, "glass", "overworld"],
        ["Enchanting Table", "enchanting_table", "black", "pickaxe", 5, false, false, false, 7, 1200, "stone", "overworld"],
        ["Anvil", "anvil", "gray", "pickaxe", 5, true, false, false, 0, 1200, "metal", "overworld"],
        ["Sculk", "sculk", "black", "hoe", 0.2, false, false, true, 0, 0.2, "plant", "overworld"],
        ["Sculk Catalyst", "sculk_catalyst", "black", "hoe", 3, false, false, false, 6, 3, "plant", "overworld"],
        ["Moss Block", "moss", "green", "hoe", 0.1, false, false, true, 0, 0.1, "plant", "overworld"],
        ["Azalea Leaves", "azalea_leaves", "green", "shears", 0.2, false, true, true, 0, 0.2, "plant", "overworld"]
    ].map(row => ({
        name: row[0], alias: row[1], color: row[2], tool: row[3], hardness: row[4],
        gravity: row[5], transparent: row[6], renewable: row[7], light: row[8],
        blast: row[9], material: row[10], dimension: row[11]
    }));

    const COLORS = ["white", "gray", "black", "red", "orange", "yellow", "green", "blue", "purple", "pink", "brown"];
    const TOOLS = ["pickaxe", "axe", "shovel", "hoe", "shears", "hand", "none"];
    const DIMENSIONS = ["overworld", "nether", "end"];

    const hb = v => (v <= 0.3 ? "0" : v <= 0.75 ? "1" : v <= 1.5 ? "2" : v <= 2.5 ? "3" : v <= 5 ? "4" : "5");
    const bb = v => (v <= 0.5 ? "0" : v <= 2 ? "1" : v <= 6 ? "2" : v <= 50 ? "3" : "4");
    const lb = v => (v <= 0 ? "0" : v <= 7 ? "1" : v <= 14 ? "2" : "3");

    function vector(b) {
        return [b.color, b.tool, hb(b.hardness), bb(b.blast), lb(b.light), b.gravity, b.transparent, b.renewable, b.material, b.dimension].join("|");
    }

    function entropy(counts) {
        const total = counts.reduce((a, b) => a + b, 0);
        let H = 0;
        for (const n of counts) {
            if (!n) continue;
            const p = n / total;
            H -= p * Math.log2(p);
        }
        return H;
    }

    function parseTool(t) {
        if (/\bpickaxe\b|\bpioche\b/.test(t)) return "pickaxe";
        if (/\baxe\b|\bhache\b/.test(t)) return "axe";
        if (/\bshovel\b|\bpelle\b/.test(t)) return "shovel";
        if (/\bhoe\b|\bhoue\b/.test(t)) return "hoe";
        if (/\bshears\b|\bcisailles\b/.test(t)) return "shears";
        if (/\bhand\b|\bmain\b/.test(t)) return "hand";
        return null;
    }

    function parseFeedback(raw, prev = null) {
        const t = String(raw || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
        const clues = [];
        const add = (kind, value, op = "eq") => clues.push({ kind, value, op, raw: raw.slice(0, 80) });
        const negative = /\b(?:not|isn'?t|incorrect|wrong|perdu|failed|try again)\b/.test(t);
        if (!negative && /\bcorrect\b|\bfound\b|\bsolved\b|\bwell done\b|\bbravo\b|\bgagne\b|\btrouv[ée]\b/.test(t)) add("solved", true);
        if (negative || /\bnot the\b/.test(t)) add("solved", false);

        const colorClue = t.match(new RegExp(`\\b(?:color|couleur)\\s*[:=]?\\s*(${COLORS.join("|")})\\b`));
        if (colorClue) add("color", colorClue[1]);
        else if (COLORS.includes(t.trim())) add("color", t.trim());
        const dimClue = t.match(new RegExp(`\\b(?:dimension|monde|world)\\s*[:=]?\\s*(${DIMENSIONS.join("|")})\\b`));
        if (dimClue) add("dimension", dimClue[1]);
        else if (DIMENSIONS.includes(t.trim())) add("dimension", t.trim());

        const tool = parseTool(t);
        if (tool && /\b(?:tool|mine|harvest|requires?|with|pickaxe|axe|shovel|hoe|shears)\b/.test(t)) add("tool", tool);

        let m = t.match(/(?:hardness|durete|hard)\s*[:=]?\s*(\d+(?:[.,]\d+)?)/);
        if (m) add("hardness", Number(m[1].replace(",", ".")), /(?:less|lower|softer|moins)/.test(t) ? "lte" : /(?:more|higher|harder|plus)/.test(t) ? "gte" : "eq");
        m = t.match(/(?:blast|explosion|resistance)\s*[:=]?\s*(\d+(?:[.,]\d+)?)/);
        if (m) add("blast", Number(m[1].replace(",", ".")), /(?:less|lower|moins)/.test(t) ? "lte" : /(?:more|higher|plus)/.test(t) ? "gte" : "eq");
        m = t.match(/(?:light|light level|lumiere|niveau de lumiere)\s*[:=]?\s*(\d{1,2})/);
        if (m) add("light", Number(m[1]), /(?:less|lower|moins)/.test(t) ? "lte" : /(?:more|higher|plus)/.test(t) ? "gte" : "eq");

        if (/\b(?:gravity|falls?|tombe|chute)\b/.test(t)) add("gravity", !/\b(?:no|not|pas|sans)\s+(?:gravity|fall)/.test(t));
        if (/\b(?:transparent|see through|transparence)\b/.test(t)) add("transparent", !/\b(?:not|no|pas|opaque)\b/.test(t));
        if (/\b(?:renewable|renouvelable)\b/.test(t)) add("renewable", !/\b(?:not|no|pas|non)\b/.test(t));
        if (/\b(?:flammable|inflammable|burns?|brule)\b/.test(t)) add("flammable", !/\b(?:not|no|pas|non)\b/.test(t));
        if (/\b(?:stackable|empilable|stack size)\b/.test(t)) add("stackable", !/\b(?:not|no|pas|non)\b/.test(t));
        if (/\b(?:drops? itself|se drop|drop lui)/.test(t)) add("dropsSelf", true);

        // Le bot compare souvent au bloc précédent : « même couleur »,
        // « outil différent », « dureté identique ». Sans ces règles, le
        // solveur répétait un bloc déjà essayé.
        if (prev) {
            const cmp = [
                ["color", prev.color], ["tool", prev.tool], ["dimension", prev.dimension],
                ["hardness", prev.hardness], ["blast", prev.blast], ["light", prev.light]
            ];
            const has = kind => clues.some(c => c.kind === kind);
            for (const [kind, value] of cmp) {
                if (has(kind)) continue;
                const fr = kind === "color" ? "couleur" : kind === "tool" ? "outil" : kind === "dimension" ? "dimension" : kind === "hardness" ? "durete" : kind === "blast" ? "resistance" : "lumiere";
                if (new RegExp(`\\b(?:same|identical|m[êe]me|identique)s?\\s+(?:${kind}|${fr})\\b`).test(t)) {
                    add(kind, value, "eq");
                } else if (new RegExp(`\\b(?:different|not the same|diff[ée]rent|pas la m[êe]me)\\s+(?:${kind}|${fr})\\b`).test(t)) {
                    add(kind, value, "ne");
                }
            }
            if (/\b(?:higher|harder|plus dur)\b/.test(t) && !has("hardness")) add("hardness", prev.hardness, "gte");
            if (/\b(?:lower|softer|moins dur)\b/.test(t) && !has("hardness")) add("hardness", prev.hardness, "lte");
        }

        // Indices de forme du nom, parfois utilisés par les jeux de devinette.
        let shape = t.match(/(?:starts? with|commence par)\s*["']?([a-z])/);
        if (shape) add("startsWith", shape[1].toUpperCase());
        shape = t.match(/(?:name|word|nom|mot)\D{0,16}(\d{1,2})\s*(?:letters|lettres)/);
        if (shape) add("letters", Number(shape[1]));

        // Un nom de bloc cité avec une négation est une élimination directe.
        for (const b of BLOCKS) {
            const name = b.alias.replace(/_/g, "[ _]?");
            const full = b.name.toLowerCase().replace(/\s+/g, "\\s+");
            if (new RegExp(`\\bnot\\s+(?:the\\s+)?(?:${name}|${full})\\b`).test(t)) add("notBlock", b.alias);
            if (new RegExp(`\\b(?:the\\s+block\\s+is|it'?s|answer\\s*:?)\\s+(?:${name}|${full})\\b`).test(t)) add("isBlock", b.alias);
            // « You found Stone! » / « C'est Stone ! » : victoire explicite.
            if (new RegExp(`\\b(?:you found|you got|tu as trouv[ée]|c'?est)\\s+(?:the\\s+)?(?:${name}|${full})\\b`).test(t)) add("isBlock", b.alias);
        }
        return clues;
    }

    function matchesClue(block, clue) {
        let ok;
        switch (clue.kind) {
            case "color": ok = block.color === clue.value; break;
            case "tool": ok = block.tool === clue.value; break;
            case "dimension": ok = block.dimension === clue.value; break;
            case "hardness": ok = compare(block.hardness, clue.value, clue.op); break;
            case "blast": ok = compare(block.blast, clue.value, clue.op); break;
            case "light": ok = compare(block.light, clue.value, clue.op); break;
            case "gravity": ok = block.gravity === clue.value; break;
            case "transparent": ok = block.transparent === clue.value; break;
            case "renewable": ok = block.renewable === clue.value; break;
            case "flammable": ok = ((block.material === "wood" || block.material === "plant" || block.material === "wool")) === clue.value; break;
            case "stackable": ok = true; break;
            case "dropsSelf": ok = !["ore", "crystal"].includes(block.material); break;
            case "notBlock": ok = block.alias !== clue.value; break;
            case "isBlock": ok = block.alias === clue.value; break;
            case "startsWith": ok = block.name.toLowerCase().startsWith(String(clue.value || "").toLowerCase()); break;
            case "letters": ok = block.name.replace(/[^a-z]/gi, "").length === Number(clue.value); break;
            default: ok = true;
        }
        // « pas la même couleur / dureté différente » : on inverse le test.
        return clue.op === "ne" ? !ok : ok;
    }

    function compare(value, target, op) {
        if (op === "gte") return value >= target;
        if (op === "lte") return value <= target;
        const a = Math.abs(value - target);
        return a <= Math.max(0.26, target * 0.15);
    }

    async function boot() {
        for (let i = 0; i < 200 && !W.BlockyLab; i++) await new Promise(r => setTimeout(r, 100));
        const lab = W.BlockyLab;
        if (!lab) { console.warn("[BlockyLab] blockdl : noyau absent"); return; }
        if (W.__blockyBlockDlLoaded) return;
        W.__blockyBlockDlLoaded = true;

        const { h, toast } = lab;
        const KEY = "blockdl.v1";
        const saved = lab.store.get(KEY, {}) || {};
        const cfg = Object.assign({
            auto: false,
            command: "/blockdl {guess}",
            dayKey: "",
            clues: [],
            guesses: [],
            manualClues: "",
            solved: null,
            lastPromptId: "",
            cooldownMs: 2500,
            responseTimeoutMs: 14000,
            maxGuesses: 8,
            strategy: "entropy"
        }, saved.cfg || {});
        const save = () => lab.store.set(KEY, { cfg });

        const state = {
            prompt: "",
            candidates: BLOCKS.slice(),
            recommendation: null,
            top: [],
            lastSent: 0,
            lastFeedbackAt: 0,
            lastSignature: "",
            busy: false
        };

        const dayKey = () => new Date().toISOString().slice(0, 10);

        function reset(keepClues = false) {
            cfg.solved = null;
            cfg.guesses = [];
            cfg.lastPromptId = "";
            if (!keepClues) cfg.clues = [];
            state.lastSignature = "";
            recompute();
        }

        if (cfg.dayKey !== dayKey()) {
            cfg.dayKey = dayKey();
            reset(false);
            save();
        }

        function clueText(c) {
            if (c.kind === "solved") return c.value ? "Résolu" : "Pas encore";
            return `${c.kind}: ${c.value}${c.op && c.op !== "eq" ? " (" + c.op + ")" : ""}`;
        }

        function applyClues(clues) {
            const unique = new Map();
            for (const c of clues) unique.set(`${c.kind}|${c.value}|${c.op}`, c);
            cfg.clues = [...unique.values()].slice(-80);
        }

        function recompute() {
            let candidates = cfg.solved
                ? BLOCKS.filter(b => b.alias === cfg.solved)
                : BLOCKS.filter(b => cfg.clues.every(c => c.kind === "solved" || matchesClue(b, c)));

            // Élimine les blocs déjà proposés, sauf s'il n'en reste qu'un.
            if (candidates.length > 1) {
                const guessed = new Set(cfg.guesses.map(g => g.alias));
                const fresh = candidates.filter(b => !guessed.has(b.alias));
                if (fresh.length) candidates = fresh;
            }
            if (!candidates.length) {
                // Indices contradictoires ou trop stricts : on repart des blocs
                // non devinés plutôt que de bloquer le solveur.
                candidates = BLOCKS.filter(b => !cfg.guesses.some(g => g.alias === b.alias));
                if (!candidates.length) candidates = BLOCKS.slice();
            }

            // Regroupement par signature : le bot répond sur un sous-ensemble
            // d'attributs (couleur, outil, dureté…). Un bon pari est celui qui
            // coupe le plus de candidats, pas le plus rare.
            const groups = new Map();
            for (const b of candidates) {
                const key = vector(b);
                groups.set(key, (groups.get(key) || 0) + 1);
            }
            const total = candidates.length;
            const H = entropy([...groups.values()]);
            const COMMON = new Set(["stone", "cobblestone", "dirt", "grass", "oak_planks", "oak_log", "sand", "gravel", "coal_ore", "iron_ore"]);
            const strategy = cfg.strategy || "entropy";
            const scored = candidates.map(b => {
                const same = groups.get(vector(b)) || 1;
                const p = same / Math.max(1, total);
                // Candidats restants attendus après ce pari (réponse « pareil »
                // ou « différent ») ; on retire le bloc proposé s'il est trouvé.
                const expected = (same - 1) + (1 - p) * (total - same);
                const info = H - p * Math.log2(Math.max(1, same));
                const prior = COMMON.has(b.alias) ? 1 : 0;
                const score = strategy === "probable"
                    ? (p * 10) - (expected / Math.max(1, total))
                    : strategy === "balanced"
                        ? (p * 2) - (expected / Math.max(1, total)) * 4
                        : -expected + prior * 0.02;
                return {
                    ...b,
                    p: Math.round(p * 1000) / 1000,
                    same,
                    expected: Math.round(expected * 10) / 10,
                    info: Math.round(info * 1000) / 1000,
                    score: Math.round(score * 1000) / 1000
                };
            }).sort((a, b) => b.score - a.score || a.expected - b.expected || a.name.localeCompare(b.name));

            state.candidates = candidates;
            state.top = scored.slice(0, 8);
            state.recommendation = scored[0] || null;
            if (state.recommendation) cfg.lastRecommendation = state.recommendation.alias;
            lab.ui.refresh("blockdl");
            return state.recommendation;
        }

        function lastGuessBlock() {
            const last = cfg.guesses[cfg.guesses.length - 1];
            if (!last) return null;
            return BLOCKS.find(b => b.alias === last.alias)
                || BLOCKS.find(b => b.name.toLowerCase() === String(last.name || "").toLowerCase())
                || null;
        }

        function applyFeedback(raw) {
            const clues = parseFeedback(raw, lastGuessBlock());
            for (const c of clues) {
                if (c.kind === "isBlock") cfg.solved = c.value;
                if (c.kind === "solved" && c.value) {
                    const last = cfg.guesses[cfg.guesses.length - 1];
                    if (last) cfg.solved = last.alias;
                }
                if (c.kind === "notBlock") cfg.guesses.push({ alias: c.value, at: Date.now() });
            }
            applyClues([...cfg.clues, ...clues.filter(c => c.kind !== "notBlock" && c.kind !== "isBlock")]);
            if (cfg.solved) {
                cfg.auto = false;
                toast(`BlockDL résolu : ${BLOCKS.find(b => b.alias === cfg.solved)?.name || cfg.solved}`, "success", 6000);
            }
            save();
            recompute();
            return clues;
        }

        function setModalValue(value) {
            const input = document.querySelector('[role="dialog"] input[type="text"], [role="dialog"] textarea');
            if (!input) return false;
            const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
            try {
                if (setter) setter.call(input, value); else input.value = value;
                input.dispatchEvent(new Event("input", { bubbles: true }));
                input.dispatchEvent(new Event("change", { bubbles: true }));
                input.focus();
                return true;
            } catch (_) { return false; }
        }

        function pressKey(el, key) {
            const opts = { key, code: key === "Enter" ? "Enter" : `Key${key}`, keyCode: key === "Enter" ? 13 : 0, which: key === "Enter" ? 13 : 0, bubbles: true, cancelable: true };
            el.dispatchEvent(new KeyboardEvent("keydown", opts));
            el.dispatchEvent(new KeyboardEvent("keyup", opts));
        }

        async function playGuess(name) {
            if (state.busy || !name) return;
            state.busy = true;
            state.lastSent = Date.now();
            const block = BLOCKS.find(b => b.alias === name || b.name.toLowerCase() === String(name).toLowerCase()) || { alias: name, name };
            cfg.guesses.push({ alias: block.alias, name: block.name, at: Date.now() });
            save();

            try {
                const root = document.querySelector('[role="dialog"]');
                if (root && setModalValue(block.name)) {
                    await new Promise(r => setTimeout(r, 120));
                    const input = root.querySelector("input, textarea");
                    if (input) pressKey(input, "Enter");
                    lab.log("blockdl", "saisie modale", block.name);
                    return;
                }
                const options = [...document.querySelectorAll("[role='option'], [role='menuitem'], [role='listbox'] button, [role='listbox'] [role='option']")]
                    .filter(b => !b.closest("#bl-panel"));
                const wanted = lab.norm(block.name).toLowerCase();
                const option = options.find(b => lab.norm(b.innerText || b.getAttribute("aria-label") || "").toLowerCase().includes(wanted));
                if (option) { lab.discord.press(option); lab.log("blockdl", "option", block.name); return; }
                const buttons = [...document.querySelectorAll("button, [role='button']")]
                    .filter(b => !b.closest("#bl-panel") && !b.disabled);
                const btn = buttons.find(b => lab.norm(b.innerText || b.getAttribute("aria-label") || "").toLowerCase().includes(wanted));
                if (btn) { lab.discord.press(btn); lab.log("blockdl", "bouton", block.name); return; }
                const cmd = String(cfg.command || "/blockdl {guess}").replace(/\{guess\}/g, block.name.toLowerCase().replace(/\s+/g, "_"));
                const ok = await lab.discord.sendText(cmd);
                if (!ok) throw new Error("envoi refusé");
                lab.log("blockdl", "commande", cmd);
            } catch (e) {
                toast("BlockDL : " + e.message, "error");
            } finally {
                state.busy = false;
                lab.ui.refresh("blockdl");
            }
        }

        function handleMessage(msg, root) {
            if (cfg.dayKey !== dayKey()) {
                cfg.dayKey = dayKey();
                reset(false);
                save();
            }
            const text = lab.embed.messageText(msg);
            if (!/\bblock\s*dl\b|\bblock\s+of\s+the\s+day\b|\bbloc\s+du\s+jour\b/i.test(text)) return;
            if (msg?.author && msg.author.bot === false) return;
            const sf = lab.snowflake(msg.id);
            if (sf && Date.now() - sf.ts > 6 * 60 * 1000) return;
            let hash = 0;
            for (let i = 0; i < text.length; i++) hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
            const signature = `${msg.id}|${text.length}|${hash}`;
            if (signature === state.lastSignature) return;
            state.lastSignature = signature;
            state.prompt = text;
            const clues = applyFeedback(text);
            state.lastFeedbackAt = Date.now();
            lab.log("blockdl", "message", text.slice(0, 200), clues.length);
            if (cfg.auto && !cfg.solved && cfg.guesses.length < Math.max(1, Number(cfg.maxGuesses) || 8) && state.recommendation && Date.now() - state.lastSent > Math.max(800, cfg.cooldownMs)) {
                setTimeout(() => playGuess(state.recommendation.alias), 450);
            }
            lab.ui.refresh("blockdl");
        }

        /* ------------------------------------------------------------------ */
        /* UI                                                                  */
        /* ------------------------------------------------------------------ */

        function render() {
            const wrap = h("div");
            const rec = state.recommendation;
            const solvedBlock = cfg.solved ? BLOCKS.find(b => b.alias === cfg.solved) : null;

            wrap.appendChild(h("div", { class: "bl-card" },
                h("b", { text: "BlockDL · bloc du jour" }),
                h("div", { class: "bl-muted", text: "Le solveur lit les indices du bot, élimine les blocs incompatibles et classe les candidats par information attendue. Il reste utilisable même si le format des indices change : ajoute-les à la main." }),
                h("div", { class: "bl-kv" }, h("span", { text: "Candidats restants" }), h("b", { text: state.candidates.length })),
                h("div", { class: "bl-kv" }, h("span", { text: "Recommandation" }), h("b", { text: solvedBlock ? solvedBlock.name : rec ? `${rec.name} (${rec.alias})` : "—" })),
                h("div", { class: "bl-kv" }, h("span", { text: "Statut" }), h("b", { class: cfg.solved ? "bl-good" : "bl-warn", text: cfg.solved ? "résolu" : "en cours" })),
                h("div", { class: "bl-row" },
                    h("button", { class: "bl-btn", text: "Jouer la recommandation", disabled: !rec || state.busy, onclick: () => playGuess(rec?.alias) }),
                    h("button", { class: "bl-btn bl-sec", text: "Nouvelle partie", onclick: () => { reset(false); save(); toast("BlockDL réinitialisé", "info"); } })
                )
            ));

            if (cfg.solved) {
                wrap.appendChild(h("div", { class: "bl-inline" }, h("b", { text: "Bloc trouvé : " + (solvedBlock?.name || cfg.solved) }),
                    h("div", { class: "bl-muted", text: "Le solveur est arrêté pour aujourd'hui. Réinitialise demain ou manuellement." })));
            }

            wrap.appendChild(h("div", { class: "bl-card" },
                h("b", { text: "Top candidats" }),
                h("div", { class: "bl-muted", text: "Probas = chance que ce soit le bloc, reste = candidats attendus après la réponse. Le solveur privilégie une réponse qui coupe le plus de blocs." }),
                ...state.top.map((b, i) => h("div", { class: "bl-kv" },
                    h("span", { text: `${i + 1}. ${b.name} · ${Math.round((b.p || 0) * 100)} %` }),
                    h("b", { text: `reste ~${b.expected} · ${b.color} · ${b.tool} · ${b.dimension}` })
                ))
            ));

            const auto = h("input", { type: "checkbox" });
            auto.checked = Boolean(cfg.auto);
            auto.addEventListener("change", () => {
                cfg.auto = auto.checked;
                save();
                if (cfg.auto) toast("BlockDL auto : le prochain indice sera joué", "warn");
            });
            const cmd = h("input", { class: "bl-input", value: cfg.command });
            cmd.addEventListener("change", () => { cfg.command = cmd.value.trim() || "/blockdl {guess}"; save(); });

            wrap.appendChild(h("div", { class: "bl-card" },
                h("b", { text: "Automatisation" }),
                h("label", { class: "bl-row" }, auto, h("span", { text: "Jouer automatiquement la recommandation" })),
                h("label", { class: "bl-col" },
                    h("span", { class: "bl-label", text: "Stratégie de choix" }),
                    (() => {
                        const sel = h("select", { class: "bl-select" },
                            h("option", { value: "entropy", text: "Information maximale (moins de blocs)" }),
                            h("option", { value: "balanced", text: "Équilibré" }),
                            h("option", { value: "probable", text: "Bloc le plus probable" })
                        );
                        sel.value = cfg.strategy || "entropy";
                        sel.addEventListener("change", () => { cfg.strategy = sel.value; save(); recompute(); });
                        return sel;
                    })()
                ),
                h("label", { class: "bl-col" }, h("span", { class: "bl-label", text: "Commande de secours ({guess})" }), cmd),
                (() => {
                    const i = h("input", { class: "bl-input", type: "number", min: 1, max: 30, value: cfg.maxGuesses });
                    i.addEventListener("change", () => { cfg.maxGuesses = Math.max(1, Math.min(30, Number(i.value) || 8)); save(); });
                    return h("label", { class: "bl-col" }, h("span", { class: "bl-label", text: "Essais automatiques maximum" }), i);
                })(),
                (() => {
                    const i = h("input", { class: "bl-input", type: "number", min: 4, max: 120, value: Math.round((cfg.responseTimeoutMs || 14000) / 1000) });
                    i.addEventListener("change", () => { cfg.responseTimeoutMs = Math.max(4, Math.min(120, Number(i.value) || 14)) * 1000; save(); });
                    return h("label", { class: "bl-col" }, h("span", { class: "bl-label", text: "Délai de réponse max (s)" }), i);
                })(),
                h("div", { class: "bl-muted", text: "L'auto attend la réponse du bot avant de rejouer ; après le délai, il propose un autre bloc. Il utilise d'abord la modale ou le bouton visible, puis la commande de secours, et s'arrête dès que le bloc est trouvé." })
            ));

            const manual = h("textarea", { class: "bl-textarea", placeholder: "Colle ici un indice : « dureté 3 », « pickaxe », « nether », « transparent », « not stone »…" });
            manual.value = cfg.manualClues;
            manual.addEventListener("input", () => { cfg.manualClues = manual.value; save(); });

            wrap.appendChild(h("div", { class: "bl-card" },
                h("b", { text: "Indices et apprentissage" }),
                h("div", { class: "bl-muted", text: "Les indices automatiques sont surlignés. Tu peux en ajouter un à la main ; il sera conservé avec la partie du jour." }),
                manual,
                h("div", { class: "bl-row" },
                    h("button", {
                        class: "bl-btn", text: "Ajouter l'indice",
                        onclick: () => {
                            const clues = parseFeedback(manual.value, lastGuessBlock());
                            if (!clues.length) { toast("Aucun indice reconnu", "warn"); return; }
                            applyFeedback(manual.value);
                            manual.value = "";
                            cfg.manualClues = "";
                            save();
                            recompute();
                            lab.ui.refresh("blockdl");
                        }
                    }),
                    h("button", {
                        class: "bl-btn bl-sec", text: "Tout effacer",
                        onclick: () => { reset(false); save(); lab.ui.refresh("blockdl"); }
                    }),
                    h("button", {
                        class: "bl-btn bl-sec", text: "Exporter",
                        onclick: () => lab.export.download("blocky-blockdl.json", JSON.stringify({
                            generatedAt: new Date().toISOString(), cfg, candidates: state.candidates.map(b => b.name), top: state.top
                        }, null, 2))
                    })
                ),
                cfg.clues.length ? h("div", { class: "bl-code", text: cfg.clues.map(clueText).join("\n") }) : h("div", { class: "bl-muted", text: "Aucun indice pour l'instant." })
            ));

            wrap.appendChild(h("div", { class: "bl-card" },
                h("b", { text: "Historique" }),
                cfg.guesses.length ? h("div", { class: "bl-code", text: cfg.guesses.map(g => `${new Date(g.at).toLocaleTimeString()} · ${g.name || g.alias}`).join("\n") })
                    : h("div", { class: "bl-muted", text: "Aucun essai enregistré." }),
                h("div", { class: "bl-muted", style: { fontSize: "10px" }, text: "La base inclut les blocs courants. Si le bloc du jour est absent, ajoute son nom comme indice ou utilise la commande manuelle." })
            ));

            return wrap;
        }

        lab.ui.tab({ id: "blockdl", title: "BlockDL", hint: "Bloc du jour : indices, solveur, auto", render });
        lab.watch((msg, root) => { try { handleMessage(msg, root); } catch (e) { lab.log("blockdl scan", e.message); } });
        recompute();

        // Boucle auto : ne joue qu'après une réponse du bot (ou un timeout),
        // jamais en rafale. C'est ce qui évite de brûler les essais.
        setInterval(() => {
            if (!cfg.auto || cfg.solved || state.busy) return;
            const max = Math.max(1, Number(cfg.maxGuesses) || 8);
            if (cfg.guesses.length >= max) return;
            const now = Date.now();
            if (now - state.lastSent < Math.max(900, Number(cfg.cooldownMs) || 2500)) return;
            const responded = state.lastFeedbackAt > state.lastSent;
            if (!responded && now - state.lastSent < Math.max(4000, Number(cfg.responseTimeoutMs) || 14000)) return;
            let next = state.recommendation;
            if (!responded) {
                // Pas de réponse : on évite de rejouer le même bloc.
                const guessed = new Set(cfg.guesses.map(g => g.alias));
                next = state.candidates.find(b => !guessed.has(b.alias)) || next;
            }
            if (next) playGuess(next.alias);
        }, 1200);
        console.info("[BlockyLab] blockdl prêt");
    }

    boot();
})();
