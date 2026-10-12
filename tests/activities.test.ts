import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// The scorer is a plain Node script so live.sh can run it without a build step.
// @ts-ignore -- untyped .mjs
import { ACTIVITIES, familyOf, filterEvidence, highestPage, listingKey, nextBrowse, scoreboard, titleMatches, scoreActivity, telemetry, waste } from '../scripts/harness/activities.mjs';

type Ev = Record<string, unknown>;

/** A run log in the shape the host streams, built from a compact list of steps. */
function log(startUrl: string, steps: Array<Ev | [string, Record<string, unknown>, boolean?, number?]>, status = 'done'): Ev[] {
  const out: Ev[] = [{ kind: 'run.started', url: startUrl, at: 1000 }, { kind: 'leader.plan', plan: 'p', subgoals: [], at: 1001 }];
  let n = 0;
  for (const s of steps) {
    if (!Array.isArray(s)) {
      out.push({ at: 1002 + n, ...s });
      continue;
    }
    const [name, args, ok = true, chars = 10] = s;
    const callId = `c${n++}`;
    out.push({ kind: 'tool.call', role: 'follower', call: { callId, name, args }, at: 1002 + n });
    out.push({ kind: 'tool.result', role: 'follower', result: { callId, name, ok, summary: ok ? 'ok' : 'boom', chars }, at: 1002 + n });
  }
  out.push({ kind: 'run.ended', status, steps: n, at: 5000 });
  return out;
}

const obs = (url: string, text?: string): Ev => ({ kind: 'observation', mode: 'dom', url, tokens: 100, ...(text ? { text } : {}) });
const failed = (r: { checks: Array<{ ok: boolean; name: string }> }) => r.checks.filter((c) => !c.ok).map((c) => c.name);

