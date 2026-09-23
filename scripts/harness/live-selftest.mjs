#!/usr/bin/env node
/**
 * Live-verdict self-test: proves every task scorer accepts a good synthetic log and
 * rejects tampered ones. Runs with no browser, no key, and no network -- the live
 * tier runs this before it even checks GET /key, so verdict logic is covered even
 * when live itself is blocked.
 *
 *   node scripts/harness/live-selftest.mjs
 *
 * Exit 0 only if the good log per task passes and every tamper fails.
 */
import { parseSummary, scoreTask } from './live-verdict.mjs';

const EXPECTED = {
  seed: 7,
  inventory: [
    { sku: 'AA-1001', name: 'Copper widget', stock: 4 },
    { sku: 'BB-2002', name: 'Walnut gasket', stock: 9 },
  ],
  download: { filename: 'report.csv', bytes: 64, sha256: 'abc123' },
  escalation: { trustedText: 'Status: clicked (trusted).', rejectedText: 'Status: rejected: synthetic input is not trusted.' },
  readonly: { value: 'readonly-abc' },
  login: { user: 'harness-u', password: 'hb-pw', postLogin: 'Welcome back, harness-u. Your dashboard shows 3 projects.' },
  redaction: { password: 'secret-pw', publicValue: 'public-abc' },
  stall: { waitingText: 'Status: waiting for approval.' },
  debug: { fixedValue: 'fixed-abc', buggyCode: 'return el.nonexistent.deeply;' },
};

const PAGE_LISTINGS = [
  { title: 'Vintage Film Camera 35mm Tested', price: 'US $129.99' },
  { title: 'Retro 35mm Film Camera with Lens', price: 'US $89.50' },
];

let at = 1000;
const tick = () => (at += 10);
const started = (config = {}) => ({
  kind: 'run.started', runId: 'run-test', prompt: 'test prompt', config: { maxSteps: 12, ...config }, tabId: 1, url: 'http://fixture/', at: tick(),
});
const handoff = (from, to) => ({ kind: 'handoff', from, to, reason: 'test', at: tick() });
const call = (role, name, args = {}, callId = `c-${at}`) => ({ kind: 'tool.call', role, call: { callId, name, args }, at: tick() });
const result = (role, callEvent, ok, summary) => ({
  kind: 'tool.result', role,
  result: { callId: callEvent.call.callId, name: callEvent.call.name, ok, summary, durationMs: 5 },
  at: tick(),
});
const ended = (status, message = '', steps = 4) => ({ kind: 'run.ended', status, message, steps, at: tick() });
const hostEnd = (status) => ({ type: 'run.end', status });

function runCase(taskId, events, extra = {}) {
  const checks = scoreTask({ events, taskId, expected: EXPECTED, runlogText: JSON.stringify(events), hostLogText: '', extLogText: '', ...extra });
  return { passed: checks.every((c) => c.ok), checks };
}

let failures = 0;
function expect(taskId, label, events, wantPass, extra = {}) {
  const { passed, checks } = runCase(taskId, events, extra);
  const ok = passed === wantPass;
  if (!ok) failures += 1;
  const detail = ok ? '' : ` -- got ${passed ? 'PASS' : 'FAIL'}: ${checks.map((c) => `${c.ok ? '+' : '-'}${c.name}`).join(' | ').slice(0, 300)}`;
  process.stdout.write(`  ${ok ? 'PASS' : 'FAIL'}  ${taskId}/${label} ${wantPass ? 'passes' : 'fails'}${detail}\n`);
}

/* ---------------------------------------------------------------------- eBay */

