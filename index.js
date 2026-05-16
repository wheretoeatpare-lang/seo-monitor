require("dotenv").config();
const express = require("express");
const cron = require("node-cron");
const cheerio = require("cheerio");
const GitHubClient = require("./githubClient");
const SEOChecker = require("./seoChecker");
const EmailReporter = require("./emailReporter");

const app = express();
const PORT = process.env.PORT || 3000;
const SITE_URL = process.env.SITE_URL || "https://ranksorcery.com/";
const API_SECRET = process.env.API_SECRET || "seo-bot-secret";

const github = new GitHubClient(
  process.env.GITHUB_TOKEN,
  process.env.GITHUB_OWNER,
  process.env.GITHUB_REPO,
  process.env.GITHUB_BRANCH || "main"
);
const seoChecker = new SEOChecker();
const mailer = new EmailReporter(
  process.env.EMAIL_FROM,
  process.env.EMAIL_TO,
  process.env.RESEND_API_KEY
);

// ── State ────────────────────────────────────────────────────────────────────
let isRunning = false;
let lastRun = null;
let lastResult = null;
let logs = [];

// ── Approval Queue ────────────────────────────────────────────────────────────
// FIX: Pages that need AI changes are QUEUED here instead of auto-committed.
// Each item: { id, filePath, url, oldTitle, oldMeta, newTitle, newMeta, sha, updatedHtml, analysis }
let pendingApprovals = [];
let approvalRunMeta = null; // saved skipped/errors/duration for the final report

function addLog(msg, type = "info") {
  const entry = { time: new Date().toISOString(), msg, type };
  logs.push(entry);
  if (logs.length > 200) logs = logs.slice(-200);
  console.log(`[${type.toUpperCase()}] ${msg}`);
}

// ── SEO Monitor Core ─────────────────────────────────────────────────────────
async function runSEOMonitor(globalKeywords = [], targetPages = []) {
  if (isRunning) {
    addLog("Already running — skipped duplicate trigger", "warn");
    return;
  }

  isRunning = true;
  logs = [];
  pendingApprovals = [];   // clear old queue on each fresh run
  approvalRunMeta = null;

  const startTime = Date.now();
  const runDate = new Date().toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });

  addLog(`SEO Monitor started: ${runDate}`, "info");
  addLog(`Site: ${SITE_URL}`, "info");
  if (globalKeywords.length > 0) addLog(`Global keywords: ${globalKeywords.join(", ")}`, "info");
  if (targetPages.length > 0) addLog(`Scanning specific pages: ${targetPages.join(", ")}`, "info");

  const skipped = [];
  const errors = [];

  try {
    addLog("Fetching HTML files from GitHub repo...", "info");
    let htmlFiles = await github.getAllHtmlFiles();
    addLog(`Found ${htmlFiles.length} HTML files`, "info");

    if (targetPages.length > 0) {
      htmlFiles = htmlFiles.filter(f => targetPages.includes(f.path));
      addLog(`Filtered to ${htmlFiles.length} targeted page(s)`, "info");
    }

    for (const file of htmlFiles) {
      try {
        const { content, sha } = await github.getFile(file.path);
        const seo = github.parseSEO(content, file.path, SITE_URL);
        const $ = cheerio.load(content);
        const pageText = $("body").text().replace(/\s+/g, " ").trim().slice(0, 500);

        addLog(`Checking: ${file.path}`, "info");
        addLog(`  Title (${seo.title.length} chars): "${seo.title.slice(0, 60)}"`, "info");
        addLog(`  Meta (${seo.metaDesc.length} chars): "${seo.metaDesc.slice(0, 60)}"`, "info");
        if (globalKeywords.length > 0) addLog(`  Target keywords: ${globalKeywords.join(", ")}`, "info");

        const analysis = await seoChecker.checkAndRewrite(
          seo.title, seo.metaDesc, seo.url, pageText, globalKeywords
        );

        if (analysis.needsChange) {
          const updatedHtml = github.applySEO(content, analysis.newTitle, analysis.newMetaDesc);
          // FIX: Queue for approval instead of committing immediately
          pendingApprovals.push({
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            filePath: file.path,
            url: seo.url,
            oldTitle: seo.title,
            oldMeta: seo.metaDesc,
            newTitle: analysis.newTitle,
            newMeta: analysis.newMetaDesc,
            sha,
            updatedHtml,
            analysis,
          });
          addLog(`  ⏳ Needs approval: "${analysis.newTitle}"`, "warn");
        } else {
          skipped.push({ filePath: file.path, url: seo.url });
          addLog(`  ✓ SEO is good — no changes needed`, "success");
        }

        await sleep(800);
      } catch (err) {
        addLog(`  ✗ Error on ${file.path}: ${err.message}`, "error");
        errors.push({ file: file.path, error: err.message });
      }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);

    if (pendingApprovals.length > 0) {
      // Save context so commitApproved() can send a full report later
      approvalRunMeta = { globalKeywords, targetPages, runDate, skipped, errors, duration };
      addLog(`⏳ ${pendingApprovals.length} suggestion(s) ready — approve or skip in the dashboard!`, "warn");
    } else {
      // Nothing to approve — send report immediately
      addLog("Sending email report...", "info");
      // FIX: Always pass rejected:[] — was missing, caused "Cannot read properties of undefined (reading 'length')"
      await mailer.sendReport({ changed: [], rejected: [], skipped, errors, runDate, siteUrl: SITE_URL });
      addLog("Email report sent!", "success");
      lastResult = { changed: 0, skipped: skipped.length, errors: errors.length, duration, runDate };
      lastRun = new Date().toISOString();
      addLog(`Done! Updated: 0, Good: ${skipped.length}, Errors: ${errors.length} (${duration}s)`, "success");
    }

  } catch (err) {
    addLog(`Fatal error: ${err.message}`, "error");
  }

  isRunning = false;
}

