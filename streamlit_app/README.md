# Career Ops — Streamlit Job Screener

Visual job inbox for [0sparsh2/career-ops](https://github.com/0sparsh2/career-ops), built on [santifer/career-ops](https://github.com/santifer/career-ops) by [Santiago Fernández de Valderrama](https://santifer.io).

![Career Ops job screener UI](../docs/streamlit-job-screener.png)

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

From the **repo root**:

```bash
cd streamlit_app
python3 -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

Ensure `portals.yml` exists in the repo root (copy from `templates/portals.example.yml` if needed).

## Run

```bash
streamlit run app.py
# Or from repo root: streamlit run streamlit_app/app.py
```

Keys load from repo-root `.env` (see [`.env.example`](../.env.example)) or the sidebar.

## Usage

1. **`npm run scan`** — refresh `data/pipeline.md` and `data/scan-history.tsv`
2. **Load pipeline (pending)** / **Load scan history** / **Load live portals**
3. **Fetch job descriptions** → **Score all loaded jobs**

See root [README.md](../README.md) for credits and upstream links.

## Credits

- **Upstream:** [santifer/career-ops](https://github.com/santifer/career-ops)
- **This UI:** `streamlit_app/` in [0sparsh2/career-ops](https://github.com/0sparsh2/career-ops)
