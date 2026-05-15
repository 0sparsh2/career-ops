# Job Finder AI Tool — Streamlit UI

The visual job inbox for [Job Finder AI Tool](https://github.com/0sparsh2/job-finder-ai-tool). Built on [career-ops](https://github.com/santifer/career-ops) by [Santiago Fernández de Valderrama](https://santifer.io).

![Job Finder AI Tool UI](../docs/streamlit-job-screener.png)

**This app does not submit applications.** It helps you decide what to apply to; you apply manually.

## What it does

- Loads jobs from **`npm run scan`** output (`data/pipeline.md`, `data/scan-history.tsv`)
- **Live portal export** via ATS APIs (Greenhouse, Ashby, Lever) plus optional **Playwright** for mega-cap career pages (Google, Microsoft, Meta, …)
- **Paste extra URLs** — ATS JSON when possible, else HTML extraction
- Scores each job against your **resume** + **constraints** with **NVIDIA NIM** first, **Ollama** fallback
- Sorted table with score, qualified flag, apply recommendation, YOE, location, and drop/filter report

## Prerequisites

- Node.js (for portal export): `npm install` in repo root
- Python 3.10+
- `NVIDIA_API_KEY` (or `NVIDIA_NIM_API`) in repo-root [`.env`](../.env) — see [`.env.example`](../.env.example)
- Optional: [Ollama](https://ollama.com) running locally for fallback scoring

## Setup

From the **Career Ops repo root**:

```bash
cd streamlit_app
python3 -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

Ensure `portals.yml` exists in the repo root (copy from `templates/portals.example.yml` if needed).

## Run

```bash
# From streamlit_app/ (recommended)
streamlit run app.py

# Or from repo root
streamlit run streamlit_app/app.py
```

Keys are read from the repo-root `.env` automatically (same as `npm run verify:nvidia-nim`):

```bash
NVIDIA_API_KEY=nvapi-...
NVIDIA_MODEL=deepseek-ai/deepseek-v4-pro
OPENCODE_MODEL_FALLBACK=ollama/gemma4:e4b
```

Or override in the sidebar / `.streamlit/secrets.toml` (`NVIDIA_API_KEY` or `NVIDIA_NIM_API`).

## Usage

1. Refresh inbox: **`npm run scan`** (writes `data/pipeline.md` + `data/scan-history.tsv`).
2. In Streamlit: **Load pipeline (pending)** — uses URLs + company + title already in career-ops (no re-scan).
3. Optional: **Load scan history** (sidebar days filter), **Fetch job descriptions** (ATS/HTML for scoring).
4. **Resume** — auto-loads `cv.md` from repo root if present; or upload/paste.
5. **Your constraints** — max YOE, location, must-have skills, etc.
6. **Score all loaded jobs** — NVIDIA NIM → Ollama fallback; fetches missing JDs automatically before scoring.

### Playwright (Google, Microsoft, Meta, …) in the UI

1. Sidebar: **Live portal export: last N days** → set **0** (so ATS rows without a publish date are not dropped).
2. Check **Include mega-cap (Playwright)** (on by default).
3. Click **Load live portals** (wait 1–2 min).
4. Open **Dropped / filtered jobs** to see anything removed (title filter, date, company multiselect).

Alternative: `npm run scan -- --all-companies` then **Load pipeline (pending)** — no Playwright wait in Streamlit.

### Drop report

After any load, expand **Dropped / filtered jobs** for a table + CSV download. Reasons include `title_filter`, `missing_publish_date`, `older_than_days_cutoff`, `company_filter`, `duplicate_url`.

**Advanced:** paste extra URLs in the expander; filter companies via multiselect.

Results sort by score; **Recommended to apply** lists strong fits.

## CLI export (without UI)

```bash
npm run export:jobs-json -- --days 14
node scripts/export-jobs-json.mjs --days 7 --companies "Anthropic,Cohere" --pretty
```

## Ollama fallback

Default fallback model: `gemma3:4b` (change in sidebar). Pull your model first:

```bash
ollama pull gemma3:4b
```

Use your custom tag (e.g. `gemma4:e4b`) in the sidebar **Ollama model** field.

## Credits

- **This project:** [0sparsh2/job-finder-ai-tool](https://github.com/0sparsh2/job-finder-ai-tool)
- **Upstream:** [santifer/career-ops](https://github.com/santifer/career-ops) — scan, evaluate, PDF, tracker (Claude Code / OpenCode)
