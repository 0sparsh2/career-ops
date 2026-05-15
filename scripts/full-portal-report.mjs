#!/usr/bin/env node
/**
 * One combined run: `node scan.mjs` (API + optional Playwright fallback) then
 * mega-cap careers smoke (same targets as `npm run smoke:careers` with no args).
 *
 * Writes `data/portal-run-report.md` and prints the path.
 *
 * Usage:
 *   npm run report:portal
 *   npm run report:portal -- --dry-run
 *   npm run report:portal -- --no-smoke
 *   npm run report:portal -- --all-companies --dry-run
 *
 * Arguments after `--` are forwarded to scan.mjs except `--no-smoke`, which only
 * skips the second section.
 */

import { spawnSync } from 'child_process';
import { mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';
import { resolveSmokeTargets, runSmokeCareers, formatSmokeMarkdown } from '../lib/smoke-careers.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const REPORT_PATH = join(ROOT, 'data', 'portal-run-report.md');
const SCAN_SCRIPT = join(ROOT, 'scan.mjs');

async function main() {
  const rawArgs = process.argv.slice(2);
  const noSmoke = rawArgs.includes('--no-smoke');
  const scanArgs = rawArgs.filter(a => a !== '--no-smoke');

  mkdirSync(join(ROOT, 'data'), { recursive: true });

  const started = new Date().toISOString();

  const scan = spawnSync(process.execPath, [SCAN_SCRIPT, ...scanArgs], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });

  const scanStdout = scan.stdout || '';
  const scanStderr = scan.stderr || '';
  const scanStatus = scan.status ?? 1;

  let smokeMd = '';
  if (!noSmoke) {
    const { targets } = resolveSmokeTargets([], { portalsPath: join(ROOT, 'portals.yml') });
    if (targets.length === 0) {
      smokeMd = '## Playwright careers smoke\n\n_(No matching companies in portals.yml.)_\n';
    } else {
      const browser = await chromium.launch({ headless: true });
      try {
        const smoke = await runSmokeCareers(browser, targets);
        smokeMd = formatSmokeMarkdown(smoke);
      } finally {
        await browser.close();
      }
    }
  } else {
    smokeMd = '## Playwright careers smoke\n\n_Skipped (`--no-smoke`)._\n';
  }

  const report = [
    '# Portal run report',
    '',
    `Generated: ${started}`,
    '',
    '## API scan (`node scan.mjs`)',
    '',
    '```',
    scanStdout.trimEnd(),
    '```',
    '',
    scanStderr.trim()
      ? ['### Scan stderr', '', '```', scanStderr.trimEnd(), '```', ''].join('\n')
      : '',
    `_(exit code ${scanStatus})_`,
    '',
    smokeMd.trimEnd(),
    '',
    '---',
    '',
    `- Scan: exit ${scanStatus}`,
    noSmoke ? '- Smoke: skipped' : '- Smoke: completed (see table above)',
    '',
  ].join('\n');

  writeFileSync(REPORT_PATH, report, 'utf-8');
  console.log(`Report written: ${REPORT_PATH}`);
  console.log(`Scan exit code: ${scanStatus}`);

  if (scanStatus !== 0) {
    process.exit(scanStatus);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
