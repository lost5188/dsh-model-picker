/**
 * Idempotent, reversible display-layer patch for the DSH model picker.
 *
 * Every transformation is expressed as an exact text pair. Before writing
 * anything we verify that each pair is either already applied or still
 * applicable, so an incompatible host version is rejected without touching
 * the file. The original text of each change is recorded in state.json so
 * `revert` can restore it even without a pristine backup.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildHelper, validateConfig, helperBlockOf, MARK_START, MARK_END } from './helper.mjs';
import { discoverClient, dshHome, hostVersion, pluginVersion, PKG_DIR } from './discover.mjs';

const DATA_DIR = () => path.join(dshHome(), 'dsh-model-picker');
export const configPath = () => path.join(DATA_DIR(), 'config.json');
export const statePath = () => path.join(DATA_DIR(), 'state.json');
export const pristinePath = () => path.join(DATA_DIR(), 'client.orig.js');
const backupDir = () => path.join(DATA_DIR(), 'backups');

const REGION_ANCHOR = '//#region lib/types/client/ModelSelect.js';
const GROUPS_NEW = 'const groups = (0, react.useMemo)(() => dshPickerGroups(state.groups), [state.groups, accountProviderName]);';

const NEW_ROW = `children: [(0, react_jsx_runtime.jsxs)("span", {
\t\t\t\t\t\t\t\t\t\t\t\t\t\tclassName: ModelSelect_module_css_default.optionCopy,
\t\t\t\t\t\t\t\t\t\t\t\t\t\tchildren: [
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t(0, react_jsx_runtime.jsxs)("span", {
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\tstyle: { display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 },
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\tchildren: [
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\tmodel.__dsh ? (0, react_jsx_runtime.jsx)("span", { style: dshPickerChipStyle(model.__dsh.tone), children: model.__dsh.badge }) : null,
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t(0, react_jsx_runtime.jsx)("span", { className: ModelSelect_module_css_default.modelName, children: renderModelLabel(dshPickerProvider(group, model), model, "option", selected) })
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t]
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t}),
\t\t\t\t\t\t\t\t\t\t\t\t\t\t\tmodel.__dsh && DSH_PICKER_CONFIG.showMeta !== false ? (0, react_jsx_runtime.jsx)("span", { style: dshPickerMetaStyle(), children: dshPickerMeta(model.__dsh) }) : null
\t\t\t\t\t\t\t\t\t\t\t\t\t\t]
\t\t\t\t\t\t\t\t\t\t\t\t\t})`;

const NEW_OPTIONS = `for (const group of dshPickerGroups(directory.groups)) {
\t\t\t\tconst name = group.name;
\t\t\t\tfor (const model of group.models) rows.push({
\t\t\t\t\tid: rowId(model.__provider ?? group.id, model.id),
\t\t\t\t\tlabel: (model.__dsh ? '[' + model.__dsh.badge + '] ' : '') + model.name,
\t\t\t\t\tgroup: {
\t\t\t\t\t\tname: group.id,
\t\t\t\t\t\tlabel: name
\t\t\t\t\t},
\t\t\t\t\t...directory.current !== null && directory.current.provider === (model.__provider ?? group.id) && directory.current.model === model.id ? { active: true } : {}
\t\t\t\t});
\t\t\t}`;

function count(src, needle) {
  if (!needle) return 0;
  let n = 0, i = 0;
  while ((i = src.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
  return n;
}

function replaceN(src, from, to, n) {
  let out = src, i = 0, done = 0;
  while (done < n) {
    const at = out.indexOf(from, i);
    if (at < 0) throw new Error('expected ' + n + ' occurrences of ' + JSON.stringify(from.slice(0, 60)));
    out = out.slice(0, at) + to + out.slice(at + from.length);
    i = at + to.length;
    done++;
  }
  return out;
}

function lineStart(src, pos) {
  return src.lastIndexOf('\n', pos - 1) + 1;
}

function blockReplace(src, firstLine, lastLineEnd, replacement) {
  const i = src.indexOf(firstLine);
  if (i < 0) throw new Error('anchor missing: ' + firstLine.slice(0, 70));
  const start = lineStart(src, i);
  const j = src.indexOf(lastLineEnd, i);
  if (j < 0) throw new Error('block end missing: ' + lastLineEnd.slice(0, 70));
  let k = src.indexOf('\n', j + lastLineEnd.length);
  if (k < 0) k = src.length;
  const oldText = src.slice(start, k);
  const indent = (oldText.match(/^\t*/) || [''])[0];
  const newText = indent + replacement;
  return { src: src.slice(0, start) + newText + src.slice(k), oldText, newText };
}

