"""Load repo-root .env into os.environ (does not override existing)."""

from __future__ import annotations

import os
import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent


def load_dotenv(root: Path | None = None) -> bool:
    path = (root or REPO_ROOT) / ".env"
    if not path.exists():
        return False
    for line in path.read_text(encoding="utf-8").splitlines():
        trimmed = line.strip()
        if not trimmed or trimmed.startswith("#"):
            continue
        m = re.match(r"^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$", trimmed)
        if not m:
            continue
        key, val = m.group(1), m.group(2).strip()
        if (val.startswith('"') and val.endswith('"')) or (
            val.startswith("'") and val.endswith("'")
        ):
            val = val[1:-1]
        if os.environ.get(key) is None:
            os.environ[key] = val
    return True


def nvidia_api_key() -> str | None:
    for key in ("NVIDIA_API_KEY", "NVIDIA_NIM_API", "NVIDIA_NIM_API_KEY"):
        v = os.environ.get(key, "").strip()
        if v:
            return v
    return None
