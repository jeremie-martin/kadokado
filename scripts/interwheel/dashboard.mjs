#!/usr/bin/env node
// Quick dashboard for browsing rendered Interwheel videos.
//   node scripts/interwheel/dashboard.mjs [--port 8088] [--root .tmp/renders]

import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), "../..");

function parseArgs(argv) {
  const out = { port: 8088, root: ".tmp/renders" };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port" || a === "-p") out.port = Number(argv[++i]);
    else if (a === "--root" || a === "-r") out.root = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv);
const rendersDir = path.isAbsolute(args.root) ? args.root : path.resolve(repoRoot, args.root);
const videosDir = path.join(rendersDir, "videos");

if (!fs.existsSync(videosDir)) {
  console.error(`videos dir not found: ${videosDir}`);
  process.exit(1);
}

function listEntries() {
  const dirs = fs
    .readdirSync(videosDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  const entries = [];
  for (const name of dirs) {
    const dirPath = path.join(videosDir, name);
    const metaPath = path.join(dirPath, "metadata.json");
    let meta = null;
    if (fs.existsSync(metaPath)) {
      try {
        meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      } catch (err) {
        meta = { _error: String(err) };
      }
    }
    const files = fs.readdirSync(dirPath).filter((f) => f.endsWith(".mp4"));
    const shortFile = files.find((f) => f.includes("short")) ?? null;
    const fullFile = files.find((f) => f !== shortFile) ?? null;
    const stat = fs.statSync(dirPath);
    entries.push({ name, meta, shortFile, fullFile, mtimeMs: stat.mtimeMs });
  }
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return entries;
}

function fmtNumber(n) {
  if (n == null || Number.isNaN(n)) return "—";
  return Number(n).toLocaleString();
}

function fmtDate(s) {
  if (!s) return "—";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleString();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function stateBadge(state) {
  const s = String(state ?? "—");
  const cls =
    s === "DEAD" ? "badge dead" : s === "ALIVE" ? "badge alive" : s === "WIN" ? "badge win" : "badge";
  return `<span class="${cls}">${escapeHtml(s)}</span>`;
}

function renderCard(entry) {
  const m = entry.meta ?? {};
  const run = m.run ?? {};
  const short = m.short ?? {};
  const dur = short.frames && short.fps ? (short.frames / short.fps).toFixed(1) + "s" : "—";
  const dim = short.width && short.height ? `${short.width}×${short.height}` : "—";
  const fps = short.fps ? `${short.fps} fps` : "—";

  const shortUrl = entry.shortFile ? `/videos/${encodeURIComponent(entry.name)}/${encodeURIComponent(entry.shortFile)}` : null;
  const fullUrl = entry.fullFile ? `/videos/${encodeURIComponent(entry.name)}/${encodeURIComponent(entry.fullFile)}` : null;
  const primaryUrl = shortUrl ?? fullUrl;

  const altLink = shortUrl && fullUrl ? `<a class="alt" href="${fullUrl}" target="_blank">open full ↗</a>` : "";
  const downloads = [
    shortUrl ? `<a class="dl" href="${shortUrl}" download>⬇ short</a>` : "",
    fullUrl ? `<a class="dl" href="${fullUrl}" download>⬇ full</a>` : "",
  ]
    .filter(Boolean)
    .join("");

  return `
    <article class="card">
      <header>
        <h2>${escapeHtml(entry.name)}</h2>
        <div class="sub">
          <span>seed <b>${escapeHtml(m.seed ?? "—")}</b></span>
          <span>preset <b>${escapeHtml(m.preset ?? "—")}</b></span>
          <span>${fmtDate(m.renderedAt)}</span>
          ${stateBadge(run.finalState)}
        </div>
      </header>
      <div class="body">
        <div class="player">
          ${
            primaryUrl
              ? `<video src="${primaryUrl}" controls preload="metadata" playsinline></video>`
              : `<div class="missing">no mp4 found</div>`
          }
          ${altLink}
        </div>
        <div class="downloads">${downloads}</div>
        <dl class="meta">
          <div><dt>final score</dt><dd>${fmtNumber(run.finalScore)}</dd></div>
          <div><dt>final height</dt><dd>${fmtNumber(run.finalHeightM)} m</dd></div>
          <div><dt>frames</dt><dd>${fmtNumber(run.frames)}</dd></div>
          <div><dt>ending tick</dt><dd>${fmtNumber(run.endingTick)}</dd></div>
          <div><dt>drowned tick</dt><dd>${run.drownedTick == null ? "—" : fmtNumber(run.drownedTick)}</dd></div>
          <div><dt>exploded tick</dt><dd>${run.explodedTick == null ? "—" : fmtNumber(run.explodedTick)}</dd></div>
          <div><dt>video</dt><dd>${dim} · ${fps} · ${dur}</dd></div>
        </dl>
      </div>
    </article>
  `;
}

function renderPage(entries) {
  const cards = entries.map(renderCard).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Interwheel renders</title>
<style>
  :root {
    --bg: #0e1014;
    --card: #161a22;
    --border: #242a36;
    --text: #e6e8ec;
    --muted: #8a93a3;
    --accent: #7ad7ff;
    --dead: #ff6b6b;
    --alive: #ffd166;
    --win: #4ade80;
  }
  * { box-sizing: border-box; }
  html, body { background: var(--bg); color: var(--text); font: 14px/1.4 system-ui, sans-serif; margin: 0; }
  header.top { padding: 18px 24px; border-bottom: 1px solid var(--border); display: flex; align-items: baseline; gap: 16px; }
  header.top h1 { margin: 0; font-size: 18px; letter-spacing: 0.5px; }
  header.top .count { color: var(--muted); font-size: 13px; }
  header.top .root { margin-left: auto; color: var(--muted); font-family: ui-monospace, monospace; font-size: 12px; }
  main { padding: 18px; display: grid; gap: 18px; grid-template-columns: repeat(auto-fill, minmax(420px, 1fr)); }
  article.card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; }
  article.card > header { padding: 12px 14px; border-bottom: 1px solid var(--border); }
  article.card h2 { margin: 0 0 6px; font-size: 14px; font-family: ui-monospace, monospace; color: var(--accent); word-break: break-all; }
  article.card .sub { display: flex; flex-wrap: wrap; gap: 10px; color: var(--muted); font-size: 12px; align-items: center; }
  article.card .sub b { color: var(--text); font-weight: 600; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; background: #2a3140; color: var(--text); font-size: 11px; }
  .badge.dead { background: #3a1f24; color: var(--dead); }
  .badge.alive { background: #3a3220; color: var(--alive); }
  .badge.win { background: #1f3a2a; color: var(--win); }
  .body { padding: 12px 14px; display: grid; gap: 12px; }
  .player { position: relative; background: #000; border-radius: 8px; overflow: hidden; aspect-ratio: 9 / 16; max-height: 520px; margin: 0 auto; width: 100%; }
  .player video { width: 100%; height: 100%; display: block; object-fit: contain; background: #000; }
  .player .missing { color: var(--muted); display: flex; align-items: center; justify-content: center; height: 100%; }
  .player a.alt { position: absolute; right: 8px; bottom: 8px; background: rgba(0,0,0,0.6); color: var(--accent); padding: 4px 8px; border-radius: 6px; font-size: 12px; text-decoration: none; }
  .downloads { display: flex; gap: 8px; flex-wrap: wrap; }
  .downloads .dl { flex: 1; text-align: center; padding: 6px 10px; border: 1px solid var(--border); border-radius: 6px; color: var(--accent); text-decoration: none; font-size: 12px; font-family: ui-monospace, monospace; background: #1b2230; }
  .downloads .dl:hover { background: #243044; }
  dl.meta { display: grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap: 6px 14px; margin: 0; }
  dl.meta div { display: flex; justify-content: space-between; gap: 8px; border-bottom: 1px dashed var(--border); padding: 4px 0; }
  dl.meta dt { color: var(--muted); }
  dl.meta dd { margin: 0; font-family: ui-monospace, monospace; }
  .empty { padding: 60px; text-align: center; color: var(--muted); }
</style>
</head>
<body>
<header class="top">
  <h1>Interwheel renders</h1>
  <span class="count">${entries.length} render${entries.length === 1 ? "" : "s"}</span>
  <span class="root">${escapeHtml(path.relative(repoRoot, videosDir) || videosDir)}</span>
</header>
${entries.length === 0 ? `<div class="empty">No renders yet.</div>` : `<main>${cards}</main>`}
</body>
</html>`;
}

const app = express();

app.get("/", (_req, res) => {
  res.type("html").send(renderPage(listEntries()));
});

app.get("/api/renders", (_req, res) => {
  res.json(listEntries());
});

app.use(
  "/videos",
  express.static(videosDir, {
    fallthrough: false,
    setHeaders: (res) => res.setHeader("Cache-Control", "public, max-age=60"),
  }),
);

app.listen(args.port, "0.0.0.0", () => {
  console.log(`Interwheel dashboard → http://0.0.0.0:${args.port}`);
  console.log(`  serving from: ${videosDir}`);
});
