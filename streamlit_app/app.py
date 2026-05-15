#!/usr/bin/env python3
"""Job Finder AI Tool — Streamlit job screener (pipeline + scan history + scoring)."""

from __future__ import annotations

import io
import os
import sys
from pathlib import Path

import pandas as pd
import streamlit as st

APP_DIR = Path(__file__).resolve().parent
if str(APP_DIR) not in sys.path:
    sys.path.insert(0, str(APP_DIR))

from job_fetch import (
    CV_PATH,
    DROP_REASON_LABELS,
    PIPELINE_PATH,
    REPO_ROOT,
    SCAN_HISTORY_PATH,
    enrich_job_descriptions,
    export_portal_jobs,
    fetch_pasted_jobs,
    filter_jobs_by_companies,
    load_cv_text,
    load_pipeline_jobs,
    load_portal_companies,
    load_scan_history_jobs,
    merge_job_lists_tracked,
    merge_jobs,
    portal_drops_to_rows,
)
from load_env import load_dotenv, nvidia_api_key
from llm_score import score_all_jobs

load_dotenv()

st.set_page_config(page_title="Job Finder AI Tool", layout="wide")

st.title("Job Finder AI Tool")
st.caption(
    "Uses jobs already found by **`npm run scan`** (`data/pipeline.md`, `data/scan-history.tsv`). "
    "**Does not submit applications** — you review and apply manually."
)

with st.sidebar:
    st.header("Filters")
    history_days = st.number_input(
        "Scan history: last N days",
        min_value=0,
        max_value=365,
        value=30,
        help="Only for **Load scan history**. 0 = all rows in scan-history.tsv.",
    )
    live_days = st.number_input(
        "Live portal export: last N days",
        min_value=0,
        max_value=365,
        value=0,
        help="Only for **Load live portals**. 0 = keep all dated jobs. "
        "Playwright (Google/Microsoft) is never dropped by date.",
    )

    _default_nim_key = nvidia_api_key() or ""
    nvidia_key = st.text_input(
        "NVIDIA NIM API key",
        value=_default_nim_key,
        type="password",
        help="From .env: NVIDIA_API_KEY or NVIDIA_NIM_API",
    )
    try:
        if not nvidia_key and hasattr(st, "secrets"):
            for sk in ("NVIDIA_API_KEY", "NVIDIA_NIM_API", "NVIDIA_NIM_API_KEY"):
                if st.secrets.get(sk):
                    nvidia_key = st.secrets[sk]
                    break
    except Exception:
        pass

    nvidia_model = st.text_input(
        "NVIDIA model",
        value=os.environ.get("NVIDIA_MODEL", "deepseek-ai/deepseek-v4-pro"),
    )
    ollama_base = st.text_input("Ollama base URL (fallback)", value="http://localhost:11434/v1")
    ollama_model = st.text_input(
        "Ollama model (fallback)",
        value=os.environ.get("OPENCODE_MODEL_FALLBACK", "ollama/gemma4:e4b").replace("ollama/", ""),
    )

    st.divider()
    st.markdown("**Data files**")
    st.caption(f"Pipeline: `{PIPELINE_PATH.name}` ({'exists' if PIPELINE_PATH.exists() else 'missing'})")
    st.caption(f"Scan history: `{SCAN_HISTORY_PATH.name}` ({'exists' if SCAN_HISTORY_PATH.exists() else 'missing'})")
    st.caption(f"CV: `{CV_PATH.name}` ({'exists' if CV_PATH.exists() else 'missing'})")

# --- Job sources (career-ops scan output) ---
st.subheader("Job inbox (from scan)")
st.markdown(
    "Run **`npm run scan`** in the repo to refresh [`data/pipeline.md`](../data/pipeline.md) and "
    "[`data/scan-history.tsv`](../data/scan-history.tsv). The screener loads URLs, company, and title from there."
)

all_companies = load_portal_companies()
company_filter: list[str] | None = None
filter_companies = st.checkbox("Filter by company name", value=False)
if filter_companies:
    company_filter = st.multiselect("Companies", options=all_companies, default=[])

st.markdown(
    "**Playwright (Google, Microsoft, Meta, …):** check *Include mega-cap*, set *Live portal days* to **0**, "
    "then **Load live portals**. Or run `npm run scan -- --all-companies` and **Load pipeline**."
)

col_a, col_b, col_c = st.columns(3)
load_pipeline_btn = col_a.button("Load pipeline (pending)", type="primary")
load_history_btn = col_b.button("Load scan history")
enrich_btn = col_c.button("Fetch job descriptions")

col_d, col_e = st.columns(2)
include_playwright = col_d.checkbox(
    "Include mega-cap (Playwright)",
    value=True,
    help="Required for Google, Microsoft, Meta, Amazon, Apple, etc.",
)
load_portal_btn = col_e.button(
    "Load live portals",
    help="ATS APIs + optional Playwright. Use Live portal days = 0 to avoid ATS date drops.",
)

