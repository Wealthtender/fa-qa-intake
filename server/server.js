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
  AIRTABLE_SUBMISSIONS_TABLE = "Submissions",
  PORT = 3000,
} = process.env;

const AIRTABLE_API = "https://api.airtable.com/v0";

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
    const url = `${AIRTABLE_API}/${AIRTABLE_BASE_ID}/${encodeURIComponent(
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
   /api/submit — writes the completed submission directly into
   the Airtable "Submissions" table. A new record there is the
   trigger that kicks off the editorial pipeline (Asana task,
   review, etc.) via the existing Airtable-triggered Zap.
   If Airtable isn't configured or the write fails, the full
   payload is logged so an advisor's work is never lost.
---------------------------------------------------------- */

// Pull every URL out of the payload so the reviewer can eyeball
// advisor-supplied links at a glance.
function extractLinks(payload) {
  const blob = JSON.stringify(payload || {});
  const urls = new Set();
  const re = /https?:\/\/[^\s"'<>\\]+/g;
  let m;
  while ((m = re.exec(blob))) urls.add(m[0]);
  return [...urls];
}

// Resolve the Articles record so the submission can be linked to it.
async function findArticleRecordId(articleId) {
  if (!articleId || !AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) return null;
  try {
    const formula = encodeURIComponent(`{Article ID}='${articleId}'`);
    const url = `${AIRTABLE_API}/${AIRTABLE_BASE_ID}/${encodeURIComponent(
      AIRTABLE_ARTICLES_TABLE
    )}?filterByFormula=${formula}&maxRecords=1`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` } });
    const data = await r.json();
    return (data.records && data.records[0] && data.records[0].id) || null;
  } catch {
    return null;
  }
}

app.post("/api/submit", async (req, res) => {
  const payload = req.body || {};
  const {
    articleId = "",
    series = "",
    entity = "",
    complianceDisclosure = "",
    readyForPublication = false,
    submittedAt = new Date().toISOString(),
  } = payload;

  // No Airtable configured — don't lose the submission; log and ack.
  if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
    console.log("Submission received (Airtable not configured):", JSON.stringify(payload).slice(0, 2000));
    return res.json({ ok: true, stored: "log" });
  }

  try {
    const articleRecId = await findArticleRecordId(articleId);
    const fields = {
      "Submission Ref": `${articleId || "unknown"} \u2014 ${submittedAt}`,
      "Article ID": articleId,
      "Series": series,
      "Entity": entity,
      "Submitted At": submittedAt,
      "Raw Q&A (JSON)": JSON.stringify(payload, null, 2),
      "External Links": extractLinks(payload).join("\n"),
      "Compliance Disclosure": complianceDisclosure,
      "Ready For Publication": !!readyForPublication,
      "Status": "Submitted",
    };
    if (articleRecId) fields["Article"] = [articleRecId];

    const url = `${AIRTABLE_API}/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_SUBMISSIONS_TABLE)}`;
    const r = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${AIRTABLE_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ fields, typecast: true }),
    });

    if (!r.ok) {
      const errText = await r.text();
      console.error("airtable submit failed", r.status, errText, "PAYLOAD:", JSON.stringify(payload));
      return res.json({ ok: true, stored: "log" }); // ack so the advisor isn't blocked; payload is in logs
    }

    const data = await r.json();
    res.json({ ok: true, stored: "airtable", id: data.id });
  } catch (e) {
    console.error("submit error", e, "PAYLOAD:", JSON.stringify(req.body));
    res.json({ ok: true, stored: "log" });
  }
});

/* ----------------------------------------------------------
   Serve the built React app and let client-side routing work.
---------------------------------------------------------- */
const dist = path.join(__dirname, "..", "dist");
app.use(express.static(dist));
app.get("*", (_req, res) => res.sendFile(path.join(dist, "index.html")));

app.listen(PORT, () => console.log(`Wealthtender advisor intake running on port ${PORT}`));
