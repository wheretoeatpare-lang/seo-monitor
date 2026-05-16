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
let isScanning = false;   // Phase 1: scanning pages
let isApplying = false;   // Phase 2: applying approved changes
let scanComplete = false; // Phase 1 done — review pending
let lastRun = null;
let lastResult = null;
let logs = [];

// Pending changes waiting for user approval
// Each item: { filePath, url, sha, originalContent, oldTitle, oldMeta, analysis }
let pendingChanges = [];
let alreadyGoodPages = []; // pages with no changes needed
let scanErrors = [];

function addLog(msg, type = "info") {
  const entry = { time: new Date().toISOString(), msg, type };
  logs.push(entry);
  if (logs.length > 300) logs = logs.slice(-300);
  console.log(`[${type.toUpperCase()}] ${msg}`);
}

function isRunning() {
  return isScanning || isApplying;
}

// ── Phase 1: Scan pages, collect suggestions (NO commits) ─────────────────
async function runSEOScan({ targetPages = [], globalKeywords = [], pageKeywords = {} } = {}) {
  if (isRunning()) {
    addLog("Already running — skipped duplicate trigger", "warn");
    return;
  }

  isScanning = true;
  scanComplete = false;
  pendingChanges = [];
  alreadyGoodPages = [];
  scanErrors = [];
  logs = [];

  const runDate = new Date().toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });

  addLog(`SEO Scan started: ${runDate}`, "info");
  addLog(`Site: ${SITE_URL}`, "info");
  addLog(`Mode: SCAN ONLY — changes will require your approval`, "info");

  if (globalKeywords.length > 0) addLog(`Global keywords: ${globalKeywords.join(", ")}`, "info");
  if (targetPages.length > 0) addLog(`Scanning ${targetPages.length} specific page(s) only`, "info");

  try {
    let htmlFiles;
    if (targetPages.length > 0) {
      addLog("Fetching specific pages from GitHub repo...", "info");
      htmlFiles = targetPages.map(p => ({ path: p.trim(), name: p.trim().split("/").pop() }));
    } else {
      addLog("Fetching all HTML files from GitHub repo...", "info");
      htmlFiles = await github.getAllHtmlFiles();
    }
    addLog(`Found ${htmlFiles.length} HTML file(s) to analyze`, "info");

    for (const file of htmlFiles) {
      try {
        const { content, sha } = await github.getFile(file.path);
        const seo = github.parseSEO(content, file.path, SITE_URL);
        const $ = cheerio.load(content);
        const pageText = $("body").text().replace(/\s+/g, " ").trim().slice(0, 600);

        addLog(`Analyzing: ${file.path}`, "info");
        addLog(`  Title (${seo.title.length} chars): "${seo.title.slice(0, 70)}"`, "info");
        addLog(`  Meta (${seo.metaDesc.length} chars): "${seo.metaDesc.slice(0, 70)}"`, "info");

        const pageKws = pageKeywords[file.path] || [];
        const allKeywords = [...new Set([...globalKeywords, ...pageKws])];
        if (allKeywords.length > 0) addLog(`  Target keywords: ${allKeywords.join(", ")}`, "info");

        const analysis = await seoChecker.checkAndRewrite(
          seo.title, seo.metaDesc, seo.url, pageText, allKeywords
        );

        if (analysis.needsChange) {
          pendingChanges.push({
            filePath: file.path,
            url: seo.url,
            sha,
            originalContent: content,
            oldTitle: seo.title,
            oldMeta: seo.metaDesc,
            analysis,
          });
          const issues = [];
          if (!analysis.titleOk) issues.push("title");
          if (!analysis.metaOk) issues.push("meta");
          addLog(`  ⚠ Needs improvement: ${issues.join(" + ")} — awaiting your approval`, "warn");
        } else {
          alreadyGoodPages.push({ filePath: file.path, url: seo.url });
          addLog(`  ✓ SEO looks good — no changes needed`, "success");
        }

        await sleep(800);
      } catch (err) {
        addLog(`  ✗ Error on ${file.path}: ${err.message}`, "error");
        scanErrors.push({ file: file.path, error: err.message });
      }
    }

    addLog("─────────────────────────────────────────────────", "info");
    addLog(`Scan complete! ${pendingChanges.length} pages need attention, ${alreadyGoodPages.length} already good`, "success");
    if (pendingChanges.length > 0) {
      addLog(`👆 Review the suggestions above and approve or skip each one`, "warn");
    }

  } catch (err) {
    addLog(`Fatal error during scan: ${err.message}`, "error");
    scanErrors.push({ file: "scan", error: err.message });
  }

  isScanning = false;
  scanComplete = true;
}

