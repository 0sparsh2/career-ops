# Career Ops — command cheat sheet

Run everything from the repo root (the folder that contains `package.json`).

```bash
cd "/path/to/Career Ops"
```

---

## Combined report (scan + mega-cap Playwright smoke)

Writes **`data/portal-run-report.md`**: full `scan` log plus a smoke summary table.

```bash
npm run report:portal
npm run report:portal -- --dry-run
npm run report:portal -- --no-smoke              # scan section only in the report
npm run report:portal -- --no-playwright-fallback
```

Forward any **`scan.mjs`** flags after `--`. Only **`--no-smoke`** is consumed by the report script itself.

---

## Portal scan (API + optional Playwright fallback)

```bash
npm run scan
npm run scan:all                    # same as: npm run scan -- --all-companies
npm run scan -- --dry-run
npm run scan -- --all-companies --dry-run
npm run scan -- --company Stripe
npm run scan -- --no-playwright-fallback
```

**Default (`npm run scan`):** every **enabled** company where a **Greenhouse, Ashby, or Lever** API is detected. Rows **without** a detectable API are **skipped** (see “skipped — no API detected” in the log).

**Every row (`--all-companies` or `npm run scan:all`):** all **enabled** companies: **API fetch** when an ATS API exists, otherwise **Playwright** on `careers_url` (unless Playwright is disabled globally or per company). Rows with **no API and no usable `careers_url`** (or Playwright off) are skipped and counted in the summary.

**Where URLs and titles go (after a real run, not `--dry-run`):**

| Output | Contents |
|--------|----------|
| `data/pipeline.md` | New roles as `- [ ] URL \| Company \| Title` checklist lines |
| `data/scan-history.tsv` | Tab-separated: `url`, date, source, `title`, `company`, `status` |

**Extract just URLs from history (shell):**

```bash
tail -n +2 data/scan-history.tsv | cut -f1
```

---

## Playwright careers smoke (heuristic link harvest)

Same link logic as the scanner’s Playwright fallback; good for diagnosing mega-cap `careers_url` pages.

```bash
npm run smoke:careers
npm run smoke:careers -- Google Microsoft Meta Snap
npm run smoke:careers -- --urls https://example.com/careers/
```

Default target list when you pass **no** names is fixed in `lib/smoke-careers.mjs` (`DEFAULT_SMOKE_NAMES`). It is **not** “every company in `portals.yml`.”

---

## LLM (NVIDIA NIM → local Ollama fallback)

Set keys in **`.env`** (copy from `.env.example`). `.envrc` loads it via `dotenv` when you use direnv.

| Variable | Role |
|----------|------|
| `NVIDIA_API_KEY` | [NVIDIA NIM](https://build.nvidia.com/) API key (`nvapi-…`) |
| `NVIDIA_MODEL` | e.g. `deepseek-ai/deepseek-v4-pro` |
| `OPENCODE_MODEL` | default `nvidia-nim/$NVIDIA_MODEL` |
| `OPENCODE_MODEL_FALLBACK` | default `ollama/gemma4:e4b` |

Base URL: `https://integrate.api.nvidia.com/v1` (OpenAI-compatible). Project **`opencode.json`** wires the provider.

```bash
npm run verify:opencode
```

Tries **NVIDIA NIM first**, then **Ollama** if the primary fails. Batch with OpenCode:

```bash
CAREER_OPS_BATCH_WORKER=opencode ./batch/batch-runner.sh
```

---

## Health and pipeline checks

```bash
npm run doctor
npm run verify
npm run sync-check
npm run liveness -- https://example.com/job/123
```

---

## “All companies, all positions, all URLs” — what is actually possible

### 1. All companies in `portals.yml`

| Goal | Command |
|------|---------|
| **Every enabled row** (API where possible, else Playwright on `careers_url`) | `npm run scan:all` or `npm run scan -- --all-companies` |
| **API-only companies** (default; faster) | `npm run scan` |
| **Combined Markdown report** (scan + default mega-cap smoke) | `npm run report:portal -- --all-companies` |
| Smoke every **default** mega-cap `careers_url` | `npm run smoke:careers` |
| Smoke **named** companies | `npm run smoke:careers -- Google Snap …` |

Rows with **no ATS API** and **no `careers_url`** (or `playwright_fallback: false` / `--no-playwright-fallback`) are still skipped; the scan summary prints how many.

Heuristic Playwright harvests are **not** as complete as a human or **`/career-ops scan`** (agent) on hard SPAs; `scan_method: websearch` in `portals.yml` is still the right signal for “needs agent.”

### 2. All positions (no title-keyword filter)

`scan.mjs` always applies `portals.yml` → **`title_filter`** (positives + negatives).

- **Widest “everything that passes negatives”:** set **`title_filter.positive`** to an **empty list** `[]`. In code, an empty positive list means “any title is allowed” for the positive side; **negatives** still apply.
- Also check **`scan_filters`** in `portals.yml` (`max_age_hours`, `location_ny_or_remote_usa`, `min_salary_usd`); those can drop rows even when titles match.

Then run:

```bash
npm run scan -- --dry-run    # preview counts
npm run scan                 # append new rows to pipeline + scan-history
```

There is **no** `npm run scan -- --all-titles` flag today; config changes are how you widen the net.

### 3. All URLs in one place

- **Discovered by `scan`:** `data/scan-history.tsv` (column 1) and matching unchecked lines in `data/pipeline.md`.
- **Already in your tracker:** search `data/pipeline.md`, `data/applications.md`, etc.
- **Raw API dump (advanced):** hit each company’s Greenhouse/Ashby/Lever JSON in a browser or `curl` using the same URLs `scan.mjs` uses (`api` field in `portals.yml`); that is outside this repo’s CLI.

---

## More detail

See **`docs/SCRIPTS.md`** for longer notes on `scan`, `smoke:careers`, and `report:portal`.