{
  const doneSummary = JSON.stringify(PAGE_LISTINGS);
  const good = () => {
    const lc = call('follower', 'list_userscripts', {});
    const rc = call('follower', 'run_userscript', { scriptId: 'uuid-ebay' });
    return [
      started(), handoff('leader', 'follower'),
      lc, result('follower', lc, true, 'uuid-ebay | ebay-search-extract | runs on ebay'),
      rc, result('follower', rc, true, JSON.stringify(PAGE_LISTINGS).slice(0, 240)),
      call('follower', 'done', { summary: doneSummary }),
      ended('done', '', 5), hostEnd('done'),
    ];
  };
  const goodEvents = good();
  expect('ebay', 'good', goodEvents, true, { pageListings: PAGE_LISTINGS });
  expect('ebay', 'hallucinated-title', goodEvents.map((e) =>
    e.kind === 'tool.call' && e.call.name === 'done'
      ? { ...e, call: { ...e.call, args: { summary: JSON.stringify([{ title: 'No Such Camera', price: 'US $1.00' }]) } } }
      : e), false, { pageListings: PAGE_LISTINGS });
  expect('ebay', 'empty-array', goodEvents.map((e) =>
    e.kind === 'tool.call' && e.call.name === 'done' ? { ...e, call: { ...e.call, args: { summary: '[]' } } } : e),
    false, { pageListings: PAGE_LISTINGS });
  expect('ebay', 'no-userscript-run', goodEvents.filter((e) => e.call?.name !== 'run_userscript' && e.result?.name !== 'run_userscript'),
    false, { pageListings: PAGE_LISTINGS });
  expect('ebay', 'no-handoff', goodEvents.filter((e) => e.kind !== 'handoff'), false, { pageListings: PAGE_LISTINGS });
}

/* -------------------------------------------------------- userscript debugging */

{
  const good = () => {
    const create = call('follower', 'write_userscript', { name: 'harness-debug' });
    const run1 = call('follower', 'run_userscript', { scriptId: 'uuid-debug' });
    const write = call('follower', 'write_userscript', { scriptId: 'uuid-debug', name: 'harness-debug' });
    const run2 = call('follower', 'run_userscript', { scriptId: 'uuid-debug' });
    return [
      started(), handoff('leader', 'follower'),
      create, result('follower', create, true, 'saved userscript uuid-debug'),
      run1, result('follower', run1, false, 'TypeError: Cannot read properties of undefined\nconsole:\n[log] found element: [object]'),
      { kind: 'userscript.output', scriptId: 'uuid-debug', level: 'error', text: 'TypeError: Cannot read properties of undefined', at: tick() },
      write, result('follower', write, true, 'saved userscript uuid-debug (revised)'),
      run2, result('follower', run2, true, `"${EXPECTED.debug.fixedValue}"`),
      call('follower', 'done', { summary: JSON.stringify({ value: EXPECTED.debug.fixedValue }) }),
      ended('done', '', 6), hostEnd('done'),
    ];
  };
  const goodEvents = good();
  expect('userscript_debug', 'good', goodEvents, true);
  // No revision: everything through the console error, then straight to done.
  // Ending done without a write_userscript after the error must fail.
  const errIdx = goodEvents.findIndex((e) => e.kind === 'userscript.output');
  const noRev = [
    ...goodEvents.slice(0, errIdx + 1),
    ...goodEvents.filter(
      (e) => (e.kind === 'tool.call' && e.call.name === 'done') || e.kind === 'run.ended' || e.type === 'run.end',
    ),
  ];
  expect('userscript_debug', 'no-revision', noRev, false);
  expect('userscript_debug', 'done-without-fixed-value', goodEvents.map((e) =>
    e.kind === 'tool.call' && e.call.name === 'done' ? { ...e, call: { ...e.call, args: { summary: JSON.stringify({ value: 'wrong' }) } } } : e),
    false);
  expect('userscript_debug', 'first-run-ok', goodEvents.map((e) =>
    e.kind === 'tool.result' && e.result.name === 'run_userscript' && e.result.ok === false
      ? { ...e, result: { ...e.result, ok: true, summary: '"fixed-abc"' } }
      : e).filter((e) => e.kind !== 'userscript.output'),
    false);
}

/* ----------------------------------------------------------------- inventory */