describe('generic activities: browse, any shop-like site', () => {
  const params = { host: 'techmikeny.com', query: 'DDR4 32GB 3200 RAM', url: 'https://techmikeny.com', site: 'TechMikeNY' };
  const results = 'https://techmikeny.com/search?q=ddr4+32gb+3200+ram';
  const listing = 'https://techmikeny.com/products/32gb-ddr4-3200-rdimm';

  it('passes a run that searched the site, opened a listing and reported that listing', () => {
    const events = log(params.url, [
      ['type', { ref: 'e4', text: 'DDR4 32GB 3200 RAM' }],
      obs(results),
      ['click', { ref: 'e40' }],
      obs(`${listing}?variant=7`, '32GB DDR4 3200 RDIMM\n$54.00'),
      ['done', { summary: JSON.stringify({ title: '32GB DDR4 3200', price: '$54.00', url: listing }) }],
    ]);
    const r = scoreActivity('browse', events, { params });
    expect(r.checks.filter((c: { ok: boolean }) => !c.ok)).toEqual([]);
    expect(r.verdict).toBe('pass');
  });

  it('fails a price that is a number but never appears in the page text the log kept', () => {
    const events = log(params.url, [
      ['type', { ref: 'e4', text: 'DDR4 32GB 3200 RAM' }],
      obs(results),
      obs(`${listing}?variant=7`, '32GB DDR4 3200 RDIMM\n$54.00'),
      ['done', { summary: JSON.stringify({ title: '32GB DDR4 3200', price: '$1.00', url: listing }) }],
    ]);
    const r = scoreActivity('browse', events, { params });
    expect(failed(r)).toContain('the reported price appears on a page the log kept');
    expect(r.checks.find((c: { name: string }) => c.name.startsWith('the reported price'))?.detail).toMatch(/not in the page text/);
  });

  it('does not pass a price when the log kept no page text to check it against', () => {
    const events = log(params.url, [
      ['type', { ref: 'e4', text: 'DDR4 32GB 3200 RAM' }],
      obs(results),
      obs(`${listing}?variant=7`),
      ['done', { summary: JSON.stringify({ title: '32GB DDR4 3200', price: '$54.00', url: listing }) }],
    ]);
    const price = scoreActivity('browse', events, { params }).checks.find((c: { name: string }) => c.name.startsWith('the reported price'));
    expect(price?.ok).toBe(false);
    expect(price?.detail).toMatch(/no page text/);
  });

  it('shows where a run broke: searched, but never opened a listing and reported one from the results page', () => {
    const events = log(params.url, [obs(results), ['done', { summary: JSON.stringify({ title: 'x', price: '$54', url: listing }) }]]);
    const r = scoreActivity('browse', events, { params });
    const byName = Object.fromEntries(r.checks.map((c: { name: string; ok: boolean }) => [c.name, c.ok]));
    expect(byName).toMatchObject({
      'reached the site': true,
      "searched with the site's own search": true,
      'opened a listing from the results': false,
      'the reported listing is a page it actually visited': false,
    });
  });

  it('counts a product page as a listing even when its URL carries the search keywords', () => {
    const amazon = { host: 'amazon.co.uk', query: 'RX 6700 XT', url: 'https://www.amazon.co.uk/', site: 'Amazon' };
    const product = 'https://www.amazon.co.uk/Sapphire-Radeon-Renewed/dp/B098XXF99T/ref=sr_1_1?crid=2K&keywords=RX+6700+XT';
    const events = log(amazon.url, [
      obs('https://www.amazon.co.uk/s?k=RX+6700+XT&ref=nb_sb_noss_1'),
      obs(product, 'Sapphire Radeon RX 6700 XT (Renewed) £229.99'),
      ['done', { summary: JSON.stringify({ title: 'Sapphire Radeon RX 6700 XT (Renewed)', price: '£229.99', url: product }) }],
    ]);
    expect(scoreActivity('browse', events, { params: amazon }).verdict).toBe('pass');
  });

  it('accepts a reported listing URL with its tracking suffix trimmed, but not a different product', () => {
    const k = 'https://www.kleinanzeigen.de/s-anzeige/2x-64gb-crucial-ddr4/3317781317-225-1866';
    expect(listingKey('https://www.kleinanzeigen.de/s-anzeige/2x-64gb-crucial-ddr4/3317781317')).toBe(listingKey(k));
    const visited = 'https://www.amazon.co.uk/Sapphire-Radeon-Renewed/dp/B098XXF99T/ref=sr_1_1?crid=2K';
    expect(listingKey('https://www.amazon.co.uk/dp/B098XXF99T')).toBe(listingKey(visited));
    expect(listingKey('https://www.amazon.co.uk/dp/B07FPH493J')).not.toBe(listingKey(visited));
  });

  it('fails a listing for a different part than the one searched, model numbers as complete tokens', () => {
    expect(titleMatches('AMD Ryzen 7 5800x', 'Ryzen 5 5600X')).toBe(false);
    expect(titleMatches('AMD Ryzen 5 5600X 6-Core Processor', 'Ryzen 5 5600X')).toBe(true);
    // Model numbers and capacities match as complete tokens: 5600XT is not 5600X.
    expect(titleMatches('AMD Ryzen 5 5600XT', 'Ryzen 5 5600X')).toBe(false);
    expect(titleMatches('2TB SATA SSD', '1TB NVMe SSD')).toBe(false);
    expect(titleMatches('Crucial 32GB DDR4-3200 UDIMM', 'DDR4 32GB 3200 RAM')).toBe(true);
  });

  it('marks a run invalid, not failed, when the model provider rate-limited it to death', () => {
    const events = log(params.url, [obs(params.url)], 'error');
    (events.at(-1) as Record<string, unknown>).message = '429 Provider returned error';
    expect(scoreActivity('browse', events, { params })).toMatchObject({ verdict: 'invalid', invalid: 'the model provider rate-limited the run (429)' });
  });

  it('marks a run invalid when the site never came up: the requested start URL is not reachability evidence', () => {
    const events = log(params.url, [], 'error');
    (events.at(-1) as Record<string, unknown>).message = 'net::ERR_NAME_NOT_RESOLVED at https://techmikeny.com';
    const r = scoreActivity('browse', events, { params });
    expect(r.verdict).toBe('invalid');
    expect(r.invalid).toMatch(/^site unreachable: net::ERR_NAME_NOT_RESOLVED/);
    // A page that really loaded (an observation, not just the request) keeps the run valid.
    const reached = log(params.url, [obs(params.url)], 'error');
    (reached.at(-1) as Record<string, unknown>).message = 'net::ERR_CONNECTION_RESET mid-run';
    expect(scoreActivity('browse', reached, { params }).invalid).toBeNull();
  });

  it('counts the type fallback only for calls that carried the query and landed', () => {
    const done = { summary: JSON.stringify({ title: '32GB DDR4 3200', price: '$54.00', url: listing }) };
    const byName = (events: Ev[]) =>
      Object.fromEntries(scoreActivity('browse', events, { params }).checks.map((c: { name: string; ok: boolean }) => [c.name, c.ok]));
    // A type call whose result failed, with no results page after it, proves no search happened.
    const lost = log(params.url, [['type', { ref: 'e4', text: 'DDR4 32GB 3200 RAM' }, false], ['done', done]]);
    expect(byName(lost)["searched with the site's own search"]).toBe(false);
    // A successful type call that never carried the query does not count either.
    const otherWords = log(params.url, [['type', { ref: 'e4', text: 'used laptops' }], obs('https://techmikeny.com/collections/laptops'), ['done', done]]);
    expect(byName(otherWords)["searched with the site's own search"]).toBe(false);
    // A failed type plus a results URL for the query still counts: the URL is evidence
    // on its own; a failed call is not rehabilitated by what came after it.
    const byUrl = log(params.url, [['type', { ref: 'e4', text: 'DDR4 32GB 3200 RAM' }, false], obs(results), ['done', done]]);
    expect(byName(byUrl)["searched with the site's own search"]).toBe(true);
  });

  it('grounds the reported listing against the listing pages it detected, not the whole visit history', () => {
    // Reporting the results page it stayed on is not reporting a listing it opened.
    const events = log(params.url, [
      ['type', { ref: 'e4', text: 'DDR4 32GB 3200 RAM' }],
      obs(results),
      ['click', { ref: 'e40' }],
      obs(`${listing}?variant=7`),
      ['done', { summary: JSON.stringify({ title: '32GB DDR4 3200', price: '$54.00', url: results }) }],
    ]);
    expect(failed(scoreActivity('browse', events, { params }))).toContain('the reported listing is a page it actually visited');
  });

  it('marks a run invalid when it ended on a Cloudflare challenge', () => {
    const events = log(params.url, [obs('https://techmikeny.com/cdn-cgi/challenge-platform/h/b/orchestrate')], 'blocked');
    expect(scoreActivity('browse', events, { params }).invalid).toBe('stopped by a bot wall or CAPTCHA');
  });

  it('carries no eBay-coupled assumptions: eBay params are not generic filter evidence', () => {
    // _udhi/_udlo/_sop are eBay's params; the generic check only scores common ones.
    expect(filterEvidence([results, `${results}&_udhi=250`], params.query)).toBeNull();
    expect(filterEvidence([results, `${results}&_sop=price`], params.query)).toBeNull();
    expect(filterEvidence([results, `${results}&sort=price_asc`], params.query)).toBe('sort=price_asc');
  });

  it('a page on the bare parent domain is not the site: only the host and its own subdomains are', () => {
    const forum = { host: 'forums.shop.example', query: 'DDR4 32GB 3200 RAM', url: 'https://forums.shop.example/', site: 'Forum shop' };
    // Before the reverse-suffix match was removed, a visit to shop.example counted as
    // reaching forums.shop.example; the other way round it is a different site.
    const events = log(forum.url, [obs('https://shop.example/search?q=ddr4+32gb+3200+ram'), ['done', { summary: '{}' }]]);
    const byName = Object.fromEntries(scoreActivity('browse', events, { params: forum }).checks.map((c: { name: string; ok: boolean }) => [c.name, c.ok]));
    expect(byName["searched with the site's own search"]).toBe(false);
    // A subdomain of the host still counts: www.forums.shop.example is the same site.
  });
});

