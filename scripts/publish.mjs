#!/usr/bin/env node
// Publishes the current tree to the public repository as ONE commit.
//
// The two repositories deliberately share no history: `origin` (hangar-private) carries the real
// commit-by-commit record, and `public` (hangar) carries a readable snapshot — `Initial commit`,
// then one commit per publish. A plain `git push public main` is therefore refused as unrelated,
// which is the right default; this script is the deliberate act that replaces it.
//
// What it publishes is HEAD's TREE, not HEAD's history. Two consequences worth knowing:
//   1. Nothing from the private log — branch names, WIP messages, the order things happened in —
//      reaches the public repository. Only the resulting files do.
//   2. Ignored files stay ignored. docs/superpowers/ is in .gitignore, so it cannot be published
//      by accident: it is not in the tree being copied.
//
// The new commit's parent is whatever public/main points at, so the public history accumulates
// normally and nobody's clone is ever invalidated by a force-push.
//
// Usage:  node scripts/publish.mjs [-m "<message>"] [--yes] [--dry-run]
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const die = (msg) => { console.error(`publish: ${msg}`); process.exit(1); };

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const valueOf = (name) => { const i = argv.indexOf(name); return i === -1 ? null : argv[i + 1] ?? null; };

const dryRun = flag('--dry-run');
const assumeYes = flag('--yes');
const message = valueOf('-m') ?? valueOf('--message') ?? `Publish ${new Date().toISOString().slice(0, 10)}`;

// A dirty tree means the thing being published is not the thing that was tested.
if (git('status', '--porcelain') !== '') die('working tree is not clean — commit or stash first.');

const remotes = git('remote').split('\n');
if (!remotes.includes('public')) die("no 'public' remote. Add it: git remote add public <url>");

console.log('publish: fetching public…');
git('fetch', 'public', '--quiet');

const localTree = git('rev-parse', 'HEAD^{tree}');
const publicRef = 'public/main';
let parent = null;
try { parent = git('rev-parse', publicRef); } catch { die(`${publicRef} not found — has the public repo been initialised?`); }
const publicTree = git('rev-parse', `${publicRef}^{tree}`);

if (localTree === publicTree) {
  console.log('publish: public already matches this tree — nothing to publish.');
  process.exit(0);
}

console.log(`\npublish: ${git('rev-parse', '--short', 'HEAD')} (${git('log', '-1', '--format=%s')})`);
console.log(`         onto ${git('rev-parse', '--short', publicRef)} (${git('log', '-1', '--format=%s', publicRef)})\n`);
console.log(git('diff', '--stat', publicRef, 'HEAD'));
console.log(`\npublish: message — ${message}`);

if (dryRun) { console.log('publish: --dry-run, stopping here.'); process.exit(0); }

if (!assumeYes) {
  if (!stdin.isTTY) die('not a terminal — pass --yes to publish non-interactively.');
  const rl = createInterface({ input: stdin, output: stdout });
  const answer = (await rl.question('\nPublish to the public repository? [y/N] ')).trim().toLowerCase();
  rl.close();
  if (answer !== 'y' && answer !== 'yes') { console.log('publish: cancelled.'); process.exit(0); }
}

const commit = git('commit-tree', localTree, '-p', parent, '-m', message);
// The point of the whole script: what lands must be this tree, byte for byte.
if (git('rev-parse', `${commit}^{tree}`) !== localTree) die('built commit does not carry the local tree — aborted.');

git('push', 'public', `${commit}:refs/heads/main`);
console.log(`\npublish: pushed ${commit.slice(0, 7)} to public/main`);
console.log(`publish: https://github.com/mrltech-alt/hangar/commit/${commit}`);
