# Job Finder AI Tool

AI-powered job screening: load roles from company portals and your scan inbox, fetch descriptions, and score them against your resume and constraints. Built on top of the open-source [career-ops](https://github.com/santifer/career-ops) pipeline by [Santiago Fernández de Valderrama](https://santifer.io).

![Job Finder AI Tool — Streamlit UI](docs/streamlit-job-screener.png)

**Does not submit applications.** You review matches and apply manually.

## Features

- **Streamlit dashboard** — filter, fetch JDs, score hundreds of jobs in one view
- **Portal scan** — Greenhouse, Ashby, Lever APIs + optional Playwright for mega-cap career sites
- **Pasted URLs** — ATS JSON or HTML extraction for any posting link
- **LLM scoring** — NVIDIA NIM primary, Ollama fallback; resume upload + free-text constraints
- **career-ops CLI** — scan, evaluate, PDF, tracker (Claude Code / OpenCode)

## Quick start

### 1. Node (scan + portals)

```bash
npm install
npx playwright install chromium
cp templates/portals.example.yml portals.yml   # if missing
cp .env.example .env                          # add NVIDIA_API_KEY
npm run scan
```

### 2. Streamlit UI

```bash
cd streamlit_app
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
streamlit run app.py
```

See [streamlit_app/README.md](streamlit_app/README.md) for full usage (pipeline load, live portals, scoring).

## Credits

| Component | Source |
|-----------|--------|
| Job Finder AI Tool (this repo) | [0sparsh2/job-finder-ai-tool](https://github.com/0sparsh2/job-finder-ai-tool) |
| Upstream pipeline & modes | [santifer/career-ops](https://github.com/santifer/career-ops) |

Upstream docs (multilingual READMEs, setup, modes): see files `README.*.md` in this repo and [career-ops docs](https://github.com/santifer/career-ops/tree/main/docs).

## License

MIT — same as upstream career-ops.
