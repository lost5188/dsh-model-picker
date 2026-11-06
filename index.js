/**
 * dsh-model-picker — Host half.
 *
 * A Host-only Cordis bundle. On activation it idempotently patches the model
 * picker renderer (display layer only). It never touches provider routes,
 * account credentials, model routing, or the OpenAI gateway.
 *
 * The renderer reads client.js when it starts, so the first activation needs a
 * DSH restart (or a renderer reload) to become visible. Optional `watch`
 * re-applies the patch if the host updates and overwrites the unpacked app.
 */
import { apply as applyPatch, status as patchStatus } from './lib/patch.mjs';

export const name = 'dsh-model-picker';
export const inject = [];

const DEFAULTS = {
  autoApply: true,
  watch: false,
  watchIntervalMinutes: 5,
  clientPath: '',
};

function run(clientPath) {
  try {
    const result = applyPatch({ client: clientPath || undefined });
    console.log('[dsh-model-picker] ' + (result.changed
      ? 'patched ' + result.clientPath + ' (restart DSH to see it)'
      : 'renderer already up to date'));
    return result;
  } catch (error) {
    // Keep this on stdout: host stderr can be interpreted as a crash reason.
    console.log('[dsh-model-picker] skipped: ' + String(error?.message || error));
    return null;
  }
}

export function apply(ctx, config = {}) {
  const options = { ...DEFAULTS, ...(config || {}) };
  const clientPath = options.clientPath || '';

  if (options.autoApply !== false) run(clientPath);
  else {
    try {
      const s = patchStatus({ client: clientPath || undefined });
      console.log('[dsh-model-picker] autoApply disabled; renderer patched=' + s.patched);
    } catch { /* host not found yet, nothing to report */ }
  }

  if (options.watch === true) {
    const ms = Math.max(1, Number(options.watchIntervalMinutes) || 5) * 60_000;
    const timer = setInterval(() => run(clientPath), ms);
    if (typeof timer?.unref === 'function') timer.unref();
    if (ctx && typeof ctx.effect === 'function') {
      ctx.effect(() => () => clearInterval(timer));
    }
  }
}