with st.expander("Advanced: paste extra URLs"):
    url_text = st.text_area(
        "Additional URLs (optional)",
        height=80,
        placeholder="https://boards.greenhouse.io/...",
    )

# --- Resume + context ---
col1, col2 = st.columns(2)
with col1:
    default_cv = load_cv_text()
    resume_file = st.file_uploader("Resume (.md, .txt, .pdf)", type=["md", "txt", "pdf"])
    resume_paste = st.text_area(
        "Or paste resume",
        value=default_cv if default_cv and not resume_file else "",
        height=160,
    )
with col2:
    user_context = st.text_area(
        "Your constraints",
        height=200,
        placeholder="e.g. Max 8 years on JD. NYC or remote US. Senior PM / AI product. No roles requiring sponsorship.",
    )

run_score = st.button("Score all loaded jobs", type="primary")

if "jobs" not in st.session_state:
    st.session_state.jobs = []
if "portal_errors" not in st.session_state:
    st.session_state.portal_errors = []
if "drop_report" not in st.session_state:
    st.session_state.drop_report = []
if "last_load_stats" not in st.session_state:
    st.session_state.last_load_stats = {}


def record_drops(rows: list, *, clear: bool = False) -> None:
    if clear:
        st.session_state.drop_report = []
    st.session_state.drop_report.extend(rows)


def apply_company_filter(jobs: list) -> list:
    if company_filter:
        kept, drops = filter_jobs_by_companies(jobs, company_filter)
        record_drops(drops)
        return kept
    return jobs


def read_resume() -> str:
    if resume_file:
        raw = resume_file.read()
        name = (resume_file.name or "").lower()
        if name.endswith(".pdf"):
            try:
                from pypdf import PdfReader

                reader = PdfReader(io.BytesIO(raw))
                return "\n".join(p.extract_text() or "" for p in reader.pages)
            except Exception as e:
                st.error(f"PDF read failed: {e}")
                return ""
        return raw.decode("utf-8", errors="replace")
    return resume_paste.strip()


if load_pipeline_btn:
    record_drops([], clear=True)
    jobs = load_pipeline_jobs(section="pendientes")
    before = len(jobs)
    jobs = apply_company_filter(jobs)
    if url_text.strip():
        jobs, merge_drops = merge_job_lists_tracked(jobs, fetch_pasted_jobs(url_text))
        record_drops(merge_drops)
    st.session_state.jobs = jobs
    st.session_state.last_load_stats = {
        "source": "pipeline",
        "loaded": before,
        "kept": len(jobs),
    }
    st.success(f"Loaded **{len(jobs)}** pending jobs from pipeline.")

if load_history_btn:
    record_drops([], clear=True)
    companies = company_filter if company_filter else None
    jobs, hist_drops = load_scan_history_jobs(days=int(history_days), companies=companies)
    record_drops(hist_drops)
    before = len(jobs)
    jobs = apply_company_filter(jobs)
    if url_text.strip():
        jobs, merge_drops = merge_job_lists_tracked(jobs, fetch_pasted_jobs(url_text))
        record_drops(merge_drops)
    st.session_state.jobs = jobs
    st.session_state.last_load_stats = {
        "source": "scan-history",
        "loaded": before,
        "kept": len(jobs),
        "history_days": int(history_days),
    }
    st.success(f"Loaded **{len(jobs)}** jobs from scan history.")

if enrich_btn:
    if not st.session_state.jobs:
        st.warning("Load pipeline or scan history first.")
    else:
        progress = st.progress(0, text="Fetching descriptions…")
        total = len(st.session_state.jobs)

        def on_progress(done: int, _total: int, label: str) -> None:
            progress.progress(min(done / max(total, 1), 1.0), text=f"{done}/{total}: {label[:50]}")

        st.session_state.jobs = enrich_job_descriptions(
            st.session_state.jobs,
            only_missing=True,
            progress_cb=on_progress,
        )
        progress.empty()
        with_desc = sum(1 for j in st.session_state.jobs if (j.get("description") or "").strip())
        st.success(f"Descriptions ready for **{with_desc}/{len(st.session_state.jobs)}** jobs.")

if load_portal_btn:
    if include_playwright and int(live_days) > 0:
        st.warning(
            "Playwright jobs are never date-filtered, but ATS jobs without a publish date are dropped "
            f"when Live portal days = {int(live_days)}. Set **Live portal days** to **0** to keep all ATS rows."
        )
    label = "Fetching portals (ATS APIs"
    if include_playwright:
        label += " + Playwright for mega-cap"
    label += ")…"
    with st.spinner(label):
        try:
            record_drops([], clear=not st.session_state.jobs)
            companies_arg = company_filter if company_filter else None
            rows, errors, meta = export_portal_jobs(
                int(live_days),
                companies_arg,
                playwright=include_playwright,
            )
            st.session_state.portal_errors = errors
            record_drops(portal_drops_to_rows(meta))
            portal_profiles = merge_jobs(rows, [])
            merged, merge_drops = merge_job_lists_tracked(st.session_state.jobs, portal_profiles)
            record_drops(merge_drops)
            st.session_state.jobs = apply_company_filter(merged)
            pw_n = meta.get("playwrightCompanies", 0)
            st.session_state.last_load_stats = {
                "source": "live-portals",
                "raw": meta.get("rawCount", 0),
                "kept": meta.get("keptCount", len(rows)),
                "dropped": len(meta.get("drops") or []),
                "playwright_companies": pw_n,
                "live_days": int(live_days),
            }
            st.success(
                f"Live export: **{meta.get('keptCount', len(rows))}** kept from "
                f"**{meta.get('rawCount', '?')}** raw "
                f"({pw_n} Playwright companies). Total in UI: **{len(st.session_state.jobs)}**."
            )
        except Exception as e:
            st.error(str(e))

