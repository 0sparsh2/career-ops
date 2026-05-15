#!/usr/bin/env node
/**
 * Playwright smoke test: heuristic job-link count per careers_url (same logic as scan.mjs fallback).
 *
 * Usage:
 *   npm run smoke:careers
 *   npm run smoke:careers -- Google Microsoft Uber "DoorDash" Spotify Atlassian
 *   npm run smoke:careers -- --urls https://careers.google.com/ https://www.uber.com/us/en/careers/
 *
 * Sequential browser (one page) — matches project Playwright rules.
 *
 * Prints raw heuristic count plus **high-confidence** count (nav / locale / Lever
 * filter chips removed — see isHighConfidenceJobLink in lib/careers-playwright-scrape.mjs).
 */

import { chromium } from 'playwright';
import { resolveSmokeTargets, runSmokeCareers } from '../lib/smoke-careers.mjs';

async function main() {
  const argv = process.argv.slice(2);
  const { targets } = resolveSmokeTargets(argv);

  if (targets.length === 0) {
    console.error('No matching companies. Try: npm run smoke:careers -- Google');
    process.exit(1);
  }

  console.log(`Smoke-testing ${targets.length} careers page(s) (sequential Playwright)…\n`);

  const browser = await chromium.launch({ headless: true });

  try {
    const { entries, summary } = await runSmokeCareers(browser, targets);

    for (const e of entries) {
      if (!e.url || e.error === 'no careers_url') {
        console.log(`✗ ${e.name}: ${e.error || 'no careers_url'}`);
        console.log('');
        continue;
      }
      if (e.error) {
        console.log(`✗ ${e.name}: ${e.error.split('\n')[0]}`);
        console.log('');
        continue;
      }
      const sample = e.samples.map(s => {
        const t = s.title.length > 68 ? `${s.title.slice(0, 68)}…` : s.title;
        return `    • ${t}\n      ${s.url}`;
      });
      console.log(`✓ ${e.name}`);
      console.log(`  url: ${e.url}`);
      console.log(`  raw heuristic links: ${e.rawCount}`);
      console.log(`  high-confidence links: ${e.highCount}`);
      if (e.highCount > 0 && sample.length) console.log(sample.join('\n'));
      else if (e.rawCount > 0 && e.highCount === 0) {
        console.log(`  (raw > 0 but high-confidence = 0 — likely nav/chips only; API scan or agent scan is authoritative.)`);
      } else if (e.rawCount === 0) {
        console.log(`  (0 raw links — SPA may hide anchors; use /career-ops scan agent or WebSearch.)`);
      }
      console.log('');
    }

    console.log(
      `Done: ${summary.ok} with high-confidence links, ${summary.weak} weak (0 high or 0 raw), ${summary.navFail} navigation errors.`,
    );
    if (summary.navFail > 0) process.exit(1);
  } finally {
    await browser.close();
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
