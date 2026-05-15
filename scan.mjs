#!/usr/bin/env node

/**
 * scan.mjs — Zero-token portal scanner
 *
 * Fetches Greenhouse, Ashby, and Lever APIs directly, applies title
 * filters from portals.yml, optional scan_filters (recency, location,
 * salary when the API exposes it). Greenhouse recency uses the fresher of
 * first_published and updated_at. Deduplicates against existing history,
 * and appends new offers to pipeline.md + scan-history.tsv.
 *
 * If an ATS API request fails (HTTP error, timeout, bad JSON), optionally
 * falls back to a headless Playwright pass over careers_url (heuristic link
 * extraction). Playwright runs sequentially — never in parallel with other
 * browser sessions. Disable with --no-playwright-fallback or per-company
 * playwright_fallback: false in portals.yml.
 *
 * Zero Claude API tokens — pure HTTP + JSON (+ optional local Playwright).
 *
 * Usage:
 *   node scan.mjs                  # scan all enabled companies (ATS API only)
 *   node scan.mjs --all-companies  # every enabled row: API where possible, else Playwright on careers_url
 *   node scan.mjs --dry-run        # preview without writing files
 *   node scan.mjs --company Cohere # scan a single company
 *   node scan.mjs --no-playwright-fallback  # API only (faster CI)
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import yaml from 'js-yaml';
import { scrapeCareersLinksPlaywright } from './lib/careers-playwright-scrape.mjs';

const parseYaml = yaml.load;

// ── Config ──────────────────────────────────────────────────────────

const PORTALS_PATH = 'portals.yml';
const SCAN_HISTORY_PATH = 'data/scan-history.tsv';
const PIPELINE_PATH = 'data/pipeline.md';
const APPLICATIONS_PATH = 'data/applications.md';

// Ensure required directories exist (fresh setup)
mkdirSync('data', { recursive: true });

const CONCURRENCY = 10;
const FETCH_TIMEOUT_MS = 10_000;

// ── API detection ───────────────────────────────────────────────────

function detectApi(company) {
  const apiUrl = (company.api || '').trim();

  // Explicit API URLs (use when careers_url is a marketing / search page)
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
    return { type: 'lever', url: apiUrl.split('?')[0] };
  }

  const url = company.careers_url || '';

  // Ashby from careers_url
  const ashbyMatch = url.match(/jobs\.ashbyhq\.com\/([^/?#]+)/);
  if (ashbyMatch) {
    return {
      type: 'ashby',
      url: `https://api.ashbyhq.com/posting-api/job-board/${ashbyMatch[1]}?includeCompensation=true`,
    };
  }

  // Lever
  const leverMatch = url.match(/jobs\.lever\.co\/([^/?#]+)/);
  if (leverMatch) {
    return {
      type: 'lever',
      url: `https://api.lever.co/v0/postings/${leverMatch[1]}`,
    };
  }

  // Greenhouse EU boards
  const ghEuMatch = url.match(/job-boards(?:\.eu)?\.greenhouse\.io\/([^/?#]+)/);
  if (ghEuMatch && !company.api) {
    return {
      type: 'greenhouse',
      url: `https://boards-api.greenhouse.io/v1/boards/${ghEuMatch[1]}/jobs`,
    };
  }

  return null;
}

// ── API parsers ─────────────────────────────────────────────────────

/** Prefer the fresher of Greenhouse first_published vs updated_at (relists bump updated_at). */
function greenhousePublishedAt(j) {
  const fp = j.first_published ? Date.parse(j.first_published) : NaN;
  const up = j.updated_at ? Date.parse(j.updated_at) : NaN;
  if (Number.isNaN(fp) && Number.isNaN(up)) return null;
  if (Number.isNaN(fp)) return j.updated_at;
  if (Number.isNaN(up)) return j.first_published;
  return fp >= up ? j.first_published : j.updated_at;
}

function parseGreenhouse(json, companyName) {
  const jobs = json.jobs || [];
  return jobs.map(j => ({
    title: j.title || '',
    url: j.absolute_url || '',
    company: companyName,
    location: j.location?.name || '',
    publishedAt: greenhousePublishedAt(j),
    salaryMin: null,
    salaryMax: null,
  }));
}

