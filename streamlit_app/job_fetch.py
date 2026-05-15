"""Career-ops data (pipeline, scan history) + portal export + JD enrichment."""

from __future__ import annotations

import json
import re
import subprocess
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Literal

import yaml

from extract_ats import fetch_job_from_url, parse_urls_from_text
from extract_html import canonical_url, enrich_job_profile

REPO_ROOT = Path(__file__).resolve().parent.parent
PIPELINE_PATH = REPO_ROOT / "data" / "pipeline.md"
SCAN_HISTORY_PATH = REPO_ROOT / "data" / "scan-history.tsv"
CV_PATH = REPO_ROOT / "cv.md"

# `- [ ] https://... | Company | Title` (career-ops scan / pipeline format)
_PIPELINE_LINE = re.compile(
    r"^-\s+\[([ xX])\]\s+(https?://\S+?)\s*\|\s*([^|]+?)\s*\|\s*(.+?)\s*$"
)


def load_portal_companies(portals_path: Path | None = None) -> list[str]:
    path = portals_path or REPO_ROOT / "portals.yml"
    if not path.exists():
        return []
    data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    names = []
    for c in data.get("tracked_companies") or []:
        if c.get("enabled") is False:
            continue
        names.append(c.get("name") or "")
    return sorted(n for n in names if n)


def export_portal_jobs(
    days: int,
    companies: list[str] | None,
    repo_root: Path | None = None,
    *,
    playwright: bool = False,
) -> tuple[list[dict[str, Any]], list[dict[str, str]], dict[str, Any]]:
    root = repo_root or REPO_ROOT
    script = root / "scripts" / "export-jobs-json.mjs"
    cmd = [
        "node",
        str(script),
        "--root",
        str(root),
        "--days",
        str(max(0, days)),
        "--stderr-meta",
    ]
    if playwright:
        cmd.append("--playwright")
    if companies:
        cmd.extend(["--companies", ",".join(companies)])
    proc = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        cwd=str(root),
        timeout=180,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or proc.stdout.strip() or "export failed")
    jobs = json.loads(proc.stdout)
    meta: dict[str, Any] = {}
    if proc.stderr:
        try:
            meta = json.loads(proc.stderr)
        except json.JSONDecodeError:
            meta = {"parse_error": proc.stderr[:500]}
    errors = meta.get("errors") or []
    return jobs, errors, meta


def portal_row_to_profile(row: dict[str, Any]) -> dict[str, Any]:
    job = {
        "url": canonical_url(row.get("url") or ""),
        "title": row.get("title") or "",
        "description": row.get("description") or "",
        "location": row.get("location") or "",
        "company": row.get("company") or "",
        "publishedAt": row.get("publishedAt"),
        "years_experience": None,
        "skills": [],
        "source": f"portal-{row.get('source', 'api')}",
        "error": None,
    }
    return enrich_job_profile(job)


def fetch_pasted_jobs(url_text: str) -> list[dict[str, Any]]:
    urls = parse_urls_from_text(url_text)
    profiles = []
    for url in urls:
        profiles.append(fetch_job_from_url(url))
    return profiles


def _parse_pipeline_section(text: str, section: Literal["pendientes", "procesadas", "all"]) -> list[dict[str, Any]]:
    """Parse ## Pendientes / ## Procesadas checkbox lines from pipeline.md."""
    lines = text.splitlines()
    in_section: str | None = None
    jobs: list[dict[str, Any]] = []

    for line in lines:
        stripped = line.strip()
        if stripped.lower().startswith("## pendientes"):
            in_section = "pendientes"
            continue
        if stripped.lower().startswith("## procesadas"):
            in_section = "procesadas"
            continue
        if stripped.startswith("## ") and in_section:
            break

        if section != "all" and in_section != section:
            continue

        m = _PIPELINE_LINE.match(stripped)
        if not m:
            continue
        checked, url, company, title = m.group(1), m.group(2), m.group(3).strip(), m.group(4).strip()
        jobs.append(
            {
                "url": canonical_url(url),
                "title": title,
                "company": company,
                "description": "",
                "location": "",
                "years_experience": None,
                "skills": [],
                "publishedAt": None,
                "source": "pipeline-pending" if checked.lower() != "x" else "pipeline-done",
                "pipeline_checked": checked.lower() == "x",
                "error": None,
            }
        )
    return jobs


