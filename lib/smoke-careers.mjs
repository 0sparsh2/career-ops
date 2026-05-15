/**
 * Shared Playwright careers smoke (targets + run). Used by smoke-careers-pages.mjs
 * and scripts/full-portal-report.mjs.
 */

import { readFileSync, existsSync } from 'fs';
import yaml from 'js-yaml';
import { scrapeCareersLinksPlaywright, filterHighConfidenceJobLinks } from './careers-playwright-scrape.mjs';

export const DEFAULT_SMOKE_NAMES = [
  'Google',
  'Microsoft',
  'Uber',
  'DoorDash',
  'Spotify',
  'Atlassian',
  'Meta',
  'Airbnb',
  'Ramp',
  'Plaid',
  'Lyft',
  'GitHub',
  'Snap',
  'Tesla',
  'Palantir',
  'NVIDIA',
  'BlackRock',
];

const PORTALS_PATH = 'portals.yml';

export function loadTrackedCompanies(portalsPath = PORTALS_PATH) {
  if (!existsSync(portalsPath)) {
    throw new Error(`Missing ${portalsPath}`);
  }
  const config = yaml.load(readFileSync(portalsPath, 'utf-8'));
  return config.tracked_companies || [];
}

/**
 * @param {string[]} argv process.argv-style tokens after script name (optional)
 * @param {{ portalsPath?: string }} [opts]
 */
export function resolveSmokeTargets(argv = [], opts = {}) {
  const portalsPath = opts.portalsPath || PORTALS_PATH;
  const companies = loadTrackedCompanies(portalsPath);

  let urlMode = false;
  const names = [];
  const directUrls = [];

  for (const a of argv) {
    if (a === '--urls') {
      urlMode = true;
      continue;
    }
    if (urlMode && a.startsWith('http')) {
      directUrls.push(a);
      continue;
    }
    if (!a.startsWith('-')) names.push(a);
  }

  const targets = [];
  if (directUrls.length > 0) {
    for (const url of directUrls) {
      targets.push({ name: url, careers_url: url });
    }
  } else {
    const want =
      names.length > 0 ? names.map(n => n.toLowerCase()) : DEFAULT_SMOKE_NAMES.map(n => n.toLowerCase());
    for (const c of companies) {
      if (c.enabled === false) continue;
      const n = (c.name || '').toLowerCase();
      if (want.some(w => n.includes(w) || w.includes(n))) {
        targets.push(c);
      }
    }
  }

  return { targets, names, directUrls };
}

const SAMPLE_LINKS_PER_COMPANY = 12;

/**
 * @param {import('playwright').Browser} browser
 * @param {object[]} targets company rows from portals.yml
 */
export async function runSmokeCareers(browser, targets) {
  const page = await browser.newPage();
  const entries = [];

  try {
    for (const c of targets) {
      const url = (c.careers_url || '').trim();
      const label = c.name || url;
      if (!url.startsWith('http')) {
        entries.push({
          name: label,
          url: '',
          rawCount: 0,
          highCount: 0,
          samples: [],
          error: 'no careers_url',
          weak: true,
        });
        continue;
      }
      try {
        const links = await scrapeCareersLinksPlaywright(page, url);
        const high = filterHighConfidenceJobLinks(links);
        const samples = high.slice(0, SAMPLE_LINKS_PER_COMPANY).map(l => ({
          title: l.title.replace(/\s+/g, ' ').trim(),
          url: l.url,
        }));
        entries.push({
          name: label,
          url,
          rawCount: links.length,
          highCount: high.length,
          samples,
          error: null,
        });
      } catch (e) {
        entries.push({
          name: label,
          url,
          rawCount: 0,
          highCount: 0,
          samples: [],
          error: (e && e.message) || String(e),
          weak: true,
        });
      }
    }
  } finally {
    await page.close();
  }

  let ok = 0;
  let weak = 0;
  let navFail = 0;
  for (const e of entries) {
    if (!e.url || e.error === 'no careers_url' || e.error) {
      navFail++;
      continue;
    }
    if (e.highCount > 0) ok++;
    else weak++;
  }

  return { entries, summary: { ok, weak, navFail, targetCount: targets.length } };
}

export function formatSmokeMarkdown({ entries, summary }) {
  const lines = [
    '## Playwright careers smoke',
    '',
    `Targets: ${summary.targetCount} · high-confidence pages: ${summary.ok} · weak: ${summary.weak} · errors: ${summary.navFail}`,
    '',
    '| Company | Raw | High | Notes |',
    '| --- | ---: | ---: | --- |',
  ];
  for (const e of entries) {
    let notes = '';
    if (e.error) notes = e.error;
    else if (e.rawCount > 0 && e.highCount === 0) notes = 'raw only (nav/chips)';
    else if (e.rawCount === 0) notes = '0 anchors';
    else notes = 'ok';
    lines.push(`| ${e.name.replace(/\|/g, '\\|')} | ${e.rawCount} | ${e.highCount} | ${notes.replace(/\|/g, '\\|')} |`);
  }
  lines.push('');
  lines.push(
    '_Counts use high-confidence links. Each company lists up to ' +
      SAMPLE_LINKS_PER_COMPANY +
      ' sample job URLs (listing page URL is in the scan log above or `portals.yml`)._',
  );
  lines.push('');
  for (const e of entries) {
    if (e.samples.length === 0) continue;
    lines.push(`**${e.name}** (${e.highCount} links)`, '');
    for (const row of e.samples) {
      const t = row.title.replace(/\|/g, '\\|');
      lines.push(`- ${t}`);
      lines.push(`  ${row.url}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
