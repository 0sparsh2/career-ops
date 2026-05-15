#!/usr/bin/env node
/**
 * Research Product roles: NY or Remote USA, min base comp, recently published.
 * Uses Ashby + Greenhouse APIs from portals.yml (same boards as scan.mjs).
 *
 * Usage:
 *   node scripts/research-product-jobs.mjs
 *   node scripts/research-product-jobs.mjs --hours 72 --min-salary 160000
 *   node scripts/research-product-jobs.mjs --append-pipeline
 *
 * Greenhouse: fetches job detail for salary only after title/location/date match (extra HTTP per job).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from "fs";
import yaml from "js-yaml";

const PORTALS_PATH = "portals.yml";
const REPORTS_DIR = "reports";
const PIPELINE_PATH = "data/pipeline.md";

const DEFAULT_HOURS = 72;
const DEFAULT_MIN_SALARY = 160_000;

function argNum(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i === -1 || !process.argv[i + 1]) return fallback;
  return Number(process.argv[i + 1]);
}

const MAX_AGE_MS = (argNum("--hours", DEFAULT_HOURS) || DEFAULT_HOURS) * 60 * 60 * 1000;
const MIN_SALARY = argNum("--min-salary", DEFAULT_MIN_SALARY) || DEFAULT_MIN_SALARY;
const APPEND_PIPELINE = process.argv.includes("--append-pipeline");
const FETCH_TIMEOUT_MS = 12_000;
const GH_DETAIL_CONCURRENCY = 6;

const now = Date.now();
const cutoff = now - MAX_AGE_MS;

function parseArgsIso(s) {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

/** Product / PM track + AI product engineering; excludes design/support-only */
function isProductRole(title) {
  const x = title.toLowerCase();
  if (
    /production\s+engineer|product\s+designer|product\s+marketing|product\s+analyst|growth\s+marketing|product\s+support\s+specialist|product\s+support\s+manager|principal\s+product\s+designer|senior\s+product\s+designer/.test(
      x
    )
  ) {
    return false;
  }
  return (
    /product\s*(manager|owner|lead|director|head)/.test(x) ||
    /\b(gpm|apm)\b/.test(x) ||
    /group\s+product/.test(x) ||
    /technical\s+product/.test(x) ||
    /principal\s+product/.test(x) ||
    /staff\s+product/.test(x) ||
    /senior\s+product\s+manager/.test(x) ||
    /associate\s+product\s+manager/.test(x) ||
    /director,?\s+product/.test(x) ||
    /director\s+of\s+product/.test(x) ||
    /head\s+of\s+product/.test(x) ||
    /vp[, ]+product/.test(x) ||
    /chief\s+product\s+officer/.test(x) ||
    /ai\s+product/.test(x) ||
    /product\s+engineer/i.test(x) ||
    (/technical\s+program\s+manager/.test(x) && /product/.test(x))
  );
}