function parseAshby(json, companyName) {
  const jobs = json.jobs || [];
  return jobs.map(j => {
    const locBits = [j.location, ...(j.secondaryLocations || []).map(s => s.location)].filter(Boolean);
    const { min, max } = ashbyCompensationUsdRange(j.compensation);
    return {
      title: j.title || '',
      url: j.jobUrl || '',
      company: companyName,
      location: locBits.join(' | '),
      publishedAt: j.publishedAt || null,
      salaryMin: min,
      salaryMax: max,
    };
  });
}

/** Best-effort USD min/max from Ashby posting-api compensation blob. */
function ashbyCompensationUsdRange(comp) {
  if (!comp) return { min: null, max: null };
  const blobs = [
    comp.compensationTierSummary,
    comp.scrapeableCompensationSalarySummary,
    ...(comp.summaryComponents || []).map(c => (typeof c === 'string' ? c : c?.text)),
    ...(comp.compensationTiers || []).map(t => [t?.min, t?.max, t?.summary].filter(Boolean).join(' ')),
  ].filter(Boolean);
  const nums = [];
  for (const b of blobs) {
    for (const n of extractUsdLikeNumbers(String(b))) nums.push(n);
  }
  if (nums.length === 0) return { min: null, max: null };
  return { min: Math.min(...nums), max: Math.max(...nums) };
}

/** Pulls integers that look like annual USD from free-text (e.g. $180,000, 200k, USD 240000). */
function extractUsdLikeNumbers(text) {
  const out = [];
  const lower = text.toLowerCase();
  for (const m of lower.matchAll(/\$?\s*(\d{1,3}(?:,\d{3})+|\d{2,3})\s*k?\b/g)) {
    let v = parseInt(m[1].replace(/,/g, ''), 10);
    if (Number.isNaN(v)) continue;
    if (/\d\s*k\b/.test(m[0]) || m[0].includes('k')) v *= 1000;
    if (v >= 30_000 && v <= 3_000_000) out.push(v);
  }
  return out;
}

function parseLever(json, companyName) {
  if (!Array.isArray(json)) return [];
  return json.map(j => ({
    title: j.text || '',
    url: j.hostedUrl || '',
    company: companyName,
    location: j.categories?.location || '',
    publishedAt: j.createdAt || j.updatedAt || null,
    salaryMin: null,
    salaryMax: null,
  }));
}

const PARSERS = { greenhouse: parseGreenhouse, ashby: parseAshby, lever: parseLever };

// ── Fetch with timeout ──────────────────────────────────────────────

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

async function playwrightFallbackJobs(page, company) {
  const url = (company.careers_url || '').trim();
  if (!url.startsWith('http')) {
    return { jobs: [], pwError: 'no careers_url' };
  }
  const raw = await scrapeCareersLinksPlaywright(page, url);
  const jobs = raw.map(r => ({
    title: r.title,
    url: r.url,
    company: company.name,
    location: '',
    publishedAt: null,
    salaryMin: null,
    salaryMax: null,
  }));
  return { jobs, pwError: null };
}

// ── Title filter ────────────────────────────────────────────────────

function buildTitleFilter(titleFilter) {
  const positive = (titleFilter?.positive || []).map(k => k.toLowerCase());
  const negative = (titleFilter?.negative || []).map(k => k.toLowerCase());

  return (title) => {
    const lower = title.toLowerCase();
    const hasPositive = positive.length === 0 || positive.some(k => lower.includes(k));
    const hasNegative = negative.some(k => lower.includes(k));
    return hasPositive && !hasNegative;
  };
}

// ── Optional scan_filters (portals.yml → scan_filters) ──────────────

