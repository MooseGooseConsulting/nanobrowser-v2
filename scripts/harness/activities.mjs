#!/usr/bin/env node
/**
 * Live activities: realistic multi-step jobs on real shop-like sites, performed by the real
 * agent on the free model pair, scored only from what the run log shows the agent did.
 *
 *   node scripts/harness/activities.mjs list
 *   node scripts/harness/activities.mjs task  --activity <id>            -> {url, prompt, options}
 *   node scripts/harness/activities.mjs live  [--log <file>]             (stdin: nb-run stream)
 *   node scripts/harness/activities.mjs score --activity <id> --runlog <file>
 *        [--artifacts <dir>] [--json <out>] [--history <history.jsonl>]
 *
 * The default tested path is the generic set — browse, filter_sort, site_median,
 * compare_sites — which works on any shop-like site in sites.json. The ebay_* activities
 * are legacy: coupled to eBay URL params and sign-in quirks, they are listed as such and
 * building one takes an explicit `--legacy` on `task`. Scoring a saved legacy run needs no
 * opt-in — old runs keep their verdicts.
 *
 * `live` prints one line per step as events arrive. `score` prints the verdict, the
 * telemetry, and the workflow and token waste the log shows, and compares against the
 * last run of the same activity in --history. Exit status of `score`: 0 pass, 1 fail,
 * 3 invalid (the site, not the agent, made the run meaningless: a bot wall, signed out).
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/* ------------------------------------------------------------------ run-log reading */

export const readJsonl = (text) =>
  text
    .split('\n')
    .filter((l) => l.trim())
    .flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    });

const of = (events, kind) => events.filter((e) => e.kind === kind);
const resultOf = (events, call) =>
  events.find((e) => e.kind === 'tool.result' && e.result?.callId === call.call?.callId)?.result;
const calls = (events, name) => of(events, 'tool.call').filter((c) => !name || c.call?.name === name);
const okCalls = (events, name) => calls(events, name).filter((c) => resultOf(events, c)?.ok === true);

/** Every page the agent was on: the start URL, each observation, each navigate it asked for. */
export function urlsVisited(events) {
  const urls = [];
  for (const e of events) {
    if (e.kind === 'run.started' && e.url) urls.push(e.url);
    if (e.kind === 'observation' && e.url) urls.push(e.url);
    if (e.kind === 'tool.call' && e.call?.name === 'navigate' && e.call.args?.url) {
      if (resultOf(events, e)?.ok) urls.push(String(e.call.args.url));
    }
  }
  return [...new Set(urls)];
}

const parseUrl = (u) => {
  try {
    return new URL(u);
  } catch {
    return null;
  }
};

export function parseSummary(raw) {
  if (raw && typeof raw === 'object') return { ok: true, value: raw };
  if (typeof raw !== 'string') return { ok: false, error: 'no done summary' };
  for (const candidate of [raw, raw.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1], raw.match(/(\[[\s\S]*\]|\{[\s\S]*\})/)?.[1]]) {
    if (!candidate) continue;
    try {
      return { ok: true, value: JSON.parse(candidate) };
    } catch {
      /* try the next shape */
    }
  }
  return { ok: false, error: 'summary is not JSON' };
}

/** "$1,234.50", "1234.5", 1234.5, "US $12.00" -> number; "Free" -> 0; otherwise NaN. */
export function money(v) {
  if (typeof v === 'number') return v;
  const s = String(v ?? '').trim();
  if (/^free/i.test(s)) return 0;
  const m = s.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : NaN;
}

const doneSummary = (events) => calls(events, 'done').at(-1)?.call?.args?.summary;
const ended = (events) => of(events, 'run.ended').at(-1);

const check = (name, ok, detail = '', weight = 1) => ({ name, ok: Boolean(ok), detail: String(detail), weight });

const WRITE_TOOLS = new Set(['click', 'hover', 'type', 'press', 'select', 'download', 'write_userscript']);

/* ------------------------------------------------------------------ activities */

/**
 * Used-hardware queries the browse activity rotates through.
 */
export const QUERIES = [
  'DDR4 32GB 3200 RAM',
  'DDR5 32GB RAM',
  'DDR4 ECC server memory',
  'RTX 3060 graphics card',
  'RX 6700 XT',
  'Ryzen 5 5600X',
  'Intel i7-12700K',
  '1TB NVMe SSD',
  '2TB SATA SSD',
  'ThinkPad T480',
  'Dell OptiPlex 7050',
  'used gaming PC',
];

const hostOf = (u) => (parseUrl(u)?.hostname ?? '').toLowerCase().replace(/^www\./, '');
/** Same site: the host or any subdomain of it (shop.example.com counts for example.com).
 *  Not the other way round: a visit to the bare example.com is not evidence of reaching
 *  the site whose host is shop.example.com. */
const sameSite = (u, host) => {
  const h = hostOf(u);
  return Boolean(h) && (h === host || h.endsWith(`.${host}`));
};
const pageKey = (u) => {
  const p = parseUrl(u);
  return p ? `${p.hostname.replace(/^www\./, '')}${p.pathname.replace(/\/$/, '')}` : String(u);
};
const words = (q) => q.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 2);
/**
 * A results page for the query: most query words in its search params, or in a path that
 * looks like search (/search/ddr4-ram, /s/ddr4). Not a product slug that happens to share
 * the words: /products/32gb-ddr4-3200-rdimm is a listing.
 */
const carriesQuery = (u, query) => {
  const p = parseUrl(u);
  if (!p) return false;
  const norm = (x) => {
    try {
      return decodeURIComponent(x).toLowerCase().replace(/[+_\-]/g, ' ');
    } catch {
      return x.toLowerCase();
    }
  };
  const hits = (s) => {
    const w = words(query);
    return w.length > 0 && w.filter((x) => s.includes(x)).length >= Math.ceil(w.length * 0.6);
  };
  return hits(norm(p.search)) || (SEARCH_PATH.test(p.pathname) && hits(norm(p.pathname)));
};

// /search/ddr4, /s/ddr4, and Kleinanzeigen's /s-ddr4-ecc/k0.
const SEARCH_PATH = /\/(search|s|sch|find|results?|suche|recherche|zoeken|buscar|cerca)(\/|$)|^\/s-[^/]+\/k\d+/i;
// Listing pages across the common shapes: Amazon /dp/, eBay /itm/, Mercari /item/,
// Shopify /products/, Kleinanzeigen /s-anzeige/, forum /threads/.
const PRODUCT_PATH = /\/(dp|gp\/product|itm|item|items|product|products|p|listing|listings|anzeige|s-anzeige|offer|angebot|threads|ad|annonce|lot|lots)\/[^/]+/i;
const productShaped = (u) => PRODUCT_PATH.test(parseUrl(u)?.pathname ?? '');

// Generic bot walls: Cloudflare, DataDome, PerimeterX, Akamai, plain captcha pages.
const WALL = /captcha|cf_chl|challenge-platform|\/challenge|datadome|perimeterx|px-captcha|_incapsula|access.denied|are.you.a.robot|verify.you.are.human/i;

/**
 * The type fallback for "searched with the site's own search": a type call that really
 * typed the query — the result was ok, and the text carried query words. A failed call,
 * or one that typed something else, proves no search happened. (A results URL carrying
 * the query covers itself through the URL check; it does not rehabilitate a failed call.)
 */
const typedQuery = (events, query) =>
  okCalls(events, 'type').some((c) => words(query).some((w) => String(c.call?.args?.text ?? '').toLowerCase().includes(w)));