// ── Phase 2: Apply only approved changes ─────────────────────────────────
async function applyApprovedChanges(approvedPaths) {
  if (isApplying) {
    addLog("Already applying — skipped duplicate trigger", "warn");
    return;
  }

  isApplying = true;
  const startTime = Date.now();

  const runDate = new Date().toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });

  const approved = pendingChanges.filter(p => approvedPaths.includes(p.filePath));
  const rejected = pendingChanges.filter(p => !approvedPaths.includes(p.filePath));

  addLog(`─────────────────────────────────────────────────`, "info");
  addLog(`Applying ${approved.length} approved change(s)...`, "info");

  const changed = [];
  const errors = [...scanErrors];

  for (const item of approved) {
    try {
      addLog(`Committing: ${item.filePath}`, "info");
      const updatedHtml = github.applySEO(item.originalContent, item.analysis.newTitle, item.analysis.newMetaDesc);
      const commitMsg = `🤖 SEO update: ${item.filePath} — approved by user`;
      await github.updateFile(item.filePath, updatedHtml, item.sha, commitMsg);
      changed.push({
        filePath: item.filePath,
        url: item.url,
        oldTitle: item.oldTitle,
        oldMeta: item.oldMeta,
        analysis: item.analysis,
      });
      addLog(`  ✓ Committed to GitHub!`, "success");
      await sleep(600);
    } catch (err) {
      addLog(`  ✗ Error committing ${item.filePath}: ${err.message}`, "error");
      errors.push({ file: item.filePath, error: err.message });
    }
  }

  // Prepare rejected list for email
  const rejectedList = rejected.map(r => ({
    filePath: r.filePath,
    url: r.url,
    analysis: r.analysis,
  }));

  addLog("Sending email report...", "info");
  try {
    await mailer.sendReport({
      changed,
      rejected: rejectedList,
      skipped: alreadyGoodPages,
      errors,
      runDate,
      siteUrl: SITE_URL,
    });
    addLog("Email report sent!", "success");
  } catch (err) {
    addLog(`Email failed: ${err.message}`, "error");
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  lastResult = {
    changed: changed.length,
    rejected: rejected.length,
    skipped: alreadyGoodPages.length,
    errors: errors.length,
    duration,
    runDate,
  };
  lastRun = new Date().toISOString();
  isApplying = false;
  scanComplete = false; // Reset so next run starts fresh
  pendingChanges = [];
  alreadyGoodPages = [];

  addLog(`Done! Applied: ${changed.length}, Skipped: ${rejected.length}, Already good: ${alreadyGoodPages.length} (${duration}s)`, "success");
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── API Routes ───────────────────────────────────────────────────────────────
app.use(express.json());

// Trigger scan (Phase 1 — no commits)
app.post("/api/run", (req, res) => {
  const secret = req.headers["x-api-secret"] || req.body?.secret;
  if (secret !== API_SECRET) return res.status(401).json({ error: "Unauthorized" });
  if (isRunning()) return res.json({ status: "already_running", message: "SEO monitor is already running!" });
  if (scanComplete && pendingChanges.length > 0) return res.json({ status: "pending_review", message: "Scan already done — review pending changes first!" });
  const { targetPages = [], globalKeywords = [], pageKeywords = {} } = req.body || {};
  runSEOScan({ targetPages, globalKeywords, pageKeywords }).catch(console.error);
  res.json({ status: "started", message: "SEO scan started!" });
});

// Apply approved changes (Phase 2)
app.post("/api/approve", (req, res) => {
  const secret = req.headers["x-api-secret"] || req.body?.secret;
  if (secret !== API_SECRET) return res.status(401).json({ error: "Unauthorized" });
  if (isRunning()) return res.json({ status: "already_running", message: "Already processing!" });
  if (!scanComplete) return res.json({ status: "no_scan", message: "Run a scan first!" });

  const { approved } = req.body; // array of filePaths to approve
  if (!Array.isArray(approved)) return res.status(400).json({ error: "approved must be an array of file paths" });

  applyApprovedChanges(approved).catch(console.error);
  res.json({ status: "applying", message: `Applying ${approved.length} approved change(s)...` });
});

// Get status
app.get("/api/status", (req, res) => {
  res.json({
    isScanning,
    isApplying,
    isRunning: isRunning(),
    scanComplete,
    pendingCount: pendingChanges.length,
    goodCount: alreadyGoodPages.length,
    lastRun,
    lastResult,
    logCount: logs.length,
  });
});

// Get logs
app.get("/api/logs", (req, res) => {
  res.json({ logs, isScanning, isApplying });
});

// Get pending changes (stripped of raw HTML content for bandwidth)
app.get("/api/pending", (req, res) => {
  const safe = pendingChanges.map(p => ({
    filePath: p.filePath,
    url: p.url,
    oldTitle: p.oldTitle,
    oldMeta: p.oldMeta,
    analysis: p.analysis,
  }));
  res.json({ pending: safe, good: alreadyGoodPages, scanComplete });
});

// Dashboard HTML
app.get("/", (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>SEO Monitor — RankSorcery</title>
<link href="https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=Syne:wght@400;600;800&display=swap" rel="stylesheet">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --bg: #0a0a0f;
    --surface: #111118;
    --surface2: #1a1a24;
    --border: #2a2a3a;
    --accent: #7c5cfc;
    --accent2: #00e5b0;
    --text: #e8e8f0;
    --muted: #6b6b80;
    --success: #00e5b0;
    --error: #ff4d6d;
    --warn: #ffb340;
    --info: #7c5cfc;
  }

  body {
    background: var(--bg);
    color: var(--text);
    font-family: 'Syne', sans-serif;
    min-height: 100vh;
    overflow-x: hidden;
  }

  body::before {
    content: '';
    position: fixed;
    inset: 0;
    background-image:
      linear-gradient(rgba(124,92,252,0.04) 1px, transparent 1px),
      linear-gradient(90deg, rgba(124,92,252,0.04) 1px, transparent 1px);
    background-size: 40px 40px;
    pointer-events: none;
    z-index: 0;
  }

  .wrap { position: relative; z-index: 1; max-width: 960px; margin: 0 auto; padding: 40px 24px; }

  /* Header */
  .header { margin-bottom: 32px; }
  .header-top { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 8px; }
  .logo { font-size: 11px; font-family: 'Space Mono', monospace; color: var(--accent2); letter-spacing: .15em; text-transform: uppercase; margin-bottom: 8px; }
  .title { font-size: 36px; font-weight: 800; line-height: 1.1; }
  .title span { color: var(--accent); }
  .subtitle { font-size: 14px; color: var(--muted); margin-top: 8px; font-family: 'Space Mono', monospace; }
  .site-badge { display: inline-flex; align-items: center; gap: 6px; background: var(--surface2); border: 1px solid var(--border); border-radius: 99px; padding: 6px 14px; font-size: 12px; font-family: 'Space Mono', monospace; color: var(--accent2); }
  .dot-live { width: 7px; height: 7px; border-radius: 50%; background: var(--accent2); animation: pulse 2s infinite; }
  @keyframes pulse { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:.5;transform:scale(1.3)} }

  /* Stats */
  .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 24px; }
  .stat { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 18px; }
  .stat-val { font-size: 28px; font-weight: 800; line-height: 1; margin-bottom: 4px; }
  .stat-label { font-size: 11px; color: var(--muted); font-family: 'Space Mono', monospace; text-transform: uppercase; letter-spacing: .08em; }
  .stat-val.green { color: var(--success); }
  .stat-val.purple { color: var(--accent); }
  .stat-val.red { color: var(--error); }
  .stat-val.warn { color: var(--warn); }

  /* Run button */
  .run-section { margin-bottom: 24px; }
  .run-btn {
    width: 100%; padding: 20px; font-size: 18px; font-weight: 800;
    font-family: 'Syne', sans-serif; letter-spacing: .04em;
    background: var(--accent); color: #fff; border: none; border-radius: 12px;
    cursor: pointer; transition: all .2s; display: flex; align-items: center; justify-content: center; gap: 10px;
    position: relative; overflow: hidden;
  }
  .run-btn::before { content: ''; position: absolute; inset: 0; background: linear-gradient(135deg, rgba(255,255,255,.1), transparent); opacity: 0; transition: opacity .2s; }
  .run-btn:hover::before { opacity: 1; }
  .run-btn:hover { transform: translateY(-2px); box-shadow: 0 8px 30px rgba(124,92,252,.4); }
  .run-btn:active { transform: translateY(0); }
  .run-btn:disabled { opacity: .5; cursor: not-allowed; transform: none; box-shadow: none; }
  .run-btn.running { background: var(--surface2); border: 1px solid var(--border); color: var(--muted); }
  .schedule-info { margin-top: 10px; text-align: center; font-size: 12px; color: var(--muted); font-family: 'Space Mono', monospace; }

  .spinner { width: 18px; height: 18px; border: 2px solid rgba(255,255,255,.3); border-top-color: #fff; border-radius: 50%; animation: spin .7s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* Last run pills */
  .last-run { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 16px 20px; margin-bottom: 24px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; }
  .last-run-label { font-size: 12px; color: var(--muted); font-family: 'Space Mono', monospace; text-transform: uppercase; letter-spacing: .08em; margin-bottom: 4px; }
  .last-run-val { font-size: 14px; font-weight: 600; }
  .result-pills { display: flex; gap: 8px; flex-wrap: wrap; }
  .pill { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; padding: 4px 12px; border-radius: 99px; font-family: 'Space Mono', monospace; font-weight: 700; }
  .pill-green { background: rgba(0,229,176,.1); color: var(--success); border: 1px solid rgba(0,229,176,.2); }
  .pill-purple { background: rgba(124,92,252,.1); color: var(--accent); border: 1px solid rgba(124,92,252,.2); }
  .pill-warn { background: rgba(255,179,64,.1); color: var(--warn); border: 1px solid rgba(255,179,64,.2); }
  .pill-red { background: rgba(255,77,109,.1); color: var(--error); border: 1px solid rgba(255,77,109,.2); }

  /* ── REVIEW PANEL ── */
  .review-panel { margin-bottom: 24px; display: none; }
  .review-header {
    background: linear-gradient(135deg, rgba(255,179,64,.15), rgba(255,179,64,.05));
    border: 1px solid rgba(255,179,64,.3);
    border-radius: 12px 12px 0 0;
    padding: 20px 24px;
    display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px;
  }
  .review-title { font-size: 16px; font-weight: 700; color: var(--warn); }
  .review-subtitle { font-size: 12px; color: var(--muted); font-family: 'Space Mono', monospace; margin-top: 4px; }
  .review-bulk-btns { display: flex; gap: 8px; }
  .btn-approve-all {
    padding: 8px 18px; font-size: 13px; font-weight: 700; font-family: 'Syne', sans-serif;
    background: rgba(0,229,176,.15); color: var(--success); border: 1px solid rgba(0,229,176,.3);
    border-radius: 8px; cursor: pointer; transition: all .2s;
  }
  .btn-approve-all:hover { background: rgba(0,229,176,.25); }
  .btn-skip-all {
    padding: 8px 18px; font-size: 13px; font-weight: 700; font-family: 'Syne', sans-serif;
    background: rgba(255,77,109,.1); color: var(--error); border: 1px solid rgba(255,77,109,.2);
    border-radius: 8px; cursor: pointer; transition: all .2s;
  }
  .btn-skip-all:hover { background: rgba(255,77,109,.2); }

  .change-cards { border: 1px solid rgba(255,179,64,.2); border-top: none; border-radius: 0 0 12px 12px; overflow: hidden; }

  .change-card {
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    transition: background .2s;
  }
  .change-card:last-child { border-bottom: none; }
  .change-card.approved { background: rgba(0,229,176,.04); border-left: 3px solid var(--success); }
  .change-card.skipped { background: rgba(255,77,109,.03); border-left: 3px solid rgba(255,77,109,.3); opacity: 0.6; }

  .card-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 16px 20px; flex-wrap: wrap; gap: 10px;
    border-bottom: 1px solid var(--border);
  }
  .card-file { font-size: 13px; font-family: 'Space Mono', monospace; color: var(--accent2); }
  .card-url { font-size: 11px; color: var(--muted); margin-top: 2px; }
  .card-keyword { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; padding: 2px 8px; border-radius: 99px; background: rgba(124,92,252,.15); color: var(--accent); border: 1px solid rgba(124,92,252,.2); font-family: 'Space Mono', monospace; margin-top: 2px; }
  .card-btns { display: flex; gap: 8px; flex-shrink: 0; }
  .btn-approve {
    padding: 7px 16px; font-size: 12px; font-weight: 700; font-family: 'Syne', sans-serif;
    background: rgba(0,229,176,.15); color: var(--success); border: 1px solid rgba(0,229,176,.3);
    border-radius: 8px; cursor: pointer; transition: all .15s;
  }
  .btn-approve:hover, .btn-approve.active { background: rgba(0,229,176,.3); transform: scale(1.02); }
  .btn-approve.active { box-shadow: 0 0 12px rgba(0,229,176,.3); }
  .btn-skip {
    padding: 7px 16px; font-size: 12px; font-weight: 700; font-family: 'Syne', sans-serif;
    background: rgba(255,77,109,.1); color: var(--error); border: 1px solid rgba(255,77,109,.2);
    border-radius: 8px; cursor: pointer; transition: all .15s;
  }
  .btn-skip:hover, .btn-skip.active { background: rgba(255,77,109,.25); }

  .card-body { padding: 16px 20px; display: flex; flex-direction: column; gap: 16px; }

  .change-field { background: var(--surface2); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
  .field-header { padding: 10px 14px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--border); background: rgba(255,179,64,.06); }
  .field-label { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .1em; color: var(--warn); font-family: 'Space Mono', monospace; }
  .field-lengths { font-size: 11px; font-family: 'Space Mono', monospace; color: var(--muted); }
  .field-length-bad { color: var(--error); }
  .field-length-good { color: var(--success); }

  .field-issues { padding: 8px 14px; background: rgba(255,77,109,.06); border-bottom: 1px solid var(--border); font-size: 12px; color: var(--error); font-family: 'Space Mono', monospace; white-space: pre-line; line-height: 1.6; }

  .comparison { padding: 12px 14px; display: grid; grid-template-columns: 1fr auto 1fr; gap: 10px; align-items: center; border-bottom: 1px solid var(--border); }
  .comp-old { background: rgba(255,77,109,.06); border: 1px solid rgba(255,77,109,.15); border-radius: 6px; padding: 8px 10px; }
  .comp-new { background: rgba(0,229,176,.06); border: 1px solid rgba(0,229,176,.15); border-radius: 6px; padding: 8px 10px; }
  .comp-label { font-size: 10px; font-family: 'Space Mono', monospace; color: var(--muted); text-transform: uppercase; letter-spacing: .08em; margin-bottom: 4px; }
  .comp-text { font-size: 13px; line-height: 1.4; }
  .comp-arrow { font-size: 18px; color: var(--muted); text-align: center; }

  .ai-reason { padding: 10px 14px; font-size: 12px; color: var(--muted); line-height: 1.6; }
  .ai-reason-label { font-size: 10px; font-family: 'Space Mono', monospace; color: var(--accent); text-transform: uppercase; letter-spacing: .08em; margin-bottom: 4px; }

  /* Apply button */
  .apply-section { padding: 20px 24px; background: var(--surface2); border-top: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; }
  .apply-count { font-size: 13px; color: var(--muted); font-family: 'Space Mono', monospace; }
  .apply-count strong { color: var(--text); }
  .btn-apply {
    padding: 12px 28px; font-size: 15px; font-weight: 800; font-family: 'Syne', sans-serif;
    background: var(--accent); color: #fff; border: none; border-radius: 10px;
    cursor: pointer; transition: all .2s;
  }
  .btn-apply:hover { transform: translateY(-2px); box-shadow: 0 6px 20px rgba(124,92,252,.4); }
  .btn-apply:disabled { opacity: .4; cursor: not-allowed; transform: none; box-shadow: none; }
  .btn-apply.zero { background: var(--surface); border: 1px solid var(--border); color: var(--muted); }

  /* Logs */
  .logs-section { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; }
  .logs-header { padding: 16px 20px; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; }
  .logs-title { font-size: 13px; font-weight: 600; font-family: 'Space Mono', monospace; text-transform: uppercase; letter-spacing: .1em; color: var(--muted); }
  .logs-badge { font-size: 11px; font-family: 'Space Mono', monospace; background: var(--surface2); border: 1px solid var(--border); border-radius: 99px; padding: 3px 10px; color: var(--muted); }
  .logs-body { height: 360px; overflow-y: auto; padding: 16px 20px; font-family: 'Space Mono', monospace; font-size: 12px; line-height: 1.7; }
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
  .status-dot.review { background: var(--warn); }


  /* ── SCAN OPTIONS ── */
  .scan-options { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 20px 24px; margin-bottom: 16px; }
  .scan-options-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .12em; color: var(--accent); font-family: 'Space Mono', monospace; margin-bottom: 14px; }
  .scan-options-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  @media (max-width: 600px) { .scan-options-grid { grid-template-columns: 1fr; } }
  .scan-field label { display: block; font-size: 11px; font-family: 'Space Mono', monospace; color: var(--muted); text-transform: uppercase; letter-spacing: .08em; margin-bottom: 6px; }
  .scan-field textarea, .scan-field input {
    width: 100%; background: var(--surface2); border: 1px solid var(--border); border-radius: 8px;
    color: var(--text); font-family: 'Space Mono', monospace; font-size: 12px; padding: 10px 12px;
    resize: vertical; outline: none; transition: border-color .2s;
  }
  .scan-field textarea:focus, .scan-field input:focus { border-color: var(--accent); }
  .scan-field textarea { height: 90px; }
  .scan-field .field-hint { font-size: 11px; color: var(--muted); margin-top: 5px; font-family: 'Space Mono', monospace; }
  .kw-tags { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; min-height: 0; }
  .kw-tag { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; padding: 3px 10px; border-radius: 99px; background: rgba(124,92,252,.15); color: var(--accent); border: 1px solid rgba(124,92,252,.2); font-family: 'Space Mono', monospace; cursor: default; }
  .kw-tag-remove { cursor: pointer; opacity: .6; font-size: 13px; line-height: 1; }
  .kw-tag-remove:hover { opacity: 1; color: var(--error); }
  .scan-mode-toggle { display: flex; gap: 8px; margin-bottom: 14px; }
  .scan-mode-btn { flex: 1; padding: 8px; font-size: 12px; font-weight: 700; font-family: 'Space Mono', monospace; border-radius: 8px; border: 1px solid var(--border); background: var(--surface2); color: var(--muted); cursor: pointer; transition: all .2s; text-align: center; appearance: none; -webkit-appearance: none; position: relative; z-index: 10; }
  .scan-mode-btn.active { background: rgba(124,92,252,.2); border-color: var(--accent); color: var(--accent); }
  @media (max-width: 600px) {
    .stats { grid-template-columns: repeat(2, 1fr); }
    .comparison { grid-template-columns: 1fr; }
    .comp-arrow { display: none; }
  }
