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
      return res.status(502).json({ ok: false, stored: "log", error: "Could not save your submission to the database. It has been logged for recovery." });
    }

    const data = await r.json();
    res.json({ ok: true, stored: "airtable", id: data.id });
  } catch (e) {
    console.error("submit error", e, "PAYLOAD:", JSON.stringify(req.body));
    res.status(502).json({ ok: false, stored: "log", error: "Could not save your submission to the database. It has been logged for recovery." });
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
    review = await callClaudeJSON(REVIEW_SYSTEM, userText, 16000);
  } catch (e) {
    console.error("review: model/parse failed; using verbatim fallback", recordId, e);
    // Deterministic verbatim fallback: the automated mechanical pass could not
    // complete (e.g. very long/dense answers overran or malformed the model's
    // JSON echo). Build the Reviewed Q&A directly from the submitted answer HTML
    // so the row is still reviewable and downstream generation can parse it.
    // Verbatim is guaranteed because we use the stored submission text as-is.
    const fb = answers
      .map((a, i) => {
        const ans = ((a && a.answerHtml) || "").trim() || "(no answer \u2014 skipped/empty)";
        return `Q${i + 1}: ${(a && a.question) || ""}\n\nA${i + 1}: ${ans}`;
      })
      .concat(
        proposed.map((p, j) => {
          const ans = ((p && p.answerHtml) || "").trim() || "(no answer \u2014 skipped/empty)";
          return `Q${answers.length + j + 1} [Proposed by advisor]: ${(p && p.question) || ""}\n\nA${answers.length + j + 1}: ${ans}`;
        })
      )
      .join("\n\n\u2014\u2014\u2014\n\n") || "(no items found in submission)";
    await safePatch(table, recordId, {
      "Reviewed Q&A": fb.slice(0, 95000),
      "Changes Made":
        "Automated mechanical review was unavailable for this submission, so answers were stored verbatim with no corrections. A manual spot-check for typos/punctuation is recommended.",
      "Flags Raised":
        "\u26A0\uFE0F Automated mechanical/YMYL review could not complete (" +
        String(e).slice(0, 160) +
        "). Answers are stored verbatim; please review manually before approving.",
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
  const recordId = cleanRecordId(req.body && (req.body.recordId || req.body.id));
  if (!recordId) return res.status(400).json({ error: "missing recordId" });
  if (!ANTHROPIC_API_KEY || !AIRTABLE_API_KEY || !AIRTABLE_BASE_ID)
    return res.status(500).json({ error: "server not configured for review" });
  // Acknowledge immediately; do the model call + write-back in the background.
  res.json({ ok: true, queued: true, recordId });
  reviewSubmission(recordId).catch((e) => console.error("review background error", recordId, e));
});

/* ----------------------------------------------------------
   /api/generate — builds the publishable HTML blocks.
   Zapier POSTs { recordId } when a Submissions row is set to
   Status = "Approved". We respond immediately, then in the
   background: read the (Brian-reviewed) Reviewed Q&A, fetch the
   advisor's Wealthtender profile for headshot/firm/Book-Intro-Call,
   ask Claude for the derived prose (Key Takeaways + meta), and
   deterministically assemble three WP-ready blocks (intro teaser,
   Key Takeaways, advisor Q&A card). Writes Generated HTML +
   Suggested Headline / Meta Description / Suggested Slug, and sets
   Status = "HTML Ready". Verbatim answers are never altered.
---------------------------------------------------------- */

const PALETTE = {
  employer: { accent: "#1a5276", light: "#f4f8fb", border: "#dce4ec", divider: "#eef1f4" },
  specialist: { accent: "#1a6b65", light: "#eef6f5", border: "#cfe3e0", divider: "#e3eeec" },
};
const KT_FILL = "#f9f9fb";

const US_STATES = {
  "alabama":"AL","alaska":"AK","arizona":"AZ","arkansas":"AR","california":"CA","colorado":"CO",
  "connecticut":"CT","delaware":"DE","florida":"FL","georgia":"GA","hawaii":"HI","idaho":"ID",
  "illinois":"IL","indiana":"IN","iowa":"IA","kansas":"KS","kentucky":"KY","louisiana":"LA",
  "maine":"ME","maryland":"MD","massachusetts":"MA","michigan":"MI","minnesota":"MN","mississippi":"MS",
  "missouri":"MO","montana":"MT","nebraska":"NE","nevada":"NV","new hampshire":"NH","new jersey":"NJ",
  "new mexico":"NM","new york":"NY","north carolina":"NC","north dakota":"ND","ohio":"OH","oklahoma":"OK",
  "oregon":"OR","pennsylvania":"PA","rhode island":"RI","south carolina":"SC","south dakota":"SD",
  "tennessee":"TN","texas":"TX","utah":"UT","vermont":"VT","virginia":"VA","washington":"WA",
  "west virginia":"WV","wisconsin":"WI","wyoming":"WY","district of columbia":"DC",
};

const esc = (s = "") => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const cardText = (s = "") => esc(s).replace(/\u00AE/g, "&#174;").replace(/['\u2019]/g, "&#8217;");
const urlAttr = (u = "") => String(u).replace(/&/g, "&amp;");
const titleCase = (s = "") => String(s).toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
const slugify = (s = "") =>
  String(s).toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

// Profile pages serve text already HTML-encoded (e.g. "Proper Planning &amp; ..."),
// and some are double-encoded. Decode to plain text so downstream cardText() / JSON-LD
// produce a single correct encoding instead of "&amp;amp;". Runs a few passes to
// collapse multi-encoding. Not applied to advisor answer HTML (which stays verbatim).
function decodeOnce(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return _; } })
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(parseInt(d, 10)); } catch { return _; } })
    .replace(/&quot;/gi, '"').replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&");
}
const decodeEntities = (s = "") => {
  let prev = String(s), cur = decodeOnce(prev);
  for (let i = 0; i < 3 && cur !== prev; i++) { prev = cur; cur = decodeOnce(prev); }
  return cur.trim();
};

// Zapier's Airtable "New or Updated Record" trigger sends a COMPOSITE id of the
// form recXXXXXXXXXXXXXX-<lastModifiedTimestamp>. Some triggers may also pass a
// full record URL. Airtable record IDs are always "rec" + 14 alphanumerics, so
// extract that canonical id from whatever we receive.
const cleanRecordId = (v = "") => {
  const m = String(v || "").match(/rec[A-Za-z0-9]{14}/);
  return m ? m[0] : "";
};

