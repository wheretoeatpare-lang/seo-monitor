const Groq = require("groq-sdk");

const PROVIDER = process.env.AI_PROVIDER || "groq";
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";

class SEOChecker {
  constructor() {
    if (PROVIDER === "groq") {
      this.groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
    } else {
      const axios = require("axios");
      this.anthropic = axios.create({
        baseURL: "https://api.anthropic.com/v1",
        headers: {
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
      });
    }
    console.log(`  AI: ${PROVIDER.toUpperCase()} (${PROVIDER === "groq" ? GROQ_MODEL : "claude-sonnet-4"})`);
  }

  async _chat(prompt, maxTokens = 800) {
    if (PROVIDER === "groq") {
      const res = await this.groq.chat.completions.create({
        model: GROQ_MODEL,
        max_tokens: maxTokens,
        messages: [{ role: "user", content: prompt }],
      });
      return res.choices[0].message.content.trim();
    } else {
      const res = await this.anthropic.post("/messages", {
        model: "claude-sonnet-4-20250514",
        max_tokens: maxTokens,
        messages: [{ role: "user", content: prompt }],
      });
      return res.data.content[0].text.trim();
    }
  }

  _parseJSON(text) {
    return JSON.parse(text.replace(/```json|```/g, "").trim());
  }

  // Analyze SEO fields with detailed reasoning — does NOT apply changes
  async checkAndRewrite(title, metaDesc, url, pageContent, targetKeywords = []) {

    const kwContext = targetKeywords.length > 0
      ? `\n\nTARGET KEYWORDS (you MUST incorporate these into the title and meta description):\n${targetKeywords.map(k => `  - "${k}"`).join('\n')}`
      : '';
    const prompt = `You are a senior SEO consultant. Analyze these SEO meta fields and determine if they need improvement. Be SPECIFIC about why changes are needed and cite the exact SEO rules being violated.

URL: ${url}
Current title: "${title}"
Current meta description: "${metaDesc}"
Page content snippet: "${pageContent.slice(0, 600)}"

━━━ SEO STANDARDS TO EVALUATE ━━━

TITLE RULES:
1. Length: Must be 50–60 characters. Under 50 = too short (wastes SERP real estate). Over 60 = truncated in Google results.
2. Primary keyword: Must include the main keyword inferred from the page content/URL. Missing keyword = lost ranking signal.
3. Relevance: Must accurately match what the page is actually about. Generic or vague titles hurt CTR.
4. Brand: Ideally includes brand name (especially for homepage/landing pages).
5. Clarity: Should be compelling and descriptive enough to earn a click.

META DESCRIPTION RULES:
1. Length: Must be 150–160 characters. Under 150 = missed engagement opportunity. Over 160 = Google truncates it.
2. Primary keyword: Must include the main keyword naturally. Keyword in meta description boosts relevance signal.
3. Call-to-action: Must have an explicit CTA like "Learn more", "Get started", "Discover", "Try free", "See how", etc.
4. Accuracy: Must accurately summarize the page content — not generic filler text.
5. Engagement: Should be written to earn clicks from search results.

━━━ TASK ━━━
For each field, diagnose ALL issues found and explain clearly WHY a change is needed. If a field is already perfect, say so.

${kwContext}

Return ONLY valid JSON (no markdown, no extra text):
{
  "titleOk": true or false,
  "metaOk": true or false,
  "needsChange": true or false,
  "newTitle": "improved title if needed, or exact same string if ok",
  "newMetaDesc": "improved meta if needed, or exact same string if ok",
  "primaryKeyword": "the main keyword you identified for this page from content/URL",
  "reasonTitle": "Plain-English explanation of what is wrong and why the new version is better. Be specific. E.g.: 'The current title is only 38 characters — well below the 50–60 optimal range — and does not include the primary keyword. The new version is 54 characters, includes the keyword, and adds a brand mention.' If ok, say: 'Title meets all SEO standards — correct length, keyword present, descriptive.'",
  "basisTitle": "Bullet-point list of rules violated. E.g.: '• Length: 38 chars (needs 50–60)\\n• Missing keyword: SEO tools\\n• No brand name'. If none: 'All rules passed'",
  "reasonMeta": "Plain-English explanation of what is wrong and why the new version is better. Be specific. If ok, say: 'Meta description meets all SEO standards — correct length, keyword present, has CTA, accurate.'",
  "basisMeta": "Bullet-point list of rules violated. E.g.: '• Length: 120 chars (needs 150–160)\\n• No call-to-action\\n• Keyword missing'. If none: 'All rules passed'",
  "titleLength": current title character count as number,
  "metaLength": current meta description character count as number,
  "newTitleLength": new title character count as number,
  "newMetaLength": new meta description character count as number
}`;

    const text = await this._chat(prompt, 800);
    return this._parseJSON(text);
  }
}

module.exports = SEOChecker;