def load_pipeline_jobs(
    *,
    section: Literal["pendientes", "procesadas", "all"] = "pendientes",
    path: Path | None = None,
) -> list[dict[str, Any]]:
    """Load jobs already discovered by `npm run scan` → data/pipeline.md."""
    p = path or PIPELINE_PATH
    if not p.exists():
        return []
    return _parse_pipeline_section(p.read_text(encoding="utf-8"), section)


DROP_REASON_LABELS: dict[str, str] = {
    "title_filter": "Title filter (portals.yml keywords)",
    "older_than_days_cutoff": "Posted before N-day cutoff",
    "missing_publish_date": "No publish date (live ATS export + days filter on)",
    "company_filter": "Excluded by company multiselect in UI",
    "duplicate_url": "Duplicate URL when merging lists",
    "scan_history_too_old": "first_seen older than scan-history day filter",
    "scan_history_company": "Company not matching scan-history filter",
    "scan_history_duplicate": "Duplicate row in scan-history.tsv",
}


def _drop_row(job: dict[str, Any], reason: str, source: str) -> dict[str, Any]:
    return {
        "reason": reason,
        "reason_label": DROP_REASON_LABELS.get(reason, reason),
        "source": source,
        "company": job.get("company") or "",
        "title": job.get("title") or "",
        "url": job.get("url") or "",
        "publishedAt": job.get("publishedAt"),
    }


