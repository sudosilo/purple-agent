// Purple agent. Plays the orange test bed through the web API, several turns per run.
import fs from 'fs';
import {execSync} from 'child_process';

const LOG = [];
const log = (...a) => { const line = a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' '); LOG.push(new Date().toISOString() + ' ' + line); console.log(line); };
function finish(code) {
  try { if (!fs.existsSync('notes.md')) fs.writeFileSync('notes.md', ''); fs.writeFileSync('run-log.md', LOG.join('\n') + '\n'); execSync('git add run-log.md notes.md'); } catch (e) { console.log('log write failed ' + e.message); }
  process.exit(code);
}

const SITE = 'https://2026-10-18-orange-testbed.vercel.app';
const RAW = 'https://raw.githubusercontent.com/sudosilo/2026-10-18-orange-testbed/main/';
const ID = 'purple';
const KEY = process.env.PURPLE_KEY;
const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.MODEL || 'claude-opus-5-5';
const TURNS = Number(process.env.TURNS || 3);
const ROUNDS = 5;
const NOTES = 'notes.md', FEEDBACK = 'feedback.md';
const C = 79248;

if (!KEY || !API_KEY) { log('Missing PURPLE_KEY or ANTHROPIC_API_KEY secret.'); finish(0); }

const cut = (o, n) => { const s = typeof o === 'string' ? o : JSON.stringify(o); return s.length > n ? s.slice(0, n) + ' ...cut' : s; };
const sleep = ms => new Promise(z => setTimeout(z, ms));
const chunkOf = p => [Math.floor(p[0] / C), Math.floor(p[1] / C)];
const key = c => c[0] + ',' + c[1];

async function getJson(url) { const r = await fetch(url); return r.json(); }

async function play(calls, dryRun) {
  const r = await fetch(SITE + '/api/play', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({id: ID, key: KEY, dryRun, calls})
  });
  return r.json();
}

async function askOnce(system, messages) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {'Content-Type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01'},
    body: JSON.stringify({model: MODEL, max_tokens: 32000, stream: true, system, messages})
  });
  if (!r.ok) throw new Error('Model HTTP ' + r.status + ': ' + cut(await r.text(), 800));
  const reader = r.body.getReader(), dec = new TextDecoder();
  let buf = '', out = '', stop = '';
  for (;;) {
    const {done, value} = await reader.read();
    if (done) break;
    buf += dec.decode(value, {stream: true});
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      let ev; try { ev = JSON.parse(line.slice(5)); } catch { continue; }
      if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') out += ev.delta.text;
      else if (ev.type === 'message_delta' && ev.delta && ev.delta.stop_reason) stop = ev.delta.stop_reason;
      else if (ev.type === 'error') throw new Error('Model stream error: ' + cut(ev.error, 800));
    }
  }
  log('model reply ' + out.length + ' chars, stop ' + stop);
  if (stop === 'max_tokens') out += '\n[REPLY CUT OFF AT THE TOKEN LIMIT]';
  return out;
}

async function ask(system, messages) {
  let last;
  for (let t = 0; t < 4; t++) {
    try { return await askOnce(system, messages); }
    catch (e) { last = e; log('model try ' + t + ' failed: ' + e.message); await sleep(20000 * (t + 1)); }
  }
  throw last;
}

function parse(text) {
  const s = text.indexOf('{'), e = text.lastIndexOf('}');
  const o = JSON.parse(text.slice(s, e + 1));
  if (!Array.isArray(o.calls)) throw new Error('no calls array');
  return o;
}

// Turn plan calls into record shapes so they can be checked together with records already in the world.
function toRecords(calls) {
  const out = [];
  for (const c of calls) {
    const a = (c && c.args) || {};
    if (c.tool === 'place_line') out.push({discipline: a.discipline, kind: 'line', pts: a.pts || [], meta: a.meta || {}, fresh: true});
    else if (c.tool === 'place_symbol') out.push({discipline: a.discipline, kind: 'symbol', type: a.type, at: a.at || [0, 0, 0], meta: a.meta || {}, fresh: true});
    else if (c.tool === 'place_hatch') out.push({discipline: a.discipline, kind: 'hatch', pts: a.pts || [], meta: a.meta || {}, fresh: true});
  }
  return out;
}

const firstPt = r => r.kind === 'symbol' ? r.at : (r.pts && r.pts[0]) || [0, 0, 0];
const SIDES = ['n', 's', 'e', 'w'];
const SIDE_NAME = {n: 'north', s: 'south', e: 'east', w: 'west'};

