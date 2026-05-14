const axios = require("axios");
const cheerio = require("cheerio");

class GitHubClient {
  constructor(token, owner, repo, branch = "main") {
    this.owner = owner;
    this.repo = repo;
    this.branch = branch;
    this.client = axios.create({
      baseURL: "https://api.github.com",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
  }

  // Get all HTML files in the repo
  async getAllHtmlFiles(path = "") {
    const htmlFiles = [];
    try {
      const res = await this.client.get(
        `/repos/${this.owner}/${this.repo}/contents/${path}`,
        { params: { ref: this.branch } }
      );
      for (const item of res.data) {
        if (item.type === "file" && item.name.endsWith(".html")) {
          htmlFiles.push(item);
        } else if (item.type === "dir") {
          // Recurse into subdirectories
          const subFiles = await this.getAllHtmlFiles(item.path);
          htmlFiles.push(...subFiles);
        }
      }
    } catch (err) {
      console.error(`  Error reading ${path}: ${err.message}`);
    }
    return htmlFiles;
  }

  // Get file content and SHA (SHA needed to update file)
  async getFile(filePath) {
    const res = await this.client.get(
      `/repos/${this.owner}/${this.repo}/contents/${filePath}`,
      { params: { ref: this.branch } }
    );
    const content = Buffer.from(res.data.content, "base64").toString("utf8");
    return { content, sha: res.data.sha, path: filePath };
  }

  // Update file content via GitHub API
  async updateFile(filePath, newContent, sha, commitMessage) {
    const encoded = Buffer.from(newContent).toString("base64");
    await this.client.put(
      `/repos/${this.owner}/${this.repo}/contents/${filePath}`,
      {
        message: commitMessage,
        content: encoded,
        sha,
        branch: this.branch,
      }
    );
  }

  // Parse SEO fields from HTML
  parseSEO(html, filePath, siteUrl) {
    const $ = cheerio.load(html);
    const title = $("title").text().trim();
    const metaDesc = $('meta[name="description"]').attr("content") || "";
    const slug = filePath.replace("index.html", "").replace(".html", "");
    const url = `${siteUrl.replace(/\/$/, "")}/${slug}`.replace(/\/+/g, "/").replace(":/", "://");

    return { title, metaDesc, filePath, url };
  }

  // Apply new SEO to HTML content
  applySEO(html, newTitle, newMetaDesc) {
    const $ = cheerio.load(html, { decodeEntities: false });

    // Update title
    if ($("title").length) {
      $("title").text(newTitle);
    } else {
      $("head").prepend(`<title>${newTitle}</title>`);
    }

    // Update or add meta description
    if ($('meta[name="description"]').length) {
      $('meta[name="description"]').attr("content", newMetaDesc);
    } else {
      $("head").append(`<meta name="description" content="${newMetaDesc}">`);
    }

    return $.html();
  }
}

module.exports = GitHubClient;
