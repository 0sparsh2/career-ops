"""HTML fetch + text extraction + field heuristics."""

from __future__ import annotations

import re
from typing import Any
from urllib.parse import urlparse

import httpx

try:
    import trafilatura
except ImportError:
    trafilatura = None  # type: ignore

USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)
FETCH_TIMEOUT = 25.0
MAX_DESC = 24_000


def canonical_url(url: str) -> str:
    u = url.strip().split("#")[0]
    if "?" in u and "greenhouse.io" in u:
        base, qs = u.split("?", 1)
        if "gh_jid=" in qs:
            return base
    return u.rstrip("/")


def fetch_html(url: str) -> tuple[str | None, str | None]:
    try:
        with httpx.Client(
            follow_redirects=True,
            timeout=FETCH_TIMEOUT,
            headers={"User-Agent": USER_AGENT},
        ) as client:
            r = client.get(url)
            r.raise_for_status()
            return r.text, None
    except Exception as e:
        return None, str(e)


def html_to_text(html: str, url: str = "") -> str:
    if trafilatura:
        text = trafilatura.extract(
            html,
            url=url or None,
            include_comments=False,
            include_tables=True,
        )
        if text and len(text.strip()) > 80:
            return text.strip()
    # fallback: strip tags crudely
    text = re.sub(r"<script[^>]*>[\s\S]*?</script>", " ", html, flags=re.I)
    text = re.sub(r"<style[^>]*>[\s\S]*?</style>", " ", text, flags=re.I)
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def title_from_html(html: str) -> str:
    m = re.search(r'<meta\s+property=["\']og:title["\']\s+content=["\']([^"\']+)', html, re.I)
    if m:
        return m.group(1).strip()
    m = re.search(r"<title[^>]*>([^<]+)</title>", html, re.I)
    if m:
        t = re.sub(r"\s+", " ", m.group(1)).strip()
        for sep in [" | ", " - ", " — "]:
            if sep in t:
                t = t.split(sep)[0].strip()
        return t
    m = re.search(r"<h1[^>]*>([\s\S]*?)</h1>", html, re.I)
    if m:
        return re.sub(r"<[^>]+>", "", m.group(1)).strip()
    return ""


YOE_PATTERNS = [
    re.compile(r"(\d+)\s*\+\s*years?(?:\s+of)?\s+(?:experience|exp)", re.I),
    re.compile(r"(\d+)\s*[-–]\s*(\d+)\s*years?(?:\s+of)?\s+(?:experience|exp)", re.I),
    re.compile(r"minimum\s+of\s+(\d+)\s+years?", re.I),
    re.compile(r"at\s+least\s+(\d+)\s+years?", re.I),
    re.compile(r"(\d+)\s+years?\s+of\s+(?:professional\s+)?experience", re.I),
]


def extract_years_experience(text: str) -> str | None:
    if not text:
        return None
    for pat in YOE_PATTERNS:
        m = pat.search(text)
        if not m:
            continue
        if m.lastindex and m.lastindex >= 2 and m.group(2):
            return f"{m.group(1)}-{m.group(2)} years"
        return f"{m.group(1)}+ years"
    return None


LOCATION_PATTERNS = [
    re.compile(
        r"(?:location|office|based in|work location)[:\s]+([^\n]{3,120})",
        re.I,
    ),
    re.compile(
        r"\b((?:remote|hybrid|on-?site)[^\n]{0,80}(?:united states|usa|new york|nyc|san francisco|seattle|boston)[^\n]{0,40})",
        re.I,
    ),
    re.compile(
        r"\b(new york|nyc|san francisco|seattle|austin|boston|chicago|denver|remote(?:\s*,?\s*us)?)\b",
        re.I,
    ),
]


def extract_location(text: str, fallback: str = "") -> str:
    if fallback:
        return fallback
    if not text:
        return ""
    for pat in LOCATION_PATTERNS:
        m = pat.search(text[:8000])
        if m:
            loc = m.group(1).strip()
            if len(loc) > 3:
                return loc[:200]
    return ""


def extract_skills(text: str, max_skills: int = 20) -> list[str]:
    if not text:
        return []
    skills: list[str] = []
    # Requirements / Qualifications section bullets
    section = re.search(
        r"(?:requirements|qualifications|what you.?ll need|must have)[:\s]*([\s\S]{0,4000})",
        text,
        re.I,
    )
    chunk = section.group(1) if section else text[:6000]
    for line in chunk.split("\n"):
        line = line.strip()
        if not line:
            continue
        if re.match(r"^[-•*]\s+", line) or re.match(r"^\d+[.)]\s+", line):
            item = re.sub(r"^[-•*\d.)]+\s*", "", line).strip()
            if 3 < len(item) < 120:
                skills.append(item)
    # comma-separated tech line
    if len(skills) < 5:
        m = re.search(
            r"(?:skills|technologies|stack)[:\s]+([^\n]+)",
            text[:8000],
            re.I,
        )
        if m:
            for part in re.split(r"[,;|]", m.group(1)):
                p = part.strip()
                if 2 < len(p) < 60:
                    skills.append(p)
    seen: set[str] = set()
    out: list[str] = []
    for s in skills:
        key = s.lower()
        if key not in seen:
            seen.add(key)
            out.append(s)
        if len(out) >= max_skills:
            break
    return out


def enrich_job_profile(job: dict[str, Any]) -> dict[str, Any]:
    desc = job.get("description") or ""
    if len(desc) > MAX_DESC:
        desc = desc[:MAX_DESC] + "\n[truncated]"
        job["description"] = desc
    if not job.get("years_experience"):
        job["years_experience"] = extract_years_experience(desc)
    if not job.get("location"):
        job["location"] = extract_location(desc, job.get("location") or "")
    if not job.get("skills"):
        job["skills"] = extract_skills(desc)
    return job


def job_from_html_url(url: str) -> dict[str, Any]:
    html, err = fetch_html(url)
    if err or not html:
        return {
            "url": canonical_url(url),
            "title": "",
            "description": "",
            "location": "",
            "years_experience": None,
            "skills": [],
            "company": urlparse(url).netloc.replace("www.", ""),
            "source": "html",
            "error": err or "empty response",
        }
    text = html_to_text(html, url)
    title = title_from_html(html)
    job = {
        "url": canonical_url(url),
        "title": title,
        "description": text[:MAX_DESC] if text else "",
        "location": "",
        "years_experience": None,
        "skills": [],
        "company": urlparse(url).netloc.replace("www.", ""),
        "source": "html",
        "error": None,
    }
    return enrich_job_profile(job)
