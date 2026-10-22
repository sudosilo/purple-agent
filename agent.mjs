// Purple agent. Plays the orange test bed once per run through the web API.
import fs from 'fs';

const SITE = 'https://2026-10-18-orange-testbed.vercel.app';
const RULES = 'https://raw.githubusercontent.com/sudosilo/2026-10-18-orange-testbed/main/agent-rules.txt';
const ID = 'purple';
const KEY = process.env.PURPLE_KEY;
const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.MODEL || 'claude-sonnet-5-5';
const NOTES = 'notes.md';

if (!KEY || !API_KEY) { console.log('Missing PURPLE_KEY or ANTHROPIC_API_KEY secret.'); process.exit(1); }

const cut = (o, n) => { const s = typeof o === 'string' ? o : JSON.stringify(o); return s.length > n ? s.slice(0, n) + ' ...cut' : s; };

async function getJson(url) { const r = await fetch(url); return r.json(); }

async function play(calls, dryRun) {
  const r = await fetch(SITE + '/api/play', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({id: ID, key: KEY, dryRun, calls})
  });
  return r.json();
}

async function ask(system, messages) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {'Content-Type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01'},
    body: JSON.stringify({model: MODEL, max_tokens: 16000, system, messages})
  });
  const j = await r.json();
  if (!j.content) throw new Error('Model error: ' + cut(j, 500));
  return j.content.filter(b => b.type === 'text').map(b => b.text).join('');
}

function parse(text) {
  const s = text.indexOf('{'), e = text.lastIndexOf('}');
  const o = JSON.parse(text.slice(s, e + 1));
  if (!Array.isArray(o.calls)) throw new Error('no calls array');
  return o;
}

const SYSTEM = `You are Purple, agent id "purple", display color 3 (#7a4f9a). You play the agent test bed, a shared city that several AI agents build together, one turn at a time.
You are a professional and a good classmate. You build cool, true to life places, connect cleanly to your neighbors, reuse existing street names, match neighbor ports, and leave room for others.
Think about the city at a higher level too: whether it has enough housing, enough places to work, schools, parks, transit and services, and build what the city is missing.
Keep a consistent style from turn to turn and come back to places you started to deepen their interiors, life and texture.
Never use real people's names or real business names.
Reply with one JSON object only, no other text and no code fences:
{"calls": [ ...tool calls exactly as the rules describe... ], "notes": "a few sentences for your future self: what you built, ids and coordinates worth remembering, and what to do next turn"}`;

const rules = await (await fetch(RULES)).text();
const state = await getJson(SITE + '/api/state');
const mine = (state.chunks || []).filter(c => c.owner === ID).map(c => c.chunk);
const detail = [];
for (const c of mine.slice(0, 4)) detail.push({chunk: c, data: cut(await getJson(SITE + '/api/state?chunk=' + c.join(',')), 40000)});
const notes = fs.existsSync(NOTES) ? fs.readFileSync(NOTES, 'utf8') : '';

const messages = [{role: 'user', content:
`RULES
${rules}

WORLD STATE
${cut(state, 60000)}

YOUR CHUNKS IN DETAIL
${detail.length ? cut(detail, 80000) : 'You own no chunks yet.'}

YOUR NOTES FROM EARLIER TURNS
${notes || 'None yet. This is your first turn.'}

UTC time now: ${new Date().toISOString()}. Plan this turn and reply with the JSON only.`}];

let plan = null, report = null;
for (let round = 0; round < 4; round++) {
  const text = await ask(SYSTEM, messages);
  messages.push({role: 'assistant', content: text});
  let p;
  try { p = parse(text); } catch (e) {
    messages.push({role: 'user', content: 'That was not valid JSON with a calls array. Reply with the JSON object only.'});
    continue;
  }
  plan = p;
  report = await play(plan.calls, true);
  if (report.error) throw new Error('Play error: ' + report.error);
  console.log('Round ' + round + ': ' + report.accepted + ' of ' + report.calls + ' accepted, flags ' + (report.newFlags || []).length);
  if (!(report.rejected || []).length && !(report.newFlags || []).length) break;
  messages.push({role: 'user', content: `Dry run report:\n${cut(report, 20000)}\nFix every rejected call and every flag. Reply with the full corrected JSON only.`});
}

if (!plan) { console.log('No usable plan this run.'); process.exit(0); }
const bad = new Set((report.rejected || []).map(r => r.index));
const calls = plan.calls.filter((_, i) => !bad.has(i));
if (!calls.length) { console.log('Nothing to save this run.'); process.exit(0); }

const saved = await play(calls, false);
console.log(cut({saved: saved.saved, date: saved.date, accepted: saved.accepted, scoreAfter: saved.scoreAfter, error: saved.error}, 2000));
if (saved.saved) {
  const entry = `\n## ${saved.date} score ${saved.scoreAfter}\n${plan.notes || ''}\n`;
  fs.writeFileSync(NOTES, (notes + entry).slice(-8000));
}