</style>
</head>
<body>
<div class="wrap">

  <div class="header">
    <div class="logo">⚡ SEO Automation Bot</div>
    <div class="header-top">
      <div>
        <div class="title">SEO <span>Monitor</span></div>
        <div class="subtitle"># scan · review · approve · commit</div>
      </div>
      <div class="site-badge"><div class="dot-live"></div>ranksorcery.com</div>
    </div>
  </div>

  <div class="stats">
    <div class="stat">
      <div class="stat-val warn" id="stat-pending">—</div>
      <div class="stat-label">Pending Review</div>
    </div>
    <div class="stat">
      <div class="stat-val green" id="stat-updated">—</div>
      <div class="stat-label">Applied</div>
    </div>
    <div class="stat">
      <div class="stat-val purple" id="stat-good">—</div>
      <div class="stat-label">Already Good</div>
    </div>
    <div class="stat">
      <div class="stat-val red" id="stat-errors">—</div>
      <div class="stat-label">Errors</div>
    </div>
  </div>


  <!-- ── SCAN OPTIONS ── -->
  <div class="scan-options">
    <div class="scan-options-title">⚙ Scan Options</div>
    <div class="scan-mode-toggle">
      <button type="button" class="scan-mode-btn active" id="mode-all" onclick="setScanMode('all')">🌐 Scan All Pages</button>
      <button type="button" class="scan-mode-btn" id="mode-specific" onclick="setScanMode('specific')">📄 Specific Pages Only</button>
    </div>
    <div class="scan-options-grid">
      <div class="scan-field" id="pages-field" style="display:none">
        <label>Pages to scan (one path per line)</label>
        <textarea id="target-pages" placeholder="index.html&#10;about.html&#10;blog/post-1.html"></textarea>
        <div class="field-hint">Leave empty to scan all pages</div>
      </div>
      <div class="scan-field">
        <label>Target keywords (press Enter to add)</label>
        <input type="text" id="kw-input" placeholder="e.g. AI SEO tool" onkeydown="handleKwInput(event)">
        <div class="kw-tags" id="kw-tags"></div>
        <div class="field-hint">AI will prioritize these keywords for all pages</div>
      </div>
    </div>
  </div>

  <div class="run-section">
    <button class="run-btn" id="run-btn" onclick="triggerScan()">
      <span id="btn-icon">🔍</span>
      <span id="btn-text">Run SEO Scan</span>
    </button>
    <div class="schedule-info" id="schedule-info">Scans all pages · You approve before anything changes</div>
  </div>

  <div class="last-run" id="last-run" style="display:none">
    <div>
      <div class="last-run-label">Last completed run</div>
      <div class="last-run-val" id="last-run-date">—</div>
    </div>
    <div class="result-pills" id="result-pills"></div>
  </div>

  <!-- ── REVIEW PANEL ── -->
  <div class="review-panel" id="review-panel">
    <div class="review-header">
      <div>
        <div class="review-title" id="review-title">⚠ Pages Need Attention</div>
        <div class="review-subtitle" id="review-subtitle">Review AI suggestions below — approve or skip each one before applying</div>
      </div>
      <div class="review-bulk-btns">
        <button class="btn-approve-all" onclick="approveAll()">✓ Approve All</button>
        <button class="btn-skip-all" onclick="skipAll()">✗ Skip All</button>
      </div>
    </div>
    <div class="change-cards" id="change-cards"></div>
    <div class="apply-section" id="apply-section">
      <div class="apply-count" id="apply-count">Select pages to approve above</div>
      <button class="btn-apply btn-apply-zero" id="apply-btn" onclick="applyApproved()" disabled>Apply Approved Changes</button>
    </div>
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
      <div class="empty-logs">No logs yet — click "Run SEO Scan" to start!</div>
    </div>
  </div>