describe('generic activities: multi-step, filter_sort / site_median / compare_sites', () => {
  const query = 'DDR4 32GB 3200 RAM';
  const results = 'https://shop.test/search?q=ddr4+32gb+3200+ram';
  const ok = (price: string) => ({ title: `Crucial 32GB DDR4 3200 RAM kit ${price}`, price });

  describe('filter_sort', () => {
    const params = { host: 'shop.test', url: 'https://shop.test/', query, site: 'Shop' };

    it('passes when the sort shows in the URL and the three prices run lowest first', () => {
      const events = log(params.url, [
        obs(results),
        obs(`${results}&sort=price_asc`),
        ['done', { summary: JSON.stringify({ applied: 'sort by price, low to high', results: [ok('$20.00'), ok('$25.50'), ok('$31.00')] }) }],
      ]);
      expect(scoreActivity('filter_sort', events, { params }).verdict).toBe('pass');
    });

    it('fails an agent that sorted the list itself: no sort in the URL and prices not ascending', () => {
      const events = log(params.url, [
        obs(results),
        ['done', { summary: JSON.stringify({ applied: 'sorted by price low to high', results: [ok('$40.00'), ok('$25.50'), ok('$31.00')] }) }],
      ]);
      const r = scoreActivity('filter_sort', events, { params });
      expect(r.verdict).toBe('fail');
      expect(failed(r)).toEqual([
        'a sort or filter shows in the URL after the results',
        'the prices run lowest first, as a price sort would give',
      ]);
    });

    it('finds a filter in the path as well as in the query string', () => {
      expect(filterEvidence([results, 'https://shop.test/search/price-low-to-high?q=ddr4+32gb+3200+ram'], query)).toBe('/search/price-low-to-high');
      expect(filterEvidence([results, `${results}&page=2`], query)).toBeNull();
    });
  });

  describe('site_median', () => {
    const params = { host: 'shop.test', url: 'https://shop.test/', query, site: 'Shop' };

    it('passes with a page-two results URL and a consistent median', () => {
      const events = log(params.url, [
        obs(results),
        obs(`${results}&page=2`),
        ['done', { summary: '{"median": 42.5, "count": 24, "low": 9.99, "high": 120}' }],
      ]);
      expect(scoreActivity('site_median', events, { params }).verdict).toBe('pass');
      expect(highestPage([results, `${results}&_pgn=3`], query)).toBe(3);
    });

    it('fails a median reported after reading one page', () => {
      const events = log(params.url, [obs(results), ['done', { summary: '{"median": 42.5, "count": 12, "low": 9.99, "high": 120}' }]]);
      expect(failed(scoreActivity('site_median', events, { params }))).toEqual(['reached the second page of results']);
    });
  });

  describe('compare_sites', () => {
    const hosts = ['a-parts.com', 'b-surplus.com', 'c-shop.com'];
    const params = { hosts, host: hosts[0], url: 'https://a-parts.com/', query, site: 'A / B / C' };
    const listing = (h: string, id: number) => `https://${h}/products/ddr4-32gb-${id}`;
    const visit = hosts.flatMap((h, i) => [obs(`https://${h}/search?q=ddr4+32gb+3200+ram`), obs(listing(h, 111111 + i))]);
    const offers = (prices: string[], cheapest: string, urls = hosts.map((h, i) => listing(h, 111111 + i))) =>
      JSON.stringify({
        offers: hosts.map((_h, i) => ({ site: ['A', 'B', 'C'][i], title: `32GB DDR4 3200 RAM ${i}`, price: prices[i], url: urls[i] })),
        cheapest,
      });

    it('passes when all three sites were searched, every listing was opened and the cheapest is named right', () => {
      const events = log(params.url, [...visit, ['done', { summary: offers(['$60', '$48', '$55'], 'B') }]]);
      expect(scoreActivity('compare_sites', events, { params }).verdict).toBe('pass');
    });

    it('fails a wrong cheapest and a listing that was never opened', () => {
      const urls = [listing(hosts[0]!, 111111), listing(hosts[1]!, 111112), listing(hosts[2]!, 999999)];
      const events = log(params.url, [...visit, ['done', { summary: offers(['$60', '$48', '$55'], 'A', urls) }]]);
      expect(failed(scoreActivity('compare_sites', events, { params }))).toEqual([
        'every reported listing is a page it actually visited',
        'the cheapest it names is the lowest price it reported',
      ]);
    });

    it('fails a run that never left the first site', () => {
      const events = log(params.url, [visit[0]!, visit[1]!, ['done', { summary: offers(['$60', '$48', '$55'], 'B') }]]);
      expect(failed(scoreActivity('compare_sites', events, { params }))).toContain('reached all three sites');
    });

    it('counts all three operators as tested for the rotation', () => {
      const sites = ['a-parts.com', 'b-surplus.com', 'c-shop.com', 'd-ram.com'].map((h) => ({ name: h, url: `https://${h}`, country: 'US', kind: 'refurbisher' }));
      const history = [{ activity: 'compare_sites', params }];
      expect(nextBrowse(sites, history, 0)!.params.host).toBe('d-ram.com');
    });
  });
});

