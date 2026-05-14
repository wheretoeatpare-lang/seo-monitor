require("dotenv").config();
const cron = require("node-cron");
const cheerio = require("cheerio");
const GitHubClient = require("./githubClient");
const SEOChecker = require("./seoChecker");
const EmailReporter = require("./emailReporter");

const SITE_URL = process.env.SITE_URL || "https://ranksorcery.com/";

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

async function runSEOMonitor() {
  const runDate = new Date().toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });

  console.log(`\n========================================`);
  console.log(`SEO Monitor started: ${runDate}`);
  console.log(`Site: ${SITE_URL}`);
  console.log(`========================================\n`);

  const changed = [];
  const skipped = [];
  const errors = [];

  // Step 1: Get all HTML files from GitHub repo
  console.log("Step 1: Fetching HTML files from GitHub repo...");
  const htmlFiles = await github.getAllHtmlFiles();
  console.log(`  Found ${htmlFiles.length} HTML files\n`);

  // Step 2: Check each file
  console.log("Step 2: Checking SEO for each page...");
  for (const file of htmlFiles) {
    const label = file.path;
    try {
      // Get file content
      const { content, sha } = await github.getFile(file.path);

      // Parse SEO fields
      const seo = github.parseSEO(content, file.path, SITE_URL);

      // Get page text content for AI context
      const $ = cheerio.load(content);
      const pageText = $("body").text().replace(/\s+/g, " ").trim().slice(0, 500);

      console.log(`  Checking: ${label}`);
      console.log(`    Title (${seo.title.length} chars): "${seo.title.slice(0, 50)}..."`);
      console.log(`    Meta (${seo.metaDesc.length} chars): "${seo.metaDesc.slice(0, 50)}..."`);

      // AI checks and rewrites if needed
      const analysis = await seoChecker.checkAndRewrite(
        seo.title,
        seo.metaDesc,
        seo.url,
        pageText
      );

      if (analysis.needsChange) {
        // Apply new SEO to HTML
        const updatedHtml = github.applySEO(content, analysis.newTitle, analysis.newMetaDesc);

        // Commit to GitHub
        const commitMsg = `🤖 SEO update: ${file.path} — auto-optimized title/meta`;
        await github.updateFile(file.path, updatedHtml, sha, commitMsg);

        changed.push({
          filePath: file.path,
          url: seo.url,
          oldTitle: seo.title,
          oldMeta: seo.metaDesc,
          analysis,
        });

        console.log(`    ✓ Updated and committed!`);
      } else {
        skipped.push({ filePath: file.path, url: seo.url });
        console.log(`    ✓ SEO is good — no changes needed`);
      }

      await sleep(800);
    } catch (err) {
      console.error(`    ✗ Error: ${err.message}`);
      errors.push({ file: label, error: err.message });
    }
  }

  // Step 3: Send email report
  console.log(`\nStep 3: Sending email report...`);
  await mailer.sendReport({ changed, skipped, errors, runDate, siteUrl: SITE_URL });

  console.log(`\n========================================`);
  console.log(`DONE!`);
  console.log(`  Updated : ${changed.length} pages`);
  console.log(`  Good    : ${skipped.length} pages`);
  console.log(`  Errors  : ${errors.length}`);
  console.log(`========================================\n`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Run now or on schedule
const args = process.argv.slice(2);
const runNow = args.includes("--now") || process.env.RUN_NOW === "true";

if (runNow) {
  console.log("RUN_NOW detected — running SEO monitor immediately...");
  runSEOMonitor().catch(console.error);
} else {
  const schedule = process.env.CRON_SCHEDULE || "0 7 * * *";
  console.log(`SEO Monitor scheduler started.`);
  console.log(`Schedule: ${schedule}`);
  console.log(`Tip: Set RUN_NOW=true in Railway variables to trigger immediately.\n`);
  cron.schedule(schedule, () => runSEOMonitor().catch(console.error));
}
