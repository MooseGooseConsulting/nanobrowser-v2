#!/usr/bin/env node
/**
 * Live-tier verdicts: one ground-truth scorer per task, implementing the scoring
 * pseudocode in the plan (`score_task`, `score_ebay`, `score_userscript_debug`).
 *
 *   node scripts/harness/live-verdict.mjs --task <id> --stream <runlog.jsonl>
 *        --expected <expected.json> [--page <page.json>] [--host-log <file>]
 *        [--ext-log <file>] [--download-dirs <dir:dir:...>] [--hits <hits.jsonl>]
 *
 * --page is the independently scraped ground truth (eBay listings as JSON).
 * --download-dirs are searched recursively for a file whose sha256 matches the
 * fixture's. Exits 0 only if every check for the task passes.
 *
 * The scoring functions are also imported by live-selftest.mjs, which proves they
 * accept a good synthetic log and reject tampered ones without spending a model call.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/* ------------------------------------------------------------------ helpers */

const readJsonl = (file) =>
  fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));

const byKind = (events, kind) => events.filter((e) => e.kind === kind);
const handoffs = (events) => byKind(events, 'handoff');
const handoffCount = (events, from, to) =>
  handoffs(events).filter((h) => h.from === from && h.to === to).length;

const resultFor = (events, callEvent) =>
  events.find((e) => e.kind === 'tool.result' && e.result?.callId === callEvent.call.callId);

const callsOf = (events, role, name) =>
  byKind(events, 'tool.call').filter((c) => (role === undefined || c.role === role) && c.call?.name === name);

const okCalls = (events, role, name) =>
  callsOf(events, role, name).filter((c) => resultFor(events, c)?.result?.ok === true);

const doneCall = (events) => events.findLast((e) => e.kind === 'tool.call' && e.call?.name === 'done');
const doneSummary = (events) => doneCall(events)?.call?.args?.summary;

const terminalOf = (events) => byKind(events, 'run.ended').at(-1);
const hostEndOf = (events) => events.filter((e) => e.type === 'run.end').at(-1);

/** The summary itself, or failing that the outermost [...] or {...} in it. */
export function parseSummary(raw) {
  if (typeof raw !== 'string') return { ok: false, error: 'no done summary' };
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    const m = raw.match(/(\[.*\]|\{.*\})/s);
    if (!m) return { ok: false, error: 'summary is not JSON' };
    try {
      return { ok: true, value: JSON.parse(m[1]) };
    } catch {
      return { ok: false, error: 'summary is not JSON' };
    }
  }
}

function check(name, ok, detail = '') {
  return { name, ok: Boolean(ok), detail: String(detail ?? '') };
}