describe('run telemetry and waste', () => {
  it('reports per-role tokens and cache share, and calls out low cache share and oversized tool results', () => {
    const events = log('https://shop.test/', [
      { kind: 'model.usage', role: 'follower', inputTokens: 30_000, cachedTokens: 3_000, outputTokens: 80, promptChars: 80_000 },
      { kind: 'model.usage', role: 'leader', inputTokens: 6_000, cachedTokens: 0, outputTokens: 200, promptChars: 10_000 },
      ['run_userscript', { scriptId: 'x' }, true, 55_000],
      ['run_userscript', { scriptId: 'x' }, true, 55_000],
    ]);
    const t = telemetry(events);
    expect(t.byRole.follower).toMatchObject({ calls: 1, inputTokens: 30_000, cacheShare: 0.1, maxPromptChars: 80_000 });
    const w = waste(events, t).join('\n');
    expect(w).toContain('follower cache share only 10% of 30000 input tokens');
    expect(w).toContain('leader got no cache hits on 6000 input tokens');
    expect(w).toContain('2 tool result(s) over 20k chars fed to the model');
    expect(w).toContain('repeated identical calls: run_userscript({"scriptId":"x"}) ×2');
  });
});

describe('site rotation', () => {
  it('treats every country domain of one operator as one site', () => {
    expect(['www.ebay.co.uk', 'ebay.de', 'ebay.com', 'shop.ebay.com.au'].map(familyOf)).toEqual(['ebay', 'ebay', 'ebay', 'ebay']);
    expect(familyOf('uk.webuy.com')).toBe('webuy');
  });

  it('rotates to operators not tested recently, one site per operator per batch', () => {
    const sites = [
      { name: 'eBay', url: 'https://www.ebay.com' },
      { name: 'eBay UK', url: 'https://www.ebay.co.uk' },
      { name: 'A', url: 'https://a-parts.com' },
      { name: 'Login only', url: 'https://walled.example', loginToBrowse: true },
      { name: 'B', url: 'https://b-surplus.de' },
    ];
    const history = [{ activity: 'ebay_csv' }, { activity: 'browse', params: { host: 'a-parts.com' } }];
    const picks = [0, 1, 2].map((i) => nextBrowse(sites, history, i).params.host);
    expect(picks).toEqual(['b-surplus.de', 'ebay.com', 'a-parts.com']);
  });

  it('does not start a fresh history on a walled site; the walled ones come last among the never-tested', () => {
    const sites = [
      { name: 'Walled big shop', url: 'https://big-wall.example', walled: true },
      { name: 'Open shop', url: 'https://open-shop.example' },
      { name: 'Open two', url: 'https://open-two.example' },
      { name: 'Walled small', url: 'https://small-wall.example', walled: true },
    ];
    const picks = [0, 1, 2, 3].map((i) => nextBrowse(sites, [], i)?.params.host);
    expect(picks).toEqual(['open-shop.example', 'open-two.example', 'big-wall.example', 'small-wall.example']);
  });

  it('prefers a query the site says it sells, and falls back to the rotation when it lists nothing usable', () => {
    const gpuOnly = [{ name: 'GPU shop', url: 'https://gpu-shop.example', sells: ['gpu'] }];
    expect(nextBrowse(gpuOnly, [], 0)!.prompt).toContain('RTX 3060 graphics card');
    expect(nextBrowse(gpuOnly, [], 1)!.prompt).toContain('RX 6700 XT');
    // No sells metadata at all: the plain rotation is unchanged.
    const bare = [{ name: 'Bare shop', url: 'https://bare.example' }];
    expect(nextBrowse(bare, [], 0)!.prompt).toContain('DDR4 32GB 3200 RAM');
    // Metadata that no query maps to (only 'other') falls back rather than starving.
    const odd = [{ name: 'Odd shop', url: 'https://odd.example', sells: ['other'] }];
    expect(nextBrowse(odd, [], 0)!.prompt).toContain('DDR4 32GB 3200 RAM');
  });

  it('sites.json flags the bot-walled operators, so a fresh rotation starts on an open site', () => {
    const sites = JSON.parse(fs.readFileSync(new URL('../scripts/harness/sites.json', import.meta.url), 'utf8')) as Array<{ host: string; walled?: boolean }>;
    const walledHosts = sites.filter((s) => s.walled).map((s) => s.host);
    // One operator, all domains: flagging one eBay domain would not help, the rotation
    // would pick the first unflagged sibling of the same family.
    expect(walledHosts).toEqual(expect.arrayContaining(['ebay.com', 'ebay.co.uk', 'ebay.de', 'amazon.com', 'walmart.com']));
    expect(nextBrowse(sites, [], 0)!.params.host).not.toMatch(/ebay|amazon\.com|walmart\.com/);
    // The open refurbishers the everyday loop was built for are reachable.
    expect(nextBrowse(sites, [], 0)!.params.host).toBe('techmikeny.com');
  });
});