/** NYC metro / NY state signals, or remote-hybrid distributed roles anchored to the US. */
function matchesNyOrRemoteUsa(locRaw) {
  const s = (locRaw || '').toLowerCase();
  if (!s.trim()) return false;

  const remoteNonUs = /\bremote\b.*\b(canada|united kingdom|\buk\b|india|germany|ireland|france|spain|italy|netherlands|sweden|poland|brazil|mexico|japan|china|singapore|australia|israel|emea|apac|latam|dublin|london|berlin|munich|paris|toronto|vancouver|sydney|tel aviv)\b|\b(canada|united kingdom|\buk\b|india|germany|ireland|france|emea|apac|latam)\b.*\bremote\b/i;
  if (remoteNonUs.test(s)) return false;

  const nyMetro =
    /new york|nyc|\bnyc\b|manhattan|brooklyn|queens|bronx|staten island|jersey city|hoboken|westchester|long island|white plains|yonkers|albany|buffalo|rochester|syracuse|ithaca|newark|princeton|stamford|greenwich|commutable.*new york|hybrid.*new york|onsite.*new york/i;
  if (nyMetro.test(s)) return true;

  const usAnchor =
    /\b(united states|usa|u\.s\.|us-only|us only|multiple locations.*united states|americas|north america)\b/i;
  if (/\bremote\b|distributed|work from home|anywhere/.test(s) && usAnchor.test(s)) return true;

  if (/\bremote\b/.test(s) && !remoteNonUs.test(s)) return true;

  if (usAnchor.test(s) && !/\b(canada|united kingdom|europe|asia|india|australia)\b/i.test(s)) return true;

  return false;
}

/**
 * @param {object} scanFilters portals.yml scan_filters block
 * @param {{ age: number, location: number, salary: number }} skipOut mutates with skip counts
 */
function buildScanPostFilter(scanFilters, skipOut) {
  const maxAgeHours = Math.max(0, Number(scanFilters?.max_age_hours) || 0);
  const minSalaryUsd = Math.max(0, Number(scanFilters?.min_salary_usd) || 0);
  const locationOn = Boolean(scanFilters?.location_ny_or_remote_usa);

  return (job) => {
    if (maxAgeHours > 0 && job.publishedAt) {
      const pub = new Date(job.publishedAt).getTime();
      if (!Number.isNaN(pub)) {
        const ageMs = Date.now() - pub;
        if (ageMs > maxAgeHours * 3600 * 1000) {
          skipOut.age++;
          return false;
        }
      }
    }

    if (locationOn && !matchesNyOrRemoteUsa(job.location)) {
      skipOut.location++;
      return false;
    }

    if (minSalaryUsd > 0 && job.salaryMax != null && job.salaryMax < minSalaryUsd) {
      skipOut.salary++;
      return false;
    }

    return true;
  };
}

// ── Dedup ───────────────────────────────────────────────────────────

function loadSeenUrls() {
  const seen = new Set();

  // scan-history.tsv
  if (existsSync(SCAN_HISTORY_PATH)) {
    const lines = readFileSync(SCAN_HISTORY_PATH, 'utf-8').split('\n');
    for (const line of lines.slice(1)) { // skip header
      const url = line.split('\t')[0];
      if (url) seen.add(url);
    }
  }

  // pipeline.md — extract URLs from checkbox lines
  if (existsSync(PIPELINE_PATH)) {
    const text = readFileSync(PIPELINE_PATH, 'utf-8');
    for (const match of text.matchAll(/- \[[ x]\] (https?:\/\/\S+)/g)) {
      seen.add(match[1]);
    }
  }

  // applications.md — extract URLs from report links and any inline URLs
  if (existsSync(APPLICATIONS_PATH)) {
    const text = readFileSync(APPLICATIONS_PATH, 'utf-8');
    for (const match of text.matchAll(/https?:\/\/[^\s|)]+/g)) {
      seen.add(match[0]);
    }
  }

  return seen;
}

function loadSeenCompanyRoles() {
  const seen = new Set();
  if (existsSync(APPLICATIONS_PATH)) {
    const text = readFileSync(APPLICATIONS_PATH, 'utf-8');
    // Parse markdown table rows: | # | Date | Company | Role | ...
    for (const match of text.matchAll(/\|[^|]+\|[^|]+\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|/g)) {
      const company = match[1].trim().toLowerCase();
      const role = match[2].trim().toLowerCase();
      if (company && role && company !== 'company') {
        seen.add(`${company}::${role}`);
      }
    }
  }
  return seen;
}