function stripHtml(html) {
  if (!html) return "";
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extract advertised USD base low-end from text ($160,000 - $240,000, $180K-215K, etc.)
 */
function extractSalaryFloor(text) {
  if (!text) return { floor: null, raw: [] };
  // Avoid 401(k) being parsed as dollar amounts
  const cleaned = text.replace(/\b401\s*\(\s*k\s*\)/gi, "401k-plan");
  const raw = [];
  let bestFloor = null;

  const t = cleaned.replace(/\u2013/g, "-");

  const reRange = /\$\s*([\d,]+)\s*[-–to]+\s*\$?\s*([\d,]+)/gi;
  let m;
  while ((m = reRange.exec(t)) !== null) {
    const a = parseInt(m[1].replace(/,/g, ""), 10);
    const b = parseInt(m[2].replace(/,/g, ""), 10);
    if (a >= 1000 && b >= 1000) {
      const low = Math.min(a, b);
      raw.push(m[0]);
      if (bestFloor === null || low < bestFloor) bestFloor = low;
    }
  }

  // Reject bogus parses (e.g. artifacts); PM base above ~400k is rare in listings
  if (bestFloor != null && (bestFloor < 50_000 || bestFloor > 400_000)) {
    bestFloor = null;
  }

  const reK = /\b(\d{2,3})\s*k\b/gi;
  while ((m = reK.exec(t)) !== null) {
    const v = parseInt(m[1], 10) * 1000;
    if (v >= 80_000) {
      raw.push(m[0]);
      if (bestFloor === null || v < bestFloor) bestFloor = v;
    }
  }

  return { floor: bestFloor, raw: [...new Set(raw)].slice(0, 5) };
}

function locationMatchesNyOrRemoteUsa(blob) {
  const x = blob.toLowerCase();

  // Remote but clearly non-US geo, without US/NYC signal
  if (
    /\bremote\b/.test(x) &&
    /\b(canada|india|germany|spain|poland|brazil|mexico|ireland|portugal|uk\b|united kingdom|emea|apac|latam)\b/.test(x) &&
    !/\b(united states|usa|u\.s\.|new york|nyc|americas)\b/.test(x)
  ) {
    return false;
  }

  const ny =
    /\bnew\s+york\b|\bnyc\b|\bmanhattan\b|\bbrooklyn\b|\bqueens\b|ny,\s*usa|new\s+york,\s*ny|ny\s+\d{5}|on-?site.*new\s+york|hybrid.*new\s+york/.test(
      x
    );

  const usRemote =
    /\bremote\b.*(\bunited states\b|\busa\b|\bu\.s\.\b)/.test(x) ||
    /(\bunited states\b|\busa\b|\bu\.s\.\b|\bus-only\b|\bus only\b|\busa only\b|\banywhere in the us\b)/.test(x) ||
    /\bremote\b.*\b(americas|north america)\b/.test(x) ||
    /\bremote\b\s*[-–]\s*\b(us|usa|united states)\b/.test(x) ||
    /\b(us|usa)\s*[-–]\s*\bremote\b/.test(x);

  const remoteWithUS =
    /\bremote\b/.test(x) &&
    (/\bunited states\b/.test(x) || /\busa\b/.test(x) || /"addresscountry":"united states"/.test(x));

  return ny || usRemote || remoteWithUS;
}

function detectApi(company) {
  const apiUrl = (company.api || '').trim();

  if (apiUrl.includes('boards-api.greenhouse.io')) {
    return { type: 'greenhouse', url: apiUrl.split('?')[0] };
  }

  const ashbyApiMatch = apiUrl.match(/^https:\/\/api\.ashbyhq\.com\/posting-api\/job-board\/([^/?#]+)/i);
  if (ashbyApiMatch) {
    return {
      type: 'ashby',
      url: `https://api.ashbyhq.com/posting-api/job-board/${ashbyApiMatch[1]}?includeCompensation=true`,
    };
  }

  if (apiUrl.includes('api.lever.co/v0/postings/')) {
    return { type: 'lever', url: `${apiUrl.split('?')[0]}?mode=json` };
  }

  const url = company.careers_url || '';
  const ashbyMatch = url.match(/jobs\.ashbyhq\.com\/([^/?#]+)/);
  if (ashbyMatch) {
    return {
      type: "ashby",
      url: `https://api.ashbyhq.com/posting-api/job-board/${ashbyMatch[1]}?includeCompensation=true`,
    };
  }
  const leverMatch = url.match(/jobs\.lever\.co\/([^/?#]+)/);
  if (leverMatch) {
    return { type: "lever", url: `https://api.lever.co/v0/postings/${leverMatch[1]}?mode=json` };
  }
  const ghEuMatch = url.match(/job-boards(?:\.eu)?\.greenhouse\.io\/([^/?#]+)/);
  if (ghEuMatch && !company.api) {
    return {
      type: "greenhouse",
      url: `https://boards-api.greenhouse.io/v1/boards/${ghEuMatch[1]}/jobs`,
    };
  }
  return null;
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function enrichGreenhouseSalary(boardSlug, jobId) {
  const url = `https://boards-api.greenhouse.io/v1/boards/${boardSlug}/jobs/${jobId}`;
  try {
    const j = await fetchJson(url);
    const text = stripHtml(j.content || "");
    const { floor, raw } = extractSalaryFloor(text);
    return { floor, raw, textSample: text.slice(0, 400) };
  } catch {
    return { floor: null, raw: [], textSample: "" };
  }
}

async function enrichGreenhouseQueue(jobs, concurrency) {
  const enriched = new Map();
  const queue = [...jobs];
  const n = Math.max(1, Math.min(concurrency, jobs.length || 1));
  const workers = Array.from({ length: n }, async () => {
    while (queue.length) {
      const job = queue.shift();
      if (!job) break;
      const r = await enrichGreenhouseSalary(job._ghBoard, job._ghId);
      enriched.set(`${job._ghBoard}:${job._ghId}`, r);
    }
  });
  await Promise.all(workers);
  return enriched;
}

function normalizeAshbyJob(j, companyName) {
  const locParts = [j.location, ...(j.secondaryLocations || []).map((s) => s.location)].filter(Boolean);
  const blob = [
    ...locParts,
    j.workplaceType || "",
    j.isRemote ? "Remote" : "",
    JSON.stringify(j.address || {}),
    (j.descriptionPlain || stripHtml(j.descriptionHtml || "")).slice(0, 12_000),
  ].join(" | ");

  const published = parseArgsIso(j.publishedAt);
  const { floor, raw } = extractSalaryFloor(
    `${j.descriptionPlain || ""} ${stripHtml(j.descriptionHtml || "")}`
  );

  return {
    company: companyName,
    title: j.title || "",
    url: j.jobUrl || j.applyUrl || "",
    location: locParts.join("; ") || "",
    published,
    blob,
    salaryFloor: floor,
    salaryHints: raw,
    source: "ashby",
  };
}

function normalizeGreenhouseListJob(j, companyName) {
  const locName = j.location?.name || "";
  const meta = (j.metadata || []).map((m) => `${m.name}:${m.value}`).join(" ");
  const blob = [locName, meta].join(" | ");
  const fp = parseArgsIso(j.first_published);
  const up = parseArgsIso(j.updated_at);
  const published = fp != null && up != null ? Math.max(fp, up) : fp ?? up ?? null;
  return {
    company: companyName,
    title: j.title || "",
    url: j.absolute_url || "",
    location: locName,
    published,
    blob,
    salaryFloor: null,
    salaryHints: [],
    source: "greenhouse",
    _ghBoard: null,
    _ghId: j.id,
  };
}

function normalizeLeverJob(j, companyName) {
  const loc =
    (typeof j.categories?.location === "string" && j.categories.location) ||
    (Array.isArray(j.categories?.location) && j.categories.location.join(", ")) ||
    "";
  const blob = [loc, j.descriptionPlain || stripHtml(j.description || ""), j.workplaceType || ""].join(
    " | "
  );
  const published = parseArgsIso(j.createdAt) || parseArgsIso(j.updatedAt);
  const { floor, raw } = extractSalaryFloor(`${j.descriptionPlain || ""} ${j.description || ""}`);
  return {
    company: companyName,
    title: j.text || "",
    url: j.hostedUrl || j.applyUrl || "",
    location: loc,
    published,
    blob,
    salaryFloor: floor,
    salaryHints: raw,
    source: "lever",
  };
}

function ghBoardFromApiUrl(apiUrl) {
  const m = String(apiUrl).match(/boards\/([^/]+)\/jobs/);
  return m ? m[1] : null;
}

async function main() {
  mkdirSync(REPORTS_DIR, { recursive: true });
  mkdirSync("data", { recursive: true });

  if (!existsSync(PORTALS_PATH)) {
    console.error("Missing portals.yml");
    process.exit(1);
  }

  const config = yaml.load(readFileSync(PORTALS_PATH, "utf-8"));
  const companies = config.tracked_companies || [];
  const targets = companies
    .filter((c) => c.enabled !== false)
    .map((c) => ({ ...c, _api: detectApi(c) }))
    .filter((c) => c._api !== null);

  const candidates = [];
  const errors = [];

  for (const company of targets) {
    const { type, url } = company._api;
    try {
      const json = await fetchJson(url);
      if (type === "greenhouse") {
        const jobs = json.jobs || [];
        const board = ghBoardFromApiUrl(url);
        for (const j of jobs) {
          const row = normalizeGreenhouseListJob(j, company.name);
          row._ghBoard = board;
          candidates.push(row);
        }
      } else if (type === "ashby") {
        for (const j of json.jobs || []) {
          if (j.isListed === false) continue;
          candidates.push(normalizeAshbyJob(j, company.name));
        }
      } else if (type === "lever") {
        if (!Array.isArray(json)) continue;
        for (const j of json) {
          candidates.push(normalizeLeverJob(j, company.name));
        }
      }
    } catch (e) {
      errors.push({ company: company.name, error: e.message });
    }
  }

  const productLocTime = candidates.filter((c) => {
    if (!isProductRole(c.title)) return false;
    if (c.published == null || c.published < cutoff) return false;
    return locationMatchesNyOrRemoteUsa(`${c.blob} ${c.location}`);
  });

  // Greenhouse salary enrichment
  const ghJobs = productLocTime.filter((c) => c.source === "greenhouse" && c._ghBoard && c._ghId);
  const enriched = await enrichGreenhouseQueue(ghJobs, GH_DETAIL_CONCURRENCY);

  const matched = [];
  const unknownSalary = [];

  for (const c of productLocTime) {
    let floor = c.salaryFloor;
    let hints = [...c.salaryHints];
    if (c.source === "greenhouse") {
      const r = enriched.get(`${c._ghBoard}:${c._ghId}`);
      if (r) {
        floor = r.floor;
        hints = r.raw || [];
      }
    }

    const passesSalary = floor != null && floor >= MIN_SALARY;
    const row = {
      company: c.company,
      title: c.title,
      url: c.url,
      location: c.location,
      published: c.published ? new Date(c.published).toISOString() : "",
      salaryFloor: floor,
      salaryHints: hints,
    };

    if (passesSalary) matched.push(row);
    else unknownSalary.push(row);
  }

  const iso = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const reportPath = `${REPORTS_DIR}/research-product-jobs-${iso}.md`;

  let md = `# Product jobs research — last ${MAX_AGE_MS / 3600000}h\n\n`;
  md += `**Filters:** Product role · NYC metro **or** Remote USA · base **≥ $${MIN_SALARY.toLocaleString("en-US")}** (from posting text when available) · published after **${new Date(cutoff).toISOString()}**\n\n`;
  md += `**Recency:** Greenhouse uses **max(first_published, updated_at)** within the window (captures relisted/refreshed postings). Ashby uses **publishedAt** only.\n\n`;
  md += `> Jobs without a parsable USD range are listed under **Salary not detected** — still review manually.\n\n`;

  md += `## Matches (${matched.length})\n\n`;
  if (matched.length === 0) md += `_None — tighten filters or widen time window._\n\n`;
  else {
    md += "| Company | Title | Location | ≥ floor | Posted (UTC) | URL |\n";
    md += "|---|---|---|---:|---|---|\n";
    for (const r of matched.sort((a, b) => b.published.localeCompare(a.published))) {
      const floor = r.salaryFloor != null ? `$${r.salaryFloor.toLocaleString("en-US")}` : "—";
      md += `| ${r.company} | ${r.title.replace(/\|/g, "/")} | ${String(r.location).replace(/\|/g, "/")} | ${floor} | ${r.published.slice(0, 16)} | ${r.url} |\n`;
    }
    md += "\n";
  }

  md += `## Salary not detected (${unknownSalary.length})\n\n`;
  md += "_Same Product + location + recency filters; comp text missing or below threshold._\n\n";
  if (unknownSalary.length === 0) md += "_None._\n\n";
  else {
    md += "| Company | Title | Location | Posted (UTC) | URL |\n";
    md += "|---|---|---|---|---|\n";
    for (const r of unknownSalary.sort((a, b) => b.published.localeCompare(a.published))) {
      md += `| ${r.company} | ${r.title.replace(/\|/g, "/")} | ${String(r.location).replace(/\|/g, "/")} | ${r.published.slice(0, 16)} | ${r.url} |\n`;
    }
    md += "\n";
  }

  if (errors.length) {
    md += "## API errors\n\n";
    for (const e of errors) md += `- **${e.company}:** ${e.error}\n`;
    md += "\n";
  }

  writeFileSync(reportPath, md, "utf-8");
  console.log(`Wrote ${reportPath}`);
  console.log(`Matches (comp ≥ $${MIN_SALARY}): ${matched.length}`);
  console.log(`Salary not detected (still filtered): ${unknownSalary.length}`);
  console.log(`API errors: ${errors.length}`);

  if (APPEND_PIPELINE && matched.length > 0) {
    const lines = matched.map((r) => `- [ ] ${r.url} | ${r.company} | ${r.title}`);
    if (!existsSync(PIPELINE_PATH)) {
      writeFileSync(
        PIPELINE_PATH,
        `# Pipeline\n\n## Pendientes\n\n${lines.join("\n")}\n\n## Procesadas\n\n`,
        "utf-8"
      );
    } else {
      let text = readFileSync(PIPELINE_PATH, "utf-8");
      const marker = "## Pendientes";
      const idx = text.indexOf(marker);
      const block = "\n" + lines.join("\n") + "\n";
      if (idx === -1) {
        text += `\n${marker}\n${block}\n`;
      } else {
        const after = idx + marker.length;
        const next = text.indexOf("\n## ", after);
        const insertAt = next === -1 ? text.length : next;
        text = text.slice(0, insertAt) + block + text.slice(insertAt);
      }
      writeFileSync(PIPELINE_PATH, text, "utf-8");
      console.log(`Appended ${matched.length} URLs to ${PIPELINE_PATH}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