describe('scoreboard', () => {
  const run = (leader: string, follower: string, host: string, verdict: string, score: number) => ({
    activity: 'browse',
    verdict,
    score,
    params: { host },
    telemetry: { modelCalls: 10, seconds: 60, byRole: { leader: { models: [leader], inputTokens: 1000 }, follower: { models: [follower], inputTokens: 9000 } } },
  });

  it('ranks model pairs by pass rate over valid runs, keeping invalid runs out of it', () => {
    const board = scoreboard([
      run('nvidia/a:free', 'nvidia/b:free', 'mercari.com', 'pass', 1),
      run('nvidia/a:free', 'nvidia/b:free', 'kleinanzeigen.de', 'invalid', 0),
      run('google/g:free', 'google/h:free', 'mercari.com', 'fail', 0.5),
    ]);
    const lines = board.split('\n');
    expect(lines[3]).toMatch(/^a \+ b\s+1\/1\s+1\s+100%/);
    expect(lines[4]).toContain('mercari.com P   kleinanzeigen.de i');
    expect(lines[5]).toMatch(/^g \+ h\s+0\/1\s+1\s+50%/);
  });

  it('breaks pass-rate ties by mean score over valid runs, not the accumulated sum', () => {
    // Both pairs accumulate 0.8 over valid runs: a+b scored it once, g+h spread it over two.
    const board = scoreboard([
      run('google/g:free', 'google/h:free', 'y.com', 'fail', 0.4),
      run('google/g:free', 'google/h:free', 'z.com', 'fail', 0.4),
      run('nvidia/a:free', 'nvidia/b:free', 'x.com', 'fail', 0.8),
    ]);
    const lines = board.split('\n');
    expect(lines[3]).toMatch(/^a \+ b\s+0\/1\s+1\s+80%/);
    expect(lines[5]).toMatch(/^g \+ h\s+0\/2\s+2\s+40%/);
  });
});