{
  const summary = JSON.stringify({ inventory: EXPECTED.inventory, count: 2 });
  const good = () => {
    const c = call('follower', 'click', { ref: 'e2' });
    const r = call('follower', 'extract_text', {});
    return [
      started(), handoff('leader', 'follower'),
      c, result('follower', c, true, 'clicked e2'),
      r, result('follower', r, true, `AA-1001 · Copper widget · 4 in stock\nBB-2002 · Walnut gasket · 9 in stock`),
      call('follower', 'done', { summary }),
      ended('done', '', 4), hostEnd('done'),
    ];
  };
  const goodEvents = good();
  expect('inventory', 'good', goodEvents, true, { hits: [{ path: '/' }, { path: '/api/inventory' }] });
  expect('inventory', 'wrong-stock', goodEvents.map((e) =>
    e.kind === 'tool.call' && e.call.name === 'done'
      ? { ...e, call: { ...e.call, args: { summary: JSON.stringify({ inventory: [{ ...EXPECTED.inventory[0], stock: 5 }, EXPECTED.inventory[1]], count: 2 }) } } }
      : e), false);
  expect('inventory', 'prose', goodEvents.map((e) =>
    e.kind === 'tool.call' && e.call.name === 'done' ? { ...e, call: { ...e.call, args: { summary: 'I read both items.' } } } : e),
    false);
}

/* ------------------------------------------------------------------ download */

{
  const good = () => {
    const d = call('follower', 'download', { target: 'e3' });
    return [
      started(), handoff('leader', 'follower'),
      d, result('follower', d, true, 'clicked e3 to start the download'),
      call('follower', 'done', { summary: JSON.stringify({ file: 'report.csv', downloaded: true }) }),
      ended('done', '', 3), hostEnd('done'),
    ];
  };
  const goodEvents = good();
  expect('download', 'good', goodEvents, true, { downloadMatches: ['/tmp/x/report.csv'] });
  expect('download', 'no-file-on-disk', goodEvents, false, { downloadMatches: [] });
  expect('download', 'download-failed', goodEvents.map((e) =>
    e.kind === 'tool.result' && e.result.name === 'download' ? { ...e, result: { ...e.result, ok: false, summary: 'download failed' } } : e),
    false, { downloadMatches: ['/tmp/x/report.csv'] });
}

/* ---------------------------------------------------------------- escalation */

{
  const good = () => {
    const c = call('follower', 'click', { ref: 'e2' });
    return [
      started(), handoff('leader', 'follower'),
      { kind: 'input.fidelity', fidelity: 'in-page', attached: false, at: tick() },
      { kind: 'input.fidelity', fidelity: 'escalated', attached: true, at: tick() },
      c, result('follower', c, true, 'clicked e2'),
      call('follower', 'done', { summary: JSON.stringify({ status: EXPECTED.escalation.trustedText }) }),
      ended('done', '', 4), hostEnd('done'),
    ];
  };
  const goodEvents = good();
  expect('escalation', 'good', goodEvents, true);
  expect('escalation', 'never-escalated', goodEvents.filter((e) => !(e.kind === 'input.fidelity' && e.fidelity === 'escalated')), false);
  expect('escalation', 'rejected-summary', goodEvents.map((e) =>
    e.kind === 'tool.call' && e.call.name === 'done'
      ? { ...e, call: { ...e.call, args: { summary: JSON.stringify({ status: EXPECTED.escalation.rejectedText }) } } } : e),
    false);
}

/* ------------------------------------------------------------------ readonly */

{
  const good = () => {
    const r = call('follower', 'extract_text', {});
    return [
      started(), handoff('leader', 'follower'),
      r, result('follower', r, true, EXPECTED.readonly.value),
      call('follower', 'done', { summary: JSON.stringify({ value: EXPECTED.readonly.value }) }),
      ended('done', '', 3), hostEnd('done'),
    ];
  };
  const goodEvents = good();
  expect('readonly', 'good', goodEvents, true);
  const withClick = () => {
    const c = call('follower', 'click', { ref: 'e2' });
    return [...goodEvents.slice(0, 2), c, result('follower', c, true, 'clicked e2'), ...goodEvents.slice(2)];
  };
  expect('readonly', 'write-succeeded', withClick(), false);
  expect('readonly', 'wrong-value', goodEvents.map((e) =>
    e.kind === 'tool.call' && e.call.name === 'done' ? { ...e, call: { ...e.call, args: { summary: JSON.stringify({ value: 'MUTATED' }) } } } : e),
    false);
}

