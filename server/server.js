import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: "1mb" }));

const {
  ANTHROPIC_API_KEY,
  ANTHROPIC_MODEL = "claude-sonnet-4-20250514",
  AIRTABLE_API_KEY,
  AIRTABLE_BASE_ID,
  AIRTABLE_ARTICLES_TABLE = "Articles",
  ZAPIER_WEBHOOK_URL,
  PORT = 3000,
} = process.env;

/* ----------------------------------------------------------
   /api/claude — proxies the Anthropic Messages API so the
   API key never reaches the browser.
---------------------------------------------------------- */
app.post("/api/claude", async (req, res) => {
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: "missing ANTHROPIC_API_KEY" });
  try {
    const { system, messages, maxTokens = 1000 } = req.body || {};
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: maxTokens, system, messages }),
    });
    const data = await r.json();
    const text = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    res.json({ text });
  } catch (e) {
    console.error("claude error", e);
    res.status(500).json({ error: "claude_failed" });
  }
});

/* ----------------------------------------------------------
   /api/config — returns the article configuration for a given
   article ID, pulled from the Airtable "Articles" table.
   Falls back to a built-in default so the app runs before
   Airtable is wired up.
---------------------------------------------------------- */
const DEFAULT_CONFIG = {
  articleId: "EMPQA-2026-6-SPAC-1",
  series: "Large Employer",
  entity: "SpaceX",
  audience: "employees and executives",
  audienceShort: "employees",
  advisorFirstName: "there",
  generateCustom: true,
};

app.get("/api/config", async (req, res) => {
  const id = req.query.id;
  if (!id || !AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) return res.json(DEFAULT_CONFIG);
  try {
    const formula = encodeURIComponent(`{Article ID}='${id}'`);
    const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(
      AIRTABLE_ARTICLES_TABLE
    )}?filterByFormula=${formula}&maxRecords=1`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` } });
    const data = await r.json();
    const rec = data.records && data.records[0];
    if (!rec) return res.json(DEFAULT_CONFIG);
    const f = rec.fields || {};
    const series = f["Series"] || "Large Employer";
    const questionList = String(f["Question List"] || "")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    res.json({
      articleId: id,
      series,
      entity: f["Employer / Niche Name"] || DEFAULT_CONFIG.entity,
      audience: f["Audience Noun"] || "employees",
      audienceShort: f["Audience Short"] || "employees",
      advisorFirstName: f["Advisor First Name"] || "there",
      // Large Employer articles dynamically generate employer-specific
      // questions; Specialist articles use the curated list as-is.
      generateCustom: series === "Large Employer",
      standardQuestions: questionList.length ? questionList : undefined,
    });
  } catch (e) {
    console.error("config error", e);
    res.json(DEFAULT_CONFIG);
  }
});

/* ----------------------------------------------------------
   /api/submit — forwards the completed submission to the
   Zapier webhook that kicks off the editorial pipeline.
   If no webhook is configured, it just logs (so the app is
   fully usable before the pipeline is built).
---------------------------------------------------------- */
app.post("/api/submit", async (req, res) => {
  try {
    if (ZAPIER_WEBHOOK_URL) {
      await fetch(ZAPIER_WEBHOOK_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(req.body),
      });
    } else {
      console.log("Submission received (no ZAPIER_WEBHOOK_URL set):", JSON.stringify(req.body).slice(0, 1000));
    }
    res.json({ ok: true });
  } catch (e) {
    console.error("submit error", e);
    res.status(500).json({ error: "submit_failed" });
  }
});

/* ----------------------------------------------------------
   Serve the built React app and let client-side routing work.
---------------------------------------------------------- */
const dist = path.join(__dirname, "..", "dist");
app.use(express.static(dist));
app.get("*", (_req, res) => res.sendFile(path.join(dist, "index.html")));

app.listen(PORT, () => console.log(`Wealthtender advisor intake running on port ${PORT}`));