describe('legacy eBay scorers (opt-in, eBay-coupled)', () => {
  const SEARCH = 'https://www.ebay.com/sch/i.html?_nkw=canon+ae-1&LH_BIN=1&_udhi=250';
  const ITEMS = ['https://www.ebay.com/itm/111111111111', 'https://www.ebay.com/itm/222222222222', 'https://www.ebay.com/itm/333333333333'];
  const rows = ITEMS.map((url, i) => ({ title: `AE-1 #${i}`, price: '$199.00', shipping: 'Free', seller: 's', url }));

  it('ebay_compare passes a filtered run that reported what it opened, and marks a run still behind a CAPTCHA invalid', () => {
    const events = log('https://www.ebay.com/', [
      ['navigate', { url: SEARCH }],
      ...ITEMS.map((u) => obs(u)),
      ['done', { summary: JSON.stringify(rows) }],
    ]);
    expect(scoreActivity('ebay_compare', events).verdict).toBe('pass');

    const cleared = log('https://www.ebay.com/', [obs('https://www.ebay.com/splashui/challenge?ap=1'), obs(SEARCH), ['done', { summary: '[]' }]]);
    expect(scoreActivity('ebay_compare', cleared).invalid).toBeNull();

    const stuck = log('https://www.ebay.com/', [obs(SEARCH), obs('https://www.ebay.com/splashui/captcha?ap=1')], 'blocked');
    expect(scoreActivity('ebay_compare', stuck)).toMatchObject({ verdict: 'invalid', invalid: 'stopped by an eBay CAPTCHA' });
  });

  it('ebay_compare fails reports of listings that were never opened', () => {
    const invented = rows.map((row, i) => ({ ...row, url: `https://www.ebay.com/itm/99999999999${i}` }));
    const events = log('https://www.ebay.com/', [['navigate', { url: SEARCH }], ...ITEMS.map((u) => obs(u)), ['done', { summary: JSON.stringify(invented) }]]);
    const grounded = scoreActivity('ebay_compare', events).checks.find((c: { name: string }) => c.name.startsWith('every reported listing'));
    expect(grounded.ok).toBe(false);
    expect(grounded.detail).toBe('0/3 reported urls were visited');
  });

  it('ebay_watchlist goes invalid when sent to sign-in and fails on any write tool', () => {
    const signedOut = log('https://www.ebay.com/mye/myebay/watchlist', [obs('https://signin.ebay.com/ws/eBayISAPI.dll?SignIn'), ['done', { summary: '[]' }]]);
    expect(scoreActivity('ebay_watchlist', signedOut).invalid).toBe('not signed in to eBay (sent to sign-in)');

    const wrote = log('https://www.ebay.com/mye/myebay/watchlist', [obs('https://www.ebay.com/mye/myebay/watchlist'), ['click', { ref: 'e3' }], ['done', { summary: '[]' }]]);
    const r = scoreActivity('ebay_watchlist', wrote);
    expect(r.verdict).toBe('fail');
    expect(r.checks.find((c: { name: string }) => c.name.startsWith('changed nothing')).detail).toBe('click');
  });

  it('ebay_csv demands the saved file and ebay_sold_median the second page of sold results', () => {
    const claimed = log('https://www.ebay.com/sch/i.html?_nkw=nikon+f3+camera', [['run_userscript', { scriptId: 'x' }], ['done', { summary: 'Saved ebay-listings.csv with 50 rows' }]]);
    expect(scoreActivity('ebay_csv', claimed).checks[0]).toMatchObject({ ok: false, detail: 'no file.saved event for a .csv' });

    const sold = 'https://www.ebay.com/sch/i.html?_nkw=canon+ae-1&LH_Sold=1&LH_Complete=1';
    const onePage = log('https://www.ebay.com/', [['navigate', { url: sold }], ['done', { summary: '{"median": 400, "count": 40, "low": 60, "high": 320}' }]]);
    expect(failed(scoreActivity('ebay_sold_median', onePage))).toEqual(['read a second page of sold results', 'low <= median <= high, all above $0']);
  });
});

