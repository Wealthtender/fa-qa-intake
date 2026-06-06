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

    return { name, firm, firmUrl, bookIntro, headshot, tagline, bio, location };
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
<div style="border-left: 4px solid ${P.accent}; background: ${P.light}; border-radius: 0 6px 6px 0; padding: 20px 24px; margin: 0 0 28px 0;" itemscope itemtype="https://schema.org/Article">
  <p style="margin: 0 0 10px 0; font-size: 12px; font-weight: 700; letter-spacing: 0.09em; text-transform: uppercase; color: ${P.accent}; font-family: inherit;">${eyebrow}</p>
  <p itemprop="description" style="margin: 0; font-size: 17px; font-weight: 500; color: #1a2833; line-height: 1.8; font-family: inherit;">${sentence}</p>
</div>
<!-- /wp:html -->`;
}

function buildKeyTakeaways(P, takeaways) {
  const items = (takeaways || []).slice(0, 4).map((it, i, arr) => {
    const last = i === arr.length - 1;
    return `    <div itemprop="itemListElement" itemscope itemtype="https://schema.org/ListItem" style="display: flex; gap: 16px;${last ? "" : " margin-bottom: 20px;"}">
      <div style="flex-shrink: 0; background: ${P.accent}; color: #fff; font-weight: 700; font-size: 15px; width: 32px; height: 32px; border-radius: 50%; display: flex; align-items: center; justify-content: center;">${i + 1}</div>
      <div>
        <p style="margin: 0 0 4px 0; font-weight: 700; font-size: 16px; color: #1a2833;" itemprop="name">${esc(it.heading)}</p>
        <p style="margin: 0; font-size: 15px; color: #333; line-height: 1.6;" itemprop="description">${esc(it.description)}</p>
      </div>
    </div>`;
  }).join("\n");
  return `<!-- wp:html -->
<div style="background: ${KT_FILL}; border-left: 5px solid ${P.accent}; border-radius: 8px; padding: 24px 28px; margin: 24px 0; font-family: inherit;">
  <p style="margin: 0 0 16px 0; font-size: 13px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: ${P.accent};">Key Takeaways</p>
  <div itemscope itemtype="https://schema.org/ItemList">
${items}
  </div>
</div>
<!-- /wp:html -->`;
}

function buildQAPairs(P, qa) {
  return qa.map((it, i) => {
    const last = i === qa.length - 1;
    const outer = last ? `padding:20px 0;` : `border-bottom:1px solid ${P.divider};padding:20px 0;`;
    return `    <div style="${outer}" itemscope itemprop="mainEntity" itemtype="https://schema.org/Question">
      <p style="margin:0 0 10px 0;font-size:15px;font-weight:700;color:${P.accent};line-height:1.5;font-family:inherit;display:flex;gap:10px;align-items:flex-start;"><span style="flex-shrink:0;background:${P.accent};color:#fff;font-size:11px;font-weight:700;padding:2px 7px;border-radius:3px;margin-top:2px;letter-spacing:0.05em;font-family:inherit;">Q</span><span itemprop="name">${esc(it.question)}</span></p>
      <div itemscope itemprop="acceptedAnswer" itemtype="https://schema.org/Answer">
        <div itemprop="text" style="font-size:15px;color:#444;line-height:1.75;font-family:inherit;padding-left:34px;">${it.answerHtml}</div>
      </div>
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
    ? `<img src="${urlAttr(headshot)}" alt="${cardText(name)}, Financial Advisor for ${cardText(ctx.audienceLabel)} at ${cardText(firm || "their firm")}" style="width:72px;height:72px;border-radius:50%;object-fit:cover;border:3px solid rgba(255,255,255,0.35);flex-shrink:0;" itemprop="image">`
    : "";
  const firmHtml = firm
    ? (firmUrl
        ? `<a href="${urlAttr(firmUrl)}" target="_blank" rel="noopener noreferrer" style="color:rgba(255,255,255,0.95);text-decoration:underline;font-family:inherit;" itemprop="worksFor">${cardText(firm)}</a>`
        : `<span itemprop="worksFor">${cardText(firm)}</span>`)
    : "";
  const metaLine = [firmHtml, location ? cardText(location) : "", "Serves clients nationwide"].filter(Boolean).join(" &nbsp;&middot;&nbsp; ");
  const taglineHtml = tagline
    ? `\n      <span style="display:inline-block;background:rgba(255,255,255,0.15);border-radius:4px;padding:5px 12px;font-size:12px;color:rgba(255,255,255,0.9);font-family:inherit;" itemprop="description">${cardText(tagline)}</span>`
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

  <div style="background:${P.accent};border-radius:10px 10px 0 0;padding:22px 28px;display:flex;align-items:center;gap:20px;flex-wrap:wrap;" itemscope itemtype="https://schema.org/Person">
    ${imgHtml}
    <div style="flex:1;min-width:200px;">
      <p style="margin:0 0 4px 0;font-size:19px;font-weight:700;color:#fff;font-family:inherit;" itemprop="name">${cardText(name)}</p>
      <p style="margin:0 0 10px 0;font-size:13px;color:rgba(255,255,255,0.8);font-family:inherit;">${metaLine}</p>${taglineHtml}
    </div>${bookBtn}
  </div>
${bioStrip}
  <div style="background:#fff;border:1px solid ${P.border};${qaTopBorder}padding:0 28px;font-family:inherit;" itemscope itemtype="https://schema.org/FAQPage">
${buildQAPairs(P, qa)}
  </div>

  <div style="background:#fff;border:1px solid ${P.border};border-top:1px solid ${P.divider};border-radius:0 0 10px 10px;padding:16px 28px;font-family:inherit;">
    ${footerProfile}${disclosure}
  </div>

</div>
<!-- /wp:html -->`;
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

  const ctx = {
    entity, audienceNoun, audienceLabel, cardEyebrow, advisorUrl, advisorFirst, compliance,
    audienceSingular: ai.audienceSingular || "",
  };

  const generatedHtml = [
    buildTeaser(P, isEmployer, ctx),
    buildKeyTakeaways(P, ai.keyTakeaways),
    buildCard(P, ctx, profile, qa),
  ].join("\n\n");

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
