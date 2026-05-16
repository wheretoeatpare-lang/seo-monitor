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


// Config endpoint — injects API secret to client safely
app.get("/api/config", (req, res) => {
  res.json({ secret: API_SECRET });
});

// Serve client.js directly
const path = require("path");
app.get("/client.js", (req, res) => {
  res.setHeader("Content-Type", "application/javascript");
  res.sendFile(path.join(__dirname, "client.js"));
});