describe('legacy opt-in gate', () => {
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const script = path.join(ROOT, 'scripts/harness/activities.mjs');

  it('marks every ebay_* activity legacy and the generic set first-class', () => {
    for (const [id, a] of Object.entries(ACTIVITIES as Record<string, { legacy?: boolean }>)) {
      if (id.startsWith('ebay_')) expect(a.legacy, id).toBe(true);
      else expect(a.legacy, id).toBeUndefined();
    }
  });

  it('list marks legacy activities; task refuses a legacy activity without --legacy', () => {
    const list = execFileSync(process.execPath, [script, 'list'], { cwd: ROOT, encoding: 'utf8' });
    expect(list).toMatch(/^ebay_compare\s+\[legacy\] /m);

    const refused = spawnSync(process.execPath, [script, 'task', '--activity', 'ebay_compare'], { cwd: ROOT, encoding: 'utf8' });
    expect(refused.status).toBe(2);
    expect(refused.stderr).toContain('legacy eBay activity; pass --legacy to opt in');

    const optedIn = JSON.parse(execFileSync(process.execPath, [script, 'task', '--activity', 'ebay_compare', '--legacy'], { cwd: ROOT, encoding: 'utf8' }));
    expect(optedIn).toMatchObject({ activity: 'ebay_compare', url: 'https://www.ebay.com/' });
  });

  it('task builds a generic activity without any flag, and score still rescues old legacy runs without --legacy', () => {
    const browse = JSON.parse(execFileSync(process.execPath, [script, 'task', '--activity', 'browse'], { cwd: ROOT, encoding: 'utf8' }));
    expect(browse).toMatchObject({ activity: 'browse', options: { maxSteps: 20, observe: 'dom' } });

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-'));
    const runlog = path.join(dir, 'runlog.jsonl');
    fs.writeFileSync(runlog, log('https://www.ebay.com/', [['navigate', { url: 'https://www.ebay.com/sch/i.html?_nkw=canon+ae-1' }], ['done', { summary: '[]' }]]).map((e) => JSON.stringify(e)).join('\n'));
    const scored = spawnSync(process.execPath, [script, 'score', '--activity', 'ebay_compare', '--runlog', runlog], { cwd: ROOT, encoding: 'utf8' });
    expect(scored.status).toBe(1); // a fail, not the exit 2 of a gated build
    expect(scored.stdout).toContain('FAIL  ebay_compare');
  });
});

