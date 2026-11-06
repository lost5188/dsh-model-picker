#!/usr/bin/env node
/**
 * dsh-model-picker CLI — works without installing the Cordis bundle.
 *
 *   node bin/dsh-model-picker.mjs status
 *   node bin/dsh-model-picker.mjs check
 *   node bin/dsh-model-picker.mjs apply
 *   node bin/dsh-model-picker.mjs revert
 *   node bin/dsh-model-picker.mjs import-original <pristine-client.js>
 *   node bin/dsh-model-picker.mjs config
 *
 * Options: --client <path>  --home <path>  --json
 */
const argv = process.argv.slice(2);
const command = (argv[0] || 'status').toLowerCase();

function option(name) {
  const i = argv.indexOf('--' + name);
  return i >= 0 ? argv[i + 1] : undefined;
}
const asJson = argv.includes('--json');
const home = option('home');
if (home) process.env.DSH_MODEL_PICKER_HOME = home;
const client = option('client');

const {
  status, check, apply, revert, importOriginal, loadConfig, configPath,
} = await import('../lib/patch.mjs');

const HELP = `dsh-model-picker CLI

Commands:
  status             Show renderer path, host version and patch state
  check              Dry-run compatibility check (never writes)
  apply              Idempotently patch the renderer
  revert             Restore the renderer to its pre-patch state
  import-original P  Register a known pristine client.js for exact revert
  config             Print the editable config path

Options:
  --client PATH      Absolute path to dsh-client-ui-model-selection/lib/client.js
  --home PATH        DSH home directory (config, state and backups live here)
  --json             Machine-readable output
`;

function output(data, human) {
  if (asJson) console.log(JSON.stringify(data, null, 2));
  else console.log(human(data));
}

try {
  if (command === 'help' || command === '--help' || command === '-h') {
    console.log(HELP);
  } else if (command === 'config') {
    loadConfig();
    output({ configPath: configPath() }, d => 'Config file: ' + d.configPath);
  } else if (command === 'status') {
    const s = status({ client });
    output(s, d => [
      'Renderer     : ' + d.clientPath,
      'Host version : ' + d.hostVersion,
      'Plugin       : ' + d.pluginVersion,
      'Patched      : ' + (d.patched ? 'yes' : 'no'),
      'Config current: ' + (d.configCurrent ? 'yes' : 'no'),
      'Pristine     : ' + (d.pristine ? 'yes' : 'no') + (d.adopted ? ' (adopted an existing patch)' : ''),
      'Applied at   : ' + (d.appliedAt || '-'),
      'Config       : ' + d.configPath,
      'DSH home     : ' + d.dshHome,
    ].join('\n'));
  } else if (command === 'check') {
    const r = check({ client });
    output(r, d => d.ok
      ? 'Compatible: ' + d.clientPath + ' (host ' + d.hostVersion + ')'
      : 'NOT compatible: ' + d.problems.join('\n  - '));
    if (!r.ok && asJson) process.exitCode = 1;
  } else if (command === 'apply') {
    const r = apply({ client });
    output(r, d => d.changed
      ? 'Patched: ' + d.clientPath + '\nSteps: ' + d.touched.join(', ') + '\nBackup: ' + d.backup + '\nRestart DSH NEXT to see the new picker.'
      : 'Already up to date: ' + d.clientPath);
  } else if (command === 'revert') {
    const r = revert({ client });
    output(r, d => 'Reverted (' + d.method + '): ' + d.clientPath + '\nRestart DSH NEXT.');
  } else if (command === 'import-original') {
    const p = argv[1];
    if (!p || p.startsWith('--')) throw new Error('usage: import-original <pristine-client.js>');
    const r = importOriginal(p, { client });
    output(r, d => 'Pristine registered: ' + d.pristine);
  } else {
    throw new Error('unknown command: ' + command);
  }
} catch (error) {
  const message = String(error?.message || error);
  if (asJson) console.log(JSON.stringify({ ok: false, error: message }, null, 2));
  else console.error('ERROR: ' + message);
  process.exitCode = 1;
}