function streetNamesAlong(records, c, side) {
  const names = new Set();
  const edge = side === 'n' ? (c[1] + 1) * C : side === 's' ? c[1] * C : side === 'e' ? (c[0] + 1) * C : c[0] * C;
  const axis = side === 'n' || side === 's' ? 1 : 0;
  for (const r of records) {
    if (r.discipline !== 'street' || r.kind !== 'line' || !r.pts || !r.meta) continue;
    if (typeof r.meta.street !== 'string') continue;
    if (r.pts.every(p => Math.abs(p[axis] - edge) <= 8000)) names.add(r.meta.street);
  }
  return [...names];
}

function neighborOf(c, side) { return side === 'n' ? [c[0], c[1] + 1] : side === 's' ? [c[0], c[1] - 1] : side === 'e' ? [c[0] + 1, c[1]] : [c[0] - 1, c[1]]; }

// Checks the owner cares about that the server does not catch.
function lint(calls, myChunks, details) {
  const issues = [];
  const removed = new Set(calls.filter(c => c.tool === 'remove').map(c => c.args && c.args.id));
  const claimed = calls.filter(c => c.tool === 'claim_chunk').map(c => c.args.chunk);
  const chunks = [...myChunks, ...claimed];
  const existing = [];
  for (const c of chunks) { const d = details[key(c)]; if (d) for (const r of d.records || []) if (r.agent === ID && !removed.has(r.id)) existing.push(r); }
  const all = existing.concat(toRecords(calls));

  for (const r of all) if (r.fresh && r.discipline === 'street' && !(r.meta && r.meta.street)) { issues.push('A street record has no meta.street. Every street record needs the street name.'); break; }

  const walls = all.filter(r => r.kind === 'line' && r.meta && r.meta.wall && r.meta.building && r.pts && r.pts.length >= 3);
  const byBuilding = {};
  for (const w of walls) (byBuilding[w.meta.building] = byBuilding[w.meta.building] || []).push(w);
  const doors = all.filter(r => r.kind === 'line' && r.meta && Array.isArray(r.meta.checks) && r.meta.checks.some(k => k[0] === 'door_width'));
  const sizes = {};
  for (const [name, ws] of Object.entries(byBuilding)) {
    const xs = ws.flatMap(w => w.pts.map(p => p[0])), ys = ws.flatMap(w => w.pts.map(p => p[1]));
    const b = {x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys)};
    const sz = Math.round((b.x1 - b.x0) / 500) + 'x' + Math.round((b.y1 - b.y0) / 500);
    sizes[sz] = (sizes[sz] || 0) + 1;
    const c = chunkOf(ws[0].pts[0]);
    const gap = {n: (c[1] + 1) * C - b.y1, s: b.y0 - c[1] * C, e: (c[0] + 1) * C - b.x1, w: b.x0 - c[0] * C};
    const minGap = Math.min(...SIDES.map(s => gap[s]));
    const fronts = SIDES.filter(s => gap[s] <= minGap * 1.6);
    const onSide = side => doors.some(d => d.pts.every(p => {
      if (side === 'n') return Math.abs(p[1] - b.y1) <= 300 && p[0] >= b.x0 - 300 && p[0] <= b.x1 + 300;
      if (side === 's') return Math.abs(p[1] - b.y0) <= 300 && p[0] >= b.x0 - 300 && p[0] <= b.x1 + 300;
      if (side === 'e') return Math.abs(p[0] - b.x1) <= 300 && p[1] >= b.y0 - 300 && p[1] <= b.y1 + 300;
      return Math.abs(p[0] - b.x0) <= 300 && p[1] >= b.y0 - 300 && p[1] <= b.y1 + 300;
    }));
    const doorSides = SIDES.filter(onSide);
    if (doorSides.length && !doorSides.some(s => fronts.includes(s)))
      issues.push(`${name} faces the wrong way. Its street front is the ${fronts.map(s => SIDE_NAME[s]).join(' or ')} side, but its door is on the ${doorSides.map(s => SIDE_NAME[s]).join(' and ')} wall, facing the inside of the block. Remove the old door, knob, window and front walk by id and put the front door on the ${SIDE_NAME[fronts[0]]} wall with the walk running from it to that sidewalk.`);
  }
  for (const [sz, n] of Object.entries(sizes)) if (n >= 3) issues.push(`${n} buildings share the same footprint size. Vary sizes, shapes and layouts so blocks do not look cloned.`);

  for (const c of chunks) {
    for (const side of SIDES) {
      const along = side === 'n' || side === 's' ? ['e', 'w'] : ['n', 's'];
      const others = [neighborOf(c, side), ...along.map(a => neighborOf(c, a))].map(k => details[key(k)]).filter(Boolean);
      const theirs = [...new Set(others.flatMap(nb => streetNamesAlong((nb.records || []).filter(r => r.agent !== ID), c, side)))];
      const mine = streetNamesAlong(all, c, side);
      if (theirs.length && !theirs.some(n => mine.includes(n)))
        issues.push(`Chunk [${c}] ${SIDE_NAME[side]} edge is ${theirs.join(' / ')}, already built by a neighbor across or along that edge. Continue it on your edge with that exact name in meta.street, mirroring their lane markings, parking lane edge, curb and sidewalk offsets.`);
      else if (!theirs.length && !mine.length)
        issues.push(`Chunk [${c}] ${SIDE_NAME[side]} edge has no street. Lay a named street there.`);
    }
  }

  const fresh = all.filter(r => r.fresh);
  const walkers = fresh.filter(r => r.kind === 'symbol' && r.type === 'person' && r.meta && r.meta.anim && r.meta.anim.type === 'path');
  if (walkers.length < 4) issues.push(`Only ${walkers.length} walking people with path animation this turn. Add at least 4 people walking along real sidewalks or paths, pose walking, meta.anim path, each with a unique meta.activity.`);
  const seen = new Set(existing.map(r => r.meta && r.meta.activity).filter(Boolean));
  for (const r of fresh) { const a = r.meta && r.meta.activity; if (a && seen.has(a)) { issues.push(`Activity "${a}" repeats an earlier one in that chunk. Every activity sentence must be new.`); } if (a) seen.add(a); }
  return [...new Set(issues)];
}

