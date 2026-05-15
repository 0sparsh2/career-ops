#!/usr/bin/env node
/**
 * Read-only export of portal jobs as JSON (stdout).
 *
 * Usage:
 *   node scripts/export-jobs-json.mjs --days 14
 *   node scripts/export-jobs-json.mjs --days 7 --companies "Anthropic,Cohere"
 *   node scripts/export-jobs-json.mjs --playwright --companies "Google,Microsoft"
 *   node scripts/export-jobs-json.mjs --root /path/to/career-ops --no-title-filter
 */

import { join } from 'path';
import { exportPortalJobs } from '../lib/portal-export.mjs';

function argValue(name) {
  const i = process.argv.indexOf(name);
  if (i === -1 || !process.argv[i + 1]) return null;
  return process.argv[i + 1];
}

const rootIdx = process.argv.indexOf('--root');
const root = rootIdx !== -1 && process.argv[rootIdx + 1] ? process.argv[rootIdx + 1] : process.cwd();

const days = Number(argValue('--days') || '0') || 0;
const companiesRaw = argValue('--companies');
const companies = companiesRaw ? companiesRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
const applyTitleFilter = !process.argv.includes('--no-title-filter');
const pretty = process.argv.includes('--pretty');

const portalsPath = join(root, 'portals.yml');

async function main() {
  const usePlaywright = process.argv.includes('--playwright');

  const result = await exportPortalJobs({
    portalsPath,
    days,
    companies,
    applyTitleFilter,
    playwright: usePlaywright,
  });

  if (process.argv.includes('--stderr-meta')) {
    console.error(JSON.stringify(result));
  }

  const payload = JSON.stringify(result.jobs, null, pretty ? 2 : 0);
  process.stdout.write(payload + '\n');
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
