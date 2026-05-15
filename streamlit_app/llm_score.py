"""Score jobs vs resume using NVIDIA NIM with Ollama fallback."""

from __future__ import annotations

import json
import os
import re
from typing import Any

import httpx

from load_env import load_dotenv, nvidia_api_key

load_dotenv()

NIM_BASE_URL = "https://integrate.api.nvidia.com/v1"
MAX_RESUME = 12_000
MAX_JOB_DESC = 6_000
BATCH_SIZE = 8


def _truncate(s: str, n: int) -> str:
    if len(s) <= n:
        return s
    return s[:n] + "\n[truncated]"


def _jobs_payload(jobs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out = []
    for i, j in enumerate(jobs):
        skills = j.get("skills") or []
        out.append(
            {
                "id": i,
                "url": j.get("url"),
                "title": j.get("title"),
                "company": j.get("company"),
                "location": j.get("location"),
                "years_experience": j.get("years_experience"),
                "skills": skills[:15] if isinstance(skills, list) else skills,
                "description": _truncate(j.get("description") or "", MAX_JOB_DESC),
            }
        )
    return out


SCORE_SCHEMA = """Return ONLY valid JSON (no markdown):
{
  "results": [
    {
      "id": 0,
      "score": 85,
      "qualified": true,
      "apply_recommendation": true,
      "short_reason": "one sentence",
      "risk_flags": ["optional strings"]
    }
  ]
}
Rules:
- score: integer 0-100 (higher = better fit)
- qualified: true if meets hard constraints from user context
- apply_recommendation: true only for strong fits you'd actually apply to (typically score >= 70 and qualified)
- Compare resume to each job's requirements (years, location, skills)
"""


def _parse_json_response(text: str) -> dict[str, Any]:
    text = text.strip()
    m = re.search(r"\{[\s\S]*\}", text)
    if m:
        text = m.group(0)
    return json.loads(text)


def _call_openai_compatible(
    prompt: str,
    *,
    base_url: str,
    api_key: str | None,
    model: str,
    timeout: float = 300.0,
    extra_body: dict[str, Any] | None = None,
) -> str:
    url = base_url.rstrip("/") + "/chat/completions"
    body: dict[str, Any] = {
        "model": model,
        "messages": [
            {"role": "system", "content": "You output only valid JSON."},
            {"role": "user", "content": prompt},
        ],
        "temperature": 0.2,
        "stream": False,
    }
    if extra_body:
        body.update(extra_body)
    headers: dict[str, str] = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    with httpx.Client(timeout=timeout) as client:
        r = client.post(url, json=body, headers=headers)
        r.raise_for_status()
        data = r.json()
    return data["choices"][0]["message"]["content"]


def _call_nvidia_nim(prompt: str, api_key: str, model: str) -> str:
    return _call_openai_compatible(
        prompt,
        base_url=NIM_BASE_URL,
        api_key=api_key,
        model=model,
        timeout=300.0,
        extra_body={
            "top_p": 0.95,
            "max_tokens": 4096,
            "chat_template_kwargs": {"thinking": False},
        },
    )


def _call_ollama(prompt: str, base_url: str, model: str) -> str:
    return _call_openai_compatible(
        prompt,
        base_url=base_url,
        api_key=None,
        model=model,
        timeout=300.0,
    )


def score_jobs_batch(
    jobs: list[dict[str, Any]],
    resume_text: str,
    user_context: str,
    *,
    nvidia_key: str | None = None,
    nvidia_model: str | None = None,
    ollama_base: str = "http://localhost:11434/v1",
    ollama_model: str = "gemma4:e4b",
) -> tuple[list[dict[str, Any]], str]:
    """Score a batch of jobs. Returns (scored_rows, provider_used)."""
    api_key = nvidia_key or nvidia_api_key()
    model = nvidia_model or os.environ.get("NVIDIA_MODEL") or "deepseek-ai/deepseek-v4-pro"
    resume = _truncate(resume_text, MAX_RESUME)
    batch_jobs = _jobs_payload(jobs)

    prompt = f"""{SCORE_SCHEMA}

USER CONTEXT (constraints — treat as hard filters when explicit):
{user_context or "(none)"}

RESUME:
{resume}

JOBS TO SCORE:
{json.dumps(batch_jobs, indent=2)}
"""

    raw = ""
    provider = "none"
    last_err: Exception | None = None

    if api_key:
        try:
            raw = _call_nvidia_nim(prompt, api_key, model)
            provider = f"nvidia-nim/{model}"
        except Exception as e:
            last_err = e

    if not raw:
        try:
            raw = _call_ollama(prompt, ollama_base, ollama_model)
            provider = f"ollama/{ollama_model}"
        except Exception as e:
            if last_err:
                raise RuntimeError(
                    f"NVIDIA NIM failed ({last_err}); Ollama failed ({e})"
                ) from e
            raise RuntimeError(
                "No NVIDIA API key (set NVIDIA_API_KEY or NVIDIA_NIM_API in .env) "
                f"and Ollama failed ({e})"
            ) from e

    parsed = _parse_json_response(raw)
    by_id = {r["id"]: r for r in parsed.get("results", []) if "id" in r}

    scored: list[dict[str, Any]] = []
    for i, job in enumerate(jobs):
        r = by_id.get(i, {})
        scored.append(
            {
                **job,
                "score": r.get("score", 0),
                "qualified": bool(r.get("qualified", False)),
                "apply_recommendation": bool(r.get("apply_recommendation", False)),
                "short_reason": r.get("short_reason", ""),
                "risk_flags": r.get("risk_flags") or [],
            }
        )
    return scored, provider


def score_all_jobs(
    jobs: list[dict[str, Any]],
    resume_text: str,
    user_context: str,
    **kwargs: Any,
) -> tuple[list[dict[str, Any]], str]:
    """Score all jobs in chunks; merge and sort by score descending."""
    if not jobs:
        return [], "none"
    all_scored: list[dict[str, Any]] = []
    provider = "none"
    for start in range(0, len(jobs), BATCH_SIZE):
        chunk = jobs[start : start + BATCH_SIZE]
        scored, prov = score_jobs_batch(chunk, resume_text, user_context, **kwargs)
        all_scored.extend(scored)
        provider = prov
    all_scored.sort(key=lambda x: (-x.get("score", 0), x.get("title") or ""))
    return all_scored, provider
