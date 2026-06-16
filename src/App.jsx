import React, { useState, useEffect, useRef } from "react";
import {
  Download, ArrowRight, ArrowLeft, Check, X, FileText, Sparkles,
  Plus, Trash2, ShieldCheck, Copy, Printer, CheckCircle2, SkipForward,
  Link as LinkIcon
} from "lucide-react";

/* ============================================================
   MOCK ARTICLE CONFIG
   In production this is fetched from Airtable using the article_id
   in the URL (e.g. ?id=EMPQA-2026-6-SPAC-1). SpaceX instance below.
   The advisor first name comes from the Airtable advisor record.
============================================================ */
const DEFAULT_CFG = {
  articleId: "EMPQA-2026-6-SPAC-1",
  series: "Large Employer",
  entity: "SpaceX",
  audience: "employees and executives",
  audienceShort: "employees",
  advisorFirstName: "there",
  generateCustom: true,
};

const STANDARD_QUESTIONS = [
  "As a financial advisor with experience helping SpaceX employees save for their retirement, how do you help them make the most of their employee benefits?",
  "When you first speak with a SpaceX employee, what questions do you like to ask to better understand their unique circumstances and determine how you can best help them achieve their goals?",
  "Is there a particular benefit available to SpaceX employees you feel isn't as well utilized or understood by employees as it should be?",
  "Beyond SpaceX employee benefits for retirement savings, are there other types of benefits offered by the company that you find valuable to discuss with your clients (e.g. stock, education savings, health savings)?",
  "For SpaceX employees thinking about leaving the company to accept a job elsewhere, what actions do you recommend they take before resigning and shortly thereafter?",
  "For SpaceX employees approaching retirement age, how do you recommend they prepare to make the transition from living off their salary to relying upon other sources of income?",
  "For SpaceX employees who have managed their finances on their own to this point, what would you suggest they consider to help them decide if they should begin working with a financial advisor at this stage in their lives?",
  "What are some of the unique financial planning challenges you commonly see among your clients who are SpaceX employees and how do you help them overcome these obstacles?",
  "What questions do you recommend SpaceX employees ask financial advisors they're considering hiring to help them decide if they're a good fit?",
  "Is there anything that comes up frequently in your initial meeting with SpaceX employees that surprises you?",
  "For highly compensated SpaceX employees and executives, are there any special benefits you believe it's important to take into consideration when preparing their financial plan?",
  "Is there a particularly memorable experience or a moment you recall with a client who worked at SpaceX when you realized they have unique opportunities and circumstances when it comes to their financial planning needs?",
];

const FALLBACK_CUSTOM = [
  "SpaceX employees often hold equity in a company whose stock isn't publicly traded — how do you help them think through the considerations and risks of concentrated private-company equity?",
  "Many SpaceX employees relocate to work at facilities like Starbase in Texas or Hawthorne in California — how do you help them navigate the financial and tax implications of relocating for their role?",
];

/* ============================================================
   CLAUDE API HELPER — routes through the Railway backend proxy
   (/api/claude) so the Anthropic key stays server-side.
============================================================ */
async function callClaude({ system, messages, maxTokens = 1000 }) {
  const res = await fetch("/api/claude", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ system, messages, maxTokens }),
  });
  if (!res.ok) throw new Error("claude_failed");
  const data = await res.json();
  return (data.text || "").trim();
}

const buildTransitionSystem = (cfg) => `You are the warm, articulate editorial voice of Wealthtender, guiding a financial advisor through a short Q&A interview. Their answers will be published verbatim on Wealthtender to help ${cfg.entity} ${cfg.audience} find a specialist financial advisor.

Between questions you write a brief transition. Strict rules:
- 1 to 2 sentences, ~35 words max.
- First, warmly acknowledge or reflect on what the advisor just shared — without flattery, evaluation, or summarizing their full answer.
- Then add a short bridging STATEMENT that signals you're moving to the next topic (e.g. "Let's move to another area where your perspective will help ${cfg.entity} employees.").
- NEVER ask a question of any kind. NEVER pose, preview, paraphrase, or hint at the next question — it appears on screen verbatim below your message, and a second question from you would confuse the advisor.
- Keep the bridge generic; do not name the specific upcoming topic.
- Vary your phrasing; never open two transitions the same way.
- About one time in three you may add one short clause noting why advisor insight tends to resonate with ${cfg.entity} ${cfg.audienceShort} or perform well in online search — still a statement, never a question, never salesy.

Return ONLY the transition text. No labels, no quotes, no questions, no preamble.`;

const CUSTOM_Q_SYSTEM = `You generate evergreen interview questions for a Wealthtender Q&A article that helps employees and executives at a specific company find a specialist financial advisor.

Given a company name, produce exactly 2 questions SPECIFIC to that employer's known compensation, benefits, equity, retirement, relocation, or career-transition characteristics — the kind of question an employee there would search for, and that a specialist advisor could answer with real insight.

Rules:
- Evergreen only. No current events, dated figures, specific years, IPO timing, recent layoffs, or one-time corporate actions.
- Address each question to the ADVISOR (e.g., "How do you help [Company] employees...").
- Each must be a complete, standalone question phrased like a professional interview question.
- Return ONLY a JSON array of 2 strings. No markdown, no preamble.`;

const FALLBACK_TRANSITIONS = [
  "Thank you for that thoughtful answer. Let's move to another area where your perspective will help.",
  "Appreciate you sharing that. Here's another topic worth your insight.",
  "That's a valuable perspective to put on the record. Let's continue.",
  "Noted, and thank you. Let's move to the next one.",
];

