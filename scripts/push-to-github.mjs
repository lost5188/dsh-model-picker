#!/usr/bin/env node
/**
 * Create (or reuse) a GitHub repository and push this plugin to it.
 *
 *   GITHUB_TOKEN=... node scripts/push-to-github.mjs
 *
 * Public by default; add --private for a private repository.
 * The token is read only from the environment (GITHUB_TOKEN / GH_TOKEN) and is
 * passed to git via an HTTP header, so it is never written to .git/config,
 * printed, or stored in any file. Give the token only the `repo` scope.
 *
 * Options:
 *   --name NAME       repository name (default: dsh-model-picker)
 *   --private         create a private repo (default: public)
 *   --owner LOGIN     create under an org instead of the token owner
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const name = arg('name', 'dsh-model-picker');
const owner = arg('owner', '');
const isPrivate = argv.includes('--private');
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;

if (!token) {
  console.error('ERROR: set GITHUB_TOKEN (or GH_TOKEN) first. The token needs the repo scope.');
  process.exit(1);
}
if (!fs.existsSync(path.join(ROOT, '.git'))) {
  console.error('ERROR: no .git directory. Run this from a clone that has a commit.');
  process.exit(1);
}

const api = 'https://api.github.com';
const headers = {
  Accept: 'application/vnd.github+json',
  Authorization: 'Bearer ' + token,
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'dsh-model-picker-push',
};

async function request(method, url, body) {
  const r = await fetch(api + url, {
    method,
    headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: r.status, data };
}

function git(args, options = {}) {
  return spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', ...options });
}

const me = await request('GET', '/user');
if (me.status !== 200) throw new Error('GitHub authentication failed (' + me.status + '): ' + JSON.stringify(me.data?.message || me.data));
const login = me.data.login;
const targetOwner = owner || login;
console.log('Authenticated as ' + login);

let repo = null;
const created = await request('POST', (owner ? '/orgs/' + owner : '/user') + '/repos', {
  name,
  private: isPrivate,
  description: 'Grouped, badged model picker plugin for DSH / DSH NEXT',
  has_issues: true,
  has_wiki: false,
  auto_init: false,
});
if (created.status === 201) {
  repo = created.data;
  console.log('Created ' + (isPrivate ? 'private' : 'public') + ' repo: ' + repo.full_name);
} else if (created.status === 422) {
  const existing = await request('GET', '/repos/' + targetOwner + '/' + name);
  if (existing.status !== 200) throw new Error('Repo already exists but cannot be read (' + existing.status + ')');
  repo = existing.data;
  console.log('Reusing existing repo: ' + repo.full_name);
} else {
  throw new Error('Could not create repo (' + created.status + '): ' + JSON.stringify(created.data?.message || created.data));
}

const remoteUrl = 'https://github.com/' + repo.full_name + '.git';
const basic = Buffer.from('x-access-token:' + token).toString('base64');
const push = git([
  '-c', 'http.extraHeader=AUTHORIZATION: basic ' + basic,
  'push', '-u', remoteUrl, 'HEAD:refs/heads/' + (repo.default_branch || 'main'),
]);
if (push.status !== 0) {
  throw new Error('git push failed: ' + String(push.stderr || push.stdout).slice(0, 800));
}

console.log('\nPushed to ' + repo.html_url);
console.log('Visibility: ' + (repo.private ? 'private' : 'public'));
console.log('\nLater, on any machine:');
console.log('  git clone ' + repo.clone_url);
console.log('  cd ' + name + ' && node bin/dsh-model-picker.mjs apply');
console.log('\nRemember to revoke the token when you are done, if it was a one-off PAT.');