export function browseInvalid(events, { host }) {
  const ends = ended(events);
  const lastUrl = of(events, 'observation').map((o) => o.url).filter(Boolean).at(-1) ?? '';
  if (WALL.test(lastUrl) || (ends && WALL.test(ends.message ?? ''))) return 'stopped by a bot wall or CAPTCHA';
  // Never got onto the site at all and the failure is the network, not the agent. The
  // requested start URL is not reachability evidence: it is what was asked for, not what
  // was reached — an unreachable site's log shows no observation and no ok navigate.
  const onSite = urlsVisited(events.filter((e) => e.kind !== 'run.started')).some((u) => sameSite(u, host));
  if (!onSite && /net::ERR|ERR_NAME|ERR_CONNECTION|timed out|did not load|404|5\d\d/i.test(ends?.message ?? '')) {
    return `site unreachable: ${String(ends.message).slice(0, 100)}`;
  }
  return null;
}

/**
 * What identifies a listing: an Amazon ASIN, else the longest run of 6+ digits in the
 * path (eBay, Kleinanzeigen, Mercari ids), else host and path. A reported URL with its
 * tracking suffix trimmed (/3317781317 for /3317781317-225-1866) is the same listing;
 * /dp/B07FPH493J reported after visiting /dp/B098XXF99T is not.
 */
export function listingKey(u) {
  const p = parseUrl(u);
  if (!p) return String(u);
  const host = p.hostname.replace(/^www\./, '');
  const asin = p.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i);
  if (asin) return `${host} asin:${asin[1].toUpperCase()}`;
  const ids = p.pathname.match(/\d{6,}/g);
  if (ids) return `${host} id:${[...ids].sort((a, b) => b.length - a.length)[0]}`;
  return pageKey(u);
}

/** Most of the query's distinctive words (model numbers, sizes) appear in the title, as
 *  complete tokens: "Ryzen 5 5600XT" is not a match for "Ryzen 5 5600X". */