// ── Pipeline writer ─────────────────────────────────────────────────

function appendToPipeline(offers) {
  if (offers.length === 0) return;

  if (!existsSync(PIPELINE_PATH)) {
    writeFileSync(
      PIPELINE_PATH,
      '# Pipeline — pending and processed job URLs\n\n## Pendientes\n\n## Procesadas\n\n',
      'utf-8',
    );
  }

  let text = readFileSync(PIPELINE_PATH, 'utf-8');

  // Find "## Pendientes" section and append after it
  const marker = '## Pendientes';
  const idx = text.indexOf(marker);
  if (idx === -1) {
    // No Pendientes section — append at end before Procesadas
    const procIdx = text.indexOf('## Procesadas');
    const insertAt = procIdx === -1 ? text.length : procIdx;
    const block = `\n${marker}\n\n` + offers.map(o =>
      `- [ ] ${o.url} | ${o.company} | ${o.title}`
    ).join('\n') + '\n\n';
    text = text.slice(0, insertAt) + block + text.slice(insertAt);
  } else {
    // Find the end of existing Pendientes content (next ## or end)
    const afterMarker = idx + marker.length;
    const nextSection = text.indexOf('\n## ', afterMarker);
    const insertAt = nextSection === -1 ? text.length : nextSection;

    const block = '\n' + offers.map(o =>
      `- [ ] ${o.url} | ${o.company} | ${o.title}`
    ).join('\n') + '\n';
    text = text.slice(0, insertAt) + block + text.slice(insertAt);
  }

  writeFileSync(PIPELINE_PATH, text, 'utf-8');
}