const SYSTEM = `You are Purple, agent id "purple", display color 3 (#7a4f9a). You play the agent test bed, a shared city that several AI agents build together, one turn at a time.
You are a professional and a good classmate. Build true to life places that connect cleanly to your neighbors. Think about the city at a higher level: housing, places to work, schools, parks, transit and services, and build what it is missing.

QUALITY CHECKLIST. Every item matters to the owner and to the judges.
Streets: every chunk you own has a street on all four edges. Where a neighbor already built the street on a shared edge, reuse its exact name and mirror its street section on your half, the same marking offsets, parking lane edge, curb height and sidewalk offset, each record with meta.street and meta.part. Study the NEIGHBOR STREET RECORDS you are given and copy their format. Only an edge with no neighbor gets a new name. Curb rings carry the list of every street they touch. Add lane_width and sidewalk_width checks. Put a sign at each corner naming both streets.
Fronts: every building faces the street its lot touches. The front door goes on the wall nearest that street, and the front walk runs from that door to that street's sidewalk. Never put a front door on a wall that faces a neighboring lot or the middle of the block. In a block cut into four lots, the two north lots face the north street and the two south lots face the south street.
Life: every turn add at least 4 people walking with meta.anim type path along real sidewalks or paths, pose walking, plus people sitting or working where it makes sense, and some cars driving with path along lanes. Each meta.activity sentence is new and fits the place.
Variety: never clone buildings. Vary footprint size and shape, roof hatch pattern and gradient, door position along the front, and interior layout. Use curved organic lines for garden beds, paths and plazas.
Depth: come back to your buildings each turn and add rooms, interior doors with checks, fixtures, lighting, outlets, and plumbing and electrical services with declared penetrations.
Fixes: when your earlier work is wrong, remove those records by id (ids are in YOUR CHUNKS IN DETAIL) and place corrected ones in the same turn.
Owner feedback in OWNER FEEDBACK outranks everything else. Act on all of it.
Never use real people's names or real business names.

Keep each turn under about 250 calls so your reply fits.
Reply with one JSON object only, no other text and no code fences:
{"calls": [ ...tool calls exactly as the rules describe... ], "notes": "a few sentences for your future self: what you built and fixed, ids and coordinates worth remembering, and what to do next turn"}`;

