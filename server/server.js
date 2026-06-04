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
      generateCustom: series === "Large Employer",
      standardQuestions: questionList.length ? questionList : undefined,
    });
  } catch (e) {
    console.error("config error", e);
    res.json(DEFAULT_CONFIG);
  }
});

/* ----------------------------------------------------------
   Airtable helpers (read/write a single record by id).
---------------------------------------------------------- */
async function airtableGetRecord(table, id) {
  const url = `${AIRTABLE_API}/${AIRTABLE_BASE_ID}/${encodeURIComponent(table)}/${id}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` } });
  if (!r.ok) throw new Error(`airtable get ${r.status}: ${await r.text()}`);
  return r.json();
}

async function airtablePatchRecord(table, id, fields) {
  const url = `${AIRTABLE_API}/${AIRTABLE_BASE_ID}/${encodeURIComponent(table)}/${id}`;
  const r = await fetch(url, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ fields, typecast: true }),
  });
  if (!r.ok) throw new Error(`airtable patch ${r.status}: ${await r.text()}`);
  return r.json();
}

function extractLinks(payload) {
  const blob = JSON.stringify(payload || {});
  const urls = new Set();
  const re = /https?:\/\/[^\s"'<>\\]+/g;
  let m;
  while ((m = re.exec(blob))) urls.add(m[0]);
  return [...urls];
}

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

/* ----------------------------------------------------------
   /api/submit — writes the completed submission directly into
   the Airtable "Submissions" table. A new record there is the
   trigger that kicks off the editorial pipeline.
---------------------------------------------------------- */
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
      return res.json({ ok: true, stored: "log" });
    }

    const data = await r.json();
    res.json({ ok: true, stored: "airtable", id: data.id });
  } catch (e) {
    console.error("submit error", e, "PAYLOAD:", JSON.stringify(req.body));
    res.json({ ok: true, stored: "log" });
  }
});

/* ----------------------------------------------------------
   /api/review — AI editorial review pass.
   Zapier POSTs { recordId } when a new Submissions row appears.
   We respond immediately, then (in the background) read the
   Raw Q&A JSON, run a verbatim-preserving Claude review that
   ONLY fixes mechanical errors and FLAGS everything else, write
   Reviewed Q&A / Changes Made / Flags Raised back to the row,
   and set Status = "In Review".
---------------------------------------------------------- */
const REVIEW_SYSTEM = `You are an editorial reviewer for Wealthtender preparing a financial advisor's Q&A submission for publication. Advisor answers are published in their own words. You do NOT rewrite or improve their writing.

Rules:
- Preserve the advisor's wording, voice, sentence structure, and HTML markup EXACTLY, except to correct unambiguous mechanical errors: clear typos, misspellings, doubled words, obviously wrong or missing punctuation/capitalization, and broken HTML tags.
- Do NOT rephrase, condense, expand, reorder, or "improve" any sentence. If wording is awkward but not a mechanical error, leave it unchanged and FLAG it instead.
- Never change numbers, figures, dates, names, firm names, product names, or factual claims. If a figure or claim looks outdated or possibly inaccurate (especially YMYL tax/financial figures such as contribution limits, tax brackets, or rules), do NOT change it; FLAG it for human verification.
- Preserve every hyperlink exactly (same href and same anchor text).
- Treat "proposed" items (advisor-suggested questions) the same way as standard answers.
- For any skipped or empty answer, return correctedAnswerHtml as "" and add a flag noting it is empty/skipped.

Return ONLY valid JSON (no markdown, no commentary) in EXACTLY this schema:
{
  "items": [
    {
      "question": "<the question, verbatim>",
      "kind": "standard | proposed",
      "correctedAnswerHtml": "<the answer HTML with ONLY mechanical fixes applied>",
      "changes": ["<each change as: \\"before\\" -> \\"after\\"">],
      "flags": ["<each thing you did NOT change but a human should review>"]
    }
  ],
  "overallFlags": ["<any cross-cutting concern>"],
  "externalLinks": [{ "url": "<url>", "note": "<ok | verify destination | missing UTM | other>" }]
}`;

async function callClaudeJSON(system, userText, maxTokens = 8000) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: userText }],
    }),
  });
  const data = await r.json();
  const text = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  const clean = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  return JSON.parse(clean);
}

