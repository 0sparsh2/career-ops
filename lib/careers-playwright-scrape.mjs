/**
 * Shared heuristic: collect job-like links from a careers landing page (SPA-friendly).
 * Used by scan.mjs (API failure fallback) and scripts/smoke-careers-pages.mjs.
 */

export const PLAYWRIGHT_GOTO_MS = 45_000;
export const PLAYWRIGHT_HYDRATE_MS = 4000;
export const PLAYWRIGHT_MAX_LINKS = 500;

/**
 * Post-filter raw heuristic links (Node). Drops obvious nav, locale switchers,
 * Lever/GH filter chips, and shallow "Explore …" rows so smoke counts match human judgment.
 * @param {{ url: string, title: string }[]} links
 * @returns {{ url: string, title: string }[]}
 */
export function filterHighConfidenceJobLinks(links) {
  return links.filter(isHighConfidenceJobLink);
}

/**
 * @param {{ url: string, title: string }} link
 */
export function isHighConfidenceJobLink(link) {
  const title = (link.title || '').replace(/\s+/g, ' ').trim();
  const url = link.url || '';
  if (!url.startsWith('http') || title.length < 3) return false;

  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }

  const p = u.pathname;
  const hn = u.hostname.toLowerCase();
  const lower = title.toLowerCase();

  const badTitle =
    /^(careers|jobs|job board|search|home|next|previous|apply)\s*$/i.test(lower) ||
    /^(deutsch|français|español|português|italiano|中文|日本語|한국어)(\s|$)/i.test(title) ||
    /^view this page in your language/i.test(lower) ||
    /^work_outline\s*jobs\b/i.test(lower) ||
    /^home\s+home\b/i.test(lower) ||
    /^google\s+how we work/i.test(lower) ||
    /^noogler/i.test(lower) ||
    /^students\s+students\b/i.test(lower) ||
    /^(cookie|privacy policy|terms of (use|service))$/i.test(lower) ||
    /^explore (ai|metaverse|engineering|careers|jobs|technology)\b/i.test(lower) ||
    /^explore our student/i.test(lower) ||
    /^(early in your career|early in profession|military and veterans)$/i.test(lower) ||
    /know your rights|workplace discrimination is illegal/i.test(lower) ||
    (title.length < 28 && /^explore\b/i.test(lower));

  if (badTitle) return false;

  if (/greenhouse\.io$/i.test(hn) || hn.includes('greenhouse.io')) {
    return /\/jobs\/\d+/i.test(p) || /\/jobs\/\d+/i.test(url);
  }

  if (hn.endsWith('.lever.co') || hn === 'jobs.lever.co') {
    const parts = p.split('/').filter(Boolean);
    if (parts.length < 2) return false;
    const tail = parts[parts.length - 1];
    return /^[0-9a-f-]{8,}$/i.test(tail);
  }

  if (hn.endsWith('.ashbyhq.com') || hn === 'jobs.ashbyhq.com') {
    if (/\/jobs\//.test(p)) return true;
    const parts = p.split('/').filter(Boolean);
    if (parts.length >= 2 && /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(parts[parts.length - 1])) return true;
    return false;
  }

  if (hn.includes('myworkdayjobs.com')) {
    return /\/job\//i.test(p) || /\/details\//i.test(p) || /\/d\/detail\//i.test(p) || /requisition/i.test(url);
  }

  if (hn.includes('nvidia.com') || hn === 'jobs.nvidia.com') {
    if (
      /workbench|simplify ai development|download now|get started with ai workbench|learn more about ai workbench/i.test(
        lower,
      )
    ) {
      return false;
    }
    if (hn === 'jobs.nvidia.com') {
      return (
        /\/(jobs|job)\//i.test(p) ||
        /myworkdayjobs\.com/i.test(url) ||
        (title.length >= 32 &&
          /\b(engineer|manager|product|scientist|developer|architect|specialist|analyst|director)\b/i.test(title))
      );
    }
  }

  if (hn.includes('google.com') && p.includes('/about/careers/applications/jobs')) {
    if (/know your rights|workplace discrimination|eeo is the law|equal opportunity/i.test(lower)) return false;
    if (
      /^home\s|students students|how we work|how we hire|your career|recommended jobs|saved jobs|job alerts|job search|ai at google|noogler|_home_|_work_outline_|_noogler_/i.test(
        lower,
      )
    ) {
      return false;
    }
    if (/^learn more$|^share$|^copy link$|^email|skip navigation|clear filters$/i.test(lower)) return false;
    const googlePostingPath =
      /\/about\/careers\/applications\/jobs\/results\/\d{8,}-[a-z0-9.-]+$/i.test(p) ||
      /\/about\/careers\/applications\/jobs\/results\/jobs\/results\/\d{8,}-[^/]+$/i.test(p);
    if (googlePostingPath) {
      return title.length >= 12;
    }
    const inResultsList = p.includes('/about/careers/applications/jobs/results');
    if (inResultsList) {
      return (
        title.length >= 22 &&
        /\b(product manager|product management|product,|strategist|consultant|partner|gtm|software engineer|data scientist|program manager|technical program|engineering manager|analyst|architect|designer|research scientist|ux|staff|director|administrative)\b/i.test(
          lower,
        )
      );
    }
    if (/\/jobs\/results\/\d/i.test(p)) {
      return title.length >= 10;
    }
    if (!/\/jobs\//i.test(p)) return false;
    return (
      title.length >= 28 &&
      /\b(engineer|scientist|manager|product|developer|analyst|designer|specialist|research|sales|marketing|legal|recruiter|intern|architect|program)\b/i.test(
        lower,
      )
    );
  }

  if (hn.includes('metacareers.com')) {
    if (/\/jobs\//i.test(p)) return true;
    if (/\/jobsearch/i.test(p)) {
      return (
        title.length >= 36 &&
        !/^explore\b/i.test(lower) &&
        /\b(engineer|manager|product|program|designer|researcher|scientist|analyst|director|lead|marketing|sales|specialist|data|security|legal|operations)\b/i.test(
          lower,
        )
      );
    }
    return false;
  }

  if (hn.includes('microsoft.com')) {
    return (
      title.length >= 32 &&
      /\b(engineer|manager|product|program|designer|architect|developer|consultant|scientist|analyst|director|lead)\b/i.test(
        title,
      )
    );
  }

  if (hn.includes('blackrock.com')) {
    if (/\/search-jobs/i.test(p)) {
      return title.length >= 32 && !/^explore\b/i.test(lower);
    }
    return title.length >= 38 && !/^explore\b/i.test(lower);
  }

  if (hn.includes('snap.com')) {
    const snapJobId = u.searchParams.get('id');
    if ((p === '/job' || p.startsWith('/job/')) && snapJobId && snapJobId.length >= 4) {
      return title.length >= 16 && !/^view openings$/i.test(lower);
    }
    if (/\/jobs\//i.test(p) && p.split('/').filter(Boolean).length >= 2) {
      const last = p.split('/').filter(Boolean).pop() || '';
      if (last.length > 4 && !/^(jobs?|search)$/i.test(last)) return true;
    }
    if ((p === '/jobs' || p === '/jobs/') && title.length >= 20 && !/^no results/i.test(lower)) {
      return /\b(engineer|scientist|product|designer|manager|analyst|researcher|marketing|sales|legal|program)\b/i.test(lower);
    }
    return (
      /\/jobs?\//i.test(p) ||
      (title.length >= 22 &&
        /\b(engineer|scientist|product|designer|manager|analyst|researcher)\b/i.test(title) &&
        !/^machine learning$/i.test(title.trim()))
    );
  }

  if (title.length >= 48) return true;
  if (
    title.length >= 24 &&
    /\b(engineer|developer|scientist|manager|director|analyst|architect|designer|specialist|lead|principal|staff|attorney|associate|officer|coordinator|product|program|deployment|capital|liquidity)\b/i.test(
      title,
    )
  ) {
    return true;
  }

  return false;
}

/**
 * @param {import('playwright').Page} page
 * @param {string} careersUrl
 */
export async function scrapeCareersLinksPlaywright(page, careersUrl) {
  await page.goto(careersUrl, { waitUntil: 'load', timeout: PLAYWRIGHT_GOTO_MS });
  await page.waitForTimeout(PLAYWRIGHT_HYDRATE_MS);
  if (/\/google\.com\/about\/careers\//i.test(careersUrl)) {
    try {
      await page.waitForFunction(
        () =>
          [...document.querySelectorAll('a[href]')].some(a => {
            const h = a.getAttribute('href') || '';
            return (
              /\/jobs\/results\/\d{8,}-/.test(h) || /\/jobs\/results\/jobs\/results\/\d{8,}-/.test(h)
            );
          }),
        { timeout: 20_000 },
      );
    } catch {
      /* listing may be slow or blocked; still scroll */
    }
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(3200);
  }
  return page.evaluate(max => {
    const junkHosts = /mailto:|tel:/i;
    const atsHost =
      /greenhouse\.io|lever\.co|ashbyhq\.com|myworkdayjobs\.com|smartrecruiters\.com|icims\.com|taleo\.|oraclecloud\.com|bamboohr\.com|teamtailor\.com|gr8people\.com|darwinbox\.in|successfactors\.com|workable\.com|taleo\.cloud|dayforcehcm\.com/i;
    const careerHost =
      /(^|\.)careers\.google\.com$|(^|\.)google\.com$|(^|\.)about\.google\.com$|(^|\.)metacareers\.com$|(^|\.)facebookcareers\.com$|(^|\.)jobs\.careers\.microsoft\.com$|(^|\.)apply\.careers\.microsoft\.com$|(^|\.)careers\.microsoft\.com$|(^|\.)jobs\.nvidia\.com$|(^|\.)openai\.com$|(^|\.)anthropic\.com$|(^|\.)nvidia\.com$|(^|\.)uber\.com$|(^|\.)careers\.doordash\.com$|(^|\.)doordash\.com$|(^|\.)shopify\.com$|(^|\.)atlassian\.com$|(^|\.)github\.com$|(^|\.)github\.careers$|(^|\.)careers\.snap\.com$|(^|\.)snap\.com$|(^|\.)tesla\.com$|(^|\.)blackrock\.com$|(^|\.)janestreet\.com$|(^|\.)citadel\.com$|(^|\.)twosigma\.com$|(^|\.)careers\.twosigma\.com$|(^|\.)mckinsey\.com$|(^|\.)bcg\.com$|(^|\.)bain\.com$|(^|\.)deloitte\.com$|(^|\.)morganstanley\.com$|(^|\.)goldmansachs\.com$|(^|\.)jpmorgan(chase)?\.com$|(^|\.)bloomberg\.com$|(^|\.)salesforce\.com$|(^|\.)stripe\.com$|(^|\.)twilio\.com$|(^|\.)tryprofound\.com$|(^|\.)www\.tryprofound\.com$|(^|\.)lifeatspotify\.com$|(^|\.)spotify\.com$|(^|\.)paypal\.com$|(^|\.)squareup\.com$|(^|\.)dropbox\.com$|(^|\.)media\.net$|(^|\.)netflix\.com$|(^|\.)explore\.jobs\.netflix\.net$/i;
    const out = [];
    const seen = new Set();
    for (const a of document.querySelectorAll('a[href]')) {
      if (out.length >= max) break;
      let href;
      try {
        href = new URL(a.getAttribute('href'), location.href).href;
      } catch {
        continue;
      }
      if (!href.startsWith('http')) continue;
      if (junkHosts.test(href)) continue;
      const u = new URL(href);
      const hn = u.hostname.toLowerCase();
      if (
        /(^|\.)linkedin\.com$|(^|\.)facebook\.com$|(^|\.)twitter\.com$|(^|\.)x\.com$|(^|\.)instagram\.com$|(^|\.)youtube\.com$|(^|\.)tiktok\.com$/i.test(
          hn,
        )
      ) {
        continue;
      }
      const path = u.pathname.replace(/\/+$/, '') || '/';
      const segments = path.split('/').filter(Boolean);
      const hostOk = atsHost.test(u.hostname);
      const onCareerMega = careerHost.test(hn);
      const jobPathToken =
        /(job|opportunity|opening|role|requisition|position|vacanc|listing|apply\/|\/apply|\/teams\/|\/departments\/|\/university|\/programs\/)/i.test(
          path + href,
        );
      const detailPath =
        /\/jobs\/[^/]+/.test(path) ||
        /\/job(?:s)?(?:\/|\?|$)/i.test(path) ||
        /\/search-jobs/i.test(path) ||
        /\/jobsearch/i.test(path) ||
        /\/position(s)?\/[^/]+/.test(path) ||
        /\/opening(s)?\/[^/]+/.test(path) ||
        /\/vacanc(y|ies)\/[^/]+/.test(path) ||
        /\/requisitions?\//i.test(path) ||
        /\/listings?\//i.test(path) ||
        /\/offers?\//i.test(path) ||
        /\/opportunit(y|ies)\//i.test(path) ||
        /\/opportunity\//i.test(path);
      const careersDetail = /\/careers\/.+\/.+/.test(path) && segments.length >= 3;
      const megaPath =
        onCareerMega &&
        (detailPath ||
          careersDetail ||
          /\/careers\/search/i.test(path) ||
          /\/about\/careers/i.test(path) ||
          /\/company\/careers/i.test(path) ||
          (jobPathToken && segments.length >= 2) ||
          segments.length >= 5);
      if (!hostOk && !megaPath) continue;
      if (seen.has(href)) continue;
      let title = (a.innerText || a.textContent || '').replace(/\s+/g, ' ').trim();
      const aria = (a.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
      if ((title.length < 4 || title.length > 280) && aria.length >= 4 && aria.length <= 280) {
        title = aria;
      }
      if (title.length < 4 || title.length > 280) {
        const lastSeg = segments[segments.length - 1] || '';
        const jm = lastSeg.match(/^\d{8,}-(.+)$/i);
        if (jm && jm[1]) {
          title = jm[1]
            .split('-')
            .filter(Boolean)
            .map(w => (w.length ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w))
            .join(' ')
            .trim();
        }
      }
      if (title.length < 4 || title.length > 280) continue;
      if (/^learn more about\s+/i.test(title)) {
        title = title.replace(/^learn more about\s+/i, '').trim();
      }
      const lower = title.toLowerCase();
      if (/^(apply|learn more|read more|see more|view)$/i.test(lower)) continue;
      seen.add(href);
      out.push({ url: href, title });
    }
    return out;
  }, PLAYWRIGHT_MAX_LINKS);
}