def load_scan_history_jobs(
    *,
    days: int = 0,
    companies: list[str] | None = None,
    path: Path | None = None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Load jobs from data/scan-history.tsv; returns (kept, dropped)."""
    p = path or SCAN_HISTORY_PATH
    drops: list[dict[str, Any]] = []
    if not p.exists():
        return [], drops
    cutoff = None
    if days > 0:
        cutoff = datetime.now() - timedelta(days=days)
    name_filters = [c.lower() for c in (companies or []) if c]

    lines = p.read_text(encoding="utf-8").splitlines()
    if len(lines) < 2:
        return [], drops
    header = lines[0].split("\t")
    col = {name: i for i, name in enumerate(header)}

    jobs: list[dict[str, Any]] = []
    seen: set[str] = set()

    for line in lines[1:]:
        if not line.strip():
            continue
        parts = line.split("\t")
        if len(parts) < 5:
            continue
        url = canonical_url(parts[col.get("url", 0)])
        company = parts[col.get("company", 4)] if "company" in col else ""
        title = parts[col.get("title", 3)] if "title" in col else ""
        first_seen = parts[col.get("first_seen", 1)] if "first_seen" in col else ""
        stub = {"url": url, "company": company, "title": title, "publishedAt": first_seen}

        if not url:
            continue
        if url in seen:
            drops.append(_drop_row(stub, "scan_history_duplicate", "scan-history"))
            continue
        if cutoff and first_seen:
            try:
                if datetime.strptime(first_seen[:10], "%Y-%m-%d") < cutoff:
                    drops.append(_drop_row(stub, "scan_history_too_old", "scan-history"))
                    continue
            except ValueError:
                pass
        if name_filters and not any(f in company.lower() for f in name_filters):
            drops.append(_drop_row(stub, "scan_history_company", "scan-history"))
            continue
        seen.add(url)
        jobs.append(
            {
                "url": url,
                "title": title,
                "company": company,
                "description": "",
                "location": "",
                "years_experience": None,
                "skills": [],
                "publishedAt": first_seen or None,
                "source": f"scan-history-{parts[col.get('portal', 2)]}" if "portal" in col else "scan-history",
                "error": None,
            }
        )
    return jobs, drops


def filter_jobs_by_companies(
    jobs: list[dict[str, Any]], companies: list[str] | None
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    if not companies:
        return jobs, []
    filters = [c.lower() for c in companies]
    kept: list[dict[str, Any]] = []
    drops: list[dict[str, Any]] = []
    for j in jobs:
        if any(f in (j.get("company") or "").lower() for f in filters):
            kept.append(j)
        else:
            drops.append(_drop_row(j, "company_filter", j.get("source") or "ui"))
    return kept, drops


def portal_drops_to_rows(meta: dict[str, Any]) -> list[dict[str, Any]]:
    rows = []
    for d in meta.get("drops") or []:
        reason = d.get("reason", "")
        rows.append(
            {
                "reason": reason,
                "reason_label": DROP_REASON_LABELS.get(reason, reason),
                "source": d.get("source", ""),
                "company": d.get("company", ""),
                "title": d.get("title", ""),
                "url": d.get("url", ""),
                "publishedAt": d.get("publishedAt"),
            }
        )
    return rows


def enrich_job_descriptions(
    jobs: list[dict[str, Any]],
    *,
    only_missing: bool = True,
    progress_cb=None,
) -> list[dict[str, Any]]:
    """Fetch full JD text for jobs (ATS/HTML). Keeps existing title/company from pipeline."""
    out: list[dict[str, Any]] = []
    todo = [j for j in jobs if not only_missing or not (j.get("description") or "").strip()]
    total = len(todo)
    for i, job in enumerate(jobs):
        if only_missing and (job.get("description") or "").strip():
            out.append(job)
            continue
        if progress_cb:
            progress_cb(i + 1, len(jobs), job.get("title") or job.get("url"))
        fetched = fetch_job_from_url(job.get("url") or "")
        merged = {**job}
        if fetched.get("description"):
            merged["description"] = fetched["description"]
        if not merged.get("title") and fetched.get("title"):
            merged["title"] = fetched["title"]
        if not merged.get("location") and fetched.get("location"):
            merged["location"] = fetched["location"]
        merged = enrich_job_profile(merged)
        if fetched.get("error"):
            merged["fetch_error"] = fetched["error"]
        out.append(merged)
    return out


def load_cv_text(path: Path | None = None) -> str:
    p = path or CV_PATH
    if p.exists():
        return p.read_text(encoding="utf-8")
    return ""


def merge_jobs(
    portal_rows: list[dict[str, Any]],
    pasted: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    by_url: dict[str, dict[str, Any]] = {}
    for row in portal_rows:
        p = portal_row_to_profile(row)
        if p["url"]:
            by_url[p["url"]] = p
    for job in pasted:
        url = canonical_url(job.get("url") or "")
        if not url:
            continue
        job["url"] = url
        if url in by_url:
            existing = by_url[url]
            if not existing.get("description") and job.get("description"):
                existing["description"] = job["description"]
            if not existing.get("title") and job.get("title"):
                existing["title"] = job["title"]
            for key in ("location", "years_experience", "skills"):
                if not existing.get(key) and job.get(key):
                    existing[key] = job[key]
            existing["source"] = f"{existing.get('source')}+paste"
        else:
            by_url[url] = enrich_job_profile(job)
    return list(by_url.values())


def merge_job_lists(*lists: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Dedupe by URL; later entries fill missing description/metadata."""
    merged, _drops = merge_job_lists_tracked(*lists)
    return merged


def _merge_all(jobs: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    by_url: dict[str, dict[str, Any]] = {}
    drops: list[dict[str, Any]] = []
    for job in jobs:
        url = canonical_url(job.get("url") or "")
        if not url:
            continue
        job = {**job, "url": url}
        if url not in by_url:
            by_url[url] = job
            continue
        drops.append(_drop_row(job, "duplicate_url", job.get("source") or "merge"))
        ex = by_url[url]
        for key in ("description", "title", "location", "company", "publishedAt", "years_experience", "skills"):
            if not ex.get(key) and job.get(key):
                ex[key] = job[key]
    return list(by_url.values()), drops


def merge_job_lists_tracked(*lists: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    combined: list[dict[str, Any]] = []
    for lst in lists:
        combined.extend(lst)
    return _merge_all(combined)