/** A simple exact-pair transformation. */
function pair(id, from, to, expected = 1, firstN = null) {
  const n = firstN ?? expected;
  return {
    id,
    applied: src => count(src, to) >= n && (firstN === null || count(src, from) === expected - firstN),
    applicable: src => count(src, from) === expected || count(src, to) >= n,
    forward(src) {
      const out = replaceN(src, from, to, n);
      return { src: out, change: { id, oldText: from, newText: to, count: n } };
    },
  };
}

function blockStep(id, isApplied, firstLine, lastLineEnd, replacement) {
  return {
    id,
    applied: isApplied,
    applicable: src => src.includes(firstLine) || isApplied(src),
    forward(src) {
      const r = blockReplace(src, firstLine, lastLineEnd, replacement);
      return { src: r.src, change: { id, oldText: r.oldText, newText: r.newText, count: 1 } };
    },
  };
}

function makeSteps(helper) {
  return [
    {
      id: 'helper',
      applied: src => {
        const b = helperBlockOf(src);
        return Boolean(b) && b.text.trimEnd() === helper.trimEnd();
      },
      applicable: src => src.includes(MARK_START) || src.includes(REGION_ANCHOR),
      forward(src) {
        const b = helperBlockOf(src);
        if (b) {
          let tail = src.slice(b.end);
          if (tail.startsWith('\r\n')) tail = tail.slice(2);
          else if (tail.startsWith('\n')) tail = tail.slice(1);
          return { src: src.slice(0, b.start) + helper + tail, change: null };
        }
        const i = src.indexOf(REGION_ANCHOR);
        if (i < 0) throw new Error('ModelSelect region anchor not found');
        const at = lineStart(src, i);
        return { src: src.slice(0, at) + helper + src.slice(at), change: null };
      },
    },
    blockStep(
      'groups useMemo',
      src => src.includes(GROUPS_NEW),
      'const groups = (0, react.useMemo)(() => orderModelProviders(state.groups)',
      '})), [state.groups, accountProviderName]);',
      GROUPS_NEW,
    ),
    pair(
      'provider refs',
      'provider: group.id,',
      'provider: model.__provider ?? group.id,',
      4,
      3,
    ),
    pair(
      'selected check',
      'const selected = state.current?.provider === group.id && state.current.model === model.id;',
      'const selected = state.current?.provider === (model.__provider ?? group.id) && state.current.model === model.id;',
    ),
    pair(
      'pending check',
      'children: pending?.provider === group.id && pending.model === model.id ?',
      'children: pending?.provider === (model.__provider ?? group.id) && pending.model === model.id ?',
    ),
    pair(
      'option title',
      'title: model.name,',
      'title: dshPickerTitle(model.__dsh, model.__provider ?? group.id, model),',
    ),
    ...['trigger', 'menu'].map(place => pair(
      'renderModelLabel ' + place,
      `renderModelLabel(currentChoice.group.provider, currentChoice.model, "${place}", true)`,
      `renderModelLabel(dshPickerProvider(currentChoice.group, currentChoice.model), currentChoice.model, "${place}", true)`,
    )),
    {
      id: 'option row',
      applied: src => src.includes('dshPickerChipStyle(model.__dsh.tone)'),
      applicable: src => src.includes('renderModelLabel(group.provider, model, "option", selected)') || src.includes('dshPickerChipStyle(model.__dsh.tone)'),
      forward(src) {
        const anchor = src.indexOf('renderModelLabel(group.provider, model, "option", selected)');
        if (anchor < 0) throw new Error('option row anchor missing');
        const start = src.lastIndexOf('children: [(0, react_jsx_runtime.jsx)("span", {', anchor);
        if (start < 0) throw new Error('option row start missing');
        const marker = '}), (0, react_jsx_runtime.jsx)("span", {';
        const end = src.indexOf(marker, start);
        if (end < 0) throw new Error('option row end missing');
        const oldText = src.slice(start, end + 2);
        if (!oldText.includes('optionCopy') || !oldText.includes('modelName')) {
          throw new Error('option row did not match the expected shape');
        }
        return {
          src: src.slice(0, start) + NEW_ROW + src.slice(end + 2),
          change: { id: 'option row', oldText, newText: NEW_ROW, count: 1 },
        };
      },
    },
    blockStep(
      'command popup',
      src => src.includes('dshPickerGroups(directory.groups)'),
      'for (const group of orderModelProviders(directory.groups)) {',
      '\t\t\t\t});\n\t\t\t}',
      NEW_OPTIONS,
    ),
  ];
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

/** Load the user config, copying the shipped defaults on first run. */
export function loadConfig() {
  const p = configPath();
  if (!fs.existsSync(p)) {
    ensureDir(path.dirname(p));
    fs.copyFileSync(path.join(PKG_DIR, 'lib', 'defaults.json'), p);
  }
  const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
  validateConfig(cfg);
  return cfg;
}

function readState() {
  try { return JSON.parse(fs.readFileSync(statePath(), 'utf8')); } catch { return null; }
}

function writeState(state) {
  ensureDir(DATA_DIR());
  fs.writeFileSync(statePath(), JSON.stringify(state, null, 2) + '\n', 'utf8');
}

function writeBackup(src) {
  ensureDir(backupDir());
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const file = path.join(backupDir(), 'client.js.' + stamp + '.bak');
  fs.writeFileSync(file, src, 'utf8');
  const all = fs.readdirSync(backupDir()).filter(n => n.endsWith('.bak')).sort();
  for (const old of all.slice(0, -3)) {
    try { fs.unlinkSync(path.join(backupDir(), old)); } catch { /* ignore */ }
  }
  return file;
}

/** Syntax check via Node (or Electron running as Node). */
function syntaxCheck(file) {
  const env = { ...process.env };
  if (process.versions?.electron) env.ELECTRON_RUN_AS_NODE = '1';
  try {
    const r = spawnSync(process.execPath, ['--check', file], { env, encoding: 'utf8', timeout: 30000 });
    if (r.error || r.status === undefined) return { ok: true, skipped: true };
    return { ok: r.status === 0, stderr: (r.stderr || '').slice(0, 500) };
  } catch {
    return { ok: true, skipped: true };
  }
}

/** Pure transformation: no filesystem access, no writes. */
export function transformSource(src, helper) {
  let out = src;
  const changes = [];
  const touched = [];
  for (const step of makeSteps(helper)) {
    if (step.applied(out)) continue;
    if (!step.applicable(out)) {
      throw new Error('Incompatible renderer (step "' + step.id + '"). Nothing was written. ' +
        'The host version may differ; see README for supported versions.');
    }
    const r = step.forward(out);
    out = r.src;
    touched.push(step.id);
    if (r.change) changes.push(r.change);
  }
  return { src: out, touched, changes, changed: out !== src };
}

export function status(options = {}) {
  const { clientPath, tried } = discoverClient(options.client);
  const src = fs.readFileSync(clientPath, 'utf8');
  const state = readState();
  const cfg = loadConfig();
  return {
    clientPath,
    hostVersion: hostVersion(clientPath),
    pluginVersion: pluginVersion(),
    patched: src.includes(MARK_START),
    configCurrent: (() => {
      const b = helperBlockOf(src);
      return Boolean(b) && b.text.trimEnd() === buildHelper(cfg).trimEnd();
    })(),
    dshHome: dshHome(),
    configPath: configPath(),
    statePath: statePath(),
    pristine: fs.existsSync(pristinePath()),
    adopted: Boolean(state?.adopted),
    appliedAt: state?.appliedAt || null,
    tried: tried.slice(-6),
  };
}

/** Dry-run compatibility check. Never writes. */
export function check(options = {}) {
  const { clientPath } = discoverClient(options.client);
  const src = fs.readFileSync(clientPath, 'utf8');
  const cfg = options.config || loadConfig();
  const helper = buildHelper(cfg);
  const problems = [];
  try {
    transformSource(src, helper);
  } catch (e) {
    problems.push(e.message);
  }
  return {
    ok: problems.length === 0,
    clientPath,
    hostVersion: hostVersion(clientPath),
    problems,
  };
}

/** Apply (or refresh) the patch. Idempotent and safe to run on every start. */
export function apply(options = {}) {
  const { clientPath } = discoverClient(options.client);
  const cfg = options.config || loadConfig();
  const helper = buildHelper(cfg);
  let src = fs.readFileSync(clientPath, 'utf8');
  const before = src;
  const alreadyPatched = src.includes(MARK_START);
  const result = transformSource(src, helper);
  src = result.src;
  const { changes, touched } = result;

  if (src === before) {
    return { ok: true, changed: false, clientPath, message: 'already up to date' };
  }

  const backup = writeBackup(before);
  if (!alreadyPatched && !fs.existsSync(pristinePath())) {
    ensureDir(DATA_DIR());
    fs.writeFileSync(pristinePath(), before, 'utf8');
  }

  fs.writeFileSync(clientPath, src, 'utf8');
  const syntax = options.skipSyntaxCheck ? { ok: true, skipped: true } : syntaxCheck(clientPath);
  if (!syntax.ok) {
    fs.writeFileSync(clientPath, before, 'utf8');
    throw new Error('Syntax check failed; restored previous file. ' + syntax.stderr);
  }

  const previous = readState();
  writeState({
    version: 1,
    clientPath,
    hostVersion: hostVersion(clientPath),
    pluginVersion: pluginVersion(),
    appliedAt: new Date().toISOString(),
    adopted: alreadyPatched && !previous?.pristineImported,
    pristineImported: Boolean(previous?.pristineImported),
    changes: changes.length ? changes : (previous?.changes || []),
  });

  return {
    ok: true,
    changed: true,
    clientPath,
    touched,
    backup,
    syntaxSkipped: Boolean(syntax.skipped),
    restartRequired: true,
  };
}

/** Restore the renderer to its pre-patch state. */
export function revert(options = {}) {
  const { clientPath } = discoverClient(options.client);
  const state = readState();
  const p = pristinePath();
  if (fs.existsSync(p)) {
    const before = fs.readFileSync(clientPath, 'utf8');
    writeBackup(before);
    fs.writeFileSync(clientPath, fs.readFileSync(p, 'utf8'), 'utf8');
    try { fs.unlinkSync(statePath()); } catch { /* ignore */ }
    return { ok: true, method: 'pristine', clientPath, restartRequired: true };
  }
  if (!state?.changes?.length) {
    throw new Error('No pristine backup and no recorded changes. ' +
      'Use "import-original <path>" or reinstall DSH to restore the renderer.');
  }
  let src = fs.readFileSync(clientPath, 'utf8');
  const before = src;
  for (const c of [...state.changes].reverse()) {
    src = replaceN(src, c.newText, c.oldText, c.count);
  }
  const b = helperBlockOf(src);
  if (b) {
    let tail = src.slice(b.end);
    if (tail.startsWith('\r\n')) tail = tail.slice(2);
    else if (tail.startsWith('\n')) tail = tail.slice(1);
    src = src.slice(0, b.start) + tail;
  }
  writeBackup(before);
  fs.writeFileSync(clientPath, src, 'utf8');
  const syntax = syntaxCheck(clientPath);
  if (!syntax.ok) {
    fs.writeFileSync(clientPath, before, 'utf8');
    throw new Error('Syntax check failed after revert; restored previous file. ' + syntax.stderr);
  }
  try { fs.unlinkSync(statePath()); } catch { /* ignore */ }
  return { ok: true, method: 'recorded-changes', clientPath, restartRequired: true };
}

/** Import a known-good pristine renderer so `revert` becomes exact. */
export function importOriginal(from, options = {}) {
  const { clientPath } = discoverClient(options.client);
  const abs = path.resolve(from);
  if (!fs.existsSync(abs)) throw new Error('file not found: ' + abs);
  const src = fs.readFileSync(abs, 'utf8');
  if (src.includes(MARK_START)) throw new Error('that file already contains the patch; it is not pristine');
  ensureDir(DATA_DIR());
  fs.writeFileSync(pristinePath(), src, 'utf8');
  const state = readState() || {};
  state.pristineImported = true;
  state.clientPath = clientPath;
  writeState(state);
  return { ok: true, pristine: pristinePath() };
}