async function turn(n, rules, feedback) {
  const state = await getJson(SITE + '/api/state');
  const mine = (state.chunks || []).filter(c => c.owner === ID).map(c => c.chunk);
  const want = new Map();
  for (const c of mine) { want.set(key(c), c); for (const s of SIDES) { const nb = neighborOf(c, s); want.set(key(nb), nb); } }
  if (!mine.length) for (const c of (state.claimableChunks || []).slice(0, 6)) { want.set(key(c), c); for (const s of SIDES) { const nb = neighborOf(c, s); want.set(key(nb), nb); } }
  const details = {};
  for (const [k, c] of want) { const j = await getJson(SITE + '/api/state?chunk=' + k); if (j && j.detail) details[k] = j.detail; }

  const myDetail = mine.map(c => details[key(c)]).filter(Boolean);
  const nbStreets = [];
  for (const c of mine.length ? mine : (state.claimableChunks || []).slice(0, 6)) for (const s of SIDES) for (const nk of [neighborOf(c, s), ...(s === 'n' || s === 's' ? ['e', 'w'] : ['n', 's']).map(a => neighborOf(c, a))]) {
    const nb = details[key(nk)];
    if (!nb) continue;
    const recs = (nb.records || []).filter(r => r.agent !== ID && r.discipline === 'street' && r.kind === 'line' && r.pts && r.pts.every(p => Math.abs(p[s === 'n' || s === 's' ? 1 : 0] - (s === 'n' ? (c[1] + 1) * C : s === 's' ? c[1] * C : s === 'e' ? (c[0] + 1) * C : c[0] * C)) <= 12000));
    if (recs.length) nbStreets.push({yourChunk: c, edge: s, neighbor: nb.chunk, neighborOwner: nb.owner, neighborPorts: nb.ports, records: recs.slice(0, 20).map(r => ({pts: r.pts, closed: r.closed, color: r.color, meta: r.meta}))});
  }
  const summary = {scores: state.scores, chunks: (state.chunks || []).map(c => ({chunk: c.chunk, owner: c.owner, ports: c.ports, lots: (c.lots || []).map(l => l.zone)})), claimableChunks: state.claimableChunks, recentFlags: state.recentFlags, renames: state.renames};
  const notes = fs.existsSync(NOTES) ? fs.readFileSync(NOTES, 'utf8') : '';

  const messages = [{role: 'user', content:
`RULES
${rules}

OWNER FEEDBACK
${feedback || 'None.'}

WORLD SUMMARY
${cut(summary, 30000)}

YOUR CHUNKS IN DETAIL
${myDetail.length ? cut(myDetail, 90000) : 'You own no chunks yet.'}

NEIGHBOR STREET RECORDS ALONG YOUR EDGES
${nbStreets.length ? cut(nbStreets, 40000) : 'None.'}

YOUR NOTES FROM EARLIER TURNS
${notes || 'None yet.'}

This is turn ${n} of ${TURNS} in this run. UTC time now: ${new Date().toISOString()}. Plan this turn and reply with the JSON only.`}];

  let plan = null, report = null, issues = [];
  for (let round = 0; round < ROUNDS; round++) {
    const text = await ask(SYSTEM, messages);
    messages.push({role: 'assistant', content: text});
    let p;
    try { p = parse(text); } catch (e) {
      log('turn ' + n + ' round ' + round + ' JSON parse failed: ' + e.message);
      messages.push({role: 'user', content: 'That was not valid JSON with a calls array, or it was cut off. Reply with a complete JSON object only, with fewer calls if needed.'});
      continue;
    }
    plan = p;
    report = await play(plan.calls, true);
    if (report.error) throw new Error('Play error: ' + cut(report, 1500));
    issues = lint(plan.calls, mine, details);
    log(`turn ${n} round ${round}: ${report.accepted} of ${report.calls} accepted, flags ${(report.newFlags || []).length}, quality issues ${issues.length}, score after ${report.scoreAfter}`);
    if (!(report.rejected || []).length && !(report.newFlags || []).length && !issues.length) break;
    if (round === ROUNDS - 1) break;
    messages.push({role: 'user', content: `Dry run report:\n${cut(report, 20000)}\n\nQuality issues to fix:\n${issues.length ? issues.join('\n') : 'None.'}\n\nFix every rejected call, every flag and every quality issue. Reply with the full corrected JSON only.`});
  }
  if (issues.length) log('remaining quality issues: ' + issues.join(' | '));

  if (!plan) { log('turn ' + n + ': no usable plan.'); return false; }
  const bad = new Set((report.rejected || []).map(r => r.index));
  const calls = plan.calls.filter((_, i) => !bad.has(i));
  if (!calls.length) { log('turn ' + n + ': nothing to save.'); return false; }
  const saved = await play(calls, false);
  log(cut({turn: n, saved: saved.saved, date: saved.date, accepted: saved.accepted, scoreAfter: saved.scoreAfter, error: saved.error}, 2000));
  if (saved.saved) {
    const entry = `\n## ${saved.date} score ${saved.scoreAfter}\n${plan.notes || ''}\n`;
    fs.writeFileSync(NOTES, (notes + entry).slice(-12000));
  }
  return !!saved.saved;
}

try {
  const rules = await (await fetch(RAW + 'agent-rules.txt')).text();
  const feedback = fs.existsSync(FEEDBACK) ? fs.readFileSync(FEEDBACK, 'utf8') : '';
  for (let n = 1; n <= TURNS; n++) {
    const ok = await turn(n, rules, feedback);
    if (n < TURNS) { log('waiting for the city to update'); await sleep(ok ? 90000 : 5000); }
  }
  log('done');
} catch (e) { log('RUN FAILED: ' + (e && e.stack || e)); }
finish(0);
