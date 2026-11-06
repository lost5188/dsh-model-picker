import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const REL = path.join(
  'node_modules', '@deepseek-ai', 'dsh-client-ui-model-selection', 'lib', 'client.js'
);

function exists(p) {
  try { return Boolean(p) && fs.statSync(p).isFile(); } catch { return false; }
}

function joinApp(appDir) {
  return path.join(appDir, REL);
}

/** Resolve the DSH home directory used for config, state and pristine backups. */
export function dshHome(explicit) {
  if (explicit) return path.resolve(explicit);
  if (process.env.DSH_MODEL_PICKER_HOME) return path.resolve(process.env.DSH_MODEL_PICKER_HOME);
  if (process.env.DSH_HOME) return path.resolve(process.env.DSH_HOME);
  const candidates = [
    path.join(os.homedir(), '.dsh'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'dsh'),
    path.join(os.homedir(), '.config', 'dsh'),
  ];
  for (const c of candidates) {
    try { if (fs.statSync(c).isDirectory()) return c; } catch { /* keep looking */ }
  }
  return candidates[0];
}

/**
 * Locate the renderer file without hard-coding an install path.
 * Order: explicit > env > running executable > DSH_HOME siblings > drive roots.
 */
export function discoverClient(explicit) {
  const tried = [];
  const consider = (p, why) => {
    if (!p) return false;
    const abs = path.resolve(p);
    tried.push({ path: abs, why });
    return exists(abs);
  };

  if (explicit || process.env.DSH_MODEL_PICKER_CLIENT) {
    const p = explicit || process.env.DSH_MODEL_PICKER_CLIENT;
    if (consider(p, 'explicit')) return { clientPath: path.resolve(p), tried };
  }

  const exeDir = path.dirname(process.execPath || '');
  for (const base of [exeDir, path.join(exeDir, '..')]) {
    const p = joinApp(path.join(base, 'resources', 'app'));
    if (consider(p, 'running executable')) return { clientPath: p, tried };
  }

  const home = dshHome();
  const parent = path.dirname(home);
  try {
    for (const ent of fs.readdirSync(parent, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      const p = joinApp(path.join(parent, ent.name, 'resources', 'app'));
      if (consider(p, 'DSH_HOME sibling')) return { clientPath: p, tried };
    }
  } catch { /* parent may not be readable */ }

  if (process.platform === 'win32') {
    for (const drive of ['C:', 'D:', 'E:', 'F:', 'G:']) {
      const root = drive + path.sep;
      try {
        for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
          if (!ent.isDirectory() || !/dsh/i.test(ent.name)) continue;
          const p = joinApp(path.join(root, ent.name, 'resources', 'app'));
          if (consider(p, 'drive root')) return { clientPath: p, tried };
        }
      } catch { /* drive not present */ }
    }
  }

  const asarHint = path.join(exeDir, 'resources', 'app.asar');
  const hint = exists(asarHint)
    ? ' The installation still uses a sealed app.asar; unpack it before installing this plugin.'
    : ' Set DSH_MODEL_PICKER_CLIENT to the absolute path of client.js.';
  const err = new Error('Could not locate the model-selection renderer.' + hint);
  err.tried = tried;
  throw err;
}

export function hostVersion(clientPath) {
  const pkg = path.resolve(clientPath, '..', '..', 'package.json');
  try {
    const manifest = JSON.parse(fs.readFileSync(pkg, 'utf8'));
    // A copied client.js may sit next to an unrelated package.json.
    if (manifest.name !== '@deepseek-ai/dsh-client-ui-model-selection') return 'unknown';
    return String(manifest.version || 'unknown');
  } catch {
    return 'unknown';
  }
}

export function pluginVersion() {
  try {
    return String(JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8')).version || 'unknown');
  } catch {
    return 'unknown';
  }
}
