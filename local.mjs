// Local copy of the game engine for purple's dry runs, so a server error never stops a turn.
import fs from 'fs';
import {execSync} from 'child_process';

export function makeLocal({ID, log, play}) {
  let E = null;
  const stamp = () => new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace(/^(\d{4})(\d{2})(\d{2})T/, '$1-$2-$3T');

  async function engineSync() {
    try {
      if (!fs.existsSync('tb/.git')) execSync('git clone -q --depth 1 https://github.com/sudosilo/2026-10-18-orange-testbed.git tb');
      else execSync('git -C tb pull -q --ff-only');
      if (!E) {
        const e = await import('file://' + process.cwd() + '/tb/engine.js');
        const l = await import('file://' + process.cwd() + '/tb/scripts/load.mjs');
        E = {replay: e.replay, scoreOf: e.scoreOf, loadContrib: l.loadContrib, loadConfig: l.loadConfig};
        log('local engine ready');
      }
    } catch (e) { log('local engine unavailable: ' + e.message); E = null; }
  }

  function dry(calls) {
    const root = process.cwd() + '/tb', date = stamp();
    const {files} = E.loadContrib(root);
    const mine = {agent: ID, date, calls};
    const all = files.concat([mine]).sort((x, y) => x.date < y.date ? -1 : x.date > y.date ? 1 : x.agent < y.agent ? -1 : x.agent > y.agent ? 1 : 0);
    const rejected = [];
    try {
      const W = E.replay(all, (f, i, call, r) => { if (f === mine && !r.ok) rejected.push({index: i, tool: call && call.tool, error: r.err}); }, E.loadConfig(root));
      const s = Object.assign({}, W.stats[ID] || {});
      return {id: ID, date, calls: calls.length, accepted: calls.length - rejected.length, rejected, scoreAfter: E.scoreOf(s), stats: s, newFlags: W.log.filter(l => l.flag && l.agent === ID && l.date === date).map(l => l.msg)};
    } catch (e) { return {error: 'engine crashed: ' + e.message, crash: true, stack: String(e.stack).slice(0, 600)}; }
  }

  async function run(calls) {
    if (E) return dry(calls);
    const r = await play(calls, true);
    return r && r.error ? Object.assign({crash: true}, r) : r;
  }

  async function crashers(calls, off = 0, depth = 0) {
    if (!calls.length) return [];
    const r = await run(calls);
    if (!r.crash) return [];
    if (calls.length === 1 || depth > 10) return calls.map((_, i) => off + i);
    const mid = Math.ceil(calls.length / 2);
    const a = await crashers(calls.slice(0, mid), off, depth + 1);
    const b = await crashers(calls.slice(mid), off + mid, depth + 1);
    return a.length || b.length ? a.concat(b) : calls.map((_, i) => off + i);
  }

  // Dry runs a plan. Calls that crash the engine or server are dropped from the plan and reported back.
  async function check(plan) {
    let r = await run(plan.calls);
    if (!r.crash) return r;
    log('dry run crash: ' + (r.stack || r.error));
    const orig = plan.calls, bad = await crashers(orig), drop = new Set(bad);
    plan.calls = orig.filter((_, i) => !drop.has(i));
    log('dropped crashing calls: ' + JSON.stringify(bad.map(i => orig[i])).slice(0, 3000));
    r = await run(plan.calls);
    if (r.crash) return {error: r.error};
    r.droppedBecauseTheyCrashTheServer = bad.map(i => orig[i]);
    return r;
  }

  return {engineSync, check};
}
