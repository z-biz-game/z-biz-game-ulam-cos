// Tiny zero-dep test harness: every tools/../test/*.mjs suite prints the same shape so
// verify.sh can aggregate them. `test()` takes an ASYNC fn as well and `run()` awaits the
// queue — a suite that forgot to await would otherwise report `rows: N fail: 0` for work
// that never ran, which is the one failure mode a test harness must not have.

const rows = [];
const pending = [];
// Assertions, not just rows: `rows: 16` says a suite has 16 stories, which is easy to write and
// hard to falsify. `asserts` counts every ok/eq/throws actually executed, so a suite that quietly
// loops over an empty array shows up as a suspiciously small number.
let asserts = 0;

export function test(name, fn) {
  if (fn.length > 0 || (fn.constructor && fn.constructor.name === 'AsyncFunction')) {
    pending.push(Promise.resolve()
      .then(fn)
      .then(() => rows.push({ test: name, pass: true }))
      .catch((err) => rows.push({ test: name, pass: false, detail: String((err && err.message) || err) })));
    return;
  }
  try {
    fn();
    rows.push({ test: name, pass: true });
  } catch (err) {
    rows.push({ test: name, pass: false, detail: String((err && err.message) || err) });
  }
}

export function ok(cond, msg = 'expected truthy') {
  asserts++;
  if (!cond) throw new Error(msg);
}

export function eq(a, b, msg = 'not equal') {
  asserts++;
  const sa = JSON.stringify(a);
  const sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(`${msg}\n    got      ${sa}\n    expected ${sb}`);
}

export function throws(fn, re, msg = 'expected a throw') {
  asserts++;
  let caught = null;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  if (!caught) throw new Error(msg);
  if (re && !re.test(String(caught.message))) {
    throw new Error(`${msg}: message ${JSON.stringify(caught.message)} does not match ${re}`);
  }
  return caught;
}

export function fail(msg) {
  throw new Error(msg);
}

export async function run() {
  await Promise.all(pending);
  const bad = rows.filter((r) => !r.pass);
  for (const r of rows) console.log(`${r.pass ? '  ok  ' : '  FAIL'} ${r.test}${r.pass ? '' : '\n         ' + r.detail}`);
  console.log(`rows: ${rows.length} asserts: ${asserts} fail: ${bad.length}`);
  process.exit(bad.length ? 1 : 0);
}
