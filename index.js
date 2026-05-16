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

function addLog(msg, type = "info") {
  const entry = { time: new Date().toISOString(), msg, type };
  logs.push(entry);
  if (logs.length > 200) logs = logs.slice(-200);
  console.log(`[${type.toUpperCase()}] ${msg}`);
}

// ── SEO Monitor Core ─────────────────────────────────────────────────────────
async function runSEOMonitor() {
  if (isRunning) {
    addLog("Already running — skipped duplicate trigger", "warn");
    return;
  }

  isRunning = true;
  logs = [];
  const startTime = Date.now();

  const runDate = new Date().toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });

  addLog(`SEO Monitor started: ${runDate}`, "info");
  addLog(`Site: ${SITE_URL}`, "info");

  const changed = [];
  const skipped = [];
  const errors = [];

  try {
    addLog("Fetching HTML files from GitHub repo...", "info");
    const htmlFiles = await github.getAllHtmlFiles();
    addLog(`Found ${htmlFiles.length} HTML files`, "info");

    for (const file of htmlFiles) {
      try {
        const { content, sha } = await github.getFile(file.path);
        const seo = github.parseSEO(content, file.path, SITE_URL);
        const $ = cheerio.load(content);
        const pageText = $("body").text().replace(/\s+/g, " ").trim().slice(0, 500);

        addLog(`Checking: ${file.path}`, "info");
        addLog(`  Title (${seo.title.length} chars): "${seo.title.slice(0, 60)}"`, "info");
        addLog(`  Meta (${seo.metaDesc.length} chars): "${seo.metaDesc.slice(0, 60)}"`, "info");

        const pageKws = pageKeywords[file.path] || [];
        const allKeywords = [...new Set([...globalKeywords, ...pageKws])];
        if (allKeywords.length > 0) addLog(`  Target keywords: ${allKeywords.join(", ")}`, "info");
        const analysis = await seoChecker.checkAndRewrite(
          seo.title, seo.metaDesc, seo.url, pageText, allKeywords
        );

        if (analysis.needsChange) {
          const updatedHtml = github.applySEO(content, analysis.newTitle, analysis.newMetaDesc);
          const commitMsg = `🤖 SEO update: ${file.path} — auto-optimized title/meta`;
          await github.updateFile(file.path, updatedHtml, sha, commitMsg);
          changed.push({ filePath: file.path, url: seo.url, oldTitle: seo.title, oldMeta: seo.metaDesc, analysis });
          addLog(`  ✓ Updated and committed to GitHub!`, "success");
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

    addLog("Sending email report...", "info");
    await mailer.sendReport({ changed, skipped, errors, runDate, siteUrl: SITE_URL });
    addLog("Email report sent!", "success");

  } catch (err) {
    addLog(`Fatal error: ${err.message}`, "error");
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  lastResult = { changed: changed.length, skipped: skipped.length, errors: errors.length, duration, runDate };
  lastRun = new Date().toISOString();
  isRunning = false;

  addLog(`Done! Updated: ${changed.length}, Good: ${skipped.length}, Errors: ${errors.length} (${duration}s)`, "success");
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── API Routes ───────────────────────────────────────────────────────────────
app.use(express.json());

// Trigger automation
app.post("/api/run", (req, res) => {
  const secret = req.headers["x-api-secret"] || req.body?.secret;
  if (secret !== API_SECRET) return res.status(401).json({ error: "Unauthorized" });
  if (isRunning) return res.json({ status: "already_running", message: "SEO monitor is already running!" });
  runSEOMonitor().catch(console.error);
  res.json({ status: "started", message: "SEO monitor started!" });
});

// Get status
app.get("/api/status", (req, res) => {
  res.json({ isRunning, lastRun, lastResult, logCount: logs.length });
});

// Get logs
app.get("/api/logs", (req, res) => {
  res.json({ logs, isRunning });
});


// Config endpoint
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

  /* Background grid */
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

  .wrap { position: relative; z-index: 1; max-width: 900px; margin: 0 auto; padding: 40px 24px; }

  /* Header */
  .header { margin-bottom: 40px; }
  .header-top { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 8px; }
  .logo { font-size: 11px; font-family: 'Space Mono', monospace; color: var(--accent2); letter-spacing: .15em; text-transform: uppercase; margin-bottom: 8px; }
  .title { font-size: 36px; font-weight: 800; line-height: 1.1; }
  .title span { color: var(--accent); }
  .subtitle { font-size: 14px; color: var(--muted); margin-top: 8px; font-family: 'Space Mono', monospace; }
  .site-badge { display: inline-flex; align-items: center; gap: 6px; background: var(--surface2); border: 1px solid var(--border); border-radius: 99px; padding: 6px 14px; font-size: 12px; font-family: 'Space Mono', monospace; color: var(--accent2); }
  .dot-live { width: 7px; height: 7px; border-radius: 50%; background: var(--accent2); animation: pulse 2s infinite; }
  @keyframes pulse { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:.5;transform:scale(1.3)} }

  /* Stats */
  .stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 24px; }
  .stat { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 20px; }
  .stat-val { font-size: 32px; font-weight: 800; line-height: 1; margin-bottom: 4px; }
  .stat-label { font-size: 12px; color: var(--muted); font-family: 'Space Mono', monospace; text-transform: uppercase; letter-spacing: .08em; }
  .stat-val.green { color: var(--success); }
  .stat-val.purple { color: var(--accent); }
  .stat-val.red { color: var(--error); }

  /* Run button */
  .run-section { margin-bottom: 24px; }
  .run-btn {
    width: 100%; padding: 20px; font-size: 18px; font-weight: 800;
    font-family: 'Syne', sans-serif; letter-spacing: .04em;
    background: var(--accent); color: #fff; border: none; border-radius: 12px;
    cursor: pointer; transition: all .2s; display: flex; align-items: center; justify-content: center; gap: 10px;
    position: relative; overflow: hidden;
  }
  .run-btn::before {
    content: ''; position: absolute; inset: 0;
    background: linear-gradient(135deg, rgba(255,255,255,.1), transparent);
    opacity: 0; transition: opacity .2s;
  }
  .run-btn:hover::before { opacity: 1; }
  .run-btn:hover { transform: translateY(-2px); box-shadow: 0 8px 30px rgba(124,92,252,.4); }
  .run-btn:active { transform: translateY(0); }
  .run-btn:disabled { opacity: .5; cursor: not-allowed; transform: none; box-shadow: none; }
  .run-btn.running { background: var(--surface2); border: 1px solid var(--border); color: var(--muted); }

  .spinner { width: 18px; height: 18px; border: 2px solid rgba(255,255,255,.3); border-top-color: #fff; border-radius: 50%; animation: spin .7s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* Schedule info */
  .schedule-info { margin-top: 10px; text-align: center; font-size: 12px; color: var(--muted); font-family: 'Space Mono', monospace; }

  /* Last run */
  .last-run { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 16px 20px; margin-bottom: 24px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; }
  .last-run-label { font-size: 12px; color: var(--muted); font-family: 'Space Mono', monospace; text-transform: uppercase; letter-spacing: .08em; margin-bottom: 4px; }
  .last-run-val { font-size: 14px; font-weight: 600; }
  .result-pills { display: flex; gap: 8px; flex-wrap: wrap; }
  .pill { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; padding: 4px 12px; border-radius: 99px; font-family: 'Space Mono', monospace; font-weight: 700; }
  .pill-green { background: rgba(0,229,176,.1); color: var(--success); border: 1px solid rgba(0,229,176,.2); }
  .pill-purple { background: rgba(124,92,252,.1); color: var(--accent); border: 1px solid rgba(124,92,252,.2); }
  .pill-red { background: rgba(255,77,109,.1); color: var(--error); border: 1px solid rgba(255,77,109,.2); }

  /* Logs */
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

  /* Status indicator */
  .status-bar { display: flex; align-items: center; gap: 8px; font-size: 12px; font-family: 'Space Mono', monospace; }
  .status-dot { width: 8px; height: 8px; border-radius: 50%; }
  .status-dot.running { background: var(--warn); animation: pulse 1s infinite; }
  .status-dot.idle { background: var(--success); }

  .scan-options { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 20px 24px; margin-bottom: 16px; }
  .scan-options-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .12em; color: var(--accent); font-family: 'Space Mono', monospace; margin-bottom: 14px; }
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
  .scan-mode-toggle { display: flex; gap: 8px; margin-bottom: 14px; }
  .scan-mode-btn { flex: 1; padding: 8px; font-size: 12px; font-weight: 700; font-family: 'Space Mono', monospace; border-radius: 8px; border: 1px solid var(--border); background: var(--surface2); color: var(--muted); cursor: pointer; transition: all .2s; appearance: none; }
  .scan-mode-btn.active { background: rgba(124,92,252,.2); border-color: var(--accent); color: var(--accent); }
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
    <div class="stat">
      <div class="stat-val green" id="stat-updated">—</div>
      <div class="stat-label">Pages Updated</div>
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
    <button class="run-btn" id="run-btn" onclick="triggerRun()">
      <span id="btn-icon">▶</span>
      <span id="btn-text">Run SEO Monitor Now</span>
    </button>
    <div class="schedule-info" id="schedule-info">Runs automatically every day at 7:00 AM</div>
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

// Daily cron
const schedule = process.env.CRON_SCHEDULE || "0 7 * * *";
cron.schedule(schedule, () => {
  console.log("Cron triggered — running SEO monitor...");
  runSEOMonitor().catch(console.error);
});

// RUN_NOW for testing
if (process.env.RUN_NOW === "true") {
  console.log("RUN_NOW=true detected — starting in 3 seconds...");
  setTimeout(() => runSEOMonitor().catch(console.error), 3000);
}