// ── Commit approved pages ────────────────────────────────────────────────────
async function commitApproved(approvedIds, rejectedIds) {
  const changed = [];
  const rejected = [];
  const errors = [];

  const meta = approvalRunMeta || {};
  const runDate = meta.runDate || new Date().toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });
  const skipped = meta.skipped || [];

  for (const item of pendingApprovals) {
    if (approvedIds.includes(item.id)) {
      try {
        const commitMsg = `🤖 SEO update: ${item.filePath} — approved via dashboard`;
        await github.updateFile(item.filePath, item.updatedHtml, item.sha, commitMsg);
        changed.push({
          filePath: item.filePath,
          url: item.url,
          oldTitle: item.oldTitle,
          oldMeta: item.oldMeta,
          analysis: item.analysis,
        });
        addLog(`  ✓ Committed: ${item.filePath}`, "success");
      } catch (err) {
        addLog(`  ✗ Commit failed for ${item.filePath}: ${err.message}`, "error");
        errors.push({ file: item.filePath, error: err.message });
      }
    } else {
      rejected.push({
        filePath: item.filePath,
        url: item.url,
        oldTitle: item.oldTitle,
        oldMeta: item.oldMeta,
        analysis: item.analysis,
      });
      addLog(`  ⏭ Skipped: ${item.filePath}`, "info");
    }
  }

  // Clear queue after processing
  pendingApprovals = [];
  approvalRunMeta = null;

  const duration = meta.duration || "?";

  addLog("Sending email report...", "info");
  try {
    // FIX: All four arrays always passed — no more undefined crashes
    await mailer.sendReport({ changed, rejected, skipped, errors, runDate, siteUrl: SITE_URL });
    addLog("Email report sent!", "success");
  } catch (err) {
    addLog(`Email send failed: ${err.message}`, "error");
  }

  const allErrors = errors.length + (meta.errors ? meta.errors.length : 0);
  lastResult = { changed: changed.length, skipped: skipped.length, errors: allErrors, duration, runDate };
  lastRun = new Date().toISOString();
  addLog(`Done! Updated: ${changed.length}, Good: ${skipped.length}, Errors: ${allErrors} (${duration}s)`, "success");
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── API Routes ───────────────────────────────────────────────────────────────
app.use(express.json());

// Trigger scan
app.post("/api/run", (req, res) => {
  const secret = req.headers["x-api-secret"] || req.body?.secret;
  if (secret !== API_SECRET) return res.status(401).json({ error: "Unauthorized" });
  if (isRunning) return res.json({ status: "already_running", message: "SEO monitor is already running!" });

  const globalKeywords = Array.isArray(req.body?.globalKeywords) ? req.body.globalKeywords : [];
  const targetPages = Array.isArray(req.body?.targetPages) ? req.body.targetPages : [];

  runSEOMonitor(globalKeywords, targetPages).catch(console.error);
  res.json({ status: "started", message: "SEO monitor started!" });
});