async function safePatch(table, id, fields) {
  try {
    await airtablePatchRecord(table, id, fields);
  } catch (e) {
    console.error("review: writeback failed", id, e, JSON.stringify(fields).slice(0, 300));
  }
}

async function reviewSubmission(recordId) {
  const table = AIRTABLE_SUBMISSIONS_TABLE;
  let rec;
  try {
    rec = await airtableGetRecord(table, recordId);
  } catch (e) {
    console.error("review: cannot read record", recordId, e);
    return;
  }
  const f = rec.fields || {};
  let payload = {};
  try {
    payload = JSON.parse(f["Raw Q&A (JSON)"] || "{}");
  } catch {
    payload = {};
  }
  const entity = f["Entity"] || payload.entity || "";
  const series = f["Series"] || payload.series || "";
  const answers = Array.isArray(payload.answers) ? payload.answers : [];
  const proposed = Array.isArray(payload.proposed) ? payload.proposed : [];
  const userText =
    "Review this submission and return the JSON described in the system prompt.\n\nSUBMISSION:\n" +
    JSON.stringify({ entity, series, answers, proposed }, null, 2);

  let review;
  try {
    review = await callClaudeJSON(REVIEW_SYSTEM, userText);
  } catch (e) {
    console.error("review: model/parse failed", recordId, e);
    await safePatch(table, recordId, {
      "Flags Raised":
        "\u26A0\uFE0F Automated review could not complete (" +
        String(e).slice(0, 160) +
        "). Please review this submission manually.",
      "Status": "In Review",
    });
    return;
  }

  const items = Array.isArray(review.items) ? review.items : [];

  const reviewedText =
    items
      .map((it, i) => {
        const tag = it.kind === "proposed" ? " [Proposed by advisor]" : "";
        const ans = (it.correctedAnswerHtml || "").trim() || "(no answer \u2014 skipped/empty)";
        return `Q${i + 1}${tag}: ${it.question || ""}\n\nA${i + 1}: ${ans}`;
      })
      .join("\n\n\u2014\u2014\u2014\n\n") || "(no items found in submission)";

  const changeLines = [];
  items.forEach((it, i) => (it.changes || []).forEach((c) => changeLines.push(`\u2022 Q${i + 1}: ${c}`)));
  const changesText = changeLines.length ? changeLines.join("\n") : "No mechanical corrections were needed.";

  const flagLines = [];
  items.forEach((it, i) => (it.flags || []).forEach((fl) => flagLines.push(`\u2022 Q${i + 1}: ${fl}`)));
  (review.overallFlags || []).forEach((fl) => flagLines.push(`\u2022 ${fl}`));
  (review.externalLinks || []).forEach((l) => {
    if (l && l.note && !/^ok$/i.test(String(l.note).trim())) flagLines.push(`\u2022 Link ${l.url}: ${l.note}`);
  });
  const flagsText = flagLines.length ? flagLines.join("\n") : "No flags raised. Spot-check before approving.";

  await safePatch(table, recordId, {
    "Reviewed Q&A": reviewedText.slice(0, 95000),
    "Changes Made": changesText.slice(0, 95000),
    "Flags Raised": flagsText.slice(0, 95000),
    "Status": "In Review",
  });
  console.log(`review complete ${recordId}: ${changeLines.length} changes, ${flagLines.length} flags`);
}

app.post("/api/review", async (req, res) => {
  const recordId = (req.body && (req.body.recordId || req.body.id)) || "";
  if (!recordId) return res.status(400).json({ error: "missing recordId" });
  if (!ANTHROPIC_API_KEY || !AIRTABLE_API_KEY || !AIRTABLE_BASE_ID)
    return res.status(500).json({ error: "server not configured for review" });
  // Acknowledge immediately; do the model call + write-back in the background.
  res.json({ ok: true, queued: true, recordId });
  reviewSubmission(recordId).catch((e) => console.error("review background error", recordId, e));
});

/* ----------------------------------------------------------
   Serve the built React app and let client-side routing work.
---------------------------------------------------------- */
const dist = path.join(__dirname, "..", "dist");
app.use(express.static(dist));
app.get("*", (_req, res) => res.sendFile(path.join(dist, "index.html")));

app.listen(PORT, () => console.log(`Wealthtender advisor intake running on port ${PORT}`));
