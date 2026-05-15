"""Resolve pasted URLs to ATS JSON (Greenhouse, Ashby, Lever)."""

from __future__ import annotations

import re
from html import unescape
from typing import Any
from urllib.parse import urlparse

import httpx

from extract_html import (
    USER_AGENT,
    canonical_url,
    enrich_job_profile,
    fetch_html,
    html_to_text,
    title_from_html,
)

FETCH_TIMEOUT = 20.0


def _client() -> httpx.Client:
    return httpx.Client(
        follow_redirects=True,
        timeout=FETCH_TIMEOUT,
        headers={"User-Agent": USER_AGENT},
    )


def strip_html(html: str) -> str:
    if not html:
        return ""
    text = re.sub(r"<[^>]+>", " ", html)
    text = unescape(text)
    return re.sub(r"\s+", " ", text).strip()


class AtsResolver:
    """Parse job posting URLs and fetch structured data when possible."""

    def resolve(self, url: str) -> dict[str, Any] | None:
        url = url.strip()
        if not url.startswith("http"):
            return None
        gh = self._parse_greenhouse(url)
        if gh:
            return self._fetch_greenhouse(gh, url)
        ashby = self._parse_ashby(url)
        if ashby:
            return self._fetch_ashby(ashby, url)
        lever = self._parse_lever(url)
        if lever:
            return self._fetch_lever(lever, url)
        return None

    def _parse_greenhouse(self, url: str) -> tuple[str, int] | None:
        # boards.greenhouse.io/company/jobs/123
        m = re.search(
            r"boards(?:\.eu)?\.greenhouse\.io/([^/]+)/jobs/(\d+)",
            url,
            re.I,
        )
        if m:
            return m.group(1), int(m.group(2))
        # company.com listing with gh_jid
        m = re.search(r"[?&]gh_jid=(\d+)", url, re.I)
        if m:
            jid = int(m.group(1))
            # try to find board token from embed
            return ("", jid)
        return None

    def _fetch_greenhouse(
        self, parsed: tuple[str, int], original_url: str
    ) -> dict[str, Any] | None:
        board, job_id = parsed
        if not board:
            board = self._greenhouse_board_from_page(original_url)
        if not board:
            return None
        api = f"https://boards-api.greenhouse.io/v1/boards/{board}/jobs/{job_id}"
        try:
            with _client() as c:
                r = c.get(api)
                r.raise_for_status()
                j = r.json()
        except Exception:
            return None
        loc = (j.get("location") or {}).get("name") or ""
        desc = strip_html(j.get("content") or "")
        return enrich_job_profile(
            {
                "url": j.get("absolute_url") or original_url,
                "title": j.get("title") or "",
                "description": desc,
                "location": loc,
                "company": board,
                "source": "greenhouse",
                "error": None,
            }
        )

    def _greenhouse_board_from_page(self, url: str) -> str | None:
        html, _ = fetch_html(url)
        if not html:
            return None
        m = re.search(r"boards(?:\.eu)?\.greenhouse\.io/([^/\"']+)", html, re.I)
        return m.group(1) if m else None

    def _parse_ashby(self, url: str) -> tuple[str, str] | None:
        # jobs.ashbyhq.com/org/job-id
        m = re.search(r"jobs\.ashbyhq\.com/([^/]+)/([0-9a-f-]{8}-[0-9a-f-]{4}-[0-9a-f-]{4}-[0-9a-f-]{4}-[0-9a-f]{12})", url, re.I)
        if m:
            return m.group(1), m.group(2)
        return None

    def _fetch_ashby(self, parsed: tuple[str, str], original_url: str) -> dict[str, Any] | None:
        org, job_id = parsed
        api = f"https://api.ashbyhq.com/posting-api/job-board/{org}?includeCompensation=true"
        try:
            with _client() as c:
                r = c.get(api)
                r.raise_for_status()
                data = r.json()
        except Exception:
            return None
        for j in data.get("jobs") or []:
            if str(j.get("id")) == job_id or job_id in (j.get("jobUrl") or ""):
                loc_bits = [j.get("location")]
                loc_bits += [
                    s.get("location")
                    for s in (j.get("secondaryLocations") or [])
                    if isinstance(s, dict)
                ]
                desc = j.get("descriptionPlain") or strip_html(j.get("descriptionHtml") or "")
                return enrich_job_profile(
                    {
                        "url": j.get("jobUrl") or original_url,
                        "title": j.get("title") or "",
                        "description": desc,
                        "location": " | ".join(x for x in loc_bits if x),
                        "company": org,
                        "source": "ashby",
                        "error": None,
                    }
                )
        return None

    def _parse_lever(self, url: str) -> tuple[str, str] | None:
        m = re.search(r"jobs\.lever\.co/([^/]+)/([0-9a-f-]{8,})", url, re.I)
        if m:
            return m.group(1), m.group(2)
        return None

    def _fetch_lever(self, parsed: tuple[str, str], original_url: str) -> dict[str, Any] | None:
        company, posting_id = parsed
        api = f"https://api.lever.co/v0/postings/{company}/{posting_id}"
        try:
            with _client() as c:
                r = c.get(api)
                r.raise_for_status()
                j = r.json()
        except Exception:
            return None
        loc = j.get("categories", {}).get("location") or ""
        if isinstance(loc, list):
            loc = ", ".join(loc)
        desc = j.get("descriptionPlain") or strip_html(j.get("description") or "")
        return enrich_job_profile(
            {
                "url": j.get("hostedUrl") or original_url,
                "title": j.get("text") or "",
                "description": desc,
                "location": loc,
                "company": company,
                "source": "lever",
                "error": None,
            }
        )


def fetch_job_from_url(url: str) -> dict[str, Any]:
    """ATS first, then HTML extraction."""
    url = url.strip()
    resolver = AtsResolver()
    job = resolver.resolve(url)
    if job and job.get("description"):
        job["url"] = canonical_url(job.get("url") or url)
        return job
    if job and not job.get("description"):
        # ATS partial — try HTML for body
        from extract_html import job_from_html_url

        html_job = job_from_html_url(url)
        if html_job.get("description"):
            job["description"] = html_job["description"]
        if not job.get("title"):
            job["title"] = html_job.get("title") or job.get("title")
        return enrich_job_profile(job)
    from extract_html import job_from_html_url

    return job_from_html_url(url)


def parse_urls_from_text(text: str) -> list[str]:
    urls = re.findall(r"https?://[^\s\])<>\"']+", text)
    return [canonical_url(u.rstrip(".,;")) for u in urls]