// Get status — pendingApprovals exposed so client can render approval UI
app.get("/api/status", (req, res) => {
  res.json({
    isRunning,
    isScanning: isRunning,
    lastRun,
    lastResult,
    logCount: logs.length,
    // FIX: Expose pending approvals to client so it can show Approve/Skip UI
    pendingApprovals: pendingApprovals.map(p => ({
      id: p.id,
      filePath: p.filePath,
      url: p.url,
      oldTitle: p.oldTitle,
      oldMeta: p.oldMeta,
      newTitle: p.newTitle,
      newMeta: p.newMeta,
      reasonTitle: p.analysis.reasonTitle,
      reasonMeta: p.analysis.reasonMeta,
      basisTitle: p.analysis.basisTitle,
      basisMeta: p.analysis.basisMeta,
      titleOk: p.analysis.titleOk,
      metaOk: p.analysis.metaOk,
    })),
  });
});

// Submit approve/skip decisions — triggers commitApproved()
app.post("/api/approve", (req, res) => {
  const secret = req.headers["x-api-secret"] || req.body?.secret;
  if (secret !== API_SECRET) return res.status(401).json({ error: "Unauthorized" });
  if (isRunning) return res.status(409).json({ error: "Scan still running — wait for it to finish" });
  if (pendingApprovals.length === 0) return res.status(400).json({ error: "No pending approvals" });

  const approvedIds = Array.isArray(req.body?.approved) ? req.body.approved : [];
  const rejectedIds = Array.isArray(req.body?.rejected) ? req.body.rejected : [];

  commitApproved(approvedIds, rejectedIds).catch(console.error);
  res.json({ status: "committing", message: `Committing ${approvedIds.length} approved change(s)...` });
});

// Get logs
app.get("/api/logs", (req, res) => {
  res.json({ logs, isRunning });
});

// Config
app.get("/api/config", (req, res) => {
  res.json({ secret: API_SECRET });
});

// Serve client.js
const path = require("path");
app.get("/client.js", (req, res) => {
  res.setHeader("Content-Type", "application/javascript");
  res.sendFile(path.join(__dirname, "client.js"));
});