describe('score and board CLIs', () => {
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const script = path.join(ROOT, 'scripts/harness/activities.mjs');
  const run = (cmd: string[]): { status: number | null; stdout: string; stderr: string } => {
    const r = spawnSync(process.execPath, [script, ...cmd], { cwd: ROOT, encoding: 'utf8' });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };

  /** A passing browse run log, as JSONL, for the given task params. */
  const browseRunlog = (p: { url: string; host: string }, resultsUrl: string, listingUrl: string) =>
    log(p.url, [
      ['type', { ref: 'e4', text: 'DDR4 32GB 3200 RAM' }],
      obs(resultsUrl),
      ['click', { ref: 'e40' }],
      obs(listingUrl, '32GB DDR4 3200 RDIMM\n$54.00'),
      ['done', { summary: JSON.stringify({ title: '32GB DDR4 3200', price: '$54.00', url: listingUrl }) }],
    ])
      .map((e) => JSON.stringify(e))
      .join('\n');

  it('validates score arguments before reading anything: exit 2 with usage, not a stack trace', () => {
    // Unknown activity.
    expect(run(['score', '--activity', 'nope', '--runlog', 'x.jsonl'])).toMatchObject({ status: 2 });
    expect(run(['score', '--runlog', 'x.jsonl'])).toMatchObject({ status: 2 });
    // Missing runlog.
    expect(run(['score', '--activity', 'ebay_compare'])).toMatchObject({ status: 2 });
    expect(run(['score', '--activity', 'ebay_compare', '--runlog', 'no/such/file.jsonl'])).toMatchObject({ status: 2 });
    // Missing task file: the same exit 2, not an ENOENT stack trace.
    expect(run(['score', '--activity', 'ebay_compare', '--task', 'no/such-task.json', '--runlog', 'x.jsonl'])).toMatchObject({ status: 2 });
  });

  it('requires --task params for a dynamic activity, and scores fine with them', () => {
    // browse is dynamic: without the task's site and query the verdict is meaningless.
    const refused = run(['score', '--activity', 'browse', '--runlog', 'x.jsonl']);
    expect(refused.status).toBe(2);
    expect(refused.stderr).toContain('needs --task');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'score-cli-'));
    const task = JSON.parse(run(['task', '--activity', 'browse']).stdout) as {
      url: string;
      params: { host: string; url: string };
    };
    const taskFile = path.join(dir, 'task.json');
    fs.writeFileSync(taskFile, JSON.stringify(task));
    const runlog = path.join(dir, 'runlog.jsonl');
    const resultsUrl = `https://${task.params.host}/search?q=ddr4+32gb+3200+ram`;
    const listingUrl = `https://${task.params.host}/products/32gb-ddr4-3200-rdimm`;
    fs.writeFileSync(runlog, browseRunlog(task.params, resultsUrl, listingUrl));
    const scored = run(['score', '--activity', 'browse', '--task', taskFile, '--runlog', runlog]);
    expect(scored.status).toBe(0);
    expect(scored.stdout).toContain('PASS  browse');

    // A task file that exists but is not JSON takes the same exit-2 path.
    const badTask = path.join(dir, 'bad-task.json');
    fs.writeFileSync(badTask, '{ truncated');
    const bad = run(['score', '--activity', 'browse', '--task', badTask, '--runlog', runlog]);
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain('not JSON');
  });

  it('board skips malformed and empty task artifacts instead of crashing, and still scores the readable ones', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-cli-'));
    const broken = path.join(dir, 'activities-broken');
    fs.mkdirSync(broken);
    fs.writeFileSync(path.join(broken, 'browse-1-task.json'), '{ truncated');
    fs.writeFileSync(path.join(broken, 'browse-2-task.json'), '');
    fs.writeFileSync(path.join(broken, 'browse-3-task.json'), 'null');

    // One readable run alongside the broken artifacts.
    const good = path.join(dir, 'activities-good');
    fs.mkdirSync(good);
    const params = { host: 'x.com', query: 'DDR4 32GB 3200 RAM', url: 'https://x.com/', site: 'X' };
    const resultsUrl = 'https://x.com/search?q=ddr4+32gb+3200+ram';
    const listingUrl = 'https://x.com/products/32gb-ddr4-3200-rdimm';
    fs.writeFileSync(path.join(good, 'browse-1-task.json'), JSON.stringify({ activity: 'browse', params }));
    fs.writeFileSync(path.join(good, 'browse-1-runlog.jsonl'), `${browseRunlog(params, resultsUrl, listingUrl)}\n`);

    const board = run(['board', '--runs', dir, '--activity', 'browse']);
    expect(board.status).toBe(0);
    expect(board.stdout).toContain('browse: 1 runs');
    expect(board.stdout).toContain('P');
  });
});