if run_score:
    resume = read_resume()
    if not resume:
        st.error("Upload or paste your resume (or add cv.md in repo root).")
    elif not st.session_state.jobs:
        st.error("Load pipeline or scan history first.")
    else:
        missing = sum(1 for j in st.session_state.jobs if not (j.get("description") or "").strip())
        if missing:
            with st.spinner(f"Fetching descriptions for {missing} jobs before scoring…"):
                st.session_state.jobs = enrich_job_descriptions(
                    st.session_state.jobs,
                    only_missing=True,
                )
        with st.spinner("Scoring with NVIDIA NIM (Ollama fallback)…"):
            try:
                scored, provider = score_all_jobs(
                    st.session_state.jobs,
                    resume,
                    user_context,
                    nvidia_key=nvidia_key or None,
                    nvidia_model=nvidia_model,
                    ollama_base=ollama_base,
                    ollama_model=ollama_model,
                )
                st.session_state.jobs = scored
                st.session_state.last_provider = provider
                apply_n = sum(1 for j in scored if j.get("apply_recommendation"))
                st.success(f"Scored {len(scored)} jobs via {provider}. Recommended to apply: {apply_n}.")
            except Exception as e:
                st.error(str(e))

# --- Drop report ---
drops = st.session_state.drop_report
if drops or st.session_state.last_load_stats:
    with st.expander(f"Dropped / filtered jobs ({len(drops)})", expanded=bool(drops)):
        if st.session_state.last_load_stats:
            st.json(st.session_state.last_load_stats)
        if drops:
            drop_df = pd.DataFrame(drops)
            if "reason_label" in drop_df.columns:
                st.caption("Counts by reason:")
                st.dataframe(
                    drop_df.groupby("reason_label", as_index=False).size().rename(columns={"size": "count"}),
                    hide_index=True,
                )
            st.dataframe(drop_df, use_container_width=True, hide_index=True)
            st.download_button(
                "Download drop report CSV",
                drop_df.to_csv(index=False),
                file_name="job-screener-dropped.csv",
                mime="text/csv",
            )
        st.caption(
            "Reasons: "
            + "; ".join(f"**{k}** — {v}" for k, v in list(DROP_REASON_LABELS.items())[:6])
            + " …"
        )

# --- Results ---
jobs = st.session_state.jobs
if st.session_state.portal_errors:
    with st.expander("Portal API errors"):
        st.json(st.session_state.portal_errors)

if jobs:
    st.subheader(f"Jobs ({len(jobs)})")
    if st.session_state.get("last_provider"):
        st.caption(f"Last scoring provider: {st.session_state.last_provider}")

    rows = []
    for j in jobs:
        skills = j.get("skills") or []
        skill_str = "; ".join(skills[:5]) if isinstance(skills, list) else str(skills)
        rows.append(
            {
                "Score": j.get("score", ""),
                "Apply?": "Yes" if j.get("apply_recommendation") else "",
                "Qualified": "Yes" if j.get("qualified") else "",
                "Title": j.get("title"),
                "Company": j.get("company"),
                "Location": j.get("location"),
                "YOE": j.get("years_experience") or "",
                "Has JD": "Yes" if (j.get("description") or "").strip() else "No",
                "Reason": j.get("short_reason", ""),
                "URL": j.get("url"),
            }
        )
    df = pd.DataFrame(rows)
    st.dataframe(df, use_container_width=True, hide_index=True)

    apply_jobs = [j for j in jobs if j.get("apply_recommendation")]
    if apply_jobs:
        st.subheader("Recommended to apply")
        for j in apply_jobs:
            st.markdown(
                f"- **{j.get('title')}** @ {j.get('company')} — score {j.get('score')}: {j.get('short_reason')}"
            )
            st.markdown(f"  [{j.get('url')}]({j.get('url')})")

    st.download_button(
        "Download CSV",
        df.to_csv(index=False),
        file_name="job-screener-results.csv",
        mime="text/csv",
    )
else:
    st.info(
        "Click **Load pipeline (pending)** to use URLs from your last `npm run scan`, "
        "then **Fetch job descriptions** (optional) and **Score all loaded jobs**."
    )