// Dashboard HTML
app.get("/", (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>SEO Monitor Dashboard</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #0a0a0f;
    --surface: #13131a;
    --surface2: #1c1c26;
    --border: #2a2a3a;
    --text: #e8e8f0;
    --muted: #666680;
    --accent: #7c5cfc;
    --success: #00e5b0;
    --error: #ff4d6d;
    --warn: #ffb340;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font-family: 'Inter', sans-serif; min-height: 100vh; }
  .wrap { max-width: 860px; margin: 0 auto; padding: 32px 20px 60px; }

  .header { margin-bottom: 32px; }
  .logo { font-size: 11px; font-family: 'Space Mono', monospace; color: var(--accent); text-transform: uppercase; letter-spacing: .2em; margin-bottom: 12px; }
  .header-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
  .title { font-size: 28px; font-weight: 600; letter-spacing: -.02em; }
  .title span { color: var(--accent); }
  .subtitle { font-size: 12px; color: var(--muted); font-family: 'Space Mono', monospace; margin-top: 4px; }
  .site-badge { display: flex; align-items: center; gap: 8px; font-size: 13px; font-family: 'Space Mono', monospace; background: var(--surface); border: 1px solid var(--border); border-radius: 99px; padding: 6px 14px; }
  .dot-live { width: 7px; height: 7px; border-radius: 50%; background: var(--success); animation: pulse 2s infinite; }
  @keyframes pulse { 0%,100%{opacity:1}50%{opacity:.4} }

  .stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 20px; }
  .stat { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 20px; text-align: center; }
  .stat-val { font-size: 32px; font-weight: 600; font-family: 'Space Mono', monospace; }
  .stat-val.green { color: var(--success); }
  .stat-val.purple { color: var(--accent); }
  .stat-val.red { color: var(--error); }
  .stat-label { font-size: 12px; color: var(--muted); margin-top: 6px; font-family: 'Space Mono', monospace; text-transform: uppercase; letter-spacing: .08em; }

  .scan-options { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 20px 24px; margin-bottom: 16px; }
  .scan-options-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .12em; color: var(--accent); font-family: 'Space Mono', monospace; margin-bottom: 14px; }
  .scan-mode-toggle { display: flex; gap: 8px; margin-bottom: 14px; }
  .scan-mode-btn { flex: 1; padding: 8px; font-size: 12px; font-weight: 700; font-family: 'Space Mono', monospace; border-radius: 8px; border: 1px solid var(--border); background: var(--surface2); color: var(--muted); cursor: pointer; transition: all .2s; appearance: none; }
  .scan-mode-btn.active { background: rgba(124,92,252,.2); border-color: var(--accent); color: var(--accent); }
  .scan-options-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .scan-field label { display: block; font-size: 11px; font-family: 'Space Mono', monospace; color: var(--muted); text-transform: uppercase; letter-spacing: .08em; margin-bottom: 6px; }
  .scan-field textarea, .scan-field input { width: 100%; background: var(--surface2); border: 1px solid var(--border); border-radius: 8px; color: var(--text); font-family: 'Space Mono', monospace; font-size: 12px; padding: 10px 12px; resize: vertical; outline: none; transition: border-color .2s; }
  .scan-field textarea:focus, .scan-field input:focus { border-color: var(--accent); }
  .scan-field textarea { height: 90px; }
  .scan-field .field-hint { font-size: 11px; color: var(--muted); margin-top: 5px; font-family: 'Space Mono', monospace; }
  .kw-tags { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
  .kw-tag { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; padding: 3px 10px; border-radius: 99px; background: rgba(124,92,252,.15); color: var(--accent); border: 1px solid rgba(124,92,252,.2); font-family: 'Space Mono', monospace; }
  .kw-tag-remove { cursor: pointer; opacity: .6; font-size: 13px; }
  .kw-tag-remove:hover { opacity: 1; color: var(--error); }

  .run-section { margin-bottom: 20px; }
  .run-btn { width: 100%; padding: 18px; font-size: 16px; font-weight: 700; font-family: 'Space Mono', monospace; border-radius: 12px; border: none; background: var(--accent); color: #fff; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 10px; transition: all .2s; }
  .run-btn:hover:not(:disabled) { filter: brightness(1.1); transform: translateY(-1px); }
  .run-btn:disabled { opacity: .5; cursor: not-allowed; transform: none; }
  .run-btn.running { background: var(--surface2); border: 1px solid var(--border); color: var(--muted); }
  .spinner { width: 18px; height: 18px; border: 2px solid rgba(255,255,255,.3); border-top-color: #fff; border-radius: 50%; animation: spin .7s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .schedule-info { margin-top: 10px; text-align: center; font-size: 12px; color: var(--muted); font-family: 'Space Mono', monospace; }

  /* ── Approval Panel ─────────────────────────────── */
  .approval-panel { background: var(--surface); border: 2px solid var(--warn); border-radius: 12px; padding: 20px 24px; margin-bottom: 20px; display: none; }
  .approval-panel.visible { display: block; }
  .approval-title { font-size: 13px; font-weight: 700; font-family: 'Space Mono', monospace; text-transform: uppercase; letter-spacing: .1em; color: var(--warn); margin-bottom: 4px; }
  .approval-subtitle { font-size: 12px; color: var(--muted); font-family: 'Space Mono', monospace; margin-bottom: 18px; }
  .approval-item { background: var(--surface2); border: 1px solid var(--border); border-radius: 10px; padding: 16px; margin-bottom: 12px; transition: border-color .2s; }
  .approval-item.approved { border-color: var(--success); }
  .approval-item.skipped { border-color: var(--border); opacity: .6; }
  .approval-file { font-size: 12px; font-family: 'Space Mono', monospace; color: var(--accent); margin-bottom: 12px; }
  .approval-row { display: grid; grid-template-columns: 72px 1fr 1fr; gap: 10px; font-size: 12px; margin-bottom: 6px; align-items: start; }
  .approval-label { font-family: 'Space Mono', monospace; color: var(--muted); font-size: 11px; text-transform: uppercase; padding-top: 2px; }
  .approval-old { color: var(--muted); text-decoration: line-through; line-height: 1.5; }
  .approval-new { color: var(--text); font-weight: 500; line-height: 1.5; }
  .approval-reason { font-size: 11px; color: var(--muted); font-family: 'Space Mono', monospace; margin-top: 8px; background: var(--bg); border-radius: 6px; padding: 8px 10px; line-height: 1.6; white-space: pre-wrap; }
  .approval-actions { display: flex; gap: 8px; margin-top: 14px; }
  .btn-approve { flex: 1; padding: 10px; font-size: 12px; font-weight: 700; font-family: 'Space Mono', monospace; border-radius: 8px; border: 1px solid var(--success); background: rgba(0,229,176,.08); color: var(--success); cursor: pointer; transition: all .2s; }
  .btn-approve:hover, .btn-approve.selected { background: rgba(0,229,176,.2); }
  .btn-approve.selected { background: var(--success); color: #000; }
  .btn-skip { flex: 1; padding: 10px; font-size: 12px; font-weight: 700; font-family: 'Space Mono', monospace; border-radius: 8px; border: 1px solid var(--border); background: transparent; color: var(--muted); cursor: pointer; transition: all .2s; }
  .btn-skip:hover { border-color: var(--error); color: var(--error); }
  .btn-skip.selected { background: rgba(255,77,109,.1); border-color: var(--error); color: var(--error); }
  .approval-commit-bar { margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--border); display: flex; gap: 12px; align-items: center; }
  .btn-commit { flex: 1; padding: 13px; font-size: 13px; font-weight: 700; font-family: 'Space Mono', monospace; border-radius: 10px; border: none; background: var(--accent); color: #fff; cursor: pointer; transition: all .2s; }
  .btn-commit:hover:not(:disabled) { filter: brightness(1.1); }
  .btn-commit:disabled { opacity: .4; cursor: not-allowed; }
  .commit-hint { font-size: 11px; color: var(--muted); font-family: 'Space Mono', monospace; }

  .last-run { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 16px 20px; margin-bottom: 24px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; }
  .last-run-label { font-size: 12px; color: var(--muted); font-family: 'Space Mono', monospace; text-transform: uppercase; letter-spacing: .08em; margin-bottom: 4px; }
  .last-run-val { font-size: 14px; font-weight: 600; }
  .result-pills { display: flex; gap: 8px; flex-wrap: wrap; }
  .pill { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; padding: 4px 12px; border-radius: 99px; font-family: 'Space Mono', monospace; font-weight: 700; }
  .pill-green { background: rgba(0,229,176,.1); color: var(--success); border: 1px solid rgba(0,229,176,.2); }
  .pill-purple { background: rgba(124,92,252,.1); color: var(--accent); border: 1px solid rgba(124,92,252,.2); }
  .pill-red { background: rgba(255,77,109,.1); color: var(--error); border: 1px solid rgba(255,77,109,.2); }
  .pill-warn { background: rgba(255,179,64,.1); color: var(--warn); border: 1px solid rgba(255,179,64,.2); }

  .logs-section { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; }
  .logs-header { padding: 16px 20px; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; }
  .logs-title { font-size: 13px; font-weight: 600; font-family: 'Space Mono', monospace; text-transform: uppercase; letter-spacing: .1em; color: var(--muted); }
  .logs-badge { font-size: 11px; font-family: 'Space Mono', monospace; background: var(--surface2); border: 1px solid var(--border); border-radius: 99px; padding: 3px 10px; color: var(--muted); }
  .logs-body { height: 380px; overflow-y: auto; padding: 16px 20px; font-family: 'Space Mono', monospace; font-size: 12px; line-height: 1.7; }
  .logs-body::-webkit-scrollbar { width: 4px; }
  .logs-body::-webkit-scrollbar-track { background: transparent; }
  .logs-body::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }
  .log-line { display: flex; gap: 12px; margin-bottom: 2px; }
  .log-time { color: var(--muted); flex-shrink: 0; }
  .log-msg.success { color: var(--success); }
  .log-msg.error { color: var(--error); }
  .log-msg.warn { color: var(--warn); }
  .log-msg.info { color: var(--text); }
  .empty-logs { color: var(--muted); text-align: center; padding: 40px 0; }
  .status-bar { display: flex; align-items: center; gap: 8px; font-size: 12px; font-family: 'Space Mono', monospace; }
  .status-dot { width: 8px; height: 8px; border-radius: 50%; }
  .status-dot.running { background: var(--warn); animation: pulse 1s infinite; }
  .status-dot.idle { background: var(--success); }
</style>
</head>
<body>
<div class="wrap">

  <div class="header">
    <div class="logo">⚡ SEO Automation Bot</div>
    <div class="header-top">
      <div>
        <div class="title">SEO <span>Monitor</span></div>
        <div class="subtitle"># daily audit · github pages · ai-powered</div>
      </div>
      <div class="site-badge"><div class="dot-live"></div>ranksorcery.com</div>
    </div>
  </div>

  <div class="stats">
    <div class="stat"><div class="stat-val green" id="stat-updated">—</div><div class="stat-label">Pages Updated</div></div>
    <div class="stat"><div class="stat-val purple" id="stat-good">—</div><div class="stat-label">Already Good</div></div>
    <div class="stat"><div class="stat-val red" id="stat-errors">—</div><div class="stat-label">Errors</div></div>
  </div>

  <div class="scan-options">
    <div class="scan-options-title">&#9881; Scan Options</div>
    <div class="scan-mode-toggle">
      <button type="button" class="scan-mode-btn active" id="mode-all" onclick="setScanMode('all')">&#127760; Scan All Pages</button>
      <button type="button" class="scan-mode-btn" id="mode-specific" onclick="setScanMode('specific')">&#128196; Specific Pages Only</button>
    </div>
    <div class="scan-options-grid">
      <div class="scan-field" id="pages-field" style="display:none">
        <label>Pages to scan (one path per line)</label>
        <textarea id="target-pages" placeholder="index.html&#10;about.html&#10;blog/post-1.html"></textarea>
        <div class="field-hint">Relative paths from repo root</div>
      </div>
      <div class="scan-field">
        <label>Target keywords (press Enter to add)</label>
        <input type="text" id="kw-input" placeholder="e.g. AI SEO tool" onkeydown="handleKwInput(event)">
        <div class="kw-tags" id="kw-tags"></div>
        <div class="field-hint">AI will prioritize these for all pages</div>
      </div>
    </div>
  </div>

  <div class="run-section">
    <button class="run-btn" id="run-btn" onclick="triggerScan()">
      <span id="btn-icon">▶</span>
      <span id="btn-text">Run SEO Monitor Now</span>
    </button>
    <div class="schedule-info" id="schedule-info">Runs automatically every day at 7:00 AM</div>
  </div>

  <!-- ── Approval Panel — hidden until pendingApprovals arrive ── -->
  <div class="approval-panel" id="approval-panel">
    <div class="approval-title">⏳ Review AI Suggestions</div>
    <div class="approval-subtitle">Approve changes to commit them to GitHub, or skip to ignore.</div>
    <div id="approval-items"></div>
    <div class="approval-commit-bar">
      <button class="btn-commit" id="commit-btn" onclick="submitApprovals()" disabled>
        ▶ Commit Approved to GitHub
      </button>
      <div class="commit-hint" id="commit-hint">Decide on all pages above first</div>
    </div>
  </div>

  <div class="last-run" id="last-run" style="display:none">
    <div>
      <div class="last-run-label">Last run</div>
      <div class="last-run-val" id="last-run-date">—</div>
    </div>
    <div class="result-pills" id="result-pills"></div>
  </div>

  <div class="logs-section">
    <div class="logs-header">
      <div class="logs-title">Live Logs</div>
      <div style="display:flex;align-items:center;gap:12px">
        <div class="status-bar">
          <div class="status-dot idle" id="status-dot"></div>
          <span id="status-text">Idle</span>
        </div>
        <div class="logs-badge" id="log-count">0 lines</div>
      </div>
    </div>
    <div class="logs-body" id="logs-body">
      <div class="empty-logs">No logs yet — click "Run SEO Monitor Now" to start!</div>
    </div>
  </div>

</div>

<script>fetch("/api/config").then(r=>r.json()).then(c=>{window.__CFG__=c;var s=document.createElement("script");s.src="/client.js";document.head.appendChild(s);});</script>
</body>
</html>`);
});

// ── Start server + cron ───────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 SEO Monitor Dashboard running on port ${PORT}`);
  console.log(`   Dashboard: http://localhost:${PORT}`);
  console.log(`   API: POST /api/run (x-api-secret header required)\n`);
});

const schedule = process.env.CRON_SCHEDULE || "0 7 * * *";
cron.schedule(schedule, () => {
  console.log("Cron triggered — running SEO monitor...");
  runSEOMonitor().catch(console.error);
});

if (process.env.RUN_NOW === "true") {
  console.log("RUN_NOW=true detected — starting in 3 seconds...");
  setTimeout(() => runSEOMonitor().catch(console.error), 3000);
}
