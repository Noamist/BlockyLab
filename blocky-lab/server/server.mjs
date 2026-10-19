#!/usr/bin/env node
/**
 * Blocky Lab — serveur d'analyse local.
 * Aucune dépendance. Node 18+.
 *
 *   node server.mjs
 *   -> http://127.0.0.1:3210
 *
 * Les userscripts envoient leurs observations sur POST /api/ingest.
 * Les données restent dans server/data/observations.ndjson.
 */

import http from "node:http";
import { readFile, appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");
const NDJSON = path.join(DATA_DIR, "observations.ndjson");
const DASHBOARD = path.join(__dirname, "dashboard.html");
const PORT = Number(process.env.PORT || 3210);
const HOST = process.env.HOST || "127.0.0.1";
const MAX_BODY = 24 * 1024 * 1024;

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

const chi2P = (x, df) => (df <= 0 || x <= 0 ? 1 : 1 - gammaP(df / 2, x / 2));

function chiSquare(observed, expected) {
    let chi2 = 0;
    for (let i = 0; i < observed.length; i++) {
        const e = expected[i];
        if (e > 0) chi2 += ((observed[i] - e) ** 2) / e;
    }
    const df = Math.max(1, expected.filter(e => e > 0).length - 1);
    return { chi2, df, p: chi2P(chi2, df) };
}

function chiSquareUniform(counts) {
    const n = counts.reduce((a, b) => a + b, 0);
    const e = n / counts.length;
    return { ...chiSquare(counts, counts.map(() => e)), n };
}

const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const variance = a => {
    if (a.length < 2) return 0;
    const m = mean(a);
    return a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1);
};
const entropy = counts => {
    const n = counts.reduce((a, b) => a + b, 0);
    if (!n) return 0;
    let H = 0;
    for (const c of counts) {
        if (!c) continue;
        const p = c / n;
        H -= p * Math.log2(p);
    }
    return H;
};

/* ------------------------------------------------------------------ */
/* Stockage                                                            */
/* ------------------------------------------------------------------ */

const LUCKY = [
    { key: "creeper", p: 0.315, mult: 0 },
    { key: "cobblestone", p: 0.22, mult: 0.5 },
    { key: "iron", p: 0.18, mult: 1 },
    { key: "gold", p: 0.15, mult: 1.5 },
    { key: "diamonds", p: 0.09, mult: 2.5 },
    { key: "emeralds", p: 0.04, mult: 4 },
    { key: "netherite", p: 0.005, mult: 10 }
];

const observations = [];
const ids = new Set();

async function load() {
    await mkdir(DATA_DIR, { recursive: true });
    try {
        const txt = await readFile(NDJSON, "utf8");
        for (const line of txt.split("\n")) {
            if (!line.trim()) continue;
            try {
                const o = JSON.parse(line);
                if (o?.id && !ids.has(String(o.id))) {
                    ids.add(String(o.id));
                    observations.push(o);
                }
            } catch { /* ligne cassée : ignorée */ }
        }
    } catch { /* premier lancement */ }
    console.log(`[blocky-lab] ${observations.length} observations chargées`);
}

async function ingest(list) {
    const fresh = [];
    for (const o of list) {
        if (!o?.id) continue;
        const id = String(o.id);
        if (ids.has(id)) continue;
        ids.add(id);
        observations.push(o);
        fresh.push(o);
    }
    if (fresh.length) {
        await appendFile(NDJSON, fresh.map(o => JSON.stringify(o)).join("\n") + "\n", "utf8");
    }
    return fresh.length;
}

/* ------------------------------------------------------------------ */
/* Agrégats                                                            */
/* ------------------------------------------------------------------ */

