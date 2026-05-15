/**
 * Read-only portal job export (ATS APIs + optional Playwright for mega-cap careers pages).
 * Used by scripts/export-jobs-json.mjs and streamlit_app job_fetch.py (via subprocess).
 */

import { readFileSync, existsSync } from 'fs';
import yaml from 'js-yaml';
import { scrapeCareersLinksPlaywright } from './careers-playwright-scrape.mjs';

const FETCH_TIMEOUT_MS = 12_000;

export function detectApi(company) {
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
    return { type: 'lever', url: apiUrl.split('?')[0] };
  }

  const url = company.careers_url || '';

  const ashbyMatch = url.match(/jobs\.ashbyhq\.com\/([^/?#]+)/);
  if (ashbyMatch) {
    return {
      type: 'ashby',
      url: `https://api.ashbyhq.com/posting-api/job-board/${ashbyMatch[1]}?includeCompensation=true`,
    };
  }

  const leverMatch = url.match(/jobs\.lever\.co\/([^/?#]+)/);
  if (leverMatch) {
    return { type: 'lever', url: `https://api.lever.co/v0/postings/${leverMatch[1]}` };
  }

  const ghEuMatch = url.match(/job-boards(?:\.eu)?\.greenhouse\.io\/([^/?#]+)/);
  if (ghEuMatch && !company.api) {
    return {
      type: 'greenhouse',
      url: `https://boards-api.greenhouse.io/v1/boards/${ghEuMatch[1]}/jobs`,
    };
  }

  return null;
}

function greenhousePublishedAt(j) {
  const fp = j.first_published ? Date.parse(j.first_published) : NaN;
  const up = j.updated_at ? Date.parse(j.updated_at) : NaN;
  if (Number.isNaN(fp) && Number.isNaN(up)) return null;
  if (Number.isNaN(fp)) return j.updated_at;
  if (Number.isNaN(up)) return j.first_published;
  return fp >= up ? j.first_published : j.updated_at;
}

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
    for (const m of String(b).toLowerCase().matchAll(/\$?\s*(\d{1,3}(?:,\d{3})+|\d{2,3})\s*k?\b/g)) {
      let v = parseInt(m[1].replace(/,/g, ''), 10);
      if (Number.isNaN(v)) continue;
      if (/\d\s*k\b/.test(m[0]) || m[0].includes('k')) v *= 1000;
      if (v >= 30_000 && v <= 3_000_000) nums.push(v);
    }
  }
  if (nums.length === 0) return { min: null, max: null };
  return { min: Math.min(...nums), max: Math.max(...nums) };
}

function parseGreenhouse(json, companyName) {
  return (json.jobs || []).map(j => ({
    title: j.title || '',
    url: j.absolute_url || '',
    company: companyName,
    location: j.location?.name || '',
    publishedAt: greenhousePublishedAt(j),
    salaryMin: null,
    salaryMax: null,
    source: 'greenhouse',
  }));
}

function parseAshby(json, companyName) {
  return (json.jobs || [])
    .filter(j => j.isListed !== false)
    .map(j => {
      const locBits = [j.location, ...(j.secondaryLocations || []).map(s => s.location)].filter(Boolean);
      const { min, max } = ashbyCompensationUsdRange(j.compensation);
      return {
        title: j.title || '',
        url: j.jobUrl || j.applyUrl || '',
        company: companyName,
        location: locBits.join(' | '),
        publishedAt: j.publishedAt || null,
        salaryMin: min,
        salaryMax: max,
        source: 'ashby',
        description: j.descriptionPlain || '',
      };
    });
}

function parseLever(json, companyName) {
  if (!Array.isArray(json)) return [];
  return json.map(j => ({
    title: j.text || '',
    url: j.hostedUrl || j.applyUrl || '',
    company: companyName,
    location:
      (typeof j.categories?.location === 'string' && j.categories.location) ||
      (Array.isArray(j.categories?.location) && j.categories.location.join(', ')) ||
      '',
    publishedAt: j.createdAt || j.updatedAt || null,
    salaryMin: null,
    salaryMax: null,
    source: 'lever',
    description: j.descriptionPlain || '',
  }));
}

const PARSERS = { greenhouse: parseGreenhouse, ashby: parseAshby, lever: parseLever };

export function buildTitleFilter(titleFilter) {
  const positive = (titleFilter?.positive || []).map(k => k.toLowerCase());
  const negative = (titleFilter?.negative || []).map(k => k.toLowerCase());

  return title => {
    const lower = title.toLowerCase();
    const hasPositive = positive.length === 0 || positive.some(k => lower.includes(k));
    const hasNegative = negative.some(k => lower.includes(k));
    return hasPositive && !hasNegative;
  };
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

function parsePublishedMs(publishedAt) {
  if (!publishedAt) return null;
  const t = Date.parse(publishedAt);
  return Number.isFinite(t) ? t : null;
}

/**
 * @param {object} opts
 * @param {string} opts.portalsPath
 * @param {number} opts.days - only jobs published within last N days (0 = no filter)
 * @param {string[]} [opts.companies] - company names (case-insensitive substring); empty = all enabled with API
 * @param {boolean} [opts.applyTitleFilter] - default true
 * @param {number} [opts.concurrency] - default 10
 * @param {boolean} [opts.playwright] - also scrape careers_url when no ATS API (Google, Microsoft, …)
 */
export async function exportPortalJobs(opts) {
  const {
    portalsPath,
    days = 0,
    companies = [],
    applyTitleFilter = true,
    concurrency = 10,
    playwright = false,
  } = opts;

  if (!existsSync(portalsPath)) {
    throw new Error(`portals.yml not found: ${portalsPath}`);
  }

  const config = yaml.load(readFileSync(portalsPath, 'utf-8'));
  const tracked = config.tracked_companies || [];
  const titleFilter = applyTitleFilter ? buildTitleFilter(config.title_filter) : () => true;
  const cutoffMs = days > 0 ? Date.now() - days * 24 * 60 * 60 * 1000 : null;

  const nameFilters = companies.map(c => c.toLowerCase().trim()).filter(Boolean);

  const enabled = tracked
    .filter(c => c.enabled !== false)
    .map(c => ({ ...c, _api: detectApi(c) }));

  let apiTargets = enabled.filter(c => c._api !== null);
  const canPlaywright = c =>
    playwright &&
    c.playwright_fallback !== false &&
    (c.careers_url || '').trim().startsWith('http');
  let pwTargets = playwright ? enabled.filter(c => c._api === null && canPlaywright(c)) : [];

  if (nameFilters.length > 0) {
    apiTargets = apiTargets.filter(c => nameFilters.some(f => c.name.toLowerCase().includes(f)));
    pwTargets = pwTargets.filter(c => nameFilters.some(f => c.name.toLowerCase().includes(f)));
  }

  const drops = [];
  let rawCount = 0;

  function recordDrop(job, source, reason) {
    drops.push({
      reason,
      source,
      company: job.company || '',
      title: job.title || '',
      url: job.url || '',
      publishedAt: job.publishedAt || null,
    });
  }

  function pushJob(job, source) {
    rawCount++;
    if (!titleFilter(job.title)) {
      recordDrop(job, source, 'title_filter');
      return;
    }
    const pubMs = parsePublishedMs(job.publishedAt);
    const isPw = String(source).startsWith('playwright');
    if (cutoffMs != null && pubMs != null && pubMs < cutoffMs) {
      recordDrop(job, source, 'older_than_days_cutoff');
      return;
    }
    if (cutoffMs != null && pubMs == null && !isPw) {
      recordDrop(job, source, 'missing_publish_date');
      return;
    }

    out.push({
      company: job.company,
      title: job.title,
      url: job.url,
      location: job.location || '',
      publishedAt: job.publishedAt || null,
      salaryMin: job.salaryMin,
      salaryMax: job.salaryMax,
      source,
      description: job.description || '',
    });
  }

  const out = [];
  const errors = [];

  const tasks = apiTargets.map(company => async () => {
    const { type, url } = company._api;
    try {
      const json = await fetchJson(url);
      const jobs = PARSERS[type](json, company.name);
      return { company: company.name, jobs, error: null };
    } catch (err) {
      return { company: company.name, jobs: [], error: err.message };
    }
  });

  const results = await parallelFetch(tasks, concurrency);

  for (const r of results) {
    if (r.error) {
      errors.push({ company: r.company, error: r.error });
      continue;
    }
    for (const job of r.jobs) {
      pushJob(job, job.source || 'api');
    }
  }

  if (pwTargets.length > 0) {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    try {
      for (const company of pwTargets) {
        try {
          const url = (company.careers_url || '').trim();
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
          for (const job of jobs) {
            pushJob(job, 'playwright');
          }
        } catch (e) {
          errors.push({ company: company.name, error: `Playwright: ${e.message}` });
        }
      }
    } finally {
      await browser.close();
    }
  }

  const dropSummary = {};
  for (const d of drops) {
    dropSummary[d.reason] = (dropSummary[d.reason] || 0) + 1;
  }

  return {
    jobs: out,
    drops,
    dropSummary,
    rawCount,
    keptCount: out.length,
    errors,
    companiesScanned: apiTargets.length + pwTargets.length,
    apiCompanies: apiTargets.length,
    playwrightCompanies: pwTargets.length,
    daysFilter: days,
    playwrightEnabled: playwright,
  };
}