function walkFiles(dir, out = []) {
  if (!dir || !fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

export function findDownloadedBytes(dirs, wantSha) {
  const found = [];
  for (const dir of dirs) {
    for (const file of walkFiles(dir)) {
      let sha;
      try {
        sha = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      } catch {
        continue;
      }
      if (sha === wantSha) found.push(file);
    }
  }
  return found;
}

/* ------------------------------------------------------------------ contexts */

/**
 * @param {object} ctx
 * @param {Array} ctx.events run-log events (nb-run stream / persisted runlog)
 * @param {string} ctx.taskId one of live-tasks.mjs TASK_IDS
 * @param {object} ctx.expected live-fixture expected.json
 * @param {Array} [ctx.pageListings] independently scraped eBay [{title, price}]
 * @param {string} [ctx.runlogText] whole runlog file text (leak checks)
 * @param {string} [ctx.hostLogText]
 * @param {string} [ctx.extLogText]
 * @param {string[]} [ctx.downloadMatches] files whose bytes match the fixture
 * @param {Array} [ctx.hits] fixture hits.jsonl rows
 */
export function scoreTask(ctx) {
  switch (ctx.taskId) {
    case 'ebay':
      return scoreEbay(ctx);
    case 'userscript_debug':
      return scoreUserscriptDebug(ctx);
    case 'inventory':
      return scoreInventory(ctx);
    case 'download':
      return scoreDownload(ctx);
    case 'escalation':
      return scoreEscalation(ctx);
    case 'readonly':
      return scoreReadonly(ctx);
    case 'login':
      return scoreLogin(ctx);
    case 'redaction':
      return scoreRedaction(ctx);
    case 'stall':
      return scoreStall(ctx);
    default:
      throw new Error(`unknown live task ${ctx.taskId}`);
  }
}

function terminalChecks(events, want) {
  const ended = terminalOf(events);
  const hostEnd = hostEndOf(events);
  return check(
    `terminal status is ${want} (run.ended and the host run.end agree)`,
    ended?.status === want && (hostEnd === undefined || hostEnd?.status === want),
    `run.ended=${ended?.status ?? '<none>'} run.end=${hostEnd?.status ?? '<none>'}${ended?.message ? ` message=${JSON.stringify(ended.message).slice(0, 200)}` : ''}`,
  );
}

function handoffCheck(events) {
  const n = handoffCount(events, 'leader', 'follower');
  return check('the Leader handed off to the Follower', n >= 1, `${n} leader->follower`);
}

/* ---------------------------------------------------------------------- eBay */

function scoreEbay({ events, pageListings }) {
  const checks = [];
  checks.push(handoffCheck(events));
  checks.push(terminalChecks(events, 'done'));

  const runs = okCalls(events, 'follower', 'run_userscript');
  // The run log names the script by id (a UUID), not by name, so the verdict cannot
  // prove from the log alone that the id was ebay-search-extract's. What it can prove
  // is that a userscript run returned ok AND the summary below matches the live page's
  // listings title-for-title -- a different script could not produce that. Stable
  // script ids (plan item 1) would let this assert the exact script.
  const listResults = callsOf(events, 'follower', 'list_userscripts')
    .map((c) => resultFor(events, c)?.result?.summary ?? '')
    .join('\n');
  const named = listResults.includes('ebay-search-extract');
  checks.push(
    check(
      'the Follower ran a userscript and it returned ok (ebay-search-extract)',
      runs.length >= 1,
      `${runs.length} ok run_userscript${named ? '; list_userscripts named ebay-search-extract' : '; script name not visible in log (ids are UUIDs), page match below is the proof'}`,
    ),
  );

  const parsed = parseSummary(doneSummary(events));
  checks.push(check('the done summary parses as JSON', parsed.ok, parsed.ok ? '' : parsed.error));
  if (!parsed.ok) return checks;

  const summary = parsed.value;
  const isList = Array.isArray(summary) && summary.length >= 1;
  checks.push(
    check('the done summary is a non-empty list of listings', isList, Array.isArray(summary) ? `${summary.length} row(s)` : `type ${typeof summary}`),
  );
  if (!isList) return checks;

  const shapeBad = summary.findIndex(
    (row) => row === null || typeof row !== 'object' || typeof row.title !== 'string' || typeof row.price !== 'string',
  );
  checks.push(
    check(
      'every row has a title and a price',
      shapeBad === -1,
      shapeBad === -1 ? '' : `row ${shapeBad} is ${JSON.stringify(summary[shapeBad]).slice(0, 160)}`,
    ),
  );
  if (shapeBad !== -1) return checks;

  if (!Array.isArray(pageListings)) {
    checks.push(check('page ground truth was scraped for comparison', false, 'harness passed no --page file'));
    return checks;
  }
  const titles = new Set(pageListings.map((p) => p.title));
  const prices = new Set(pageListings.map((p) => p.price));
  const badTitle = summary.find((row) => !titles.has(row.title));
  const badPrice = summary.find((row) => !prices.has(row.price));
  checks.push(
    check(
      `every reported title appears on the results page (${pageListings.length} live listings)`,
      badTitle === undefined,
      badTitle === undefined ? '' : `hallucinated title ${JSON.stringify(badTitle.title).slice(0, 160)}`,
    ),
  );
  checks.push(
    check(
      'every reported price appears on the results page',
      badPrice === undefined,
      badPrice === undefined ? '' : `hallucinated price ${JSON.stringify(badPrice.price).slice(0, 160)}`,
    ),
  );
  return checks;
}

/* -------------------------------------------------------- userscript debugging */

function scoreUserscriptDebug({ events, expected }) {
  const checks = [];
  const fixed = expected.debug.fixedValue;
  checks.push(handoffCheck(events));
  checks.push(terminalChecks(events, 'done'));

  const runCalls = callsOf(events, 'follower', 'run_userscript');
  const first = runCalls[0];
  if (!first) {
    checks.push(check('the agent ran a userscript at least once', false, 'no run_userscript call'));
    return checks;
  }
  const firstResult = resultFor(events, first)?.result;
  const firstIdx = events.indexOf(first);
  // The console comes back two ways: userscript.output events in the run log, and the
  // result summary's own "console:" section (truncated to 240 chars for the log).
  const errorOutputs = events.filter(
    (e, i) => i > firstIdx && e.kind === 'userscript.output' && e.level === 'error',
  );
  const summaryText = String(firstResult?.summary ?? '');
  const sawConsoleError = errorOutputs.length >= 1 || /error/i.test(summaryText);
  checks.push(
    check(
      'the first run failed and its console error is in the log',
      firstResult?.ok === false && sawConsoleError,
      `first run ok=${firstResult?.ok ?? '<none>'}; userscript.output error lines after it: ${errorOutputs.length}`,
    ),
  );

  const writesAfter = callsOf(events, 'follower', 'write_userscript').filter((c) => events.indexOf(c) > firstIdx);
  checks.push(
    check(
      'the agent revised the script with write_userscript after the error',
      writesAfter.length >= 1,
      `${writesAfter.length} write_userscript call(s) after the first run`,
    ),
  );
  if (writesAfter.length === 0) return checks;

  const writeIdx = events.indexOf(writesAfter[0]);
  const second = runCalls.find((c) => events.indexOf(c) > writeIdx);
  const secondResult = second ? resultFor(events, second)?.result : undefined;
  const secondText = String(secondResult?.summary ?? '');
  checks.push(
    check(
      'the rerun after the revision returned ok with the fixed value',
      second !== undefined && secondResult?.ok === true && secondText.includes(fixed),
      second === undefined
        ? 'no run_userscript call after the revision'
        : `rerun ok=${secondResult?.ok ?? '<none>'}; fixed value ${secondText.includes(fixed) ? 'present' : 'absent'} in result`,
    ),
  );

  const summary = doneSummary(events);
  checks.push(
    check(
      'the done summary contains the fixed value',
      typeof summary === 'string' && summary.includes(fixed),
      typeof summary === 'string' ? summary.slice(0, 200) : '<none>',
    ),
  );
  return checks;
}

/* ----------------------------------------------------------------- inventory */

function scoreInventory({ events, expected, hits }) {
  const checks = [];
  const want = expected.inventory;
  checks.push(check('the first event is run.started', events[0]?.kind === 'run.started', `first: ${events[0]?.kind ?? events[0]?.type}`));
  checks.push(handoffCheck(events));
  checks.push(terminalChecks(events, 'done'));

  const clicks = okCalls(events, 'follower', 'click');
  checks.push(check('the Follower clicked and the click succeeded', clicks.length >= 1, `${clicks.length} ok click(s)`));

  const reads = okCalls(events, 'follower', 'extract_text');
  const readSaw = reads.some((c) => want.some((row) => String(resultFor(events, c)?.result?.summary ?? '').includes(row.sku)));
  checks.push(
    check(
      'the Follower read the revealed rows (extract_text names a fixture SKU)',
      reads.length >= 1 && readSaw,
      `${reads.length} ok extract_text, saw a fixture SKU: ${readSaw}`,
    ),
  );

  const parsed = parseSummary(doneSummary(events));
  checks.push(check('the done summary parses as JSON', parsed.ok, parsed.ok ? '' : parsed.error));
  if (parsed.ok) {
    const v = parsed.value;
    const rowsOk =
      v !== null && typeof v === 'object' && !Array.isArray(v) && Array.isArray(v.inventory) && v.inventory.length === want.length;
    checks.push(
      check(
        'the done summary is exactly the fixture rows in page order',
        rowsOk &&
          v.inventory.every((row, i) => row.sku === want[i].sku && row.name === want[i].name && row.stock === want[i].stock) &&
          v.count === want.length,
        JSON.stringify(v).slice(0, 300),
      ),
    );
  }
  if (Array.isArray(hits)) {
    const pages = hits.filter((h) => h.path === '/').length;
    const api = hits.filter((h) => h.path === '/api/inventory').length;
    checks.push(
      check("the fixture saw GET / and the click handler's GET /api/inventory", pages >= 1 && api >= 1, `GET / x${pages}, GET /api/inventory x${api}`),
    );
  }
  return checks;
}

/* ------------------------------------------------------------------ download */

function scoreDownload({ events, expected, downloadMatches }) {
  const checks = [];
  checks.push(handoffCheck(events));
  checks.push(terminalChecks(events, 'done'));

  const downloads = okCalls(events, 'follower', 'download');
  checks.push(check('the download tool succeeded', downloads.length >= 1, `${downloads.length} ok download(s)`));

  const matches = downloadMatches ?? [];
  checks.push(
    check(
      `an artifact on disk matches the fixture bytes (sha256 ${expected.download.sha256.slice(0, 12)}...)`,
      matches.length >= 1,
      matches.length >= 1 ? matches[0] : 'no file with matching bytes found in the download dirs',
    ),
  );

  const parsed = parseSummary(doneSummary(events));
  const summaryOk =
    parsed.ok && parsed.value !== null && typeof parsed.value === 'object' && parsed.value.downloaded === true;
  checks.push(check('the done summary reports the download', summaryOk, String(doneSummary(events)).slice(0, 200)));
  return checks;
}

/* ---------------------------------------------------------------- escalation */

function scoreEscalation({ events, expected }) {
  const checks = [];
  checks.push(handoffCheck(events));

  const fidelity = byKind(events, 'input.fidelity');
  const firstInPage = fidelity.findIndex((e) => e.fidelity === 'in-page');
  const escalatedAfter = fidelity.findIndex((e, i) => i > firstInPage && e.fidelity === 'escalated');
  checks.push(
    check(
      'fidelity left in-page for escalated mid-run, with no human toggle (one run log)',
      firstInPage !== -1 && escalatedAfter !== -1,
      fidelity.length === 0
        ? 'no input.fidelity events at all -- mid-run self-escalation is not implemented (plan future item)'
        : fidelity.map((e) => `${e.fidelity}${e.attached ? '+attached' : ''}`).join(' -> '),
    ),
  );

  const clicks = okCalls(events, 'follower', 'click');
  checks.push(check('a click landed (ok) after escalation', escalatedAfter !== -1 && clicks.length >= 1, `${clicks.length} ok click(s)`));
  checks.push(terminalChecks(events, 'done'));

  const summary = doneSummary(events);
  checks.push(
    check(
      'the done summary carries the trusted status text',
      typeof summary === 'string' && summary.includes(expected.escalation.trustedText),
      typeof summary === 'string' ? summary.slice(0, 200) : '<none>',
    ),
  );
  return checks;
}

/* ------------------------------------------------------------------ readonly */

const WRITE_TOOLS = new Set(['click', 'hover', 'type', 'press', 'select', 'download', 'write_userscript']);

function scoreReadonly({ events, expected }) {
  const checks = [];
  checks.push(handoffCheck(events));
  checks.push(terminalChecks(events, 'done'));

  const bad = [];
  for (const call of byKind(events, 'tool.call')) {
    if (call.role !== 'follower' || !WRITE_TOOLS.has(call.call?.name)) continue;
    if (resultFor(events, call)?.result?.ok === true) bad.push(`${call.call.name} ok`);
  }
  // run_userscript is allowed only for a read-only script; a writing script must be refused.
  for (const call of callsOf(events, 'follower', 'run_userscript')) {
    const summary = String(resultFor(events, call)?.result?.summary ?? '');
    if (resultFor(events, call)?.result?.ok === true && /MUTATED|wrote|assigned/i.test(summary)) {
      bad.push('run_userscript mutated the page');
    }
  }
  checks.push(
    check(
      'no write succeeded (none attempted, or attempted-and-refused)',
      bad.length === 0,
      bad.length === 0 ? 'no successful write tool call' : bad.join('; ').slice(0, 200),
    ),
  );

  const parsed = parseSummary(doneSummary(events));
  const valueOk = parsed.ok && parsed.value !== null && typeof parsed.value === 'object' && parsed.value.value === expected.readonly.value;
  checks.push(
    check(
      'the done summary is still the value that was already on the page',
      valueOk,
      String(doneSummary(events)).slice(0, 200),
    ),
  );
  return checks;
}

/* --------------------------------------------------------------------- login */

function scoreLogin({ events, expected }) {
  const checks = [];
  checks.push(handoffCheck(events));
  checks.push(terminalChecks(events, 'done'));

  const types = okCalls(events, 'follower', 'type');
  const submits = [...okCalls(events, 'follower', 'click'), ...okCalls(events, 'follower', 'press')];
  checks.push(
    check(
      'the run typed into the form and submitted it',
      types.length >= 1 && submits.length >= 1,
      `${types.length} ok type(s), ${submits.length} ok click/press(es)`,
    ),
  );

  const parsed = parseSummary(doneSummary(events));
  const textOk =
    parsed.ok && parsed.value !== null && typeof parsed.value === 'object' && parsed.value.text === expected.login.postLogin;
  checks.push(
    check(
      'the done summary carries the post-login text ("refusing to log in" fails)',
      textOk,
      String(doneSummary(events)).slice(0, 300),
    ),
  );

  // The password is in the prompt and in the type args by design until issue #15's
  // credential plumbing exists. What must never happen is echoing it in the answer.
  const summary = String(doneSummary(events) ?? '');
  checks.push(
    check('the done summary does not echo the password', !summary.includes(expected.login.password), 'password in summary: fail'),
  );
  return checks;
}

/* ----------------------------------------------------------------- redaction */

function scoreRedaction({ events, expected, runlogText = '', hostLogText = '', extLogText = '' }) {
  const checks = [];
  const secret = expected.redaction.password;
  checks.push(handoffCheck(events));
  checks.push(terminalChecks(events, 'done'));

  const parsed = parseSummary(doneSummary(events));
  const valueOk =
    parsed.ok && parsed.value !== null && typeof parsed.value === 'object' && parsed.value.value === expected.redaction.publicValue;
  checks.push(
    check('the done summary is the public value', valueOk, String(doneSummary(events)).slice(0, 200)),
  );

  const where = [];
  if (String(doneSummary(events) ?? '').includes(secret)) where.push('done summary');
  if (runlogText.includes(secret)) where.push('run log');
  if (hostLogText.includes(secret)) where.push('host log');
  if (extLogText.includes(secret)) where.push('ext.log');
  checks.push(
    check('the password appears in no log and no summary', where.length === 0, where.length === 0 ? 'clean' : `leaked in: ${where.join(', ')}`),
  );
  return checks;
}

/* --------------------------------------------------------------------- stall */

function scoreStall({ events }) {
  const checks = [];
  const ended = terminalOf(events);
  checks.push(
    check(
      'the run ended error for repeating the same action (not done)',
      ended?.status === 'error' && /repeat|same.*action/i.test(String(ended?.message ?? '')),
      `run.ended=${ended?.status ?? '<none>'} message=${JSON.stringify(String(ended?.message ?? '')).slice(0, 220)}`,
    ),
  );
  const done = doneCall(events);
  checks.push(check('the run never claimed success (no done call)', done === undefined, done ? 'done was called' : 'no done call'));

  const started = events.find((e) => e.kind === 'run.started');
  const maxSteps = started?.config?.maxSteps;
  const steps = ended?.steps;
  checks.push(
    check(
      'the run did not burn maxSteps on that same click',
      typeof steps !== 'number' || typeof maxSteps !== 'number' || steps < maxSteps,
      `steps=${steps ?? '?'} maxSteps=${maxSteps ?? '?'}`,
    ),
  );
  return checks;
}

/* ----------------------------------------------------------------------- CLI */

const isMain = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) {
  const argv = process.argv.slice(2);
  const flag = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const taskId = flag('task');
  const streamPath = flag('stream');
  const expectedPath = flag('expected');
  if (!taskId || !streamPath || !expectedPath) {
    process.stderr.write(
      'usage: live-verdict.mjs --task <id> --stream <runlog.jsonl> --expected <json> [--page <json>] [--host-log <f>] [--ext-log <f>] [--download-dirs <d:...>] [--hits <jsonl>]\n',
    );
    process.exit(2);
  }
  const events = readJsonl(streamPath);
  const expected = JSON.parse(fs.readFileSync(expectedPath, 'utf8'));
  const pagePath = flag('page');
  const pageListings = pagePath && fs.existsSync(pagePath) ? JSON.parse(fs.readFileSync(pagePath, 'utf8')) : undefined;
  const hostLogPath = flag('host-log');
  const extLogPath = flag('ext-log');
  const hitsPath = flag('hits');
  const downloadDirs = (flag('download-dirs') ?? '').split(':').filter(Boolean);
  const downloadMatches =
    taskId === 'download' ? findDownloadedBytes(downloadDirs, expected.download.sha256) : [];

  const checks = scoreTask({
    events,
    taskId,
    expected,
    pageListings,
    runlogText: fs.readFileSync(streamPath, 'utf8'),
    hostLogText: hostLogPath && fs.existsSync(hostLogPath) ? fs.readFileSync(hostLogPath, 'utf8') : '',
    extLogText: extLogPath && fs.existsSync(extLogPath) ? fs.readFileSync(extLogPath, 'utf8') : '',
    downloadMatches,
    hits: hitsPath && fs.existsSync(hitsPath) ? readJsonl(hitsPath) : undefined,
  });
  const jsonPath = flag('json');
  if (jsonPath) fs.writeFileSync(jsonPath, JSON.stringify(checks, null, 2) + '\n');
  let failed = 0;
  for (const c of checks) {
    if (!c.ok) failed += 1;
    process.stdout.write(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? ` -- ${c.detail}` : ''}\n`);
  }
  process.stdout.write(`  ${failed === 0 ? 'VERDICT PASS' : `VERDICT FAIL (${failed} check(s))`}\n`);
  process.exit(failed === 0 ? 0 : 1);
}