function buildStats() {
    const byGame = {};
    const byGameLabel = {};
    const lucky = Object.fromEntries(LUCKY.map(l => [l.key, 0]));
    const wheel = new Array(37).fill(0);
    const hours = new Array(24).fill(0);
    const days = {};
    let wheelN = 0;

    for (const o of observations) {
        const game = o.game || "unknown";
        byGame[game] = (byGame[game] || 0) + 1;
        const key = `${game}:${o.label || "none"}`;
        byGameLabel[key] = (byGameLabel[key] || 0) + 1;
        if (o.ts) {
            const d = new Date(o.ts);
            if (!Number.isNaN(d.getTime())) {
                hours[d.getHours()]++;
                const day = d.toISOString().slice(0, 10);
                days[day] = (days[day] || 0) + 1;
            }
        }
        if (game === "luckyblock" && o.detail?.category && lucky[o.detail.category] !== undefined) lucky[o.detail.category]++;
        if (game === "wheel" && Number.isInteger(o.detail?.number)) { wheel[o.detail.number]++; wheelN++; }
    }

    const luckyCounts = LUCKY.map(l => lucky[l.key]);
    const luckyN = luckyCounts.reduce((a, b) => a + b, 0);
    const luckyChi = luckyN ? chiSquare(luckyCounts, LUCKY.map(l => l.p * luckyN)) : null;
    const luckyRtp = luckyN
        ? mean(observations.filter(o => o.game === "luckyblock" && o.detail?.category).map(o => (LUCKY.find(l => l.key === o.detail.category) || {}).mult || 0))
        : null;

    const wheelChi = wheelN ? chiSquareUniform(wheel) : null;

    const bj = observations.filter(o => o.game === "blackjack" && (o.label === "win" || o.label === "loss"));
    const bjWins = bj.filter(o => o.label === "win").length;
    const bjRate = bj.length ? bjWins / bj.length : null;
    const bjZ = bj.length ? (bjRate - 0.5) / Math.sqrt(0.25 / bj.length) : null;

    return {
        generatedAt: new Date().toISOString(),
        total: observations.length,
        byGame,
        byGameLabel,
        lucky: {
            counts: lucky,
            n: luckyN,
            chi2: luckyChi,
            rtp: luckyRtp,
            expectedRtp: LUCKY.reduce((s, l) => s + l.p * l.mult, 0),
            ci95: luckyN > 1 ? (() => {
                const vals = observations.filter(o => o.game === "luckyblock" && o.detail?.category).map(o => (LUCKY.find(l => l.key === o.detail.category) || {}).mult || 0);
                const se = Math.sqrt(variance(vals) / vals.length);
                return [luckyRtp - 1.96 * se, luckyRtp + 1.96 * se];
            })() : null
        },
        wheel: {
            counts: wheel,
            n: wheelN,
            chi2: wheelChi,
            entropy: entropy(wheel),
            maxEntropy: Math.log2(37)
        },
        blackjack: { n: bj.length, wins: bjWins, rate: bjRate, z: bjZ },
        hours,
        days,
        recent: observations.slice(-120).reverse()
    };
}

function toCSV() {
    const cols = ["id", "iso", "ts", "game", "label", "category", "number", "color", "authorId", "source", "text"];
    const esc = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const rows = [cols.join(",")];
    for (const o of observations) {
        rows.push([
            o.id, o.iso, o.ts, o.game, o.label,
            o.detail?.category ?? "", o.detail?.number ?? "", o.detail?.color ?? "",
            o.authorId ?? "", o.source ?? "", (o.text || "").replace(/\s+/g, " ").slice(0, 300)
        ].map(esc).join(","));
    }
    return rows.join("\n");
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

function cors(res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function json(res, code, body) {
    const data = JSON.stringify(body);
    res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(data);
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on("data", c => {
            size += c.length;
            if (size > MAX_BODY) { reject(new Error("corps trop volumineux")); req.destroy(); return; }
            chunks.push(c);
        });
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        req.on("error", reject);
    });
}

const server = http.createServer(async (req, res) => {
    cors(res);
    const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);

    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    try {
        if (req.method === "POST" && url.pathname === "/api/ingest") {
            const raw = await readBody(req);
            let body;
            try { body = JSON.parse(raw); } catch { return json(res, 400, { error: "JSON invalide" }); }
            const list = Array.isArray(body) ? body : body.observations;
            if (!Array.isArray(list)) return json(res, 400, { error: "observations manquantes" });
            const added = await ingest(list.slice(0, 20000));
            return json(res, 200, { ok: true, added, total: observations.length });
        }

        if (req.method === "GET" && url.pathname === "/api/stats") {
            return json(res, 200, buildStats());
        }

        if (req.method === "GET" && url.pathname === "/api/observations") {
            const game = url.searchParams.get("game");
            const limit = Math.min(5000, Math.max(1, Number(url.searchParams.get("limit")) || 500));
            let list = observations;
            if (game) list = list.filter(o => o.game === game);
            return json(res, 200, { count: list.length, observations: list.slice(-limit) });
        }

        if (req.method === "GET" && url.pathname === "/api/export.csv") {
            res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": "attachment; filename=blocky-observations.csv" });
            return res.end(toCSV());
        }

        if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
            const html = await readFile(DASHBOARD, "utf8");
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            return res.end(html);
        }

        if (url.pathname === "/api/health") return json(res, 200, { ok: true, count: observations.length, uptime: process.uptime() });

        return json(res, 404, { error: "not found" });
    } catch (e) {
        console.error("[blocky-lab]", e);
        return json(res, 500, { error: e.message });
    }
});

await load();
server.listen(PORT, HOST, () => {
    console.log(`[blocky-lab] http://${HOST}:${PORT}`);
});
