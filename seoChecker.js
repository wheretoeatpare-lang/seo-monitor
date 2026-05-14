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

  async _chat(prompt, maxTokens = 500) {
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

  // Check if SEO is good and rewrite if needed
  async checkAndRewrite(title, metaDesc, url, pageContent) {
    const prompt = `You are an SEO expert. Analyze these SEO fields for this page and determine if they need improvement.

URL: ${url}
Current title: "${title}"
Current meta description: "${metaDesc}"
Page content snippet: "${pageContent.slice(0, 500)}"

SEO rules to check:
- Title: 50-60 characters, includes main keyword, descriptive
- Meta description: 150-160 characters, compelling, includes keyword, has call to action
- Both should accurately describe the page content

Return ONLY valid JSON:
{
  "titleOk": true or false,
  "metaOk": true or false,
  "needsChange": true or false,
  "newTitle": "improved title if needed, or same if ok",
  "newMetaDesc": "improved meta if needed, or same if ok",
  "reasonTitle": "why title was changed or 'No change needed'",
  "reasonMeta": "why meta was changed or 'No change needed'",
  "titleLength": number,
  "metaLength": number
}

No markdown, no explanation, just JSON.`;

    const text = await this._chat(prompt, 500);
    return this._parseJSON(text);
  }
}

module.exports = SEOChecker;