export function titleMatches(title, query) {
  const tokens = String(title ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const key = words(query).filter((w) => /\d/.test(w) || w.length >= 4);
  const need = key.length ? key : words(query);
  return need.length > 0 && need.filter((w) => tokens.includes(w)).length >= Math.ceil(need.length * 0.6);
}

export function browseChecks(events, { host, query, url: home }) {
  const urls = urlsVisited(events).filter((u) => sameSite(u, host));
  const homeKey = pageKey(home);
  const searchIdx = urls.findIndex((u) => carriesQuery(u, query));
  const typed = typedQuery(events, query);
  // A listing: a page on the site, reached after the search, that is product-shaped, or
  // else not a results page and not a path already seen as one. Product shape wins over
  // the query check: Amazon's product URLs carry the search keywords in their query string.
  const after = searchIdx >= 0 ? urls.slice(searchIdx + 1) : typed ? urls.slice(1) : [];
  const resultPaths = new Set(urls.filter((u) => !productShaped(u) && carriesQuery(u, query)).map(pageKey));
  const listings = after.filter(
    (u) => pageKey(u) !== homeKey && (productShaped(u) || (!carriesQuery(u, query) && !resultPaths.has(pageKey(u)))),
  );
  const parsed = parseSummary(doneSummary(events));
  const v = parsed.ok && parsed.value && !Array.isArray(parsed.value) ? parsed.value : Array.isArray(parsed.value) ? parsed.value[0] ?? {} : {};
  const reported = typeof v?.url === 'string' ? v.url : '';
  // Ground the report against the listing pages the run detected, not the whole visit
  // history: a results page it stayed on is not a listing it opened.
  const grounded = Boolean(reported) && listings.some((u) => listingKey(u) === listingKey(reported));
  const price = money(v?.price);
  return [
    check('reached the site', urls.length > 0, urls[0] ?? `no page on ${host}`),
    check('searched with the site\'s own search', searchIdx >= 0 || typed, searchIdx >= 0 ? urls[searchIdx] : typed ? 'typed the query (results URL does not carry it)' : 'no results page for the query and nothing typed'),
    check('opened a listing from the results', listings.length > 0, listings[0] ?? 'no page after the results', 2),
    check('reported title, price and url as JSON', Boolean(v?.title && v?.price !== undefined && reported), parsed.ok ? JSON.stringify(v).slice(0, 160) : parsed.error),
    check('the reported listing is a page it actually visited', grounded, reported || 'no url reported', 2),
    check('the price is a number above $0', Number.isFinite(price) && price > 0, String(v?.price ?? '')),
    // Searched "Ryzen 5 5600X", opened a Ryzen 7 5800X: a listing, but not the one asked for.
    check('the listing is for what was searched', titleMatches(v?.title, query), String(v?.title ?? '').slice(0, 100)),
    check('the run ended done', ended(events)?.status === 'done', ended(events)?.status ?? 'no run.ended'),
  ];
}

export function browseTask(site, query) {
  return {
    title: `Browse ${site.name}: ${query}`,
    url: site.url,
    params: { host: hostOf(site.url) || site.host, query, url: site.url, site: site.name },
    maxSteps: 20,
    prompt: [
      `This is ${site.name}. Use the site's own search to look for: ${query}.`,
      'Open one listing from the results and read its title and price.',
      'Call done with only JSON: {"title": "...", "price": "$123.45", "url": "<the listing page url>"}.',
    ].join(' '),
  };
}

/** ebay.co.uk, ebay.de and ebay.com are one operator: rotation counts them as one site. */
export const familyOf = (host) => {
  const parts = String(host).toLowerCase().replace(/^www\./, '').split('.');
  // Drop the public suffix (co.uk, com.au, de, com...) and keep the operator's label.
  const tail = parts.length >= 3 && /^(co|com|org|net|gov|ac)$/.test(parts.at(-2)) ? 2 : 1;
  return parts.at(-1 - tail) ?? parts[0];
};
/** The operators a past run tested: one for most activities, several for compare_sites. */
const familiesOfRun = (h) => {
  if (h.activity?.startsWith('ebay_')) return ['ebay'];
  const hosts = h.params?.hosts ?? (h.params?.host ? [h.params.host] : []);
  return hosts.map(familyOf);
};

/**
 * The next site to browse: an operator never tested before first, then the least
 * recently tested, so a long series spreads across the whole list instead of
 * returning to the same few operators. `offset` picks the Nth best, for a batch.
 */
export function rankSites(sites, history, { filter = () => true } = {}) {
  const lastUsed = new Map();
  history.forEach((h, i) => {
    for (const f of familiesOfRun(h)) lastUsed.set(f, i);
  });
  const usable = sites.filter((s) => !s.loginToBrowse && s.url && filter(s));
  const ranked = usable
    .map((s, i) => {
      const f = familyOf(hostOf(s.url));
      // Never-tested operators first, least recently tested next. Among the never-tested,
      // walled sites (CAPTCHA and bot walls, per sites.json) go last: a fresh history
      // should not start a run on a site that blocks it.
      return { s, f, order: lastUsed.has(f) ? lastUsed.get(f) : -1e6 + i + (s.walled ? 1e5 : 0) };
    })
    .sort((a, b) => a.order - b.order);
  // One site per operator per batch.
  const seen = new Set();
  return ranked.filter(({ f }) => !seen.has(f) && seen.add(f)).map(({ s }) => s);
}

/**
 * What each query is about, in sites.json's `sells` vocabulary, so a query rotation can
 * respect what a site actually carries.
 */
const QUERY_SELLS = new Map([
  ['DDR4 32GB 3200 RAM', 'ram'],
  ['DDR5 32GB RAM', 'ram'],
  ['DDR4 ECC server memory', 'ram'],
  ['RTX 3060 graphics card', 'gpu'],
  ['RX 6700 XT', 'gpu'],
  ['Ryzen 5 5600X', 'cpu'],
  ['Intel i7-12700K', 'cpu'],
  ['1TB NVMe SSD', 'storage'],
  ['2TB SATA SSD', 'storage'],
  ['ThinkPad T480', 'laptops'],
  ['Dell OptiPlex 7050', 'desktops'],
  ['used gaming PC', 'desktops'],
]);

const queryFor = (history, offset, site) => {
  const i = history.filter((h) => h.params?.query).length + offset;
  // Prefer a query whose subject the site's own sells metadata says it carries; a site
  // without that metadata, or one that lists nothing we have a query for, falls back to
  // the whole rotation.
  const sells = site?.sells;
  const compatible = Array.isArray(sells) && sells.length ? QUERIES.filter((q) => sells.includes(QUERY_SELLS.get(q))) : [];
  const pool = compatible.length ? compatible : QUERIES;
  return pool[i % pool.length];
};

export function nextBrowse(sites, history, offset = 0) {
  const ranked = rankSites(sites, history);
  const site = ranked[offset % Math.max(1, ranked.length)];
  return site ? browseTask(site, queryFor(history, offset, site)) : null;
}

export const SITES_FILE = new URL('./sites.json', import.meta.url);

function findSite(sites, host) {
  const h = String(host).replace(/^www\./, '');
  return sites.find((s) => hostOf(s.url) === h) ?? { name: h, url: `https://${h}` };
}

/* ---------------------------------------------- multi-step: filter, median, compare */

// Query parameters that sorting or filtering a results list sets, across common sites.
// eBay's own params (_sop, _udhi, _udlo) are deliberately absent: those belong to the
// legacy ebay_* scorers, and a generic check should not score an eBay param as generic
// filter evidence.
const FILTER_PARAM = /sort|order|price|min|max|cond|filter|facet|refine|^s$|^o$|^f$/i;
const FILTER_PATH = /\/(sort|price|filter|condition|used|refurbished)[-_/]|[-_/](lowest|low-to-high|price-asc|price-low)/i;
const PAGE_PARAM = /^(page|pg|p|_pgn|pagenum|pageno|paged|pagenumber)$/i;

/**
 * Whether a sort or filter shows up in the URL after the results page: a parameter that
 * sorts or filters whose value differs from the results page's, or such a path segment.
 * Sites that filter in the page without touching the URL show nothing here, and the
 * detail says so rather than guessing.
 */
export function filterEvidence(urls, query) {
  const at = urls.findIndex((u) => !productShaped(u) && carriesQuery(u, query));
  if (at < 0) return null;
  const base = parseUrl(urls[at]);
  for (const u of urls.slice(at + 1)) {
    const p = parseUrl(u);
    if (!p || productShaped(u)) continue;
    for (const [k, v] of p.searchParams) {
      if (FILTER_PARAM.test(k) && !PAGE_PARAM.test(k) && base.searchParams.get(k) !== v) return `${k}=${v}`;
    }
    if (p.pathname !== base.pathname && FILTER_PATH.test(p.pathname)) return p.pathname;
  }
  return null;
}

/** Highest results page number the URLs show for the query: 2 means page two was reached. */
export function highestPage(urls, query) {
  let top = 1;
  for (const u of urls) {
    const p = parseUrl(u);
    if (!p || productShaped(u) || !carriesQuery(u, query)) continue;
    for (const [k, v] of p.searchParams) if (PAGE_PARAM.test(k)) top = Math.max(top, Number(v) || 1);
    const inPath = p.pathname.match(/\/(?:page|p|seite)[-/](\d{1,3})(?:\/|$)/i);
    if (inPath) top = Math.max(top, Number(inPath[1]));
  }
  return top;
}

const rowsOf = (events, key) => {
  const parsed = parseSummary(doneSummary(events));
  const v = parsed.ok ? parsed.value : null;
  const rows = Array.isArray(v) ? v : Array.isArray(v?.[key]) ? v[key] : [];
  return { parsed, value: v, rows };
};

/**
 * Sites where sorting and price medians mean something: shops and marketplaces that list
 * priced items, in US dollars. A forum thread list or a bid-only
 * auction would make the test about the site, not the agent.
 */
const SHOP_KINDS = new Set(['marketplace', 'refurbisher', 'retailer-used-section', 'classifieds']);
const isShop = (x) => x.country === 'US' && SHOP_KINDS.has(x.kind);

const siteParams = (site, extra = {}) => ({ host: hostOf(site.url) || site.host, url: site.url, site: site.name, ...extra });

export function filterTask(site, query) {
  return {
    title: `Filter and sort on ${site.name}: ${query}`,
    url: site.url,
    params: siteParams(site, { query }),
    maxSteps: 30,
    prompt: [
      `This is ${site.name}. Use the site's own search to look for: ${query}.`,
      "Then use the site's own controls to sort the results by price, lowest first,",
      'or if it has no sort, filter them to the lowest price range or to used condition. Do not sort the list yourself.',
      'Read the first three results after that.',
      'Call done with only JSON: {"applied": "<which control you used, in words>",',
      '"results": [{"title": "...", "price": "$12.34"}, {...}, {...}]}.',
    ].join(' '),
  };
}

export function filterChecks(events, { host, query, url: home }) {
  const urls = urlsVisited(events).filter((u) => sameSite(u, host));
  const searchIdx = urls.findIndex((u) => carriesQuery(u, query));
  const typed = typedQuery(events, query);
  const evidence = filterEvidence(urls, query);
  const { parsed, value, rows } = rowsOf(events, 'results');
  const prices = rows.map((r) => money(r?.price));
  const ascending = prices.length >= 3 && prices.every(Number.isFinite) && prices.every((p, i) => i === 0 || p >= prices[i - 1]);
  const sorted = /low|asc|cheap|price/i.test(String(value?.applied ?? ''));
  return [
    check('reached the site', urls.length > 0, urls[0] ?? `no page on ${host}`),
    check("searched with the site's own search", searchIdx >= 0 || typed, searchIdx >= 0 ? urls[searchIdx] : typed ? 'typed the query' : 'no results page for the query'),
    check('a sort or filter shows in the URL after the results', Boolean(evidence), evidence ?? 'no sort or filter parameter appeared after the results page', 3),
    check('reported what it applied and three results as JSON', rows.length >= 3 && Boolean(value?.applied) && rows.every((r) => r?.title), parsed.ok ? `${rows.length} row(s); applied: ${String(value?.applied ?? '').slice(0, 60)}` : parsed.error, 2),
    check('the three prices are numbers', prices.length >= 3 && prices.every((p) => Number.isFinite(p) && p > 0), prices.join(', ')),
    check('the prices run lowest first, as a price sort would give', ascending || (!sorted && prices.length >= 3), prices.join(' <= ') || 'no prices', 2),
    check('the results are for what was searched', rows.length >= 3 && rows.filter((r) => titleMatches(r?.title, query)).length >= 2, rows.map((r) => String(r?.title ?? '').slice(0, 40)).join(' | ')),
    check('the run ended done', ended(events)?.status === 'done', ended(events)?.status ?? 'no run.ended'),
  ];
}

export function medianTask(site, query) {
  return {
    title: `Median price on ${site.name}: ${query}`,
    url: site.url,
    params: siteParams(site, { query }),
    maxSteps: 40,
    prompt: [
      `This is ${site.name}. Use the site's own search to look for: ${query}.`,
      'Read the prices of the listings on the first two pages of results (go to the second page with the site\'s own next-page control),',
      'and work out the median price.',
      'Call done with only JSON: {"median": 123.45, "count": <number of prices you used>, "low": <lowest>, "high": <highest>}.',
    ].join(' '),
  };
}

export function medianChecks(events, { host, query }) {
  const urls = urlsVisited(events).filter((u) => sameSite(u, host));
  const searchIdx = urls.findIndex((u) => carriesQuery(u, query));
  const typed = typedQuery(events, query);
  const page = highestPage(urls, query);
  const parsed = parseSummary(doneSummary(events));
  const v = parsed.ok && parsed.value && !Array.isArray(parsed.value) ? parsed.value : {};
  const [median, count, low, high] = ['median', 'count', 'low', 'high'].map((k) => money(v[k]));
  const sane = [median, count, low, high].every(Number.isFinite) && low <= median && median <= high && low > 0;
  return [
    check('reached the site', urls.length > 0, urls[0] ?? `no page on ${host}`),
    check("searched with the site's own search", searchIdx >= 0 || typed, searchIdx >= 0 ? urls[searchIdx] : typed ? 'typed the query' : 'no results page for the query'),
    check('reached the second page of results', page >= 2, page >= 2 ? `page ${page}` : 'no results URL with a page number of 2 or more', 3),
    check('reported median, count, low and high as numbers', [median, count, low, high].every(Number.isFinite), parsed.ok ? JSON.stringify(v).slice(0, 160) : parsed.error),
    check('low <= median <= high, all above 0', sane, `${low} <= ${median} <= ${high}`, 2),
    check('used at least 10 prices', count >= 10, `count=${count}`),
    check('the run ended done', ended(events)?.status === 'done', ended(events)?.status ?? 'no run.ended'),
  ];
}

export function compareTask(sites, query) {
  const [a, b, c] = sites;
  const list = sites.map((s) => `${s.name} (${s.url})`).join(', ');
  return {
    title: `Compare ${sites.map((s) => s.name).join(' / ')}: ${query}`,
    url: a.url,
    params: { hosts: sites.map((s) => hostOf(s.url)), host: hostOf(a.url), query, url: a.url, site: sites.map((s) => s.name).join(' / ') },
    maxSteps: 50,
    prompt: [
      `Find ${query} on three sites: ${list}.`,
      "On each, use the site's own search, open the cheapest listing you can see on the first page of results, and read its title and price.",
      'You start on the first one; go to the others with navigate.',
      'Call done with only JSON: {"offers": [{"site": "<site name>", "title": "...", "price": "$12.34", "url": "<listing page url>"}, {...}, {...}],',
      '"cheapest": "<site name of the lowest price>"}.',
    ].join(' '),
  };
}

export function compareChecks(events, { hosts, query }) {
  const visited = urlsVisited(events);
  const reached = hosts.filter((h) => visited.some((u) => sameSite(u, h)));
  const { parsed, value, rows } = rowsOf(events, 'offers');
  const prices = rows.map((r) => money(r?.price));
  const grounded = rows.filter((r) => r?.url && visited.some((u) => listingKey(u) === listingKey(r.url)));
  const sitesNamed = new Set(rows.map((r) => String(r?.site ?? '').toLowerCase()).filter(Boolean));
  const min = prices.every(Number.isFinite) && prices.length ? Math.min(...prices) : NaN;
  const cheapestRow = rows.find((r) => String(r?.site ?? '').toLowerCase() === String(value?.cheapest ?? '').toLowerCase());
  return [
    check('reached all three sites', reached.length === hosts.length, `${reached.length}/${hosts.length}: ${reached.join(', ')}`, 2),
    check('searched on each site', hosts.every((h) => visited.some((u) => sameSite(u, h) && carriesQuery(u, query))) || calls(events, 'type').length >= hosts.length, `${calls(events, 'type').length} typed search(es)`),
    check('reported three offers from three different sites', rows.length >= 3 && sitesNamed.size >= 3, parsed.ok ? `${rows.length} offer(s), ${sitesNamed.size} site name(s)` : parsed.error, 2),
    check('every reported listing is a page it actually visited', rows.length >= 3 && grounded.length === rows.length, `${grounded.length}/${rows.length} reported urls were visited`, 3),
    check('every price is a number above 0', rows.length >= 3 && prices.every((p) => Number.isFinite(p) && p > 0), prices.join(', ')),
    check('the cheapest it names is the lowest price it reported', Boolean(cheapestRow) && money(cheapestRow.price) === min, `cheapest=${value?.cheapest}; lowest reported=${min}`, 2),
    check('the listings are for what was searched', rows.length >= 3 && rows.filter((r) => titleMatches(r?.title, query)).length >= 2, rows.map((r) => String(r?.title ?? '').slice(0, 36)).join(' | ')),
    check('the run ended done', ended(events)?.status === 'done', ended(events)?.status ?? 'no run.ended'),
  ];
}

/* ---------------------------------------- legacy eBay activities: opt-in via --legacy */

/**
 * Everything eBay-specific lives here, used only by the ebay_* scorers below: the _nkw /
 * LH_BIN / LH_Sold / _udhi URL params, /itm/ item ids, and the sign-in and CAPTCHA walls.
 * The generic checks above must not depend on any of it.
 */

const onEbay = (u) => /(^|\.)ebay\.com$/.test(parseUrl(u)?.hostname ?? '');
const searchUrls = (urls) => urls.filter((u) => onEbay(u) && parseUrl(u)?.searchParams.get('_nkw'));

/** eBay item id from any listing URL shape (/itm/123, /itm/slug/123, ?item=123). */
export function itemId(u) {
  const m = String(u).match(/\/itm\/(?:[^/?#]+\/)?(\d{9,})/) ?? String(u).match(/[?&]item=(\d{9,})/);
  return m ? m[1] : null;
}

/**
 * Signed out, or stopped by a CAPTCHA or bot wall: the site, not the agent, made the run
 * meaningless. Only when the run ended still behind the wall: eBay often shows a
 * challenge that clears itself, and a run that got past it is scored normally.
 */
function invalidReason(events, { needsSignIn = false } = {}) {
  const last = of(events, 'observation').map((o) => o.url).filter(Boolean).at(-1) ?? urlsVisited(events).at(-1) ?? '';
  const wall = /splashui\/(captcha|challenge)|\/captcha/i;
  const signin = /signin\.ebay\.com|[?&]ru=https?%3A%2F%2Fsignin\.ebay\.com/i;
  // A signed-in activity that was ever sent to sign-in cannot be scored on what it read.
  if (needsSignIn && urlsVisited(events).some((u) => signin.test(u))) return 'not signed in to eBay (sent to sign-in)';
  if (wall.test(last)) return 'stopped by an eBay CAPTCHA';
  return null;
}

export const ACTIVITIES = {
  browse: {
    title: 'Open a site, search it, open a listing, report it (any site; rotates)',
    dynamic: true,
    score: (events, ctx) => browseChecks(events, ctx.params),
    invalid: (events, ctx) => browseInvalid(events, ctx.params),
  },

  filter_sort: {
    title: "Search a site, then sort or filter by price with the site's own controls",
    dynamic: true,
    build: ({ sites, history, offset, site, query }) => {
      const pool = rankSites(sites, history, { filter: isShop });
      const s = site ? findSite(sites, site) : pool[offset % Math.max(1, pool.length)];
      return s ? filterTask(s, query ?? queryFor(history, offset, s)) : null;
    },
    score: (events, ctx) => filterChecks(events, ctx.params),
    invalid: (events, ctx) => browseInvalid(events, ctx.params),
  },

  site_median: {
    title: 'Median price across the first two pages of a site\'s results',
    dynamic: true,
    build: ({ sites, history, offset, site, query }) => {
      const pool = rankSites(sites, history, { filter: isShop });
      const s = site ? findSite(sites, site) : pool[offset % Math.max(1, pool.length)];
      return s ? medianTask(s, query ?? queryFor(history, offset, s)) : null;
    },
    score: (events, ctx) => medianChecks(events, ctx.params),
    invalid: (events, ctx) => browseInvalid(events, ctx.params),
  },

  compare_sites: {
    title: 'Find the same part on three sites and say which is cheapest',
    dynamic: true,
    build: ({ sites, history, offset, query }) => {
      // Same currency, sites with a known search URL: a comparison of dollars with euros
      // would be a different test.
      const pool = rankSites(sites, history, { filter: isShop });
      const three = pool.slice(offset * 3, offset * 3 + 3);
      return three.length === 3 ? compareTask(three, query ?? queryFor(history, offset)) : null;
    },
    score: (events, ctx) => compareChecks(events, ctx.params),
    invalid: (events, ctx) => browseInvalid(events, { host: ctx.params.host }),
  },

  ebay_compare: {
    title: 'Search, filter and compare three listings',
    legacy: true,
    url: 'https://www.ebay.com/',
    maxSteps: 40,
    prompt: [
      'On eBay, find a used Canon AE-1 film camera. Only Buy It Now listings, priced at most $250:',
      "use eBay's own filters for both, not just your judgement.",
      'Open three different listings from the results and, for each, read the title, the price,',
      'the shipping cost and the seller.',
      'When you are done, call done with only a JSON array of the three, in this shape:',
      '[{"title": "...", "price": "$199.00", "shipping": "$15.00 or Free", "seller": "...", "url": "https://www.ebay.com/itm/..."}]',
    ].join(' '),
    score(events) {
      const urls = urlsVisited(events);
      const searches = searchUrls(urls);
      const query = searches.map((u) => parseUrl(u).searchParams.get('_nkw').toLowerCase());
      const bin = searches.some((u) => parseUrl(u).searchParams.get('LH_BIN') === '1');
      const priceCap = searches
        .map((u) => money(parseUrl(u).searchParams.get('_udhi')))
        .filter((n) => Number.isFinite(n));
      const visitedItems = new Set(urls.map(itemId).filter(Boolean));
      const parsed = parseSummary(doneSummary(events));
      const rows = parsed.ok && Array.isArray(parsed.value) ? parsed.value : [];
      const rowIds = rows.map((r) => itemId(r?.url ?? ''));
      const grounded = rowIds.filter((id) => id && visitedItems.has(id));
      const prices = rows.map((r) => money(r?.price));
      return [
        check('searched eBay for the AE-1', query.some((q) => /ae-?1/.test(q) && /canon/.test(q)), query.join(' | ') || 'no eBay search URL'),
        check("used eBay's Buy It Now filter", bin, bin ? 'LH_BIN=1' : 'no search URL with LH_BIN=1'),
        check("used eBay's price filter at $250 or less", priceCap.some((n) => n <= 250), priceCap.length ? `_udhi=${priceCap.join(',')}` : 'no _udhi in any search URL'),
        check('opened at least three distinct listings', visitedItems.size >= 3, `${visitedItems.size} listing page(s): ${[...visitedItems].slice(0, 6).join(', ')}`, 2),
        check('reported three listings as JSON', rows.length >= 3 && rows.every((r) => r?.title && r?.seller), parsed.ok ? `${rows.length} row(s)` : parsed.error, 2),
        check('every reported listing is one it actually opened', rows.length >= 3 && grounded.length === rows.length, `${grounded.length}/${rows.length} reported urls were visited`, 3),
        check('every reported price is a number at most $250', rows.length >= 3 && prices.every((p) => Number.isFinite(p) && p <= 250), prices.join(', ')),
        check('the run ended done', ended(events)?.status === 'done', ended(events)?.status ?? 'no run.ended'),
      ];
    },
    invalid: (events) => invalidReason(events),
  },

  ebay_watchlist: {
    title: 'Read my watchlist, signed in, read-only',
    legacy: true,
    url: 'https://www.ebay.com/mye/myebay/watchlist',
    maxSteps: 25,
    options: { readOnly: true },
    prompt: [
      'This is my eBay watchlist. Without changing anything, list every item on it with its current price.',
      'If the list spans more than one page, include them all.',
      'Call done with only a JSON array: [{"title": "...", "price": "$12.34"}], or [] if the watchlist is empty.',
    ].join(' '),
    score(events) {
      const urls = urlsVisited(events);
      const onList = urls.some((u) => /ebay\.com\/(mye\/myebay\/watchlist|myb\/WatchList)/i.test(u));
      const writes = calls(events).filter((c) => WRITE_TOOLS.has(c.call?.name));
      const parsed = parseSummary(doneSummary(events));
      const rows = parsed.ok && Array.isArray(parsed.value) ? parsed.value : null;
      const read = okCalls(events, 'extract_text').length + okCalls(events, 'run_userscript').length + okCalls(events, 'snapshot').length;
      return [
        check('reached the watchlist page while signed in', onList, urls.filter(onEbay).slice(-3).join(' | ')),
        check('changed nothing: no write tool was called', writes.length === 0, writes.map((c) => c.call.name).join(', ') || 'none', 2),
        check('read the page content', read >= 1 || of(events, 'observation').length >= 1, `${read} explicit read(s)`),
        check('reported the watchlist as a JSON array', Array.isArray(rows) && rows.every((r) => r?.title), parsed.ok ? `${rows?.length ?? 'not an array'} item(s)` : parsed.error, 2),
        check('every reported price is a number', Array.isArray(rows) && rows.every((r) => Number.isFinite(money(r?.price))), (rows ?? []).map((r) => r?.price).join(', ')),
        check('the run ended done', ended(events)?.status === 'done', ended(events)?.status ?? 'no run.ended'),
      ];
    },
    invalid: (events) => invalidReason(events, { needsSignIn: true }),
  },

  ebay_csv: {
    title: 'Extract a results page to a CSV file',
    legacy: true,
    url: 'https://www.ebay.com/sch/i.html?_nkw=nikon+f3+camera',
    maxSteps: 30,
    prompt: [
      'Save every listing on this eBay results page to a CSV file named ebay-listings.csv,',
      'with the columns title, price, url (the listing link).',
      'Writing a userscript that extracts the rows is the reliable way; save its output with save_file.',
      'Call done with a one-line summary naming the file and how many rows it has.',
    ].join(' '),
    score(events, { artifactsDir } = {}) {
      const saved = of(events, 'file.saved').filter((f) => /\.csv$/i.test(f.filename));
      const file = saved.at(-1);
      let text = '';
      const candidates = [file?.path, file && artifactsDir ? path.join(artifactsDir, file.filename) : null].filter(Boolean);
      for (const p of candidates) {
        try {
          text = fs.readFileSync(p, 'utf8');
          break;
        } catch {
          /* next */
        }
      }
      const lines = text.split(/\r?\n/).filter((l) => l.trim());
      const header = (lines[0] ?? '').toLowerCase();
      const body = lines.slice(1);
      const withItem = body.filter((l) => itemId(l));
      const ids = new Set(withItem.map(itemId));
      const scripted = okCalls(events, 'run_userscript').length;
      return [
        check('saved a .csv file', Boolean(file), file ? `${file.filename} (${file.bytes} bytes)` : 'no file.saved event for a .csv'),
        check('the file is readable on disk', text.length > 0, candidates.join(' | ') || 'no path'),
        check('the header has title, price and url', /title/.test(header) && /price/.test(header) && /url|link/.test(header), header.slice(0, 120)),
        check('at least 10 listing rows', body.length >= 10, `${body.length} row(s)`, 2),
        check('rows link to distinct eBay listings', ids.size >= Math.min(10, body.length) && ids.size >= 10, `${ids.size} distinct item ids in ${body.length} rows`, 2),
        check('extracted with a userscript that ran ok', scripted >= 1, `${scripted} ok run_userscript call(s)`),
        check('the run ended done', ended(events)?.status === 'done', ended(events)?.status ?? 'no run.ended'),
      ];
    },
    invalid: (events) => invalidReason(events),
  },

  ebay_sold_median: {
    title: 'Median sold price across two pages of sold listings',
    legacy: true,
    url: 'https://www.ebay.com/',
    maxSteps: 40,
    prompt: [
      'What have used Canon AE-1 cameras actually sold for on eBay recently?',
      "Use eBay's Sold Items filter, read the sold prices on the first two pages of results,",
      'and work out the median.',
      'Call done with only JSON: {"median": 123.45, "count": <number of sold prices you used>, "low": <lowest>, "high": <highest>}.',
    ].join(' '),
    score(events) {
      const urls = urlsVisited(events);
      const searches = searchUrls(urls);
      const sold = searches.filter((u) => parseUrl(u).searchParams.get('LH_Sold') === '1');
      const page2 = sold.some((u) => Number(parseUrl(u).searchParams.get('_pgn')) >= 2);
      const parsed = parseSummary(doneSummary(events));
      const v = parsed.ok && parsed.value && !Array.isArray(parsed.value) ? parsed.value : {};
      const [median, count, low, high] = ['median', 'count', 'low', 'high'].map((k) => money(v[k]));
      const sane = [median, count, low, high].every(Number.isFinite) && low <= median && median <= high && low > 0;
      return [
        check("used eBay's Sold Items filter", sold.length >= 1, sold.length ? 'LH_Sold=1' : 'no search URL with LH_Sold=1', 2),
        check('read a second page of sold results', page2, page2 ? '_pgn>=2 with LH_Sold=1' : 'never reached page 2 of sold results', 2),
        check('reported median, count, low and high as numbers', [median, count, low, high].every(Number.isFinite), parsed.ok ? JSON.stringify(v).slice(0, 160) : parsed.error),
        check('low <= median <= high, all above $0', sane, `${low} <= ${median} <= ${high}`, 2),
        check('used at least 20 sold prices', count >= 20, `count=${count}`),
        check('the run ended done', ended(events)?.status === 'done', ended(events)?.status ?? 'no run.ended'),
      ];
    },
    invalid: (events) => invalidReason(events),
  },
};

/* ------------------------------------------------------------------ telemetry and waste */

const argsKey = (c) => `${c.call?.name}(${JSON.stringify(c.call?.args ?? {})})`;

export function telemetry(events) {
  const usage = of(events, 'model.usage');
  const byRole = {};
  for (const u of usage) {
    const r = (byRole[u.role] ??= { models: [], calls: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, promptChars: 0, maxPromptChars: 0, unknownTokens: 0 });
    r.calls += 1;
    if (u.model && !r.models.includes(u.model)) r.models.push(u.model);
    if (typeof u.inputTokens === 'number') r.inputTokens += u.inputTokens;
    else r.unknownTokens += 1;
    r.outputTokens += u.outputTokens ?? 0;
    r.cachedTokens += u.cachedTokens ?? 0;
    r.promptChars += u.promptChars ?? 0;
    r.maxPromptChars = Math.max(r.maxPromptChars, u.promptChars ?? 0);
  }
  for (const r of Object.values(byRole)) r.cacheShare = r.inputTokens ? r.cachedTokens / r.inputTokens : null;

  const toolCalls = calls(events).filter((c) => c.role === 'follower' || c.role === 'leader');
  const errors = toolCalls
    .map((c) => ({ c, r: resultOf(events, c) }))
    .filter(({ r }) => r && r.ok === false)
    .map(({ c, r }) => `${c.call.name}: ${String(r.summary ?? r.error ?? '').slice(0, 120)}`);
  const started = of(events, 'run.started')[0]?.at ?? events[0]?.at;
  const end = ended(events)?.at ?? events.at(-1)?.at;

  // Gaps between consecutive model calls well above a normal round trip: rate limits or retries.
  const stamps = usage.map((u) => u.at).filter(Number.isFinite);
  const stalls = [];
  for (let i = 1; i < stamps.length; i++) if (stamps[i] - stamps[i - 1] > 30_000) stalls.push(Math.round((stamps[i] - stamps[i - 1]) / 1000));

  return {
    status: ended(events)?.status ?? 'unknown',
    message: ended(events)?.message ?? '',
    steps: ended(events)?.steps ?? of(events, 'step').length,
    seconds: started && end ? Math.round((end - started) / 1000) : null,
    modelCalls: usage.length,
    byRole,
    toolCalls: toolCalls.length,
    toolsUsed: Object.entries(toolCalls.reduce((m, c) => ((m[c.call.name] = (m[c.call.name] ?? 0) + 1), m), {}))
      .sort((a, b) => b[1] - a[1])
      .map(([n, k]) => `${n}×${k}`)
      .join(' '),
    toolErrors: errors,
    handoffs: of(events, 'handoff').length,
    replans: of(events, 'leader.plan').filter((p) => p.replan).length,
    observations: of(events, 'observation').length,
    unchangedObservations: of(events, 'observation').filter((o) => o.unchanged).length,
    urls: urlsVisited(events),
    stallsSeconds: stalls,
  };
}

/** Workflow and token waste the log shows, each with the evidence. */
export function waste(events, t = telemetry(events)) {
  const out = [];
  const toolCalls = calls(events);
  // The same call with the same arguments more than once: the agent lost track of what it did.
  const seen = new Map();
  for (const c of toolCalls) seen.set(argsKey(c), (seen.get(argsKey(c)) ?? 0) + 1);
  const repeats = [...seen].filter(([k, n]) => n >= 2 && !k.startsWith('wait('));
  if (repeats.length) out.push(`repeated identical calls: ${repeats.map(([k, n]) => `${k.slice(0, 80)} ×${n}`).join('; ')}`);
  // An explicit snapshot right after an observation the model already received.
  const snaps = calls(events, 'snapshot').length + calls(events, 'leader_snapshot').length;
  if (snaps) out.push(`${snaps} explicit snapshot call(s) on top of the per-step observation`);
  const bigReads = of(events, 'tool.result').filter((r) => (r.result?.chars ?? 0) > 20_000);
  if (bigReads.length) out.push(`${bigReads.length} tool result(s) over 20k chars fed to the model (${bigReads.map((r) => `${r.result.name} ${r.result.chars}`).join(', ')})`);
  const f = t.byRole.follower;
  if (f && f.cacheShare !== null && f.cacheShare < 0.5) out.push(`follower cache share only ${(f.cacheShare * 100).toFixed(0)}% of ${f.inputTokens} input tokens`);
  const l = t.byRole.leader;
  if (l && l.inputTokens > 5_000 && (l.cacheShare ?? 0) === 0) out.push(`leader got no cache hits on ${l.inputTokens} input tokens`);
  if (f && t.toolCalls && f.calls > t.toolCalls * 1.5) out.push(`${f.calls} follower model calls for ${t.toolCalls} tool calls`);
  if (t.modelCalls && t.steps && t.modelCalls / Math.max(1, okCalls(events).length) > 2) {
    out.push(`${t.modelCalls} model calls for ${okCalls(events).length} successful tool calls`);
  }
  if (t.toolErrors.length) out.push(`${t.toolErrors.length} failed tool call(s): ${t.toolErrors.slice(0, 4).join(' | ')}`);
  if (t.stallsSeconds.length) out.push(`${t.stallsSeconds.length} gap(s) over 30 s between model calls (${t.stallsSeconds.join(', ')} s): rate limits or retries`);
  if (t.replans >= 3) out.push(`${t.replans} replans`);
  return out;
}

/** Where a failed run stopped, from the furthest stage the log shows it reached. */
export function stuckAt(events, checks) {
  if (!of(events, 'run.started').length) return 'setup';
  if (!of(events, 'leader.plan').length) return 'planning';
  if (urlsVisited(events).length <= 1 && !okCalls(events).some((c) => c.call.name !== 'set_plan')) return 'navigation';
  if (!calls(events, 'done').length) return 'execution';
  if (checks.some((c) => !c.ok)) return 'verification';
  return null;
}

export function scoreActivity(id, events, ctx = {}) {
  const a = ACTIVITIES[id];
  if (!a) throw new Error(`unknown activity ${id}`);
  const t = telemetry(events);
  // The model provider, not the model, ended the run: no verdict on the pair.
  const providerFailed = ended(events)?.status === 'error' && /\b429\b|rate.?limit|MODEL_RATE_LIMIT/i.test(ended(events)?.message ?? '');
  const invalid = providerFailed ? 'the model provider rate-limited the run (429)' : a.invalid?.(events, ctx) ?? null;
  const checks = a.score(events, ctx);
  const total = checks.reduce((s, c) => s + c.weight, 0);
  const got = checks.filter((c) => c.ok).reduce((s, c) => s + c.weight, 0);
  const passed = !invalid && checks.every((c) => c.ok);
  const parsed = parseSummary(doneSummary(events));
  return {
    activity: id,
    verdict: invalid ? 'invalid' : passed ? 'pass' : 'fail',
    invalid,
    score: total ? got / total : 0,
    checks,
    stuckAt: passed || invalid ? null : stuckAt(events, checks),
    selfReported: t.status === 'done' ? 'done' : t.status,
    summary: parsed.ok ? parsed.value : doneSummary(events) ?? null,
    telemetry: t,
    waste: waste(events, t),
  };
}

/* ------------------------------------------------------------------ printing */

const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n ?? 0));
const pct = (x) => (x === null || x === undefined ? '—' : `${Math.round(x * 100)}%`);
const clock = (at) => new Date(at).toTimeString().slice(0, 8);

export function formatReport(r, previous) {
  const t = r.telemetry;
  const lines = [];
  lines.push(`${r.verdict.toUpperCase()}  ${r.activity}  score ${(r.score * 100).toFixed(0)}%${r.invalid ? `  (${r.invalid})` : ''}${r.stuckAt ? `  stuck at: ${r.stuckAt}` : ''}`);
  for (const c of r.checks) lines.push(`  ${c.ok ? 'ok  ' : 'FAIL'}  ${c.name}${c.detail ? `  -- ${c.detail}` : ''}`);
  lines.push('telemetry');
  lines.push(`  ended ${t.status} after ${t.steps} steps, ${t.seconds ?? '?'} s; ${t.modelCalls} model calls, ${t.toolCalls} tool calls, ${t.handoffs} handoffs, ${t.replans} replans`);
  for (const [role, u] of Object.entries(t.byRole)) {
    lines.push(`  ${role.padEnd(8)} ${u.calls} calls  in ${k(u.inputTokens)} (${pct(u.cacheShare)} cached)  out ${k(u.outputTokens)}  largest prompt ${k(u.maxPromptChars)} chars  [${u.models.join(', ') || 'model unknown'}]${u.unknownTokens ? `  ${u.unknownTokens} call(s) without token counts` : ''}`);
  }
  lines.push(`  tools: ${t.toolsUsed || 'none'}`);
  lines.push(`  observations ${t.observations} (${t.unchangedObservations} unchanged, sent as a note)`);
  lines.push(`  pages: ${t.urls.length} distinct; last ${t.urls.at(-1) ?? '—'}`);
  lines.push(`waste${r.waste.length ? '' : ': none found'}`);
  for (const w of r.waste) lines.push(`  - ${w}`);
  if (previous) {
    const pt = previous.telemetry;
    const d = (a, b) => (a - b > 0 ? `+${a - b}` : String(a - b));
    lines.push(`vs previous run (${previous.at}, ${previous.verdict})`);
    lines.push(`  model calls ${d(t.modelCalls, pt.modelCalls)}, steps ${d(t.steps, pt.steps)}, seconds ${d(t.seconds ?? 0, pt.seconds ?? 0)}, follower cache ${pct(pt.byRole.follower?.cacheShare)} -> ${pct(t.byRole.follower?.cacheShare)}`);
  }
  return lines.join('\n');
}

/** One terminal line per interesting event; state carries the pending call per callId. */
export function liveLine(e, state) {
  switch (e.kind) {
    case 'run.started':
      return `${clock(e.at)}  start     ${e.url}`;
    case 'leader.plan':
      return `${clock(e.at)}  leader    ${e.replan ? 'replan' : 'plan'}: ${String(e.plan).slice(0, 110)}`;
    case 'observation':
      if (e.url && e.url !== state.url) {
        state.url = e.url;
        return `${clock(e.at)}  page      ${e.url.slice(0, 120)}${e.unchanged ? '  (unchanged)' : `  ~${k(e.tokens ?? 0)} tok`}`;
      }
      return null;
    case 'model.usage': {
      const cached = e.inputTokens ? ` (${Math.round(((e.cachedTokens ?? 0) / e.inputTokens) * 100)}% cached)` : '';
      state.lastUsage = `in ${k(e.inputTokens ?? 0)}${cached} out ${k(e.outputTokens ?? 0)}`;
      return null;
    }
    case 'tool.call':
      state.calls[e.call.callId] = { at: e.at, role: e.role, text: `${e.call.name} ${JSON.stringify(e.call.args ?? {}).slice(0, 70)}`, usage: state.lastUsage };
      return null;
    case 'tool.result': {
      const c = state.calls[e.result.callId];
      if (!c) return null;
      const status = e.result.ok ? '' : `  ERR ${String(e.result.summary ?? '').slice(0, 80)}`;
      return `${clock(c.at)}  ${String(c.role).padEnd(8)}  ${c.text.padEnd(80)}  ${c.usage ?? ''}  ${e.result.durationMs ?? '?'}ms${status}`;
    }
    case 'handoff':
      return `${clock(e.at)}  handoff   ${e.from} -> ${e.to}: ${String(e.reason).slice(0, 90)}`;
    case 'run.ended':
      return `${clock(e.at)}  end       ${e.status} after ${e.steps} steps: ${String(e.message).slice(0, 100)}`;
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ scoreboard */

const short = (m) => String(m ?? '?').replace(/^[^/]+\//, '').replace(/:free$/, '');
export const pairOf = (h) => `${short(h.telemetry?.byRole?.leader?.models?.[0])} + ${short(h.telemetry?.byRole?.follower?.models?.[0])}`;

/**
 * Model pair by site, from runs/history.jsonl: which free models actually get the job
 * done, on what, and at what cost. Invalid runs (bot walls, provider 429s) are counted
 * apart and kept out of the pass rate: they say nothing about the model.
 */
export function scoreboard(history, { activity = 'browse' } = {}) {
  const runs = history.filter((h) => h.activity === activity && h.telemetry?.byRole);
  if (!runs.length) return `no ${activity} runs with model telemetry yet`;
  const pairs = new Map();
  for (const h of runs) {
    const p = pairOf(h);
    const s = pairs.get(p) ?? { runs: 0, valid: 0, pass: 0, score: 0, calls: 0, seconds: 0, tokensIn: 0, sites: new Map() };
    s.runs += 1;
    const site = h.params?.hosts?.map((x) => x.replace(/^www\./, '')).join('+') ?? h.params?.host ?? '?';
    const cell = s.sites.get(site) ?? [];
    cell.push(h.verdict === 'pass' ? 'P' : h.verdict === 'invalid' ? 'i' : `${Math.round((h.score ?? 0) * 100)}`);
    s.sites.set(site, cell);
    if (h.verdict === 'invalid') {
      pairs.set(p, s);
      continue;
    }
    s.valid += 1;
    s.pass += h.verdict === 'pass' ? 1 : 0;
    s.score += h.score ?? 0;
    s.calls += h.telemetry.modelCalls ?? 0;
    s.seconds += h.telemetry.seconds ?? 0;
    s.tokensIn += Object.values(h.telemetry.byRole).reduce((n, r) => n + (r.inputTokens ?? 0), 0);
    pairs.set(p, s);
  }
  const lines = [`${activity}: ${runs.length} runs.  cell per run: P pass, i invalid, else score %`, ''];
  lines.push(`${'leader + follower'.padEnd(52)} pass   valid  mean   calls  secs  tokens-in`);
  // Pass rate over valid runs first, then mean score per valid run: a pair that squeaked
  // one high score is not ahead of one that reliably lands mid-range.
  const ranked = [...pairs].sort(
    (a, b) =>
      b[1].pass / Math.max(1, b[1].valid) - a[1].pass / Math.max(1, a[1].valid) ||
      b[1].score / Math.max(1, b[1].valid) - a[1].score / Math.max(1, a[1].valid),
  );
  for (const [p, s] of ranked) {
    const v = Math.max(1, s.valid);
    lines.push(
      `${p.padEnd(52)} ${`${s.pass}/${s.valid}`.padEnd(6)} ${String(s.valid).padEnd(6)} ${`${Math.round((s.score / v) * 100)}%`.padEnd(6)} ${String(Math.round(s.calls / v)).padEnd(6)} ${String(Math.round(s.seconds / v)).padEnd(5)} ${k(Math.round(s.tokensIn / v))}`,
    );
    lines.push(`    ${[...s.sites].map(([site, cell]) => `${site} ${cell.join(',')}`).join('   ')}`);
  }
  return lines.join('\n');
}

/* ------------------------------------------------------------------ CLI */

function flag(argv, name) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main(argv) {
  const cmd = argv[0];
  if (cmd === 'board') {
    // Rescore every saved run from its raw log with the scorer as it is now, so the board
    // never mixes verdicts from older scorer versions.
    const root = flag(argv, 'runs') ?? 'runs';
    const activity = flag(argv, 'activity') ?? 'browse';
    const rows = [];
    for (const dir of fs.readdirSync(root).filter((d) => d.startsWith('activities-')).sort()) {
      for (const f of fs.readdirSync(path.join(root, dir)).filter((f) => f.endsWith('-task.json'))) {
        // A truncated or empty artifact is one bad run, not a board-wide crash: skip it.
        let task;
        try {
          task = JSON.parse(fs.readFileSync(path.join(root, dir, f), 'utf8'));
        } catch {
          continue;
        }
        if (!task || typeof task !== 'object' || Array.isArray(task)) continue;
        const id = task.activity ?? f.replace(/-\d+-task\.json$/, '');
        const runlog = path.join(root, dir, f.replace(/-task\.json$/, '-runlog.jsonl'));
        if (id !== activity || !fs.existsSync(runlog)) continue;
        const r = scoreActivity(id, readJsonl(fs.readFileSync(runlog, 'utf8')), { params: task.params ?? undefined });
        rows.push({ ...r, params: task.params });
      }
    }
    console.log(scoreboard(rows, { activity }));
    return 0;
  }
  if (cmd === 'list') {
    for (const [id, a] of Object.entries(ACTIVITIES)) console.log(`${id.padEnd(18)} ${a.legacy ? '[legacy] ' : ''}${a.title}`);
    return 0;
  }
  if (cmd === 'task') {
    const id = flag(argv, 'activity');
    let a = ACTIVITIES[id];
    if (!a) return console.error(`unknown activity; one of ${Object.keys(ACTIVITIES).join(', ')}`), 2;
    // Legacy eBay activities are opt-in: the everyday path is the generic set on sites.json.
    if (a.legacy && !argv.includes('--legacy')) {
      console.error(`${id} is a legacy eBay activity; pass --legacy to opt in (score --activity still accepts old runs). Default path: ${Object.keys(ACTIVITIES).filter((k) => !ACTIVITIES[k].legacy).join(', ')}`);
      return 2;
    }
    if (a.dynamic) {
      const sites = JSON.parse(fs.readFileSync(SITES_FILE, 'utf8'));
      const historyFile = flag(argv, 'history');
      const history = historyFile && fs.existsSync(historyFile) ? readJsonl(fs.readFileSync(historyFile, 'utf8')) : [];
      const site = flag(argv, 'site');
      const query = flag(argv, 'query');
      const offset = Number(flag(argv, 'offset') ?? 0);
      a = a.build
        ? a.build({ sites, history, offset, site, query })
        : site
          ? browseTask(findSite(sites, site), query ?? QUERIES[0])
          : nextBrowse(sites, history, offset);
      if (!a) return console.error('no usable site in sites.json'), 2;
    }
    // observe=dom pins the panel's stored mode: the free pair is text-only, and a screenshot
    // needs the window focused, which a test running behind other windows cannot promise.
    console.log(JSON.stringify({ activity: id, title: a.title, url: a.url, prompt: a.prompt, params: a.params ?? null, options: { maxSteps: a.maxSteps, observe: 'dom', ...(a.options ?? {}) } }));
    return 0;
  }
  if (cmd === 'live') {
    const state = { calls: {}, url: null, lastUsage: null };
    const log = flag(argv, 'log');
    const sink = log ? fs.createWriteStream(log, { flags: 'a' }) : null;
    let buf = '';
    for await (const chunk of process.stdin) {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const raw = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        sink?.write(raw + '\n');
        const [e] = readJsonl(raw);
        const line = e && liveLine(e, state);
        if (line) console.log(line);
      }
    }
    sink?.end();
    return 0;
  }
  if (cmd === 'score') {
    // Validate everything before reading anything: a wrong invocation exits 2 with the
    // usage, not a stack trace, and never scores against the wrong activity.
    const id = flag(argv, 'activity');
    const a = ACTIVITIES[id];
    const runlog = flag(argv, 'runlog');
    const taskFile = flag(argv, 'task');
    if (!a) return console.error(`unknown activity ${id ?? '<none>'}; one of ${Object.keys(ACTIVITIES).join(', ')}`), 2;
    // Dynamic activities score their checks against the site and query in the task file's
    // params; without them the verdict would be about a run that never happened.
    if (a.dynamic && !taskFile) return console.error(`scoring ${id} needs --task <task.json> (its params carry the site and query)`), 2;
    if (taskFile && !fs.existsSync(taskFile)) return console.error(`no task file at ${taskFile}`), 2;
    if (!runlog) return console.error('score needs --runlog <file>'), 2;
    if (!fs.existsSync(runlog)) return console.error(`no runlog at ${runlog}`), 2;
    const events = readJsonl(fs.readFileSync(runlog, 'utf8'));
    let params;
    if (taskFile) {
      // A truncated or non-JSON task file is a wrong invocation, not a crash: same exit 2.
      try {
        params = JSON.parse(fs.readFileSync(taskFile, 'utf8')).params ?? undefined;
      } catch {
        return console.error(`could not read the task file at ${taskFile}: not JSON`), 2;
      }
    }
    const r = scoreActivity(id, events, { artifactsDir: flag(argv, 'artifacts'), params });
    if (params) r.params = params;
    r.at = new Date().toISOString();
    const historyFile = flag(argv, 'history');
    let previous;
    if (historyFile && fs.existsSync(historyFile)) {
      // A browse run compares against the last run on the same site, not any site.
      previous = readJsonl(fs.readFileSync(historyFile, 'utf8'))
        .filter((h) => h.activity === id && (!params || h.params?.host === params.host))
        .at(-1);
    }
    console.log(formatReport(r, previous));
    const json = flag(argv, 'json');
    if (json) fs.writeFileSync(json, JSON.stringify(r, null, 2));
    if (historyFile) fs.appendFileSync(historyFile, JSON.stringify({ ...r, telemetry: { ...r.telemetry, urls: undefined } }) + '\n');
    return r.verdict === 'pass' ? 0 : r.verdict === 'invalid' ? 3 : 1;
  }
  console.error('usage: activities.mjs list | task --activity <id> | live [--log f] | score --activity <id> --runlog <f> [--artifacts dir] [--json f] [--history f]');
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then((code) => process.exit(code ?? 0));
}