function parseReviewedQA(text) {
  if (!text) return [];
  const blocks = String(text).split(/\n+\s*[\u2014\-]{3,}\s*\n+/);
  const items = [];
  for (const b of blocks) {
    const m = b.match(/Q\d*[^:]*:\s*([\s\S]*?)\n+\s*A\d*[^:]*:\s*([\s\S]*)/);
    if (!m) continue;
    const question = m[1].trim();
    const answerHtml = m[2].trim();
    if (!question) continue;
    if (/^\(no answer/i.test(answerHtml)) continue;
    const firstLine = (b.split("\n")[0] || "");
    items.push({ question, answerHtml, proposed: /\[Proposed by advisor\]/i.test(firstLine) });
  }
  return items;
}

async function fetchProfile(url) {
  if (!url) return {};
  try {
    const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (compatible; WealthtenderBot)" } });
    if (!r.ok) return {};
    const html = await r.text();

    const metas = {};
    let mm;
    const metaRe = /<meta\b[^>]*>/gi;
    while ((mm = metaRe.exec(html))) {
      const tag = mm[0];
      const key = (tag.match(/(?:property|name)\s*=\s*["']([^"']+)["']/i) || [])[1];
      const val = (tag.match(/content\s*=\s*["']([^"']*)["']/i) || [])[1];
      if (key) metas[key.toLowerCase()] = val || "";
    }
    const ogTitle = metas["og:title"] || "";
    const ogDesc = metas["og:description"] || "";
    const parts = ogDesc.split("|").map((s) => s.trim()).filter(Boolean);

    let name = (parts[0] || "").trim();
    if (!name) name = ogTitle.replace(/\s*[-|]\s*Wealthtender\s*$/i, "").trim();
    let firm = parts.length >= 3 ? parts[parts.length - 1] : "";

    let location = "";
    const mid = parts.find((p) => /Financial Advisor in/i.test(p));
    if (mid) {
      const loc = mid.replace(/.*Financial Advisor in\s*/i, "").trim();
      const segs = loc.split(",").map((s) => s.trim()).filter(Boolean);
      const city = segs[0] || "";
      let region = segs[1] || "";
      region = US_STATES[region.toLowerCase()] || region;
      location = city + (region ? ", " + region : "");
    }

    let headshot = "";
    let im;
    const imgRe = /<img\b[^>]*>/gi;
    while ((im = imgRe.exec(html))) {
      const tag = im[0];
      if (/alt\s*=\s*["'][^"']*Headshot of/i.test(tag)) {
        headshot = (tag.match(/src\s*=\s*["']([^"']+)["']/i) || [])[1] || "";
        if (headshot) break;
      }
    }
    // NitroPack serves a cache URL that embeds the canonical /wp-content/ path; the
    // cache URL is fragile (breaks on purge), so rewrite to the stable original.
    if (/\/nitropack_static\//i.test(headshot)) {
      const orig = headshot.match(/\/((?:[a-z0-9-]+\.)*wealthtender\.com\/wp-content\/.+)$/i);
      if (orig) headshot = "https://" + orig[1];
    }

    const anchorHref = (label) => {
      const lab = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp('<a\\b[^>]*href=["\']([^"\']+)["\'][^>]*>(?:(?!</a>)[\\s\\S])*?' + lab + '(?:(?!</a>)[\\s\\S])*?</a>', "i");
      const m = html.match(re);
      return m ? m[1] : "";
    };
    const bookIntro = anchorHref("Book Intro Call");
    let firmUrl = "";
    const provWeb = html.match(/<a\b[^>]*id=["']ProviderWebsite["'][^>]*>/i);
    if (provWeb) firmUrl = (provWeb[0].match(/href=["']([^"']+)["']/i) || [])[1] || "";
    if (!firmUrl) firmUrl = anchorHref("Website");

    let tagline = "";
    let hm;
    const h2Re = /<h2\b[^>]*>([\s\S]*?)<\/h2>/gi;
    while ((hm = h2Re.exec(html))) {
      const t = hm[1].replace(/<[^>]+>/g, "").trim();
      if (t && t.length >= 5 && t.length <= 120 &&
          !/^(about|areas|compensation|what|who|education|affiliations|primary|additional|meeting|offers|hobbies|sec|jump)/i.test(t)) {
        tagline = t;
        break;
      }
    }

    let bio = "";
    const aboutM = html.match(/About\s+[^<]{0,60}<\/h[1-6]>([\s\S]*?)<h[1-6]/i);
    if (aboutM) {
      const chunk = aboutM[1].replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " ");
      bio = chunk.split(/\n+/).map((x) => x.replace(/\s+/g, " ").trim()).filter(Boolean)[0] || "";
    }

    return {
      name: decodeEntities(name), firm: decodeEntities(firm), firmUrl, bookIntro,
      headshot, tagline: decodeEntities(tagline), bio: decodeEntities(bio), location: decodeEntities(location),
    };
  } catch (e) {
    console.error("profile fetch failed", url, e);
    return {};
  }
}

async function getArticleFields(subFields) {
  let artId = null;
  const link = subFields["Article"];
  if (Array.isArray(link) && link.length) artId = typeof link[0] === "string" ? link[0] : (link[0] && link[0].id);
  if (!artId) artId = await findArticleRecordId(subFields["Article ID"]);
  if (!artId) return {};
  try {
    const art = await airtableGetRecord(AIRTABLE_ARTICLES_TABLE, artId);
    return art.fields || {};
  } catch (e) {
    console.error("getArticleFields failed", e);
    return {};
  }
}

const GENERATE_SYSTEM = `You are an editorial AEO/SEO specialist for Wealthtender. From a financial advisor's Q&A (already reviewed and verbatim-locked), produce only DERIVED metadata. You do not rewrite or quote the answers.

Return ONLY valid JSON (no markdown, no commentary) in EXACTLY this schema:
{
  "keyTakeaways": [ { "heading": "<assertive, standalone answer to a likely search/AI query>", "description": "<2-3 sentences of specific context drawn ONLY from the Q&A; no invented figures>" } ],
  "metaDescription": "<150-160 characters; lead with the finding action; name 2-3 specific planning topics that actually appear in the Q&A; signal expert Q&A insights>",
  "audienceSingular": "<ONLY for the specialist series: the singular noun phrase that fits 'Are you a ___?' e.g. 'Cross-Border Canadian'. For the employer series return an empty string.>"
}

Rules:
- Provide exactly 3 keyTakeaways unless the Q&A clearly supports only 2.
- Every takeaway must reflect the actual content of the answers. Do NOT fabricate statistics, dollar figures, dates, or claims.
- Headings are specific and keyword-aware, not vague ("A TFSA Loses Its Tax-Free Status Once You Become a U.S. Tax Resident", not "Tax Matters").
- metaDescription must be 150-160 characters.`;

function buildTeaser(P, isEmployer, ctx) {
  const eyebrow = isEmployer
    ? `Do you work at ${cardText(ctx.entity)}?`
    : `Are you a ${cardText(ctx.audienceSingular || ctx.entity)}?`;
  const sentence = isEmployer
    ? `Get expert insights from financial advisors who specialize in helping ${cardText(ctx.entity)} ${cardText(ctx.audienceNoun)} make the most of their compensation package and benefits.`
    : `Get expert insights from financial advisors who specialize in helping ${cardText(ctx.entity)} navigate the unique financial planning challenges they face.`;
  return `<!-- wp:html -->
<div style="border-left: 4px solid ${P.accent}; background: ${P.light}; border-radius: 0 6px 6px 0; padding: 20px 24px; margin: 0 0 28px 0;">
  <p style="margin: 0 0 10px 0; font-size: 12px; font-weight: 700; letter-spacing: 0.09em; text-transform: uppercase; color: ${P.accent}; font-family: inherit;">${eyebrow}</p>
  <p style="margin: 0; font-size: 17px; font-weight: 500; color: #1a2833; line-height: 1.8; font-family: inherit;">${sentence}</p>
</div>
<!-- /wp:html -->`;
}

function buildKeyTakeaways(P, takeaways) {
  const items = (takeaways || []).slice(0, 4).map((it, i, arr) => {
    const last = i === arr.length - 1;
    return `    <div style="display: flex; gap: 16px;${last ? "" : " margin-bottom: 20px;"}">
      <div style="flex-shrink: 0; background: ${P.accent}; color: #fff; font-weight: 700; font-size: 15px; width: 32px; height: 32px; border-radius: 50%; display: flex; align-items: center; justify-content: center;">${i + 1}</div>
      <div>
        <p style="margin: 0 0 4px 0; font-weight: 700; font-size: 16px; color: #1a2833;">${esc(it.heading)}</p>
        <p style="margin: 0; font-size: 15px; color: #333; line-height: 1.6;">${esc(it.description)}</p>
      </div>
    </div>`;
  }).join("\n");
  return `<!-- wp:html -->
<div style="background: ${KT_FILL}; border-left: 5px solid ${P.accent}; border-radius: 8px; padding: 24px 28px; margin: 24px 0; font-family: inherit;">
  <p style="margin: 0 0 16px 0; font-size: 13px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: ${P.accent};">Key Takeaways</p>
  <div>
${items}
  </div>
</div>
<!-- /wp:html -->`;
}

function buildQAPairs(P, qa) {
  return qa.map((it, i) => {
    const last = i === qa.length - 1;
    const outer = last ? `padding:20px 0;` : `border-bottom:1px solid ${P.divider};padding:20px 0;`;
    return `    <div style="${outer}">
      <p style="margin:0 0 10px 0;font-size:15px;font-weight:700;color:${P.accent};line-height:1.5;font-family:inherit;display:flex;gap:10px;align-items:flex-start;"><span style="flex-shrink:0;background:${P.accent};color:#fff;font-size:11px;font-weight:700;padding:2px 7px;border-radius:3px;margin-top:2px;letter-spacing:0.05em;font-family:inherit;">Q</span><span>${esc(it.question)}</span></p>
      <div style="font-size:15px;color:#444;line-height:1.75;font-family:inherit;padding-left:34px;">${it.answerHtml}</div>
    </div>`;
  }).join("\n");
}

function buildCard(P, ctx, profile, qa) {
  const name = profile.name || ctx.advisorFirst || "Financial Advisor";
  const firm = profile.firm || "";
  const firmUrl = profile.firmUrl || "";
  const headshot = profile.headshot || "";
  const tagline = profile.tagline || "";
  const bio = profile.bio || "";
  const location = profile.location || "";
  const anchorId = slugify(ctx.advisorFirst || name) || "advisor";

  const imgHtml = headshot
    ? `<img src="${urlAttr(headshot)}" alt="${cardText(name)}, Financial Advisor for ${cardText(ctx.audienceLabel)} at ${cardText(firm || "their firm")}" style="width:72px;height:72px;border-radius:50%;object-fit:cover;border:3px solid rgba(255,255,255,0.35);flex-shrink:0;">`
    : "";
  const firmHtml = firm
    ? (firmUrl
        ? `<a href="${urlAttr(firmUrl)}" target="_blank" rel="noopener noreferrer" style="color:rgba(255,255,255,0.95);text-decoration:underline;font-family:inherit;">${cardText(firm)}</a>`
        : `<span>${cardText(firm)}</span>`)
    : "";
  const metaLine = [firmHtml, location ? cardText(location) : "", "Serves clients nationwide"].filter(Boolean).join(" &nbsp;&middot;&nbsp; ");
  const taglineHtml = tagline
    ? `\n      <span style="display:inline-block;background:rgba(255,255,255,0.15);border-radius:4px;padding:5px 12px;font-size:12px;color:rgba(255,255,255,0.9);font-family:inherit;">${cardText(tagline)}</span>`
    : "";
  const bookBtn = profile.bookIntro
    ? `\n    <a href="${urlAttr(profile.bookIntro)}" target="_blank" rel="noopener noreferrer" style="display:inline-block;background:#fff;color:${P.accent};text-decoration:none;border-radius:5px;padding:9px 18px;font-size:13px;font-weight:700;font-family:inherit;flex-shrink:0;white-space:nowrap;">Book Intro Call</a>`
    : "";
  const bioStrip = bio
    ? `\n  <div style="background:${P.light};border-left:1px solid ${P.border};border-right:1px solid ${P.border};padding:18px 28px;font-family:inherit;">
    <p style="margin:0;font-size:15px;color:#444;line-height:1.75;font-family:inherit;">${cardText(bio)}</p>
  </div>`
    : "";
  const qaTopBorder = bio ? "border-top:none;" : `border-top:1px solid ${P.border};`;
  const footerProfile = ctx.advisorUrl
    ? `<p style="margin:0;font-size:14px;font-family:inherit;"><a href="${urlAttr(ctx.advisorUrl)}" target="_blank" rel="noopener noreferrer" style="color:${P.accent};font-weight:600;font-family:inherit;">View ${cardText(ctx.advisorFirst || name.split(" ")[0])}&#8217;s profile page on Wealthtender &#8599;</a></p>`
    : "";
  const disclosure = ctx.compliance
    ? `\n    <p style="margin:8px 0 0 0;font-size:12px;color:#777;line-height:1.6;font-family:inherit;">${cardText(ctx.compliance)}</p>`
    : "";

  return `<!-- wp:html -->
<div id="${anchorId}" style="margin-bottom:48px;font-family:inherit;">

  <p style="margin:0 0 8px 0;font-size:11px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#999;font-family:inherit;">${ctx.cardEyebrow}</p>

  <div style="background:${P.accent};border-radius:10px 10px 0 0;padding:22px 28px;display:flex;align-items:center;gap:20px;flex-wrap:wrap;">
    ${imgHtml}
    <div style="flex:1;min-width:200px;">
      <p style="margin:0 0 4px 0;font-size:19px;font-weight:700;color:#fff;font-family:inherit;">${cardText(name)}</p>
      <p style="margin:0 0 10px 0;font-size:13px;color:rgba(255,255,255,0.8);font-family:inherit;">${metaLine}</p>${taglineHtml}
    </div>${bookBtn}
  </div>
${bioStrip}
  <div style="background:#fff;border:1px solid ${P.border};${qaTopBorder}padding:0 28px;font-family:inherit;">
${buildQAPairs(P, qa)}
  </div>

  <div style="background:#fff;border:1px solid ${P.border};border-top:1px solid ${P.divider};border-radius:0 0 10px 10px;padding:16px 28px;font-family:inherit;">
    ${footerProfile}${disclosure}
  </div>

</div>
<!-- /wp:html -->`;
}

/* ----------------------------------------------------------
   Style Guide section 7 (intro body) + closing scaffolding.
   These were specified in the playbook but never ported into
   the generator; added here so /api/generate emits a complete,
   paste-ready article wrapped in a single constrained Group
   (no empty-column layout scaffolding) with one JSON-LD payload
   (no scattered inline microdata).
---------------------------------------------------------- */
const LINK = {
  hsa: "https://wealthtender.com/insights/investing/why-you-should-put-the-max-in-your-hsa-before-putting-more-in-your-401k/",
  quitting: "https://wealthtender.com/insights/money-management/what-happens-to-your-401k-when-you-quit-your-job/",
  layoff: "https://wealthtender.com/insights/money-management/avoid-getting-laid-off/",
  nearMe: "https://wealthtender.com/financial-advisor-near-me/",
  virtual: "https://wealthtender.com/guide/virtual-financial-advisors/",
  find: "https://wealthtender.com/find-financial-advisor/",
  joinAdvisor: "https://wealthtender.com/financial-advisor-marketing",
  authorBio: "https://wealthtender.com/author/brian-thorp/",
  authorLinkedIn: "https://www.linkedin.com/in/briancthorp/",
  authorHeadshot: "https://wealthtender.com/wp-content/uploads/2023/01/Brian-Thorp-Business-Card-427x640.jpg",
};
// Default evergreen "Browse Related Articles" set (review per article).
const RELATED_DEFAULT = ["21590", "14979", "14634", "49306", "58729"];
const QUESTION_FORM_ID = "34";
const NEWSLETTER_FORM_ID = "1";

const stripTags = (s = "") => String(s).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const aOrAn = (w = "") => (/^[aeiou]/i.test(String(w).trim()) ? "an" : "a");
// Plain-text body insertions (entities like "AT&T" -> "AT&amp;T", curly apostrophes).
const txt = (s = "") => cardText(s);

const pBlock = (html) => `<!-- wp:paragraph -->\n<p>${html}</p>\n<!-- /wp:paragraph -->`;
function hBlock(level, html, anchor) {
  const attrs = {};
  if (level && level !== 2) attrs.level = level;
  if (anchor) attrs.anchor = anchor;
  const attrStr = Object.keys(attrs).length ? " " + JSON.stringify(attrs) : "";
  const idAttr = anchor ? ` id="${anchor}"` : "";
  return `<!-- wp:heading${attrStr} -->\n<h${level} class="wp-block-heading"${idAttr}>${html}</h${level}>\n<!-- /wp:heading -->`;
}

// Map the setup classifier's category to the section 8 benefits-swap clause.
function inferCategory(noun = "") {
  const n = String(noun).toLowerCase();
  if (n.includes("executive")) return "corporate";
  if (n.includes("faculty")) return "university";
  if (n.includes("service member")) return "military";
  if (n.includes("first responder")) return "first_responders";
  if (n.includes("member")) return "government_pension";
  return "other"; // healthcare + plain "employees" fall back to a generic clause
}
function benefitsParagraph(category, entity, audienceNoun, audienceShort) {
  const E = txt(entity);
  const hsa = `<a href="${LINK.hsa}">health savings accounts</a>`;
  const MAP = {
    corporate: {
      range: `health insurance and ${hsa} to retirement plans like a 401(k) and deferred compensation, along with equity compensation such as restricted stock units (RSUs), stock options, and an employee stock purchase plan`,
      org: "the company",
    },
    healthcare: {
      range: `health insurance and ${hsa} to retirement plans like a 403(b) or 401(k) and other valuable workplace benefits`,
      org: "the organization",
    },
    university: {
      range: `health insurance and ${hsa} to retirement plans like a 403(b), pension options, and other faculty and staff benefits`,
      org: "the institution",
    },
    government_pension: {
      range: `health insurance to a defined-benefit pension, a 457(b) or Thrift Savings Plan, and other benefits available to members`,
      org: "the organization",
    },
    military: {
      range: `health and medical benefits to the Thrift Savings Plan, the Blended Retirement System, and other benefits available to service members`,
      org: "the service",
    },
    first_responders: {
      range: `health insurance to a pension, a 457(b) or 403(b), and other benefits`,
      org: "the department",
    },
    other: {
      range: `health insurance and ${hsa} to retirement plans like a 401(k) or 403(b) and other valuable workplace benefits`,
      org: "the organization",
    },
  };
  const m = MAP[category] || MAP.other;
  return `Throughout the year, ${E} provides its ${txt(audienceNoun)} with updates about their benefits, ranging from ${m.range}. While ${m.org} offers many useful resources and access to knowledgeable staff who can assist with questions, you&#8217;ll also find financial professionals not affiliated with ${E} who specialize in helping ${E} ${txt(audienceShort)} make the most of their income and benefits.`;
}

// Items 2-3: keyword lead paragraph + hook + two checkmark questions.
function buildIntroLead(P, isEmployer, ctx) {
  const E = txt(ctx.entity);
  if (isEmployer) {
    const short = txt(ctx.audienceShort);
    const noun = txt(ctx.audienceNoun);
    return [
      pBlock(`Looking for a financial advisor who specializes in working with ${E} ${short}? You&#8217;re in the right place. Below, you&#8217;ll find advisors who understand ${E} benefits and compensation &mdash; along with their answers to common financial questions from ${E} ${noun}.`),
      pBlock(`Whether you recently joined ${E} or you&#8217;ve advanced into a management or executive leadership role over a multi-year career, making smart decisions about your income and ${E} benefits can have a lasting impact on your financial future. For example:`),
      pBlock(`&#9989; Do you know the right moves to get the greatest value from the ${E} benefits available to you?`),
      pBlock(`&#9989; If you&#8217;re thinking about leaving ${E} for another job or planning to retire in a few years, are you taking the right steps today to receive all the compensation and benefits you&#8217;ve earned?`),
    ].join("\n\n");
  }
  const noun = txt(ctx.audienceNoun);
  return [
    pBlock(`Looking for a financial advisor who specializes in working with ${noun}? You&#8217;re in the right place. Below, you&#8217;ll find advisors with experience helping ${noun} navigate their unique financial planning needs &mdash; along with their answers to common questions.`),
    pBlock(`Finding the right financial advisor matters even more when your situation is specialized. For example:`),
    pBlock(`&#9989; Do you know whether your current plan accounts for the financial challenges specific to ${noun}?`),
    pBlock(`&#9989; Are you working with an advisor who understands your circumstances well enough to help you avoid costly mistakes?`),
  ].join("\n\n");
}

// Items 4-11: Why H2, benefits, geographic, sensitive topics, Should-You-Hire H3,
// specialist-vs-local, the lightbulb Q&A intro, and the question prompt.
function buildIntroBody(P, isEmployer, ctx) {
  const E = txt(ctx.entity);
  if (!isEmployer) {
    const noun = txt(ctx.audienceNoun);
    const whyH = `Why ${noun} Work with a Specialist Financial Advisor`;
    const hireH = `Should You Hire a Specialist or a Local Financial Advisor?`;
    return [
      hBlock(2, whyH, "h-" + slugify(whyH)),
      pBlock(`A specialist financial advisor brings experience with the specific tax rules, account types, and planning decisions that affect ${noun}. While a generalist can help with the basics, the nuances of your situation are often better served by a professional who works with people in circumstances like yours every day.`),
      pBlock(`Sensitive topics &mdash; like major life transitions, cross-border or tax complexity, and deciding when and how to make big financial moves &mdash; are all conversations that may be more comfortable with a trusted financial advisor who understands your situation.`),
      hBlock(3, hireH, "h-" + slugify(hireH)),
      pBlock(`You&#8217;ll likely find dozens of <a href="${LINK.nearMe}">nearby financial advisors</a> well-suited to help you reach your money goals with a personalized plan. But it can be harder to find a financial advisor who specializes in serving ${noun}. Fortunately, many financial advisors offer <a href="${LINK.virtual}">virtual services</a>, so you can meet online no matter where you (or they) live &mdash; which means you can <a href="${LINK.find}">hire a specialist financial advisor</a> who lives hundreds of miles away if their knowledge and experience are the better fit for your unique needs.`),
      pBlock(`&#128161; In the Q&amp;A below, you&#8217;ll gain insights from financial advisors who work with ${noun} to help them make smart decisions, reduce their money stress, and feel confident about their financial future.`),
      pBlock(`&#128587;&#8205;&#9792;&#65039; <em>Have a question not yet answered?</em> Use the form below to submit it anonymously and watch this article for updates with answers to your questions. You can also reach out to the financial advisors below to set up an introductory call or contact them with your questions by email.`),
    ].join("\n\n");
  }
  const short = txt(ctx.audienceShort);
  const shortTitle = titleCase(ctx.audienceShort);
  const whyH = `Why ${ctx.entity} ${shortTitle} Work with a Specialist Financial Advisor`;
  const hireH = `Should You Hire ${aOrAn(ctx.entity)} ${ctx.entity} Specialist or a Local Financial Advisor?`;
  const layoffPhrase = ctx.category === "corporate" ? "corporate layoff" : "layoff or workforce reduction";
  return [
    hBlock(2, txt(whyH), "h-" + slugify(whyH)),
    pBlock(benefitsParagraph(ctx.category, ctx.entity, ctx.audienceNoun, ctx.audienceShort)),
    pBlock(`Whether you work at one of ${E}&#8217;s offices, from a regional hub, or remotely from home, you may have questions about your compensation package and benefits better suited for a financial professional who can offer unbiased advice and guidance.`),
    pBlock(`Sensitive topics &mdash; like the steps you should take before <a href="${LINK.quitting}">quitting your job</a> at ${E} to work elsewhere, protecting yourself in advance of a <a href="${LINK.layoff}">${layoffPhrase}</a>, or deciding when you should plan to retire &mdash; are all conversations that may be more comfortable with a trusted financial advisor.`),
    hBlock(3, txt(hireH), "h-" + slugify(hireH)),
    pBlock(`You&#8217;ll likely find dozens of <a href="${LINK.nearMe}">nearby financial advisors</a> well-suited to help you reach your money goals with a personalized plan. But it can be harder to find a financial advisor who specializes in serving ${E} ${short}. Fortunately, many financial advisors offer <a href="${LINK.virtual}">virtual services</a>, so you can meet online no matter where you (or they) live &mdash; which means you can <a href="${LINK.find}">hire a specialist financial advisor</a> who lives hundreds of miles away if their knowledge and experience working with ${E} ${short} is the better fit for your unique needs.`),
    pBlock(`&#128161; In the Q&amp;A below, you&#8217;ll gain insights from financial advisors who work with ${E} ${short} to help them make smart decisions, get the most value from their compensation and benefits, reduce their money stress, and prepare for a comfortable retirement.`),
    pBlock(`&#128587;&#8205;&#9792;&#65039; <em>Have a question not yet answered?</em> Use the form below to submit it anonymously and watch this article for updates with answers to your questions. You can also reach out to the financial advisors below to set up an introductory call or contact them with your questions by email.`),
  ].join("\n\n");
}

// Items 12-13: the Q&A section heading + one-sentence lead-in.
function buildQaHeading(P, isEmployer, ctx) {
  if (isEmployer) {
    const nounAmp = titleCase(ctx.audienceNoun).replace(/\bAnd\b/g, "&");
    const heading = `Q&A: Financial Planning Tips for ${ctx.entity} ${nounAmp}`;
    const anchor = "h-" + slugify("q-and-a-financial-planning-tips-for-" + ctx.entity + "-" + ctx.audienceNoun);
    const h = `<!-- wp:heading {"style":{"typography":{"textTransform":"capitalize"}}} -->\n<h2 class="wp-block-heading" id="${anchor}" style="text-transform:capitalize">${cardText(heading)}</h2>\n<!-- /wp:heading -->`;
    const lead = pBlock(`In this section, you&#8217;ll learn how you can make the most of your ${txt(ctx.entity)} employee benefits and gain valuable tips from financial advisors who specialize in working with ${txt(ctx.entity)} ${txt(ctx.audienceNoun)}.`);
    return h + "\n\n" + lead;
  }
  const heading = `Q&A: Financial Planning Insights for ${ctx.entity}`;
  const anchor = "h-" + slugify("q-and-a-financial-planning-insights-for-" + ctx.entity);
  const h = `<!-- wp:heading {"style":{"typography":{"textTransform":"capitalize"}}} -->\n<h2 class="wp-block-heading" id="${anchor}" style="text-transform:capitalize">${cardText(heading)}</h2>\n<!-- /wp:heading -->`;
  const lead = pBlock(`In this section, you&#8217;ll gain valuable tips from financial advisors who specialize in working with ${txt(ctx.audienceNoun)}.`);
  return h + "\n\n" + lead;
}

// Items 16-20: recruitment accordion, question form, newsletter, related row, author bio.
// Universal scaffolding; varies only by entity/audience text.
function buildClosing(P, isEmployer, ctx) {
  const E = txt(ctx.entity);
  const short = txt(ctx.audienceShort);
  const accordionQ = isEmployer
    ? `Are you a financial advisor who specializes in working with ${short} at ${E} or another large company?`
    : `Are you a financial advisor who specializes in working with ${txt(ctx.audienceNoun)}?`;
  const accordionBody = isEmployer
    ? `&#9989; Join Wealthtender and get featured as a specialist financial advisor based on your knowledge and experience working with ${short} at ${E} or another large company. <em>(Subject to availability and terms.)</em> <br>&#9989; <a href="${LINK.joinAdvisor}">Sign up today</a> and join financial advisors attracting their ideal clients on Wealthtender`
    : `&#9989; Join Wealthtender and get featured as a specialist financial advisor based on your knowledge and experience working with ${txt(ctx.audienceNoun)}. <em>(Subject to availability and terms.)</em> <br>&#9989; <a href="${LINK.joinAdvisor}">Sign up today</a> and join financial advisors attracting their ideal clients on Wealthtender`;
  const askH = isEmployer
    ? `Ask a Financial Advisor Your ${ctx.entity} Benefits & Career Questions`
    : `Ask a Financial Advisor Your Questions`;
  const askAnchor = "h-" + slugify((isEmployer ? "ask-a-financial-advisor-your-" + ctx.entity + "-benefits-and-career-questions" : "ask-a-financial-advisor-your-questions"));
  const related = RELATED_DEFAULT.map((id) => `"${id}"`).join(",");

  return [
    `<!-- wp:spacer {"height":"25px"} -->\n<div style="height:25px" aria-hidden="true" class="wp-block-spacer"></div>\n<!-- /wp:spacer -->`,
    `<!-- wp:genesis-blocks/gb-accordion {"accordionFontSize":15} -->\n<div class="wp-block-genesis-blocks-gb-accordion gb-block-accordion gb-font-size-15"><details><summary class="gb-accordion-title">${cardText(accordionQ)}</summary><div class="gb-accordion-text"><!-- wp:paragraph -->\n<p>${accordionBody}</p>\n<!-- /wp:paragraph --></div></details></div>\n<!-- /wp:genesis-blocks/gb-accordion -->`,
    `<!-- wp:spacer {"height":"20px"} -->\n<div style="height:20px" aria-hidden="true" class="wp-block-spacer"></div>\n<!-- /wp:spacer -->`,
    hBlock(2, cardText(askH), askAnchor),
    `<!-- wp:gravityforms/form {"formId":"${QUESTION_FORM_ID}","title":false,"inputPrimaryColor":"#204ce5"} /-->`,
    `<!-- wp:genesis-blocks/gb-spacer -->\n<div style="color:#ddd" class="wp-block-genesis-blocks-gb-spacer gb-block-spacer gb-divider-solid gb-divider-size-1"><hr style="height:30px"/></div>\n<!-- /wp:genesis-blocks/gb-spacer -->`,
    `<!-- wp:heading {"textColor":"primary"} -->\n<h2 class="wp-block-heading has-primary-color has-text-color">Are you ready to enjoy life more with less money stress?</h2>\n<!-- /wp:heading -->`,
    pBlock(`Sign up to receive weekly insights from Wealthtender with useful money tips and fresh ideas to help you achieve your financial goals.`),
    `<!-- wp:gravityforms/form {"formId":"${NEWSLETTER_FORM_ID}","title":false,"description":false,"inputPrimaryColor":"#204ce5"} /-->`,
    `<!-- wp:genesis-blocks/gb-spacer -->\n<div style="color:#ddd" class="wp-block-genesis-blocks-gb-spacer gb-block-spacer gb-divider-solid gb-divider-size-1"><hr style="height:30px"/></div>\n<!-- /wp:genesis-blocks/gb-spacer -->`,
    `<!-- wp:acf/article-row {"name":"acf/article-row","data":{"title":"\uD83D\uDCF0 Browse Related Articles","_title":"field_5fd2a81a9f9c9","layout":"row","_layout":"field_5fda937cbb309","articles":[${related}],"_articles":"field_5fd2a8259f9ca","featured_image":"1","_featured_image":"field_60b6c8b369e79","viewMoreText":"","_viewMoreText":"field_64ac40c148ca2","viewMoreLink":"","_viewMoreLink":"field_64ac40d548ca3"},"align":"","mode":"edit"} /-->`,
    `<!-- wp:spacer {"height":"10px"} -->\n<div style="height:10px" aria-hidden="true" class="wp-block-spacer"></div>\n<!-- /wp:spacer -->`,
    buildAuthorBio(),
  ].join("\n\n");
}

function buildAuthorBio() {
  return `<!-- wp:html -->
<div style="margin: 40px 0 0 0; font-family: inherit;">

  <p style="margin: 0 0 16px 0; font-size: 11px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: #999; font-family: inherit;">About the Author</p>

  <div style="background: #f4f8fb; border: 1px solid #dce4ec; border-radius: 10px; padding: 28px; display: flex; gap: 24px; align-items: flex-start; flex-wrap: wrap;">

    <img
      src="${LINK.authorHeadshot}"
      alt="Brian Thorp, Founder and CEO of Wealthtender and Editor-in-Chief"
      style="width: 96px; height: 96px; border-radius: 50%; object-fit: cover; flex-shrink: 0; border: 3px solid #fff;"
    >

    <div style="flex: 1; min-width: 260px;">
      <p style="margin: 0 0 2px 0; font-size: 20px; font-weight: 700; color: #1a2833; font-family: inherit;">Brian Thorp</p>
      <p style="margin: 0 0 14px 0; font-size: 14px; font-weight: 600; color: #1a5276; font-family: inherit;">Founder &amp; CEO, Wealthtender &nbsp;&middot;&nbsp; Editor-in-Chief</p>

      <p style="margin: 0 0 12px 0; font-size: 15px; color: #444; line-height: 1.7; font-family: inherit;">Brian Thorp is the founder and CEO of Wealthtender and serves as Editor-in-Chief. With over 25 years in the financial services industry &mdash; including nearly 22 years at Invesco, where he led strategic partnerships with wealth management firms representing more than $100 billion in assets &mdash; Brian founded Wealthtender to help people find financial advisors they can trust and make more informed money decisions.</p>

      <p style="margin: 0 0 12px 0; font-size: 15px; color: #444; line-height: 1.7; font-family: inherit;">A member of the National Society of Compliance Professionals and its SEC Marketing Rule Working Group, Brian was recognized by WealthManagement.com as one of its &#8220;Ten to Watch in 2024&#8221; for his work reshaping how financial advisors market their services. He holds a B.B.A. in Finance from The University of Texas at Austin.</p>

      <p style="margin: 0 0 16px 0; font-size: 15px; color: #444; line-height: 1.7; font-family: inherit;">Brian and his wife live in Austin, Texas.</p>

      <p style="margin: 0; font-size: 14px; font-weight: 600; font-family: inherit;">
        <a href="${LINK.authorBio}" style="color: #1a5276; text-decoration: none; font-family: inherit;">Read Brian&#8217;s full bio &#8594;</a>
        &nbsp;&nbsp;&middot;&nbsp;&nbsp;
        <a href="${LINK.authorLinkedIn}" target="_blank" rel="noopener noreferrer" style="color: #1a5276; text-decoration: none; font-family: inherit;">Connect on LinkedIn &#8594;</a>
      </p>
    </div>

  </div>
</div>
<!-- /wp:html -->`;
}

// One coherent JSON-LD graph (Article + FAQPage + advisor Person + author),
// replacing the scattered inline microdata. Visible Q&A text matches mainEntity.
function buildJsonLd(ctx, profile, qa, isEmployer) {
  const graph = [];
  graph.push({
    "@type": "FAQPage",
    mainEntity: qa.map((it) => ({
      "@type": "Question",
      name: stripTags(it.question),
      acceptedAnswer: { "@type": "Answer", text: String(it.answerHtml || "").trim() },
    })),
  });
  const advisorName = stripTags(profile.name || ctx.advisorFirst || "Financial Advisor");
  const person = { "@type": "Person", name: advisorName, jobTitle: "Financial Advisor" };
  if (profile.firm) {
    person.worksFor = { "@type": "Organization", name: profile.firm };
    if (profile.firmUrl) person.worksFor.url = profile.firmUrl;
  }
  if (profile.headshot) person.image = profile.headshot;
  if (ctx.advisorUrl) person.url = ctx.advisorUrl;
  graph.push(person);
  const article = { "@type": "Article" };
  if (ctx.headline) article.headline = stripTags(ctx.headline);
  if (ctx.metaDescription) article.description = ctx.metaDescription;
  article.author = { "@type": "Person", name: "Brian Thorp", url: LINK.authorBio };
  article.publisher = { "@type": "Organization", name: "Wealthtender", url: "https://wealthtender.com" };
  graph.push(article);
  const json = JSON.stringify({ "@context": "https://schema.org", "@graph": graph }, null, 2).replace(/</g, "\\u003c");
  return `<!-- wp:html -->\n<script type="application/ld+json">\n${json}\n</script>\n<!-- /wp:html -->`;
}

// Wrap the full article body in a single constrained Group so content sits at a
// readable width and centers on desktop / goes edge-to-edge on mobile -- without
// empty layout columns. Tune contentSize to match the theme if needed.
function wrapConstrained(inner) {
  return `<!-- wp:group {"layout":{"type":"constrained","contentSize":"814px"}} -->\n<div class="wp-block-group">\n${inner}\n</div>\n<!-- /wp:group -->`;
}

async function generateArticle(recordId) {
  const SUB = AIRTABLE_SUBMISSIONS_TABLE;
  let rec;
  try {
    rec = await airtableGetRecord(SUB, recordId);
  } catch (e) {
    console.error("generate: cannot read record", recordId, e);
    return;
  }
  const f = rec.fields || {};
  const qa = parseReviewedQA(f["Reviewed Q&A"]);
  if (!qa.length) {
    await safePatch(SUB, recordId, {
      "Flags Raised": (f["Flags Raised"] || "") + "\n\n\u2014 Generation \u2014\n\u2022 Could not parse Reviewed Q&A into question/answer pairs; HTML not generated.",
    });
    return;
  }

  const art = await getArticleFields(f);
  const series = f["Series"] || art["Series"] || "Large Employer";
  const isEmployer = !/specialist/i.test(series);
  const P = isEmployer ? PALETTE.employer : PALETTE.specialist;
  const entity = f["Entity"] || art["Employer / Niche Name"] || "";
  const audienceNoun = art["Audience Noun"] || "employees and executives";
  const audienceShort = art["Audience Short"] || "employees";
  const advisorUrl = art["Advisor Wealthtender URL"] || "";
  const advisorFirst = art["Advisor First Name"] || "";
  const compliance = f["Compliance Disclosure"] || art["Compliance Disclosure"] || "";

  const profile = await fetchProfile(advisorUrl);

  const qaForAI = qa.map((it) => ({
    question: it.question,
    answer: it.answerHtml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
  }));
  const userText =
    "Series: " + series + "\nEntity/Niche: " + entity + "\nAudience noun: " + audienceNoun +
    "\n\nQ&A:\n" + JSON.stringify(qaForAI, null, 2);

  let ai;
  try {
    ai = await callClaudeJSON(GENERATE_SYSTEM, userText, 3000);
  } catch (e) {
    console.error("generate: model/parse failed", recordId, e);
    await safePatch(SUB, recordId, {
      "Flags Raised": (f["Flags Raised"] || "") + "\n\n\u2014 Generation \u2014\n\u2022 Metadata generation failed (" + String(e).slice(0, 140) + "); HTML not generated.",
    });
    return;
  }

  let headline, slug, audienceLabel, cardEyebrow, seoTitle;
  if (isEmployer) {
    const nounAmp = titleCase(audienceNoun).replace(/\bAnd\b/g, "&");
    const shortTitle = titleCase(audienceShort);
    headline = `Find Financial Advisors for ${entity} ${nounAmp}: Q&A Insights from the Experts`;
    slug = `financial-advisor-for-${slugify(entity)}-employees`;
    seoTitle = `Find a Financial Advisor for ${entity} ${shortTitle} | Wealthtender`;
    audienceLabel = `${entity} ${shortTitle}`;
    cardEyebrow = `Financial Advisor Q&amp;A &nbsp;&middot;&nbsp; ${cardText(entity)} ${cardText(shortTitle)}`;
  } else {
    headline = `Find a Financial Advisor for ${entity}: Q&A Insights from the Experts`;
    slug = `financial-advisor-for-${slugify(entity)}`;
    seoTitle = `Financial Advisor for ${entity} | Wealthtender`;
    audienceLabel = entity;
    cardEyebrow = `Financial Advisor Q&amp;A &nbsp;&middot;&nbsp; ${cardText(entity)}`;
  }

  const category = (String(art["Category"] || "").trim().toLowerCase()) || inferCategory(audienceNoun);

  const ctx = {
    entity, audienceNoun, audienceShort, audienceLabel, cardEyebrow, advisorUrl, advisorFirst, compliance,
    audienceSingular: ai.audienceSingular || "",
    category, headline, metaDescription: (ai.metaDescription || "").trim(),
  };

  const body = [
    buildTeaser(P, isEmployer, ctx),
    buildIntroLead(P, isEmployer, ctx),
    buildKeyTakeaways(P, ai.keyTakeaways),
    buildIntroBody(P, isEmployer, ctx),
    buildQaHeading(P, isEmployer, ctx),
    buildCard(P, ctx, profile, qa),
    buildClosing(P, isEmployer, ctx),
  ].join("\n\n");

  const generatedHtml = buildJsonLd(ctx, profile, qa, isEmployer) + "\n\n" + wrapConstrained(body);

  const genFlags = [];
  if (!advisorUrl) genFlags.push("No Advisor Wealthtender URL on the Article record \u2014 advisor card built without profile data.");
  else {
    if (!profile.headshot) genFlags.push("Headshot not found on profile \u2014 add the image manually.");
    if (!profile.firm) genFlags.push("Firm name not parsed \u2014 verify.");
    if (!profile.firmUrl) genFlags.push("Firm website URL not found \u2014 verify the firm link.");
    if (!profile.bookIntro) genFlags.push("Book Intro Call URL not found \u2014 add manually.");
    if (!profile.location) genFlags.push("Location not parsed \u2014 verify city/state.");
    if (!profile.tagline) genFlags.push("Specialty tagline not found \u2014 consider adding one.");
    if (!profile.bio) genFlags.push("Bio strip omitted (no About paragraph parsed) \u2014 consider adding the advisor bio.");
  }
  if (isEmployer) {
    genFlags.push(`Benefits paragraph built from the "${category}" template \u2014 confirm ${entity} actually offers each benefit named (remove any it doesn't).`);
    genFlags.push(`Geographic paragraph uses a generic, evergreen template \u2014 optionally add ${entity}'s specific office locations or hubs for stronger local relevance.`);
  }
  genFlags.push("Browse Related Articles uses a default set of 5 posts \u2014 review/replace the article IDs for topical relevance.");
  if (seoTitle && seoTitle.length > 60) genFlags.push(`SEO Title is ${seoTitle.length} chars (target ~60) \u2014 consider shortening before publishing.`);
  const prevFlags = f["Flags Raised"] || "";
  const flagsOut = genFlags.length
    ? (prevFlags ? prevFlags + "\n\n" : "") + "\u2014 Generation \u2014\n" + genFlags.map((x) => "\u2022 " + x).join("\n")
    : prevFlags;

  await safePatch(SUB, recordId, {
    "Generated HTML": generatedHtml.slice(0, 95000),
    "Suggested Headline": headline,
    "SEO Title": seoTitle,
    "Meta Description": (ai.metaDescription || "").trim(),
    "Suggested Slug": slug,
    "Flags Raised": flagsOut.slice(0, 95000),
    "Status": "HTML Ready",
  });
  console.log(`generate complete ${recordId}: ${qa.length} Q&A, ${genFlags.length} gen-flags`);
}

app.post("/api/generate", async (req, res) => {
  const recordId = cleanRecordId(req.body && (req.body.recordId || req.body.id));
  if (!recordId) return res.status(400).json({ error: "missing recordId" });
  if (!ANTHROPIC_API_KEY || !AIRTABLE_API_KEY || !AIRTABLE_BASE_ID)
    return res.status(500).json({ error: "server not configured for generate" });
  res.json({ ok: true, queued: true, recordId });
  generateArticle(recordId).catch((e) => console.error("generate background error", recordId, e));
});

/* ----------------------------------------------------------
   Serve the built React app and let client-side routing work.
---------------------------------------------------------- */
/* ----------------------------------------------------------
   /api/article-setup — one-field article provisioning.
   A HubSpot dropdown creates an Articles row (Series + advisor
   fields, Status = "Needs Name"). Brian types the Employer /
   Niche Name and checks "Generate Setup". Zapier POSTs
   { recordId }; we derive the audience noun/short, build the
   Article ID, generate the Question List (employer: 12 standard
   + 2 bespoke; specialist: drafted), write Setup Notes, set
   Status = "Ready to Invite", and uncheck "Generate Setup".
---------------------------------------------------------- */
const STANDARD_EMPLOYER_QUESTIONS = [
  "As a financial advisor with experience helping COMPANY employees save for their retirement, how do you help them make the most of their employee benefits?",
  "When you first speak with a COMPANY employee, what questions do you like to ask to better understand their unique circumstances and determine how you can best help them achieve their goals?",
  "Is there a particular benefit available to COMPANY employees you feel isn't as well utilized or understood by employees as it should be?",
  "Beyond COMPANY employee benefits for retirement savings, are there other types of benefits offered by the company that you find valuable to discuss with your clients (e.g. stock, education savings, health savings)?",
  "For COMPANY employees thinking about leaving the company to accept a job elsewhere, what actions do you recommend they take before resigning and shortly thereafter?",
  "For COMPANY employees approaching retirement age, how do you recommend they prepare to make the transition from living off their salary to relying upon other sources of income?",
  "For COMPANY employees who have managed their finances on their own to this point, what would you suggest they consider to help them decide if they should begin working with a financial advisor at this stage in their lives?",
  "What are some of the unique financial planning challenges you commonly see among your clients who are COMPANY employees and how do you help them overcome these obstacles?",
  "What questions do you recommend COMPANY employees ask financial advisors they're considering hiring to help them decide if they're a good fit?",
  "Is there anything that comes up frequently in your initial meeting with COMPANY employees that surprises you?",
  "For highly compensated COMPANY employees and executives, are there any special benefits you believe it's important to take into consideration when preparing their financial plan?",
  "Is there a particularly memorable experience or a moment you recall with a client who worked at COMPANY when you realized they have unique opportunities and circumstances when it comes to their financial planning needs?",
];

const SETUP_EMPLOYER_SYSTEM = `You are an editorial strategist for Wealthtender's Large Employer Q&A series. Given an employer name, classify the employer and return audience framing plus two employer-specific Q&A questions.

Return ONLY valid JSON (no markdown) in EXACTLY this schema:
{
  "category": "corporate | healthcare | university | government_pension | military | first_responders | other",
  "audienceNoun": "<lowercase plural phrase>",
  "audienceShort": "<lowercase plural phrase>",
  "ampExecutives": <true|false>,
  "rationale": "<one sentence on the category call and whether '& Executives' applies>",
  "bespokeQuestions": ["<question 1>", "<question 2>"]
}

Audience mapping by category (use EXACTLY these values):
- corporate: audienceNoun "employees and executives", audienceShort "employees", ampExecutives true
- healthcare: audienceNoun "employees", audienceShort "employees", ampExecutives false
- university: audienceNoun "faculty and staff", audienceShort "employees", ampExecutives false
- government_pension: audienceNoun "members", audienceShort "members", ampExecutives false
- military: audienceNoun "service members", audienceShort "service members", ampExecutives false
- first_responders: audienceNoun "first responders", audienceShort "first responders", ampExecutives false
- other: audienceNoun "employees", audienceShort "employees", ampExecutives false

Rules for bespokeQuestions:
- Exactly 2 questions, each open-ended and in the same voice as a professional advisor interview, each naming the employer.
- They MUST be distinct from these standard topics already covered: making the most of benefits; discovery questions; an under-utilized benefit; non-retirement benefits (stock/education/health savings); leaving the company; approaching retirement; deciding to hire an advisor; common planning challenges; questions to ask an advisor; first-meeting surprises; highly compensated employees and executives; a memorable client moment.
- Focus on what is genuinely DISTINCTIVE about THIS employer (e.g. equity/RSUs/pre-IPO liquidity, pension specifics, mission-driven or relocation-heavy culture, unusual compensation structures). Keep each question to one or two sentences.`;

const SETUP_SPECIALIST_SYSTEM = `You are an editorial strategist for Wealthtender's Specialist Spotlight Q&A series. Given a niche audience, return audience framing plus query-shaped Q&A questions an advisor who SPECIALIZES IN SERVING that niche would answer.

Return ONLY valid JSON (no markdown) in EXACTLY this schema:
{
  "audienceNoun": "<the niche as a plural audience phrase, Title Case, e.g. 'Cross-Border Canadians'>",
  "audienceShort": "<a short plural label, Title Case>",
  "questions": ["<8 to 12 questions>"]
}

Rules:
- Frame the niche as people an advisor specializes in serving, never as a credential the advisor holds.
- Questions are query-shaped (the way someone asks AI or search), specific to the real financial challenges of this niche, open-ended, and answerable by an advisor. Provide 8 to 12.
- No current-year dollar figures or contribution limits in the questions (keep them evergreen).`;

function articleIdKeyword(entity) {
  const alpha = String(entity || "").replace(/[^A-Za-z]/g, "").toUpperCase();
  return alpha.slice(0, 4) || "XXXX";
}

async function countArticlesWithPrefix(prefix) {
  try {
    const formula = encodeURIComponent(`LEFT({Article ID}, ${prefix.length})='${prefix}'`);
    let count = 0, offset = "";
    for (let i = 0; i < 5; i++) {
      const url = `${AIRTABLE_API}/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_ARTICLES_TABLE)}?filterByFormula=${formula}&fields%5B%5D=${encodeURIComponent("Article ID")}&pageSize=100${offset ? `&offset=${encodeURIComponent(offset)}` : ""}`;
      const r = await fetch(url, { headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` } });
      if (!r.ok) break;
      const data = await r.json();
      count += (data.records || []).length;
      if (!data.offset) break;
      offset = data.offset;
    }
    return count;
  } catch (e) {
    console.error("countArticlesWithPrefix failed", e);
    return 0;
  }
}

async function articleSetup(recordId) {
  const T = AIRTABLE_ARTICLES_TABLE;
  let rec;
  try {
    rec = await airtableGetRecord(T, recordId);
  } catch (e) {
    console.error("setup: cannot read record", recordId, e);
    return;
  }
  const f = rec.fields || {};
  const series =
    (typeof f["Series"] === "string" ? f["Series"] : (f["Series"] && f["Series"].name)) || "Large Employer";
  const isEmployer = !/specialist/i.test(series);
  const entity = String(f["Employer / Niche Name"] || "").trim();
  const advisorUrl = String(f["Advisor Wealthtender URL"] || "").trim();

  if (!entity) {
    await safePatch(T, recordId, {
      "Setup Notes": "\u26A0\uFE0F Enter the Employer / Niche Name first, then re-check Generate Setup.",
      "Generate Setup": false,
    });
    return;
  }

  const now = new Date();
  const idPrefix = `${isEmployer ? "EMPQA" : "ICPQA"}-${now.getFullYear()}-${now.getMonth() + 1}-${articleIdKeyword(entity)}-`;

  let ai;
  try {
    ai = isEmployer
      ? await callClaudeJSON(SETUP_EMPLOYER_SYSTEM, `Employer name: ${entity}`, 1500)
      : await callClaudeJSON(SETUP_SPECIALIST_SYSTEM, `Niche audience: ${entity}`, 2000);
  } catch (e) {
    console.error("setup: model/parse failed", recordId, e);
    await safePatch(T, recordId, {
      "Setup Notes":
        "\u26A0\uFE0F Setup could not complete (" +
        String(e).slice(0, 160) +
        "). Fix and re-check Generate Setup, or fill the fields manually.",
      "Generate Setup": false,
    });
    return;
  }

  const n = (await countArticlesWithPrefix(idPrefix)) + 1;
  const articleId = `${idPrefix}${n}`;

  let audienceNoun, audienceShort, questionList, notes;
  if (isEmployer) {
    audienceNoun = String(ai.audienceNoun || "employees and executives").trim();
    audienceShort = String(ai.audienceShort || "employees").trim();
    const bespoke = Array.isArray(ai.bespokeQuestions) ? ai.bespokeQuestions.filter(Boolean) : [];
    const standard = STANDARD_EMPLOYER_QUESTIONS.map((q) => q.replace(/COMPANY/g, entity));
    questionList = standard.concat(bespoke).join("\n");
    notes =
      `Article ID: ${articleId}\n` +
      `Category: ${ai.category || "?"}  |  Audience noun: "${audienceNoun}"  |  Short: "${audienceShort}"  |  & Executives: ${ai.ampExecutives ? "yes" : "no"}\n` +
      (ai.rationale ? `Rationale: ${ai.rationale}\n` : "") +
      `\nQuestion List = 12 standard (COMPANY \u2192 ${entity}) + 2 bespoke:\n` +
      bespoke.map((q, i) => `  ${i + 1}. ${q}`).join("\n") +
      `\n\nReview the audience-noun / "& Executives" call and the 2 bespoke questions, then copy the Invite URL and send.`;
  } else {
    audienceNoun = String(ai.audienceNoun || entity).trim();
    audienceShort = String(ai.audienceShort || audienceNoun).trim();
    const qs = Array.isArray(ai.questions) ? ai.questions.filter(Boolean) : [];
    questionList = qs.join("\n");
    notes =
      `Article ID: ${articleId}\n` +
      `Audience noun: "${audienceNoun}"  |  Short: "${audienceShort}"\n` +
      `\nDrafted ${qs.length} questions for your review (edit/reorder/remove any in the Question List field):\n` +
      qs.map((q, i) => `  ${i + 1}. ${q}`).join("\n") +
      `\n\nThese are a starting point \u2014 tweak freely, then copy the Invite URL and send.`;
  }

  if (!advisorUrl) {
    notes += `\n\n\u26A0\uFE0F Advisor Wealthtender URL is blank \u2014 add it before inviting (the article card + generation need it).`;
  }

  await safePatch(T, recordId, {
    "Article ID": articleId,
    "Audience Noun": audienceNoun,
    "Audience Short": audienceShort,
    ...(isEmployer ? { "Category": String(ai.category || "").trim() } : {}),
    "Question List": questionList.slice(0, 95000),
    "Setup Notes": notes.slice(0, 95000),
    "Status": "Ready to Invite",
    "Generate Setup": false,
  });
  console.log(`setup complete ${recordId}: ${articleId} (${isEmployer ? "employer" : "specialist"})`);
}

app.post("/api/article-setup", async (req, res) => {
  const recordId = cleanRecordId(req.body && (req.body.recordId || req.body.id));
  if (!recordId) return res.status(400).json({ error: "missing recordId" });
  if (!ANTHROPIC_API_KEY || !AIRTABLE_API_KEY || !AIRTABLE_BASE_ID)
    return res.status(500).json({ error: "server not configured for setup" });
  res.json({ ok: true, queued: true, recordId });
  articleSetup(recordId).catch((e) => console.error("setup background error", recordId, e));
});

const dist = path.join(__dirname, "..", "dist");
app.use(express.static(dist));
app.get("*", (_req, res) => res.sendFile(path.join(dist, "index.html")));

app.listen(PORT, () => console.log(`Wealthtender advisor intake running on port ${PORT}`));