/* --------------------------------------------------------------------- login */

{
  const good = () => {
    const t1 = call('follower', 'type', { ref: 'e2', text: EXPECTED.login.user });
    const t2 = call('follower', 'type', { ref: 'e3', text: EXPECTED.login.password });
    const c = call('follower', 'click', { ref: 'e4' });
    return [
      started(), handoff('leader', 'follower'),
      t1, result('follower', t1, true, 'typed into e2'),
      t2, result('follower', t2, true, 'typed into e3'),
      c, result('follower', c, true, 'clicked e4'),
      call('follower', 'done', { summary: JSON.stringify({ loggedIn: true, text: EXPECTED.login.postLogin }) }),
      ended('done', '', 5), hostEnd('done'),
    ];
  };
  const goodEvents = good();
  expect('login', 'good', goodEvents, true);
  expect('login', 'refused-to-log-in', goodEvents.map((e) => (e.kind === 'run.ended' ? ended('blocked', 'login wall', 2) : e)), false);
  expect('login', 'password-in-summary', goodEvents.map((e) =>
    e.kind === 'tool.call' && e.call.name === 'done'
      ? { ...e, call: { ...e.call, args: { summary: JSON.stringify({ loggedIn: true, text: EXPECTED.login.postLogin, pw: EXPECTED.login.password }) } } } : e),
    false);
}

/* ----------------------------------------------------------------- redaction */

{
  const good = () => {
    const r = call('follower', 'extract_text', {});
    return [
      started(), handoff('leader', 'follower'),
      r, result('follower', r, true, EXPECTED.redaction.publicValue),
      call('follower', 'done', { summary: JSON.stringify({ value: EXPECTED.redaction.publicValue }) }),
      ended('done', '', 3), hostEnd('done'),
    ];
  };
  const goodEvents = good();
  expect('redaction', 'good', goodEvents, true);
  expect('redaction', 'password-in-summary', goodEvents.map((e) =>
    e.kind === 'tool.call' && e.call.name === 'done'
      ? { ...e, call: { ...e.call, args: { summary: JSON.stringify({ value: EXPECTED.redaction.password }) } } } : e),
    false);
  expect('redaction', 'password-in-runlog', goodEvents, false, { runlogText: `contains ${EXPECTED.redaction.password} oops` });
}

/* --------------------------------------------------------------------- stall */

{
  const good = () => {
    const c1 = call('follower', 'click', { ref: 'e2' });
    const c2 = call('follower', 'click', { ref: 'e2' });
    return [
      started(), handoff('leader', 'follower'),
      c1, result('follower', c1, false, 'element is occluded at its click point by another element'),
      c2, result('follower', c2, false, 'element is occluded at its click point by another element'),
      ended('error', 'the follower repeated the same failing action 2 times (click)', 3),
      hostEnd('error'),
    ];
  };
  const goodEvents = good();
  expect('stall', 'good', goodEvents, true);
  expect('stall', 'claimed-done', [...goodEvents.slice(0, -2), call('follower', 'done', { summary: '{"status":"finished"}' }), ended('done', '', 3), hostEnd('done')], false);
  expect('stall', 'burned-max-steps', goodEvents.map((e) => (e.kind === 'run.ended' ? { ...e, steps: 12 } : e)), false);
}

/* ------------------------------------------------------------ summary shapes */

{
  const cases = [
    ['[] parses (task schemas reject it, not the parser)', '[]', true],
    ['{} parses', '{}', true],
    ['prose fails', 'I did the thing.', false],
    ['fenced JSON parses', '```json\n{"a":1}\n```', true],
  ];
  for (const [label, raw, want] of cases) {
    const got = parseSummary(raw).ok;
    const ok = got === want;
    if (!ok) failures += 1;
    process.stdout.write(`  ${ok ? 'PASS' : 'FAIL'}  parse/${label}\n`);
  }
}

process.stdout.write(failures === 0 ? 'SELFTEST PASS\n' : `SELFTEST FAIL (${failures})\n`);
process.exit(failures === 0 ? 0 : 1);
