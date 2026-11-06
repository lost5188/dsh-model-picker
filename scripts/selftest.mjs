/**
 * Self-contained test. No DSH installation required.
 *
 *   node scripts/selftest.mjs
 *
 * Verifies: config validity, every transformation applies on a synthetic
 * renderer, the patch is idempotent, the reverse pass restores the original,
 * and the generated display logic keeps every model visible with the free
 * channels in the auto-collected group.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildHelper, validateConfig, helperBlockOf, MARK_START, MARK_END } from '../lib/helper.mjs';
import { transformSource } from '../lib/patch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'lib', 'defaults.json'), 'utf8'));
validateConfig(cfg);
const helper = buildHelper(cfg);

const T = '\t';
const FIXTURE = [
  '//#region lib/types/client/ModelSelect.js',
  'const groups = (0, react.useMemo)(() => orderModelProviders(state.groups)',
  '  ..., state.groups, accountProviderName);',
  '})), [state.groups, accountProviderName]);',
  'provider: group.id,',
  'provider: group.id,',
  'provider: group.id,',
  'provider: group.id,',
  'const selected = state.current?.provider === group.id && state.current.model === model.id;',
  'children: pending?.provider === group.id && pending.model === model.id ?',
  'title: model.name,',
  'renderModelLabel(currentChoice.group.provider, currentChoice.model, "trigger", true)',
  'renderModelLabel(currentChoice.group.provider, currentChoice.model, "menu", true)',
  'children: [(0, react_jsx_runtime.jsx)("span", {',
  'className: ModelSelect_module_css_default.optionCopy,',
  'children: (0, react_jsx_runtime.jsx)("span", { className: ModelSelect_module_css_default.modelName, children: renderModelLabel(group.provider, model, "option", selected) })',
  '}), (0, react_jsx_runtime.jsx)("span", {',
  'for (const group of orderModelProviders(directory.groups)) {',
  'const name = group.name;',
  'for (const model of group.models) rows.push({ id: rowId(group.id, model.id) });',
  T.repeat(4) + '});',
  T.repeat(3) + '}',
  '',
].join('\n');

function assert(cond, message) {
  if (!cond) throw new Error('FAIL: ' + message);
  console.log('  ok  ' + message);
}

console.log('1. transformation');
const r1 = transformSource(FIXTURE, helper);
assert(r1.changed, 'all steps apply to a pristine synthetic renderer');
assert(r1.touched.length === 10, 'every transformation step ran (' + r1.touched.length + ')');
assert(r1.src.includes(MARK_START) && r1.src.includes(MARK_END), 'helper block inserted');

console.log('2. idempotency');
const r2 = transformSource(r1.src, helper);
assert(!r2.changed, 're-applying changes nothing');
assert(r2.touched.length === 0, 'no steps run on the second pass');

console.log('3. reverse');
function replaceN(src, from, to, n) {
  let out = src, i = 0, done = 0;
  while (done < n) {
    const at = out.indexOf(from, i);
    if (at < 0) throw new Error('reverse: missing ' + from.slice(0, 50));
    out = out.slice(0, at) + to + out.slice(at + from.length);
    i = at + to.length;
    done++;
  }
  return out;
}
let back = r1.src;
for (const c of [...r1.changes].reverse()) back = replaceN(back, c.newText, c.oldText, c.count);
const block = helperBlockOf(back);
assert(Boolean(block), 'helper block found for removal');
let tail = back.slice(block.end);
if (tail.startsWith('\n')) tail = tail.slice(1);
back = back.slice(0, block.start) + tail;
assert(back === FIXTURE, 'reverse pass restores the original byte-for-byte');

console.log('4. display logic');
const ctx = { console };
vm.createContext(ctx);
vm.runInContext(helper + '\nthis.__api = { dshPickerGroups, dshPickerMeta };', ctx);
const { dshPickerGroups } = ctx.__api;

const entries = [
  ...cfg.models.map(m => ({ id: m.id, name: m.name })),
  { id: 'workbuddy/hy3', name: 'Hy3 · x0.00→免费' },
  { id: 'workbuddy/hy4free', name: 'Hy4 · x0.00→免费' },
  { id: 'workbuddy-vision/hy3', name: 'Hy3 · x0.00→免费' },
  { id: 'buddy/hy4free', name: 'Hy4 · x0.00→免费' },
  { id: 'qoder/qfmodel', name: 'Qwen3.8-Flash · 免费' },
  { id: 'loomy/spark-x2.6', name: 'Spark-X2.6 (限时免费) · x0.0' },
  { id: 'our-free-model/big-pickle', name: '⚠️ 免费·额度用尽 Big Pickle' },
  { id: 'deepseek-account/deepseek-flash', name: 'DeepSeek-V4.1-Flash' },
];
const byProvider = new Map();
const original = new Set(entries.map(e => e.id));
for (const e of entries) {
  const cut = e.id.indexOf('/');
  const provider = e.id.slice(0, cut);
  if (!byProvider.has(provider)) byProvider.set(provider, []);
  byProvider.get(provider).push({ id: e.id.slice(cut + 1), name: e.name });
}
const groups = [...byProvider].map(([id, models]) => ({ id, name: id, models }));
const display = dshPickerGroups(groups);
const rows = [];
for (const g of display) for (const m of g.models) rows.push(m.__provider + '/' + m.id);
assert(rows.length === original.size, 'every catalog model stays visible (' + rows.length + '/' + original.size + ')');
assert(new Set(rows).size === rows.length, 'no duplicate provider/model rows');
for (const m of cfg.models) assert(rows.includes(m.id), 'curated: ' + m.id);
const free = display.find(g => g.id === 'dsh-picker-free');
assert(Boolean(free), 'auto free group exists');
for (const id of ['workbuddy/hy3', 'workbuddy/hy4free', 'buddy/hy4free', 'qoder/qfmodel', 'loomy/spark-x2.6']) {
  assert(free.models.some(m => m.__provider + '/' + m.id === id), 'free: ' + id);
}
assert(!free.models.some(m => /额度用尽|地区受限|未实测/.test(m.name)), 'known-bad models excluded from free group');
assert(display.some(g => g.id === 'dsh-picker-other'), 'fallback group exists');

console.log('5. syntax');
const targets = [
  'index.js', 'bin/dsh-model-picker.mjs', 'lib/helper.mjs',
  'lib/discover.mjs', 'lib/patch.mjs', 'scripts/selftest.mjs', 'scripts/push-to-github.mjs',
];
for (const rel of targets) {
  const r = spawnSync(process.execPath, ['--check', path.join(ROOT, rel)], { encoding: 'utf8' });
  assert(r.status === 0, rel + ' parses' + (r.status ? ': ' + (r.stderr || '').slice(0, 200) : ''));
}

console.log('\nALL TESTS PASSED');