const stripHtml = (h) => (h || "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
const htmlHasText = (h) => stripHtml(h).length > 0;

/* ============================================================
   DRAFT AUTOSAVE — persists in-progress answers to localStorage so
   an advisor never loses work to a crash, refresh, sleep, or closed
   tab. Keyed per article. All access is guarded: if storage is
   unavailable (private mode, etc.) these no-op rather than throw.
============================================================ */
const DRAFT_PREFIX = "wt-intake-draft:";
const draftKey = (articleId) => DRAFT_PREFIX + (articleId || "default");

function saveDraft(articleId, snap) {
  try {
    localStorage.setItem(draftKey(articleId), JSON.stringify(snap));
  } catch {}
}
function loadDraft(articleId) {
  try {
    const raw = localStorage.getItem(draftKey(articleId));
    if (!raw) return null;
    const snap = JSON.parse(raw);
    // Only restore a draft that actually contains advisor-entered content.
    const hasAnswers = snap && snap.answers && Object.values(snap.answers).some((v) => htmlHasText(v));
    const hasProposed = snap && Array.isArray(snap.proposed) && snap.proposed.some((p) => (p.q && p.q.trim()) || htmlHasText(p.a));
    const hasDisc = snap && htmlHasText(snap.disc);
    if (!hasAnswers && !hasProposed && !hasDisc) return null;
    return snap;
  } catch {
    return null;
  }
}
function clearDraft(articleId) {
  try {
    localStorage.removeItem(draftKey(articleId));
  } catch {}
}

/* ============================================================
   RICH INPUT — minimal contentEditable with Link + Bold.
   Outputs clean HTML; external links get target/rel automatically.
============================================================ */
function RichInput({ value, onChange, placeholder, minHeight = 160 }) {
  const ref = useRef(null);
  const range = useRef(null);
  const [linkMode, setLinkMode] = useState(false);
  const [url, setUrl] = useState("");
  const [empty, setEmpty] = useState(!htmlHasText(value));

  useEffect(() => {
    if (ref.current) ref.current.innerHTML = value || "";
    setEmpty(!htmlHasText(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const addUtm = (href) => {
    if (!/^https?:\/\//i.test(href)) return href;
    if (/[?&]utm_source=/i.test(href)) return href; // don't clobber existing
    const hashIdx = href.indexOf("#");
    const base = hashIdx >= 0 ? href.slice(0, hashIdx) : href;
    const hash = hashIdx >= 0 ? href.slice(hashIdx) : "";
    const sep = base.includes("?") ? "&" : "?";
    return base + sep + "utm_source=wealthtender&utm_medium=referral" + hash;
  };

  const normalize = () => {
    if (!ref.current) return;
    ref.current.querySelectorAll("a").forEach((a) => {
      const href = a.getAttribute("href") || "";
      if (/^https?:\/\//i.test(href)) {
        a.setAttribute("href", addUtm(href));
        a.setAttribute("target", "_blank");
        a.setAttribute("rel", "noopener noreferrer");
      }
    });
  };

  const emit = () => {
    if (!ref.current) return;
    normalize();
    const html = ref.current.innerHTML;
    setEmpty(!htmlHasText(html));
    onChange(html);
  };

  const saveSel = () => {
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0 && ref.current && ref.current.contains(sel.anchorNode)) {
      range.current = sel.getRangeAt(0).cloneRange();
    }
  };

  const exec = (cmd) => {
    ref.current.focus();
    document.execCommand(cmd, false, null);
    emit();
  };

  const openLink = () => { saveSel(); setLinkMode(true); };

  const applyLink = () => {
    let u = url.trim();
    if (!u) { setLinkMode(false); return; }
    if (!/^https?:\/\//i.test(u) && !/^mailto:/i.test(u)) u = "https://" + u;
    ref.current.focus();
    const sel = window.getSelection();
    sel.removeAllRanges();
    if (range.current) sel.addRange(range.current);
    if (sel.isCollapsed) {
      document.execCommand("insertHTML", false, `<a href="${u}">${u}</a>`);
    } else {
      document.execCommand("createLink", false, u);
    }
    emit();
    setLinkMode(false);
    setUrl("");
  };

  return (
    <div className="wt-rich">
      <div className="wt-richtoolbar">
        <button type="button" className="wt-tbtn"
          onMouseDown={(e) => { e.preventDefault(); exec("bold"); }}><b>B</b></button>
        <button type="button" className="wt-tbtn"
          onMouseDown={(e) => { e.preventDefault(); exec("italic"); }}><i>I</i></button>
        <button type="button" className="wt-tbtn"
          onMouseDown={(e) => { e.preventDefault(); openLink(); }}>
          <LinkIcon size={13} /> Link
        </button>
      </div>
      <div className="wt-richboxwrap">
        <div
          ref={ref}
          className="wt-richbox"
          contentEditable
          suppressContentEditableWarning
          onInput={emit}
          onBlur={saveSel}
          style={{ minHeight }}
        />
        {empty && <span className="wt-richph">{placeholder}</span>}
      </div>
      {linkMode && (
        <div className="wt-linkpop">
          <input
            autoFocus
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") applyLink(); if (e.key === "Escape") { setLinkMode(false); setUrl(""); } }}
            placeholder="Paste a URL (e.g. yourfirm.com/article)"
          />
          <button className="wt-linkadd" onClick={applyLink}>Add link</button>
          <button className="wt-linkcancel" onClick={() => { setLinkMode(false); setUrl(""); }}>Cancel</button>
        </div>
      )}
    </div>
  );
}

/* ============================================================
   STYLES
============================================================ */
const STYLES = `
@import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600&family=Hanken+Grotesk:wght@400;500;600;700&display=swap');

.wt-root *{box-sizing:border-box;}
.wt-root{
  --paper:#f4efe4; --paper2:#ece5d6; --card:#fffdf8; --ink:#192a36;
  --navy:#1a5276; --navy2:#15435f; --muted:#76808a; --line:#e6ddcb;
  --line2:#dbe3ea; --gold:#b58a4b; --green:#2f6f57; --soft:#f7f3ec;
  font-family:'Hanken Grotesk',system-ui,sans-serif;color:var(--ink);
  background:
    radial-gradient(1200px 600px at 80% -10%, #fbf7ee 0%, rgba(251,247,238,0) 60%),
    radial-gradient(900px 500px at -10% 110%, #efe7d6 0%, rgba(239,231,214,0) 55%),
    var(--paper);
  min-height:100vh;width:100%;-webkit-font-smoothing:antialiased;
}
.wt-wrap{max-width:760px;margin:0 auto;padding:32px 24px 96px;}
.wt-serif{font-family:'Fraunces',Georgia,serif;}

.wt-top{display:flex;align-items:center;justify-content:space-between;margin-bottom:28px;}
.wt-brand{display:flex;align-items:center;gap:10px;}
.wt-mark{width:30px;height:30px;border-radius:7px;background:var(--navy);color:#fff;
  display:flex;align-items:center;justify-content:center;font-family:'Fraunces',serif;font-weight:600;font-size:17px;}
.wt-brandtext{font-weight:700;font-size:15px;letter-spacing:-0.01em;color:var(--ink);}
.wt-brandsub{font-size:11px;color:var(--muted);letter-spacing:0.04em;text-transform:uppercase;font-weight:600;}
.wt-allbtn{display:inline-flex;align-items:center;gap:7px;background:transparent;border:1px solid var(--line);
  color:var(--navy);border-radius:8px;padding:8px 13px;font-size:13px;font-weight:600;cursor:pointer;
  font-family:inherit;transition:all .18s ease;}
.wt-allbtn:hover{border-color:var(--navy);background:#fff;transform:translateY(-1px);}

.wt-card{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:40px;
  box-shadow:0 1px 0 #fff inset, 0 18px 40px -28px rgba(25,42,54,.28);}

.wt-eyebrow{font-size:11.5px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;
  color:var(--navy);margin:0 0 14px;display:flex;align-items:center;gap:8px;}
.wt-eyebrow .dot{width:5px;height:5px;border-radius:50%;background:var(--gold);}

.wt-h1{font-size:36px;line-height:1.12;font-weight:500;margin:0 0 18px;letter-spacing:-0.015em;color:var(--ink);}
.wt-h1 em{font-style:italic;color:var(--navy);}
.wt-lead{font-size:17px;line-height:1.72;color:#3a4750;margin:0 0 26px;}
.wt-how{background:var(--soft);border:1px solid var(--line);border-radius:14px;padding:22px 24px;margin:0 0 28px;}
.wt-how h3{font-size:12px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:var(--muted);margin:0 0 14px;}
.wt-howitem{display:flex;gap:12px;align-items:flex-start;margin-bottom:13px;font-size:15px;line-height:1.55;color:#34424c;}
.wt-howitem:last-child{margin-bottom:0;}
.wt-howitem .ic{flex-shrink:0;width:22px;height:22px;border-radius:6px;background:#eaf0f4;color:var(--navy);
  display:flex;align-items:center;justify-content:center;margin-top:1px;}

.wt-actions{display:flex;flex-direction:column;gap:14px;}
.wt-primary{display:inline-flex;align-items:center;justify-content:center;gap:9px;background:var(--navy);
  color:#fff;border:none;border-radius:11px;padding:16px 26px;font-size:15.5px;font-weight:600;cursor:pointer;
  font-family:inherit;transition:all .18s ease;box-shadow:0 10px 22px -12px rgba(26,82,118,.7);}
.wt-primary:hover{background:var(--navy2);transform:translateY(-1px);box-shadow:0 14px 26px -12px rgba(26,82,118,.75);}
.wt-primary:disabled{opacity:.5;cursor:not-allowed;transform:none;}
.wt-textlink{background:none;border:none;color:var(--navy);font-weight:600;font-size:14.5px;cursor:pointer;
  font-family:inherit;display:inline-flex;align-items:center;gap:8px;align-self:center;padding:4px;}
.wt-textlink:hover{text-decoration:underline;}
.wt-fineprint{font-size:13px;color:var(--muted);line-height:1.6;margin:22px 0 0;display:flex;gap:9px;align-items:flex-start;}

.wt-prog{display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;}
.wt-progtxt{font-size:12.5px;font-weight:600;color:var(--muted);letter-spacing:0.02em;}
.wt-tag{font-size:11px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:var(--gold);
  display:inline-flex;align-items:center;gap:5px;}
.wt-bar{height:4px;background:var(--paper2);border-radius:99px;overflow:hidden;margin-bottom:26px;}
.wt-barfill{height:100%;background:linear-gradient(90deg,var(--navy),#2f7aa6);border-radius:99px;
  transition:width .5s cubic-bezier(.4,0,.2,1);}

.wt-msg{display:flex;gap:13px;align-items:flex-start;margin-bottom:22px;animation:fadeUp .5s ease both;}
.wt-msg .av{flex-shrink:0;width:32px;height:32px;border-radius:9px;background:var(--navy);color:#fff;
  display:flex;align-items:center;justify-content:center;font-family:'Fraunces',serif;font-weight:600;font-size:16px;}
.wt-msgbody{font-size:15.5px;line-height:1.6;color:#42505a;padding-top:4px;}
.wt-dots{display:inline-flex;gap:4px;padding-top:10px;}
.wt-dots span{width:7px;height:7px;border-radius:50%;background:var(--navy);opacity:.4;animation:blink 1.2s infinite;}
.wt-dots span:nth-child(2){animation-delay:.2s;}
.wt-dots span:nth-child(3){animation-delay:.4s;}

.wt-q{font-family:'Fraunces',serif;font-size:24px;line-height:1.34;font-weight:500;color:var(--ink);
  margin:0 0 20px;letter-spacing:-0.01em;animation:fadeUp .5s .08s ease both;}

/* rich input */
.wt-rich{animation:fadeUp .5s .14s ease both;}
.wt-richtoolbar{display:flex;gap:6px;margin-bottom:9px;}
.wt-tbtn{display:inline-flex;align-items:center;gap:6px;background:#f3efe6;border:1px solid var(--line);
  border-radius:7px;padding:6px 11px;font-size:13px;font-weight:600;color:#42505a;cursor:pointer;font-family:inherit;transition:all .15s;}
.wt-tbtn:hover{background:#ece6da;color:var(--navy);}
.wt-tbtn b{font-size:14px;}
.wt-richboxwrap{position:relative;}
.wt-richbox{width:100%;border:1px solid var(--line);border-radius:13px;padding:18px 19px;font-family:inherit;
  font-size:15.5px;line-height:1.65;color:var(--ink);background:#fffefb;outline:none;transition:border .18s, box-shadow .18s;}
.wt-richbox:focus{border-color:var(--navy);box-shadow:0 0 0 3px rgba(26,82,118,.1);}
.wt-richbox a{color:var(--navy);}
.wt-richph{position:absolute;top:18px;left:20px;right:20px;color:#a9b1b8;pointer-events:none;font-size:15.5px;line-height:1.65;}
.wt-richcap{font-size:12.5px;color:var(--muted);margin-top:10px;display:flex;align-items:flex-start;gap:7px;line-height:1.5;}
.wt-linkpop{display:flex;gap:8px;margin-top:11px;background:#fff;border:1px solid var(--line);border-radius:10px;padding:10px;align-items:center;}
.wt-linkpop input{flex:1;border:1px solid var(--line);border-radius:7px;padding:9px 11px;font-family:inherit;font-size:14px;color:var(--ink);}
.wt-linkpop input:focus{outline:none;border-color:var(--navy);}
.wt-linkadd{background:var(--navy);color:#fff;border:none;border-radius:7px;padding:9px 14px;font-weight:600;font-size:13px;cursor:pointer;font-family:inherit;}
.wt-linkcancel{background:none;border:none;color:var(--muted);font-weight:600;font-size:13px;cursor:pointer;font-family:inherit;}

.wt-controls{display:flex;align-items:center;justify-content:space-between;margin-top:18px;}
.wt-ghost{display:inline-flex;align-items:center;gap:7px;background:none;border:none;color:var(--muted);
  font-size:14px;font-weight:600;cursor:pointer;font-family:inherit;padding:8px;}
.wt-ghost:hover{color:var(--navy);}
.wt-rightcontrols{display:flex;align-items:center;gap:10px;}
.wt-skip{background:none;border:1px solid var(--line);border-radius:9px;padding:11px 16px;color:var(--muted);
  font-weight:600;font-size:14px;cursor:pointer;font-family:inherit;transition:all .18s;}
.wt-skip:hover{border-color:var(--muted);color:var(--ink);}
.wt-next{display:inline-flex;align-items:center;gap:8px;background:var(--navy);color:#fff;border:none;border-radius:9px;
  padding:12px 20px;font-size:14.5px;font-weight:600;cursor:pointer;font-family:inherit;transition:all .18s;}
.wt-next:hover{background:var(--navy2);transform:translateY(-1px);}
.wt-next:disabled{opacity:.5;cursor:not-allowed;transform:none;}

.wt-sech2{font-family:'Fraunces',serif;font-size:27px;font-weight:500;margin:0 0 12px;letter-spacing:-0.015em;color:var(--ink);}
.wt-sectext{font-size:15.5px;line-height:1.7;color:#42505a;margin:0 0 24px;}
.wt-propcard{border:1px solid var(--line);border-radius:13px;padding:18px;margin-bottom:14px;background:#fffefb;}
.wt-fieldlabel{font-size:12px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;color:var(--muted);margin:0 0 8px;}
.wt-input{width:100%;border:1px solid var(--line);border-radius:10px;padding:13px 15px;font-family:inherit;font-size:15px;
  color:var(--ink);background:#fff;margin-bottom:14px;}
.wt-input:focus{outline:none;border-color:var(--navy);box-shadow:0 0 0 3px rgba(26,82,118,.1);}
.wt-addbtn{display:inline-flex;align-items:center;gap:8px;background:#eaf0f4;color:var(--navy);border:1px dashed #bcd0dd;
  border-radius:10px;padding:12px 16px;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit;width:100%;justify-content:center;transition:all .18s;}
.wt-addbtn:hover{background:#e1ebf1;}
.wt-removerow{background:none;border:none;color:#b85c5c;cursor:pointer;display:inline-flex;align-items:center;gap:6px;
  font-size:13px;font-weight:600;font-family:inherit;padding:10px 0 0;}

.wt-choices{display:flex;gap:12px;margin-bottom:20px;}
.wt-choice{flex:1;border:1.5px solid var(--line);border-radius:12px;padding:18px;cursor:pointer;background:#fffefb;
  transition:all .18s;text-align:left;font-family:inherit;}
.wt-choice:hover{border-color:#bcd0dd;}
.wt-choice.on{border-color:var(--navy);background:#f3f8fb;box-shadow:0 0 0 3px rgba(26,82,118,.08);}
.wt-choice .ct{font-weight:700;font-size:15px;color:var(--ink);margin-bottom:4px;}
.wt-choice .cd{font-size:13px;color:var(--muted);line-height:1.45;}

.wt-check{display:flex;gap:12px;align-items:flex-start;cursor:pointer;padding:16px;border:1px solid var(--line);
  border-radius:12px;background:var(--soft);}
.wt-box{flex-shrink:0;width:22px;height:22px;border-radius:6px;border:1.5px solid #c3ccd2;background:#fff;
  display:flex;align-items:center;justify-content:center;transition:all .15s;margin-top:1px;}
.wt-box.on{background:var(--navy);border-color:var(--navy);}
.wt-checktext{font-size:14.5px;line-height:1.55;color:#3a4750;}

.wt-rev{border:1px solid var(--line);border-radius:13px;padding:18px 20px;margin-bottom:12px;background:#fffefb;}
.wt-revq{font-family:'Fraunces',serif;font-size:16.5px;font-weight:500;color:var(--ink);line-height:1.4;margin:0 0 10px;}
.wt-reva{font-size:14.5px;line-height:1.6;color:#42505a;}
.wt-reva a{color:var(--navy);}
.wt-revskip{font-size:13.5px;color:var(--muted);font-style:italic;display:inline-flex;align-items:center;gap:7px;}
.wt-editlink{background:none;border:none;color:var(--navy);font-weight:600;font-size:13px;cursor:pointer;font-family:inherit;float:right;}
.wt-customchip{font-size:10px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:var(--gold);
  background:#faf3e6;border:1px solid #ecdcc0;border-radius:5px;padding:2px 7px;margin-left:8px;vertical-align:middle;}

.wt-overlay{position:fixed;inset:0;background:rgba(20,30,38,.55);backdrop-filter:blur(3px);display:flex;
  align-items:flex-start;justify-content:center;padding:40px 20px;z-index:50;overflow-y:auto;animation:fadeIn .2s ease;}
.wt-modal{background:var(--card);border-radius:18px;max-width:680px;width:100%;box-shadow:0 30px 70px -30px rgba(0,0,0,.5);animation:fadeUp .3s ease;}
.wt-modalhead{padding:26px 28px 20px;border-bottom:1px solid var(--line);position:relative;}
.wt-modalbody{padding:24px 28px;}
.wt-closex{position:absolute;top:22px;right:22px;background:#f0eadd;border:none;border-radius:8px;width:32px;height:32px;
  display:flex;align-items:center;justify-content:center;cursor:pointer;color:var(--muted);}
.wt-closex:hover{background:#e6dfce;color:var(--ink);}
.wt-qrow{display:flex;gap:12px;align-items:flex-start;padding:13px 0;border-bottom:1px solid var(--line);}
.wt-qrow:last-child{border-bottom:none;}
.wt-qcheck{flex-shrink:0;width:20px;height:20px;border-radius:5px;border:1.5px solid #c3ccd2;background:#fff;
  display:flex;align-items:center;justify-content:center;cursor:pointer;margin-top:2px;}
.wt-qcheck.on{background:var(--navy);border-color:var(--navy);}
.wt-qtext{font-size:14px;line-height:1.5;color:#3a4750;}
.wt-qtext.off{opacity:.4;text-decoration:line-through;}
.wt-modalfoot{padding:18px 28px 24px;border-top:1px solid var(--line);display:flex;gap:12px;}

.wt-done{text-align:center;padding:20px 0;}
.wt-donecircle{width:70px;height:70px;border-radius:50%;background:#e8f3ee;color:var(--green);display:flex;
  align-items:center;justify-content:center;margin:0 auto 22px;animation:pop .5s ease both;}
.wt-idpill{display:inline-block;background:var(--soft);border:1px solid var(--line);border-radius:8px;padding:7px 14px;
  font-size:13px;font-weight:600;color:var(--navy);letter-spacing:0.03em;margin:6px 0 22px;font-family:'Fraunces',serif;}
.wt-nextbox{text-align:left;background:var(--soft);border:1px solid var(--line);border-radius:13px;padding:20px 22px;margin-top:8px;}
.wt-nextbox h4{font-size:12px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:var(--muted);margin:0 0 14px;}
.wt-nextitem{display:flex;gap:11px;align-items:flex-start;font-size:14.5px;line-height:1.55;color:#3a4750;margin-bottom:11px;}
.wt-nextitem:last-child{margin-bottom:0;}
.wt-nextnum{flex-shrink:0;width:21px;height:21px;border-radius:50%;background:var(--navy);color:#fff;font-size:11px;
  font-weight:700;display:flex;align-items:center;justify-content:center;margin-top:1px;}

.wt-note{font-size:12.5px;color:var(--muted);text-align:center;margin-top:18px;line-height:1.5;}
.wt-divider{height:1px;background:var(--line);margin:26px 0;border:none;}

@keyframes fadeUp{from{opacity:0;transform:translateY(10px);}to{opacity:1;transform:none;}}
@keyframes fadeIn{from{opacity:0;}to{opacity:1;}}
@keyframes blink{0%,60%,100%{opacity:.3;}30%{opacity:1;}}
@keyframes pop{0%{transform:scale(.7);opacity:0;}60%{transform:scale(1.08);}100%{transform:scale(1);opacity:1;}}

@media (max-width:600px){.wt-card{padding:26px 20px;}.wt-h1{font-size:29px;}.wt-q{font-size:21px;}.wt-choices{flex-direction:column;}}
@media print{.wt-root>*:not(.wt-printonly){display:none !important;}.wt-printonly{display:block !important;}}
.wt-printonly{display:none;}
`;

/* ============================================================
   APP
============================================================ */
export default function App() {
  const [cfg, setCfg] = useState(DEFAULT_CFG);
  const [phase, setPhase] = useState("welcome");
  const [custom, setCustom] = useState(null);
  const [allQ, setAllQ] = useState([]);
  const [idx, setIdx] = useState(0);
  const [answers, setAnswers] = useState({});
  const [skipped, setSkipped] = useState({});
  const [draft, setDraft] = useState("");
  const [transition, setTransition] = useState("");
  const [thinking, setThinking] = useState(false);
  const [proposed, setProposed] = useState([{ id: 1, q: "", a: "" }]);
  const [propId, setPropId] = useState(2);
  const [hasDisc, setHasDisc] = useState(null);
  const [disc, setDisc] = useState("");
  const [ready, setReady] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [excluded, setExcluded] = useState({});
  const [editingFrom, setEditingFrom] = useState(null);
  const [copied, setCopied] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [restored, setRestored] = useState(false);
  const hydrated = useRef(false);

  useEffect(() => {
    let active = true;
    (async () => {
      // 1) Load the article config from the backend (Airtable in production)
      let conf = DEFAULT_CFG;
      try {
        const id = new URLSearchParams(window.location.search).get("id");
        const r = await fetch(`/api/config${id ? `?id=${encodeURIComponent(id)}` : ""}`);
        if (r.ok) {
          const d = await r.json();
          if (d && d.entity) conf = { ...DEFAULT_CFG, ...d };
        }
      } catch {}
      if (!active) return;
      setCfg(conf);

      // 1b) If this advisor has an in-progress draft for THIS article, restore it
      // verbatim and resume where they left off — before generating anything fresh.
      const snap = loadDraft(conf.articleId);
      if (snap && snap.phase && snap.phase !== "submitted") {
        setCustom(Array.isArray(snap.custom) ? snap.custom : []);
        if (Array.isArray(snap.allQ) && snap.allQ.length) setAllQ(snap.allQ);
        if (snap.answers) setAnswers(snap.answers);
        if (snap.skipped) setSkipped(snap.skipped);
        if (Array.isArray(snap.proposed) && snap.proposed.length) setProposed(snap.proposed);
        if (typeof snap.propId === "number") setPropId(snap.propId);
        if (typeof snap.hasDisc === "boolean") setHasDisc(snap.hasDisc);
        if (typeof snap.disc === "string") setDisc(snap.disc);
        if (typeof snap.ready === "boolean") setReady(snap.ready);
        if (typeof snap.excluded === "object" && snap.excluded) setExcluded(snap.excluded);
        const resumeIdx = typeof snap.idx === "number" ? snap.idx : 0;
        setIdx(resumeIdx);
        if (snap.answers && typeof snap.answers[resumeIdx] === "string") setDraft(snap.answers[resumeIdx]);
        // Resume in the conversation (or wherever they were); avoid the AI
        // transition spinner so restored text shows immediately.
        setPhase(snap.phase === "welcome" ? "welcome" : (snap.phase === "submitted" ? "review" : snap.phase));
        setRestored(true);
        hydrated.current = true;
        return;
      }

      // 2) Large Employer: generate employer-specific questions. Specialist: none.
      if (conf.generateCustom) {
        try {
          const txt = await callClaude({
            system: CUSTOM_Q_SYSTEM,
            messages: [{ role: "user", content: `Company: ${conf.entity}. Generate the questions.` }],
            maxTokens: 400,
          });
          const arr = JSON.parse(txt.replace(/```json|```/g, "").trim());
          if (active) setCustom(Array.isArray(arr) && arr.length ? arr.slice(0, 2) : FALLBACK_CUSTOM);
        } catch {
          if (active) setCustom(FALLBACK_CUSTOM);
        }
      } else if (active) {
        setCustom([]);
      }
      hydrated.current = true;
    })();
    return () => { active = false; };
  }, []);

  // Continuously autosave the in-progress draft to localStorage. Folds the live
  // editor buffer (draft) into answers at the current index so even mid-sentence
  // typing survives a crash. Never runs before hydration (so the initial empty
  // render can't clobber a restored draft) and never persists the submitted state.
  useEffect(() => {
    if (!hydrated.current) return;
    if (phase === "submitted") return;
    const mergedAnswers = { ...answers };
    if (phase === "conversation" && htmlHasText(draft)) mergedAnswers[idx] = draft;
    saveDraft(cfg.articleId, {
      v: 1,
      articleId: cfg.articleId,
      savedAt: new Date().toISOString(),
      phase, idx,
      answers: mergedAnswers,
      skipped, proposed, propId, hasDisc, disc, ready, excluded,
      allQ, custom,
    });
  }, [phase, idx, answers, draft, skipped, proposed, propId, hasDisc, disc, ready, excluded, allQ, custom, cfg.articleId]);

  // Warn before leaving with unsaved-looking work in progress. (The draft is
  // already persisted to localStorage; this is a second, belt-and-suspenders cue.)
  useEffect(() => {
    const handler = (e) => {
      if (phase === "submitted" || phase === "welcome") return;
      const hasContent = Object.values(answers).some((v) => htmlHasText(v)) || htmlHasText(draft) ||
        proposed.some((p) => (p.q && p.q.trim()) || htmlHasText(p.a)) || htmlHasText(disc);
      if (!hasContent) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [phase, answers, draft, proposed, disc]);

  const buildAll = () => {
    const c = custom || [];
    const std = (cfg.standardQuestions && cfg.standardQuestions.length ? cfg.standardQuestions : STANDARD_QUESTIONS);
    return [
      ...std.map((t) => ({ text: String(t).replace(/COMPANY/g, cfg.entity), type: "standard" })),
      ...c.map((t) => ({ text: t, type: "custom" })),
    ];
  };

  const requestTransition = async (kind, justAnswered, justQuestion) => {
    setThinking(true);
    setTransition("");
    let userMsg;
    if (kind === "welcome") {
      userMsg = `This is the very start of the interview with ${cfg.advisorFirstName}. Write a warm 2-3 sentence welcome that thanks them, sets a relaxed but thoughtful tone, and signals the first question is shown below — without posing any question yourself.`;
    } else if (kind === "skip") {
      userMsg = `The advisor chose to skip the previous question. Write a brief, gracious transition (a statement, never a question) that doesn't make them feel bad and signals moving to the next topic.`;
    } else {
      userMsg = `The advisor just answered this question: "${justQuestion}" with: "${stripHtml(justAnswered)}". Write the transition (statements only, never a question).`;
    }
    try {
      const txt = await callClaude({ system: buildTransitionSystem(cfg), messages: [{ role: "user", content: userMsg }], maxTokens: 200 });
      setTransition(txt || FALLBACK_TRANSITIONS[Math.floor(Math.random() * FALLBACK_TRANSITIONS.length)]);
    } catch {
      setTransition(FALLBACK_TRANSITIONS[Math.floor(Math.random() * FALLBACK_TRANSITIONS.length)]);
    }
    setThinking(false);
  };

  const begin = () => {
    const all = buildAll();
    setAllQ(all);
    setPhase("conversation");
    setIdx(0);
    setDraft("");
    requestTransition("welcome");
  };

  const advance = (didSkip) => {
    const curr = allQ[idx];
    if (didSkip) {
      setSkipped((s) => ({ ...s, [idx]: true }));
      setAnswers((a) => { const n = { ...a }; delete n[idx]; return n; });
    } else {
      setAnswers((a) => ({ ...a, [idx]: draft }));
      setSkipped((s) => { const n = { ...s }; delete n[idx]; return n; });
    }
    if (editingFrom === "review") { setEditingFrom(null); setPhase("review"); return; }
    const nextIdx = idx + 1;
    if (nextIdx >= allQ.length) { setPhase("propose"); return; }
    setIdx(nextIdx);
    setDraft(answers[nextIdx] || "");
    requestTransition(didSkip ? "skip" : "answer", didSkip ? null : draft, curr.text);
  };

  const goBack = () => {
    if (idx === 0) { setPhase("welcome"); return; }
    setAnswers((a) => ({ ...a, [idx]: draft }));
    const prev = idx - 1;
    setIdx(prev);
    setDraft(answers[prev] || "");
    setTransition("");
    setThinking(false);
  };

  const jumpToEdit = (i) => {
    if (!allQ.length) setAllQ(buildAll());
    setIdx(i);
    setDraft(answers[i] || "");
    setEditingFrom("review");
    setPhase("conversation");
    setTransition("");
    setThinking(false);
  };

  const doSubmit = async () => {
    if (submitting) return; // guard against double-submit
    setSubmitting(true);
    setSubmitError("");
    const payload = {
      articleId: cfg.articleId,
      series: cfg.series,
      entity: cfg.entity,
      answers: allQ.map((q, i) => ({
        question: q.text, type: q.type,
        answerHtml: answers[i] || "", skipped: !answers[i],
      })),
      proposed: proposed
        .filter((p) => p.q.trim() || htmlHasText(p.a))
        .map((p) => ({ question: p.q, answerHtml: p.a })),
      complianceDisclosure: hasDisc === true ? disc : "",
      readyForPublication: ready,
      submittedAt: new Date().toISOString(),
    };
    try {
      const r = await fetch("/api/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!r.ok) throw new Error(`The server returned an error (${r.status}).`);
      const d = await r.json().catch(() => null);
      if (!d || d.ok !== true) throw new Error("The submission wasn't confirmed.");
      // Treat a fallback-to-log as NOT durably saved — the record isn't in the
      // database, so we must not tell the advisor it succeeded.
      if (d.stored && d.stored === "log") throw new Error("We couldn't reach the database to save your answers.");
      // Confirmed durable save — now it's safe to clear the local draft.
      clearDraft(cfg.articleId);
      setPhase("submitted");
    } catch (e) {
      setSubmitError(
        (e && e.message ? e.message + " " : "") +
        "Your answers are safe and still here on this page — nothing was lost. Please try submitting again in a moment."
      );
    } finally {
      setSubmitting(false);
    }
  };

  const total = allQ.length || buildAll().length;
  const progress = phase === "conversation" ? (idx / total) * 100 : 0;
  const overlayQuestions = allQ.length ? allQ : buildAll();

  const includedText = () => {
    const lines = [
      `Wealthtender Q&A — ${cfg.entity} ${cfg.audience}`,
      `Reference: ${cfg.articleId}`, ``,
      `Please share your answers to any of the questions below. Your responses are published in your own words.`, ``,
    ];
    let n = 1;
    overlayQuestions.forEach((q, i) => {
      if (excluded[i]) return;
      lines.push(`${n}. ${q.text}`, ``, `Your answer:`, ``, ``);
      n++;
    });
    lines.push(`If you'd like to propose your own question and answer, please add it here:`, ``,
      `Do you have any compliance disclosures that must appear with your published Q&A? If so, please include the exact language.`);
    return lines.join("\n");
  };

  const copyAll = async () => {
    try { await navigator.clipboard.writeText(includedText()); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch {}
  };

  return (
    <div className="wt-root">
      <style>{STYLES}</style>

      <div className="wt-printonly">
        <pre style={{ fontFamily: "Georgia, serif", fontSize: 13, whiteSpace: "pre-wrap", padding: 24 }}>{includedText()}</pre>
      </div>

      <div className="wt-wrap">
        <div className="wt-top">
          <div className="wt-brand">
            <div className="wt-mark">W</div>
            <div>
              <div className="wt-brandtext">Wealthtender</div>
              <div className="wt-brandsub">Advisor Q&amp;A</div>
            </div>
          </div>
          {phase !== "submitted" && (
            <button className="wt-allbtn" onClick={() => setShowAll(true)}><FileText size={15} /> All questions</button>
          )}
        </div>

        {restored && phase !== "submitted" && (
          <div style={{ display: "flex", alignItems: "flex-start", gap: 10, margin: "0 0 18px 0", padding: "12px 16px", background: "#eef6f0", border: "1px solid #c8e2d2", borderRadius: 8, color: "#1c5234", fontSize: 14, lineHeight: 1.6 }}>
            <Check size={16} style={{ flexShrink: 0, marginTop: 2 }} />
            <span style={{ flex: 1 }}>Welcome back — we restored your in-progress answers so you can pick up right where you left off.</span>
            <button onClick={() => setRestored(false)} style={{ background: "none", border: "none", color: "#1c5234", cursor: "pointer", fontWeight: 600, fontSize: 13 }}>Dismiss</button>
          </div>
        )}

        {/* WELCOME */}
        {phase === "welcome" && (
          <div className="wt-card" style={{ animation: "fadeUp .5s ease both" }}>
            <p className="wt-eyebrow"><span className="dot" />Financial Advisor Q&amp;A · {cfg.entity}</p>
            <h1 className="wt-h1 wt-serif">Share your expertise with <em>{cfg.entity}</em> employees &amp; executives</h1>
            <p className="wt-lead">
              Thank you for contributing, {cfg.advisorFirstName}. Your answers will be published on Wealthtender
              to help {cfg.entity} {cfg.audience} find a financial advisor who understands their benefits and
              compensation — and to put your expertise in front of the people already searching for it.
            </p>
            <div className="wt-how">
              <h3>What to expect</h3>
              <div className="wt-howitem"><span className="ic"><Sparkles size={13} /></span>
                <span>A set of questions tailored to {cfg.entity}, plus a couple specific to working there. Take your time with each — your answers are published in your own words, as written.</span></div>
              <div className="wt-howitem"><span className="ic"><SkipForward size={13} /></span>
                <span>Skip any question, revisit earlier answers anytime, and review everything before you submit.</span></div>
              <div className="wt-howitem"><span className="ic"><ShieldCheck size={13} /></span>
                <span>Need compliance to review first? Grab all the questions as a document and come back when you're ready.</span></div>
              <div className="wt-howitem"><span className="ic"><FileText size={13} /></span>
                <span>Takes about 15–20 minutes. Your perspective is the value, so it's worth answering thoughtfully.</span></div>
            </div>
            <div className="wt-actions">
              <button className="wt-primary" onClick={begin} disabled={!custom}>
                {custom ? <>Begin the Q&amp;A <ArrowRight size={18} /></> : "Preparing your questions…"}
              </button>
              <button className="wt-textlink" onClick={() => setShowAll(true)}>
                <Download size={15} /> Prefer to review with compliance first? Get all the questions
              </button>
            </div>
            <p className="wt-fineprint">
              <ShieldCheck size={15} style={{ flexShrink: 0, marginTop: 1, color: "var(--navy)" }} />
              Your answers are published in your own words. We only correct typos and clear errors.
            </p>
          </div>
        )}

        {/* CONVERSATION */}
        {phase === "conversation" && (
          <div>
            <div className="wt-prog">
              <span className="wt-progtxt">Question {idx + 1} of {total}</span>
              {allQ[idx]?.type === "custom" && <span className="wt-tag"><Sparkles size={12} /> {cfg.entity}-specific</span>}
            </div>
            <div className="wt-bar"><div className="wt-barfill" style={{ width: `${progress}%` }} /></div>
            <div className="wt-card">
              <div className="wt-msg">
                <div className="av">W</div>
                <div className="wt-msgbody">
                  {thinking ? <div className="wt-dots"><span /><span /><span /></div> : (transition || "Here's the next question.")}
                </div>
              </div>
              {!thinking && (
                <>
                  <p className="wt-q wt-serif">{allQ[idx]?.text}</p>
                  <RichInput
                    key={idx}
                    value={draft}
                    onChange={setDraft}
                    placeholder="Share your answer in your own words. Take your time — this is published as written."
                    minHeight={160}
                  />
                  <p className="wt-richcap"><ShieldCheck size={13} style={{ color: "var(--navy)", flexShrink: 0, marginTop: 2 }} />
                    <span>Published verbatim. Select any text and use <strong>Link</strong> to point a phrase to a page on your website.</span></p>
                  <div className="wt-controls">
                    <button className="wt-ghost" onClick={goBack}><ArrowLeft size={15} /> Back</button>
                    <div className="wt-rightcontrols">
                      <button className="wt-skip" onClick={() => advance(true)}>Skip</button>
                      <button className="wt-next" onClick={() => advance(false)} disabled={!htmlHasText(draft)}>
                        {editingFrom === "review" ? "Save & return" : "Continue"} <ArrowRight size={16} />
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        {/* PROPOSE */}
        {phase === "propose" && (
          <div className="wt-card" style={{ animation: "fadeUp .5s ease both" }}>
            <p className="wt-eyebrow"><span className="dot" />One more invitation</p>
            <h2 className="wt-sech2 wt-serif">Anything you'd add in your own words?</h2>
            <p className="wt-sectext">
              You've answered the questions we prepared — thank you. If there's a question your {cfg.entity}
              clients often ask that we didn't cover, this is the place to add it. Completely optional.
            </p>
            {proposed.map((p, i) => (
              <div className="wt-propcard" key={p.id}>
                <p className="wt-fieldlabel">Your question {proposed.length > 1 ? `#${i + 1}` : ""}</p>
                <input className="wt-input" placeholder="e.g. How should new SpaceX hires think about their first equity grant?"
                  value={p.q} onChange={(e) => setProposed((arr) => arr.map((x) => x.id === p.id ? { ...x, q: e.target.value } : x))} />
                <p className="wt-fieldlabel">Your answer</p>
                <RichInput key={p.id} value={p.a} minHeight={90}
                  onChange={(html) => setProposed((arr) => arr.map((x) => x.id === p.id ? { ...x, a: html } : x))}
                  placeholder="Your answer, in your own words. Add links if helpful." />
                {proposed.length > 1 && (
                  <button className="wt-removerow" onClick={() => setProposed((arr) => arr.filter((x) => x.id !== p.id))}>
                    <Trash2 size={13} /> Remove
                  </button>
                )}
              </div>
            ))}
            <button className="wt-addbtn" onClick={() => { setProposed((arr) => [...arr, { id: propId, q: "", a: "" }]); setPropId(propId + 1); }}>
              <Plus size={16} /> Add another question
            </button>
            <div className="wt-controls" style={{ marginTop: 26 }}>
              <button className="wt-ghost" onClick={() => { setPhase("conversation"); setIdx(total - 1); setDraft(answers[total - 1] || ""); }}>
                <ArrowLeft size={15} /> Back
              </button>
              <button className="wt-next" onClick={() => setPhase("compliance")}>Continue <ArrowRight size={16} /></button>
            </div>
          </div>
        )}

        {/* COMPLIANCE */}
        {phase === "compliance" && (
          <div className="wt-card" style={{ animation: "fadeUp .5s ease both" }}>
            <p className="wt-eyebrow"><span className="dot" />Compliance</p>
            <h2 className="wt-sech2 wt-serif">Do you have any required disclosures?</h2>
            <p className="wt-sectext">
              Some advisors' compliance teams require specific disclosure language to appear alongside published content.
              If that applies to you, we'll place it directly beneath your Q&amp;A.
            </p>
            <div className="wt-choices">
              <button className={`wt-choice ${hasDisc === false ? "on" : ""}`} onClick={() => { setHasDisc(false); setDisc(""); }}>
                <div className="ct">No disclosure needed</div><div className="cd">My answers can be published as-is.</div>
              </button>
              <button className={`wt-choice ${hasDisc === true ? "on" : ""}`} onClick={() => setHasDisc(true)}>
                <div className="ct">Yes, I have disclosure language</div><div className="cd">I'll provide the exact wording to include.</div>
              </button>
            </div>
            {hasDisc === true && (
              <div style={{ marginBottom: 20 }}>
                <RichInput key="disc" value={disc} onChange={setDisc} minHeight={120}
                  placeholder="Paste the exact disclosure language your compliance team requires. You can add links if needed." />
              </div>
            )}
            <div className="wt-controls">
              <button className="wt-ghost" onClick={() => setPhase("propose")}><ArrowLeft size={15} /> Back</button>
              <button className="wt-next" onClick={() => setPhase("review")}
                disabled={hasDisc === null || (hasDisc === true && !htmlHasText(disc))}>
                Review my answers <ArrowRight size={16} />
              </button>
            </div>
          </div>
        )}

        {/* REVIEW */}
        {phase === "review" && (
          <div style={{ animation: "fadeUp .5s ease both" }}>
            <div className="wt-card">
              <p className="wt-eyebrow"><span className="dot" />Final review</p>
              <h2 className="wt-sech2 wt-serif">Review your responses</h2>
              <p className="wt-sectext">Here's everything you're about to submit. Edit anything that doesn't feel right — your words are what get published.</p>
              {allQ.map((q, i) => (
                <div className="wt-rev" key={i}>
                  <button className="wt-editlink" onClick={() => jumpToEdit(i)}>{answers[i] ? "Edit" : "Answer"}</button>
                  <p className="wt-revq wt-serif">{q.text}{q.type === "custom" && <span className="wt-customchip">{cfg.entity}-specific</span>}</p>
                  {answers[i]
                    ? <div className="wt-reva" dangerouslySetInnerHTML={{ __html: answers[i] }} />
                    : <span className="wt-revskip"><SkipForward size={13} /> Skipped</span>}
                </div>
              ))}
              {proposed.some((p) => p.q.trim() || htmlHasText(p.a)) && (
                <>
                  <hr className="wt-divider" />
                  <p className="wt-fieldlabel" style={{ marginBottom: 12 }}>Your proposed questions</p>
                  {proposed.filter((p) => p.q.trim() || htmlHasText(p.a)).map((p) => (
                    <div className="wt-rev" key={p.id}>
                      <p className="wt-revq wt-serif">{p.q || "(no question text)"}</p>
                      <div className="wt-reva" dangerouslySetInnerHTML={{ __html: p.a }} />
                    </div>
                  ))}
                </>
              )}
              {hasDisc === true && htmlHasText(disc) && (
                <>
                  <hr className="wt-divider" />
                  <p className="wt-fieldlabel" style={{ marginBottom: 12 }}>Compliance disclosure</p>
                  <div className="wt-rev"><div className="wt-reva" dangerouslySetInnerHTML={{ __html: disc }} /></div>
                </>
              )}
              <hr className="wt-divider" />
              <label className="wt-check" onClick={() => setReady(!ready)}>
                <span className={`wt-box ${ready ? "on" : ""}`}>{ready && <Check size={15} color="#fff" />}</span>
                <span className="wt-checktext">These answers are ready for publication and, where required, have been reviewed for compliance.</span>
              </label>
              <div className="wt-controls" style={{ marginTop: 22 }}>
                <button className="wt-ghost" onClick={() => setPhase("compliance")} disabled={submitting}><ArrowLeft size={15} /> Back</button>
                <button className="wt-next" onClick={doSubmit} disabled={!ready || submitting} style={{ padding: "13px 24px" }}>
                  {submitting ? "Submitting…" : <>Submit my Q&amp;A <ArrowRight size={16} /></>}
                </button>
              </div>
              {submitError && (
                <p style={{ marginTop: 14, padding: "12px 16px", background: "#fff4f4", border: "1px solid #f3c9c9", borderRadius: 8, color: "#9a2222", fontSize: 14, lineHeight: 1.6 }} role="alert">
                  {submitError}
                </p>
              )}
            </div>
          </div>
        )}

        {/* SUBMITTED */}
        {phase === "submitted" && (
          <div className="wt-card">
            <div className="wt-done">
              <div className="wt-donecircle"><CheckCircle2 size={38} /></div>
              <h2 className="wt-sech2 wt-serif" style={{ marginBottom: 6 }}>Your Q&amp;A is in, {cfg.advisorFirstName}.</h2>
              <p className="wt-sectext" style={{ marginBottom: 4 }}>Thank you for sharing your expertise.</p>
              <div className="wt-idpill">{cfg.articleId}</div>
              <div className="wt-nextbox">
                <h4>What happens next</h4>
                <div className="wt-nextitem"><span className="wt-nextnum">1</span><span>Our editorial team reviews your answers, correcting only typos and clear errors — your words stay yours.</span></div>
                <div className="wt-nextitem"><span className="wt-nextnum">2</span><span>We format your Q&amp;A into your published article, optimized to rank in search and surface in AI answers.</span></div>
                <div className="wt-nextitem"><span className="wt-nextnum">3</span><span>You'll get an email with a link to the live article and tips to promote it — usually within a few business days.</span></div>
              </div>
            </div>
          </div>
        )}

        <p className="wt-note">Wealthtender Large Employer Q&A · Conversational responses powered live by Claude.</p>
      </div>

      {/* ALL-QUESTIONS OVERLAY */}
      {showAll && (
        <div className="wt-overlay" onClick={() => setShowAll(false)}>
          <div className="wt-modal" onClick={(e) => e.stopPropagation()}>
            <div className="wt-modalhead">
              <button className="wt-closex" onClick={() => setShowAll(false)}><X size={17} /></button>
              <p className="wt-eyebrow" style={{ marginBottom: 8 }}><span className="dot" />All questions</p>
              <h3 className="wt-serif" style={{ fontSize: 21, fontWeight: 500, margin: "0 0 8px" }}>Your {cfg.entity} Q&amp;A questions</h3>
              <p style={{ fontSize: 14, color: "var(--muted)", lineHeight: 1.55, margin: 0 }}>
                Review or share these with your compliance team. Uncheck any you'd prefer to exclude, then copy or print.
              </p>
            </div>
            <div className="wt-modalbody">
              {!custom && <p style={{ color: "var(--muted)", fontSize: 14 }}>Preparing {cfg.entity}-specific questions…</p>}
              {overlayQuestions.map((q, i) => (
                <div className="wt-qrow" key={i}>
                  <span className={`wt-qcheck ${!excluded[i] ? "on" : ""}`} onClick={() => setExcluded((e) => ({ ...e, [i]: !e[i] }))}>
                    {!excluded[i] && <Check size={13} color="#fff" />}
                  </span>
                  <span className={`wt-qtext ${excluded[i] ? "off" : ""}`}>
                    {q.text}{q.type === "custom" && <span className="wt-customchip">{cfg.entity}-specific</span>}
                  </span>
                </div>
              ))}
            </div>
            <div className="wt-modalfoot">
              <button className="wt-primary" style={{ flex: 1, padding: "13px 18px" }} onClick={copyAll}>
                {copied ? <><Check size={17} /> Copied</> : <><Copy size={16} /> Copy questions</>}
              </button>
              <button className="wt-allbtn" style={{ padding: "13px 18px" }} onClick={() => window.print()}>
                <Printer size={15} /> Print / PDF
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