function appendToScanHistory(offers, date) {
  // Ensure file + header exist
  if (!existsSync(SCAN_HISTORY_PATH)) {
    writeFileSync(SCAN_HISTORY_PATH, 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\n', 'utf-8');
  }

  const lines = offers.map(o =>
    `${o.url}\t${date}\t${o.source}\t${o.title}\t${o.company}\tadded`
  ).join('\n') + '\n';

  appendFileSync(SCAN_HISTORY_PATH, lines, 'utf-8');
}

// ── Parallel fetch with concurrency limit ───────────────────────────

async function parallelFetch(tasks, limit) {
  const results = [];
  let i = 0;

  async function next() {
    while (i < tasks.length) {
      const task = tasks[i++];
      results.push(await task());
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => next());
  await Promise.all(workers);
  return results;
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const companyFlag = args.indexOf('--company');
  const filterCompany = companyFlag !== -1 ? args[companyFlag + 1]?.toLowerCase() : null;

  // 1. Read portals.yml
  if (!existsSync(PORTALS_PATH)) {
    console.error('Error: portals.yml not found. Run onboarding first.');
    process.exit(1);
  }

  const config = parseYaml(readFileSync(PORTALS_PATH, 'utf-8'));
  const companies = config.tracked_companies || [];
  const titleFilter = buildTitleFilter(config.title_filter);
  const scanSkips = { age: 0, location: 0, salary: 0 };
  const scanPost = buildScanPostFilter(config.scan_filters || {}, scanSkips);
  const scanFiltersActive = Boolean(
    config.scan_filters &&
      (Number(config.scan_filters.max_age_hours) > 0 ||
        config.scan_filters.location_ny_or_remote_usa ||
        Number(config.scan_filters.min_salary_usd) > 0),
  );

  const allCompanies = args.includes('--all-companies');

  const enabledFiltered = companies
    .filter(c => c.enabled !== false)
    .filter(c => !filterCompany || c.name.toLowerCase().includes(filterCompany))
    .map(c => ({ ...c, _api: detectApi(c) }));

  const playwrightFallback =
    !args.includes('--no-playwright-fallback') && config.scanner?.playwright_fallback !== false;

  const apiTargets = enabledFiltered.filter(c => c._api !== null);

  const canPlaywrightCareers = c =>
    playwrightFallback &&
    c.playwright_fallback !== false &&
    (c.careers_url || '').trim().startsWith('http');

  const playwrightDirect =
    allCompanies && playwrightFallback
      ? enabledFiltered.filter(c => c._api === null && canPlaywrightCareers(c))
      : [];

  const skippedNoApiNoPw = enabledFiltered.filter(
    c => c._api === null && !canPlaywrightCareers(c),
  ).length;

  if (!allCompanies) {
    const skippedCount = enabledFiltered.length - apiTargets.length;
    console.log(`Scanning ${apiTargets.length} companies via API (${skippedCount} skipped — no API detected)`);
  } else {
    console.log(
      `Scanning all ${enabledFiltered.length} enabled row(s): ${apiTargets.length} via ATS API, ${playwrightDirect.length} via Playwright only (no API); ${skippedNoApiNoPw} skipped (no API + no Playwright path)`,
    );
  }
  if (playwrightFallback) {
    console.log('Playwright fallback: on (after API failure; use --no-playwright-fallback to disable)');
  }
  if (dryRun) console.log('(dry run — no files will be written)\n');

  // 3. Load dedup sets
  const seenUrls = loadSeenUrls();
  const seenCompanyRoles = loadSeenCompanyRoles();

  // 4. Fetch all APIs (parallel), then Playwright fallback (sequential)
  const date = new Date().toISOString().slice(0, 10);
  let totalFound = 0;
  let totalFiltered = 0;
  let totalDupes = 0;
  const newOffers = [];
  const errors = [];
  const recovered = new Set();

  function ingestJobList(jobs, source) {
    for (const job of jobs) {
      if (!titleFilter(job.title)) {
        totalFiltered++;
        continue;
      }
      if (!scanPost(job)) {
        continue;
      }
      if (seenUrls.has(job.url)) {
        totalDupes++;
        continue;
      }
      const key = `${job.company.toLowerCase()}::${job.title.toLowerCase()}`;
      if (seenCompanyRoles.has(key)) {
        totalDupes++;
        continue;
      }
      seenUrls.add(job.url);
      seenCompanyRoles.add(key);
      newOffers.push({ ...job, source });
    }
  }

  const tasks = apiTargets.map(company => async () => {
    const { type, url } = company._api;
    try {
      const json = await fetchJson(url);
      const jobs = PARSERS[type](json, company.name);
      return { company, apiType: type, jobs, fetchError: null };
    } catch (err) {
      return { company, apiType: type, jobs: [], fetchError: err.message };
    }
  });

  const apiResults = await parallelFetch(tasks, CONCURRENCY);

  for (const r of apiResults) {
    if (r.fetchError) continue;
    totalFound += r.jobs.length;
    ingestJobList(r.jobs, `${r.apiType}-api`);
  }

  const needsFallback = apiResults.filter(
    r =>
      r.fetchError &&
      playwrightFallback &&
      r.company.playwright_fallback !== false &&
      (r.company.careers_url || '').trim().startsWith('http'),
  );

  const pwTasks = [
    ...needsFallback.map(r => ({ kind: 'api-fail', company: r.company, apiErr: r.fetchError })),
    ...playwrightDirect.map(c => ({ kind: 'no-api', company: c, apiErr: null })),
  ];

  if (pwTasks.length > 0) {
    const label =
      needsFallback.length > 0 && playwrightDirect.length > 0
        ? 'API failures + no-API careers rows'
        : needsFallback.length > 0
          ? 'API failure fallbacks'
          : 'Playwright-only (no ATS API)';
    console.log(`\nPlaywright (${label}): ${pwTasks.length} company(ies) (sequential)…`);
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    try {
      for (const t of pwTasks) {
        if (t.kind === 'api-fail') {
          console.log(`  ↳ ${t.company.name} — API error: ${t.apiErr}`);
        } else {
          console.log(`  ↳ ${t.company.name} — no ATS API; harvesting careers_url`);
        }
        try {
          const { jobs, pwError } = await playwrightFallbackJobs(page, t.company);
          if (pwError) {
            errors.push({
              company: t.company.name,
              error:
                t.kind === 'api-fail'
                  ? `API: ${t.apiErr} | Playwright: ${pwError}`
                  : `No ATS API | Playwright: ${pwError}`,
            });
            continue;
          }
          if (jobs.length === 0) {
            errors.push({
              company: t.company.name,
              error:
                t.kind === 'api-fail'
                  ? `API: ${t.apiErr} | Playwright: 0 job-like links on careers page`
                  : 'No ATS API | Playwright: 0 job-like links on careers page',
            });
            continue;
          }
          const beforeLen = newOffers.length;
          totalFound += jobs.length;
          const source = t.kind === 'api-fail' ? 'playwright-fallback' : 'playwright-no-api';
          ingestJobList(jobs, source);
          const kept = newOffers.length - beforeLen;
          console.log(`     → ${jobs.length} raw links, ${kept} new after filters & dedup`);
          if (t.kind === 'api-fail') recovered.add(t.company.name);
        } catch (e) {
          errors.push({
            company: t.company.name,
            error:
              t.kind === 'api-fail'
                ? `API: ${t.apiErr} | Playwright: ${e.message}`
                : `No ATS API | Playwright: ${e.message}`,
          });
        }
      }
    } finally {
      await browser.close();
    }
  }

  for (const r of apiResults) {
    if (!r.fetchError) continue;
    if (recovered.has(r.company.name)) continue;
    const couldFallback =
      playwrightFallback &&
      r.company.playwright_fallback !== false &&
      (r.company.careers_url || '').trim().startsWith('http');
    if (couldFallback) continue;
    errors.push({ company: r.company.name, error: r.fetchError });
  }

  // 5. Write results
  if (!dryRun && newOffers.length > 0) {
    appendToPipeline(newOffers);
    appendToScanHistory(newOffers, date);
  }

  // 6. Print summary
  console.log(`\n${'━'.repeat(45)}`);
  console.log(`Portal Scan — ${date}`);
  console.log(`${'━'.repeat(45)}`);
  console.log(`Companies (API path):  ${apiTargets.length}`);
  if (allCompanies) {
    console.log(`Companies (Playwright-only, no API): ${playwrightDirect.length}`);
    if (skippedNoApiNoPw > 0) {
      console.log(`Skipped (no API + no Playwright path): ${skippedNoApiNoPw}`);
    }
  }
  console.log(`Total jobs found:      ${totalFound}`);
  console.log(`Filtered by title:     ${totalFiltered} removed`);
  if (scanFiltersActive) {
    console.log(`scan_filters skips:    age=${scanSkips.age} location=${scanSkips.location} salary=${scanSkips.salary}`);
    console.log(`  (salary only excludes when API lists a max below min_salary_usd; else verify comp in JD.)`);
  }
  console.log(`Duplicates:            ${totalDupes} skipped`);
  console.log(`New offers added:      ${newOffers.length}`);
  if (recovered.size > 0) {
    console.log(`Playwright recoveries: ${recovered.size} company(ies) (API failed, links from careers page)`);
  }

  if (errors.length > 0) {
    console.log(`\nErrors (${errors.length}):`);
    for (const e of errors) {
      console.log(`  ✗ ${e.company}: ${e.error}`);
    }
  }

  if (newOffers.length > 0) {
    console.log('\nNew offers:');
    for (const o of newOffers) {
      console.log(`  + ${o.company} | ${o.title} | ${o.location || 'N/A'}`);
    }
    if (dryRun) {
      console.log('\n(dry run — run without --dry-run to save results)');
    } else {
      console.log(`\nResults saved to ${PIPELINE_PATH} and ${SCAN_HISTORY_PATH}`);
    }
  } else if (dryRun) {
    console.log(`\n(dry run — ${PIPELINE_PATH} and ${SCAN_HISTORY_PATH} not modified.)`);
  } else {
    console.log(
      `\n${PIPELINE_PATH} and ${SCAN_HISTORY_PATH} not modified: 0 new offers (dedup, title_filter, and/or scan_filters).`,
    );
  }

  console.log(`\n→ Run /career-ops pipeline to evaluate new offers.`);
  console.log('→ Share results and get help: https://discord.gg/8pRpHETxa4');
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