</div>

<script>
  const API_SECRET_CLIENT = '${API_SECRET}';
const SECRET = "${API_SECRET}";
let polling = null;
let wasRunning = false;
let pendingData = [];
let approvedSet = new Set(); // filePaths the user approved
let reviewRendered = false;

let scanMode = 'all';
  let globalKeywords = [];

  function setScanMode(mode) {
    scanMode = mode;
    document.getElementById('mode-all').classList.toggle('active', mode === 'all');
    document.getElementById('mode-specific').classList.toggle('active', mode === 'specific');
    document.getElementById('pages-field').style.display = mode === 'specific' ? 'block' : 'none';
  }

  function handleKwInput(e) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const val = e.target.value.trim();
    if (!val || globalKeywords.includes(val)) { e.target.value = ''; return; }
    globalKeywords.push(val);
    e.target.value = '';
    renderKwTags();
  }

  function removeKw(kw) {
    globalKeywords = globalKeywords.filter(k => k !== kw);
    renderKwTags();
  }

  function renderKwTags() {
    const el = document.getElementById('kw-tags');
    el.innerHTML = globalKeywords.map(kw =>
      '<span class="kw-tag">' + escapeHtml(kw) + '<span class="kw-tag-remove" onclick="removeKw(\'' + escapeHtml(kw) + '\')">×</span></span>'
    ).join('');
  }

  async function triggerScan() {
    if (isRunning) return;
    try {
      const targetPages = scanMode === 'specific'
        ? (document.getElementById('target-pages').value || '').split('\n').map(s => s.trim()).filter(Boolean)
        : [];
      const res = await fetch('/api/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-secret': API_SECRET_CLIENT },
        body: JSON.stringify({ targetPages, globalKeywords })
      });
      const data = await res.json();
      console.log('Scan triggered:', data);
      startPolling();
    } catch(e) { console.error('Failed to trigger scan', e); }
  }

