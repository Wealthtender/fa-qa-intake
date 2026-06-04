# Wealthtender Advisor Q&A Intake

A conversational intake tool that collects advisor Q&A responses for Wealthtender's
article series (Large Employer, Specialist Spotlight, and any future series). It's a
React front end served by a small Express backend. The backend holds the API keys so
they never reach the browser.

The same app powers every article. Which questions an advisor sees is decided by the
**article ID** in the invite URL — no code changes per article.

---

## How an advisor reaches it

You send each advisor a link like:

```
https://YOUR-RAILWAY-URL/?id=EMPQA-2026-6-SPAC-1
```

The app reads `id` from the URL, fetches that article's configuration (which series,
which employer/niche, the question list, the advisor's first name) from Airtable, and
configures itself. With no `id`, it loads a built-in SpaceX demo so you can always see it working.

---

## What's live vs. still-to-wire

The app **runs end to end right now** with just an Anthropic key. The other integrations
are optional and can be added incrementally:

| Capability | Needs | If not set |
|---|---|---|
| Conversational layer + employer-specific questions | `ANTHROPIC_API_KEY` | App can't generate text (required) |
| Live per-article config | Airtable vars | Serves the built-in SpaceX default |
| Submissions feed the editorial pipeline | `ZAPIER_WEBHOOK_URL` | Submissions are logged to the server console |

So: deploy with the Anthropic key first, confirm it works, then add Airtable and Zapier.

---

## Deploy to Railway (step by step)

You'll create the GitHub repo (one click) and Railway will build and host from it.

### 1. Put this code in a GitHub repo
- Create a new **empty** repository on GitHub (no README, no .gitignore — this project already has them).
- From this project folder on your computer, push it up:
  ```
  git init
  git add .
  git commit -m "Advisor intake tool"
  git branch -M main
  git remote add origin https://github.com/YOUR-USERNAME/YOUR-REPO.git
  git push -u origin main
  ```

### 2. Create the Railway service
- In Railway: **New Project → Deploy from GitHub repo → pick this repo.**
- Railway auto-detects Node, runs `npm install`, then `npm run build`, then `npm start`.
  (Those scripts are already set up — nothing to configure.)

### 3. Add environment variables
In the Railway service: **Variables** tab. Add at minimum:
```
ANTHROPIC_API_KEY = your Anthropic key
```
Then, when ready, add the optional ones (see `.env.example` for the full list):
```
AIRTABLE_API_KEY        = your Airtable personal access token
AIRTABLE_BASE_ID        = apppicofJgY9YMx7G   (the Q&A base)
AIRTABLE_ARTICLES_TABLE = Articles
ZAPIER_WEBHOOK_URL      = your Zapier catch hook URL
```
Railway sets `PORT` automatically — don't add it there.

### 4. Generate a public URL
- In **Settings → Networking → Generate Domain**. That's your `YOUR-RAILWAY-URL`.
- Test it: open `https://YOUR-RAILWAY-URL/` — you should see the SpaceX demo.

That's the deploy. Adding the Airtable and Zapier variables later just makes the app
go live against real data — no redeploy of code needed (Railway restarts on variable changes).

---

## Putting it in front of advisors (Circle.so)

Because the customization rides on the `?id=...` URL parameter, the cleanest path is to
**send advisors the direct Railway URL with their article ID** (e.g. in the invite email),
rather than embedding it in Circle where the parameter can't be passed through.

If you do want it inside Circle, embed it with an iframe in a custom-HTML block and pass the
ID in the iframe `src` — but the direct link is simpler and is the recommended approach.

---

## Local development (optional)

```
npm install
# Terminal 1 — backend:
ANTHROPIC_API_KEY=sk-ant-... npm start
# Terminal 2 — UI with hot reload (proxies /api to the backend):
npm run dev
```
Open the URL Vite prints (usually http://localhost:5173).
For a production-like local test: `npm run build` then `npm start`, open http://localhost:3000.

---

## The Airtable "Articles" table this expects

One row per Q&A article. Fields read by `/api/config`:

| Field | Example |
|---|---|
| Article ID | `EMPQA-2026-6-SPAC-1` |
| Series | `Large Employer` or `Specialist Spotlight` |
| Employer / Niche Name | `SpaceX` / `Cross-Border Canadians` |
| Audience Noun | `employees and executives` |
| Audience Short | `employees` |
| Advisor First Name | `Brady` |
| Question List | one question per line (use `COMPANY` as a placeholder for the employer; it's auto-substituted) |

For **Large Employer** rows, the app also generates ~2 employer-specific questions on the fly.
For **Specialist Spotlight** rows, it uses the Question List exactly as given (your pre-approved set).

---

## What the app sends on submit (the pipeline payload)

`POST /api/submit` forwards this JSON to your Zapier webhook:

```json
{
  "articleId": "EMPQA-2026-6-SPAC-1",
  "series": "Large Employer",
  "entity": "SpaceX",
  "answers": [
    { "question": "...", "type": "standard", "answerHtml": "<p>...</p>", "skipped": false }
  ],
  "proposed": [ { "question": "...", "answerHtml": "<p>...</p>" } ],
  "complianceDisclosure": "",
  "readyForPublication": true,
  "submittedAt": "2026-..."
}
```

`answerHtml` already contains clean links with `target`/`rel` and Wealthtender UTM
parameters appended — ready for the editorial-review and HTML-template steps.

---

## File map

```
index.html          Vite entry
vite.config.js       build + dev proxy
package.json         scripts + deps (build deps included for Railway)
src/main.jsx         React mount
src/App.jsx          the whole intake experience
server/server.js     Express: /api/claude, /api/config, /api/submit + static serving
.env.example         all environment variables, documented
```