async function applyApproved() {
  if (approvedSet.size === 0) {
    alert('No changes approved — select at least one page to apply!');
    return;
  }
  if (!confirm(\`Apply \${approvedSet.size} approved change(s) to GitHub? This will commit the updated SEO to your repo.\`)) return;

  document.getElementById('apply-btn').disabled = true;
  try {
    const res = await fetch('/api/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-secret': SECRET },
      body: JSON.stringify({ secret: SECRET, approved: [...approvedSet] })
    });
    const data = await res.json();
    if (data.status !== 'applying') {
      alert('Error: ' + data.message);
      document.getElementById('apply-btn').disabled = false;
      return;
    }
    document.getElementById('review-panel').style.display = 'none';
    startPolling();
  } catch (err) {
    alert('Error: ' + err.message);
    document.getElementById('apply-btn').disabled = false;
  }
}

function approve(filePath) {
  approvedSet.add(filePath);
  const card = document.getElementById('card-' + CSS.escape(filePath));
  if (card) {
    card.classList.add('approved');
    card.classList.remove('skipped');
    card.querySelector('.btn-approve').classList.add('active');
    card.querySelector('.btn-skip').classList.remove('active');
  }
  updateApplyBtn();
}

function skip(filePath) {
  approvedSet.delete(filePath);
  const card = document.getElementById('card-' + CSS.escape(filePath));
  if (card) {
    card.classList.add('skipped');
    card.classList.remove('approved');
    card.querySelector('.btn-skip').classList.add('active');
    card.querySelector('.btn-approve').classList.remove('active');
  }
  updateApplyBtn();
}

function approveAll() {
  pendingData.forEach(p => approve(p.filePath));
}

function skipAll() {
  pendingData.forEach(p => skip(p.filePath));
}

function updateApplyBtn() {
  const btn = document.getElementById('apply-btn');
  const count = document.getElementById('apply-count');
  const n = approvedSet.size;
  const total = pendingData.length;
  const skippedCount = total - n;

  if (n === 0) {
    btn.disabled = true;
    btn.className = 'btn-apply btn-apply-zero';
    count.innerHTML = \`<strong>0</strong> approved · \${total} pending\`;
  } else {
    btn.disabled = false;
    btn.className = 'btn-apply';
    count.innerHTML = \`<strong style="color:var(--success)">\${n} approved</strong> · \${skippedCount > 0 ? skippedCount + ' will be skipped' : 'all approved!'}\`;
  }
}

function renderPendingChanges(pending) {
  if (reviewRendered && pendingData.length === pending.length) return;
  reviewRendered = true;
  pendingData = pending;

  const panel = document.getElementById('review-panel');
  const cards = document.getElementById('change-cards');
  const title = document.getElementById('review-title');
  const subtitle = document.getElementById('review-subtitle');

  if (!pending || pending.length === 0) {
    panel.style.display = 'none';
    return;
  }

  panel.style.display = 'block';
  title.textContent = \`⚠ \${pending.length} Page\${pending.length > 1 ? 's' : ''} Need SEO Improvements\`;
  subtitle.textContent = 'Review the AI analysis below — approve to apply changes, or skip to leave as-is';

  cards.innerHTML = pending.map(p => {
    const a = p.analysis;
    const titleIssues = !a.titleOk ? a.basisTitle : null;
    const metaIssues = !a.metaOk ? a.basisMeta : null;

    const titleLenOld = a.titleLength;
    const titleLenNew = a.newTitleLength || a.newTitle.length;
    const metaLenOld = a.metaLength;
    const metaLenNew = a.newMetaLength || a.newMetaDesc.length;

    const titleField = !a.titleOk ? \`
      <div class="change-field">
        <div class="field-header">
          <div class="field-label">📌 Page Title</div>
          <div class="field-lengths">
            <span class="\${(titleLenOld >= 50 && titleLenOld <= 60) ? 'field-length-good' : 'field-length-bad'}">\${titleLenOld} chars</span>
            <span style="color:var(--muted)"> → </span>
            <span class="\${(titleLenNew >= 50 && titleLenNew <= 60) ? 'field-length-good' : 'field-length-bad'}">\${titleLenNew} chars</span>
          </div>
        </div>
        \${titleIssues ? \`<div class="field-issues">\${escapeHtml(titleIssues)}</div>\` : ''}
        <div class="comparison">
          <div class="comp-old">
            <div class="comp-label">Current (will be replaced)</div>
            <div class="comp-text">\${escapeHtml(p.oldTitle || '(empty)')}</div>
          </div>
          <div class="comp-arrow">→</div>
          <div class="comp-new">
            <div class="comp-label">AI suggestion</div>
            <div class="comp-text">\${escapeHtml(a.newTitle)}</div>
          </div>
        </div>
        <div class="ai-reason">
          <div class="ai-reason-label">🤖 AI Explanation</div>
          \${escapeHtml(a.reasonTitle)}
        </div>
      </div>\` : '';

    const metaField = !a.metaOk ? \`
      <div class="change-field">
        <div class="field-header">
          <div class="field-label">📝 Meta Description</div>
          <div class="field-lengths">
            <span class="\${(metaLenOld >= 150 && metaLenOld <= 160) ? 'field-length-good' : 'field-length-bad'}">\${metaLenOld} chars</span>
            <span style="color:var(--muted)"> → </span>
            <span class="\${(metaLenNew >= 150 && metaLenNew <= 160) ? 'field-length-good' : 'field-length-bad'}">\${metaLenNew} chars</span>
          </div>
        </div>
        \${metaIssues ? \`<div class="field-issues">\${escapeHtml(metaIssues)}</div>\` : ''}
        <div class="comparison">
          <div class="comp-old">
            <div class="comp-label">Current (will be replaced)</div>
            <div class="comp-text">\${escapeHtml(p.oldMeta || '(empty)')}</div>
          </div>
          <div class="comp-arrow">→</div>
          <div class="comp-new">
            <div class="comp-label">AI suggestion</div>
            <div class="comp-text">\${escapeHtml(a.newMetaDesc)}</div>
          </div>
        </div>
        <div class="ai-reason">
          <div class="ai-reason-label">🤖 AI Explanation</div>
          \${escapeHtml(a.reasonMeta)}
        </div>
      </div>\` : '';

    return \`
      <div class="change-card" id="card-\${CSS.escape(p.filePath)}">
        <div class="card-header">
          <div>
            <div class="card-file">📄 \${escapeHtml(p.filePath)}</div>
            <div class="card-url">\${escapeHtml(p.url)}</div>
            \${a.primaryKeyword ? \`<div class="card-keyword">🔑 \${escapeHtml(a.primaryKeyword)}</div>\` : ''}
          </div>
          <div class="card-btns">
            <button class="btn-approve" onclick="approve('\${p.filePath}')">✓ Approve</button>
            <button class="btn-skip" onclick="skip('\${p.filePath}')">✗ Skip</button>
          </div>
        </div>
        <div class="card-body">
          \${titleField}
          \${metaField}
        </div>
      </div>\`;
  }).join('');

  updateApplyBtn();
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function startPolling() {
  if (polling) clearInterval(polling);
  polling = setInterval(fetchStatus, 1500);
  fetchStatus();
}

async function fetchStatus() {
  try {
    const [statusRes, logsRes] = await Promise.all([
      fetch('/api/status'),
      fetch('/api/logs')
    ]);
    const status = await statusRes.json();
    const logsData = await logsRes.json();
    updateUI(status, logsData);

    // Fetch pending changes if scan is done
    if (status.scanComplete && status.pendingCount > 0) {
      const pendRes = await fetch('/api/pending');
      const pendData = await pendRes.json();
      renderPendingChanges(pendData.pending);
    }
  } catch {}
}

function updateUI(status, logsData) {
  const btn = document.getElementById('run-btn');
  const btnText = document.getElementById('btn-text');
  const btnIcon = document.getElementById('btn-icon');
  const statusDot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');
  const scheduleInfo = document.getElementById('schedule-info');

  // Update pending stat
  document.getElementById('stat-pending').textContent = status.scanComplete ? (status.pendingCount || '0') : '—';

  if (status.isScanning) {
    wasRunning = true;
    btn.disabled = true;
    btn.classList.add('running');
    btnIcon.outerHTML = '<div class="spinner" id="btn-icon"></div>';
    btnText.textContent = 'Scanning Pages...';
    statusDot.className = 'status-dot running';
    statusText.textContent = 'Scanning';
    scheduleInfo.textContent = 'AI is analyzing your pages...';
  } else if (status.isApplying) {
    wasRunning = true;
    btn.disabled = true;
    btn.classList.add('running');
    const iconEl = document.getElementById('btn-icon');
    if (iconEl) iconEl.outerHTML = '<div class="spinner" id="btn-icon"></div>';
    btnText.textContent = 'Applying Changes...';
    statusDot.className = 'status-dot running';
    statusText.textContent = 'Applying';
    scheduleInfo.textContent = 'Committing approved changes to GitHub...';
  } else if (status.scanComplete && status.pendingCount > 0) {
    btn.disabled = false;
    btn.classList.remove('running');
    const iconEl = document.getElementById('btn-icon');
    if (iconEl) iconEl.outerHTML = '<span id="btn-icon">🔍</span>';
    btnText.textContent = 'Re-Scan Pages';
    statusDot.className = 'status-dot review';
    statusText.textContent = 'Review Pending';
    scheduleInfo.textContent = \`\${status.pendingCount} page(s) need your review — approve or skip below\`;
  } else {
    btn.disabled = false;
    btn.classList.remove('running');
    const iconEl = document.getElementById('btn-icon');
    if (iconEl) iconEl.outerHTML = '<span id="btn-icon">🔍</span>';
    btnText.textContent = 'Run SEO Scan';
    statusDot.className = 'status-dot idle';
    statusText.textContent = 'Idle';
    scheduleInfo.textContent = 'Scans all pages · You approve before anything changes';

    if (wasRunning && !status.isApplying && !status.isScanning) {
      wasRunning = false;
      if (polling) { clearInterval(polling); polling = null; }
    }
  }

  if (status.lastResult) {
    document.getElementById('stat-updated').textContent = status.lastResult.changed;
    document.getElementById('stat-good').textContent = status.lastResult.skipped;
    document.getElementById('stat-errors').textContent = status.lastResult.errors;

    const lastRunEl = document.getElementById('last-run');
    lastRunEl.style.display = 'flex';
    document.getElementById('last-run-date').textContent = status.lastResult.runDate + ' · ' + status.lastResult.duration + 's';

    document.getElementById('result-pills').innerHTML = \`
      <span class="pill pill-green">✓ \${status.lastResult.changed} applied</span>
      <span class="pill pill-warn">⏭ \${status.lastResult.rejected || 0} skipped</span>
      <span class="pill pill-purple">◎ \${status.lastResult.skipped} good</span>
      \${status.lastResult.errors > 0 ? \`<span class="pill pill-red">✗ \${status.lastResult.errors} errors</span>\` : ''}
    \`;
  }

  // Update logs
  const logsBody = document.getElementById('logs-body');
  const logCount = document.getElementById('log-count');

  if (logsData.logs && logsData.logs.length > 0) {
    logCount.textContent = logsData.logs.length + ' lines';
    logsBody.innerHTML = logsData.logs.map(l => {
      const time = new Date(l.time).toLocaleTimeString('en-US', { hour12: false });
      return \`<div class="log-line"><span class="log-time">\${time}</span><span class="log-msg \${l.type}">\${escapeHtml(l.msg)}</span></div>\`;
    }).join('');
    logsBody.scrollTop = logsBody.scrollHeight;
  }
}

// Poll on load to restore state
startPolling();
</script>
</body>
</html>`);
});

// ── Start server + cron ───────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 SEO Monitor Dashboard running on port ${PORT}`);
  console.log(`   Dashboard: http://localhost:${PORT}`);
  console.log(`   Scan: POST /api/run (x-api-secret header)`);
  console.log(`   Approve: POST /api/approve { approved: [...filePaths] }\n`);
});

// Daily cron — scans but does NOT auto-commit (needs manual approval via dashboard)
const schedule = process.env.CRON_SCHEDULE || "0 7 * * *";
cron.schedule(schedule, () => {
  console.log("Cron triggered — running SEO scan...");
  runSEOScan().catch(console.error);
});

// RUN_NOW for testing
if (process.env.RUN_NOW === "true") {
  console.log("RUN_NOW=true detected — starting scan in 3 seconds...");
  setTimeout(() => runSEOScan().catch(console.error), 3000);
}
