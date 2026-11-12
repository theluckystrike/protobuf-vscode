'use strict';
// Local git only (execFile, no shell, no network): the base version of the .proto files for the breaking-change check.
// Every call has a time limit and an output cap.
const { execFile } = require('child_process');

function git(cwd, args, { timeout = 20000, maxBuffer = 64 << 20 } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout, maxBuffer, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } }, (err, stdout, stderr) => {
      if (err) { err.stderr = String(stderr || ''); return reject(err); }
      resolve(String(stdout));
    });
  });
}

async function repoRoot(cwd) {
  try { return (await git(cwd, ['rev-parse', '--show-toplevel'], { timeout: 5000 })).trim() || null; } catch { return null; }
}

async function refExists(root, ref) {
  try { await git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { timeout: 5000 }); return true; } catch { return false; }
}

/** The base to compare with: the setting, else origin/main, main, origin/master, master (the first that exists). */
async function findBase(root, configured) {
  const list = configured ? [configured] : ['origin/main', 'main', 'origin/master', 'master'];
  for (const ref of list) if (await refExists(root, ref)) return ref;
  return null;
}

async function mergeBase(root, ref) {
  try { return (await git(root, ['merge-base', 'HEAD', ref], { timeout: 10000 })).trim() || null; } catch { return null; }
}

/** .proto files of a commit: Map(relPath -> text). */
async function protoFilesAt(root, commit, { maxFiles = 5000 } = {}) {
  const list = (await git(root, ['ls-tree', '-r', '--name-only', '-z', commit])).split('\0').filter((p) => p.endsWith('.proto')).slice(0, maxFiles);
  const out = new Map();
  for (const p of list) {
    try { out.set(p, await git(root, ['show', `${commit}:${p}`], { timeout: 10000 })); } catch { /* unreadable blob: skip */ }
  }
  return out;
}

/** .proto files of the working tree that git knows or would add (tracked + untracked, not ignored). */
async function workingProtoFiles(root, { maxFiles = 5000 } = {}) {
  const out = (await git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])).split('\0').filter((p) => p.endsWith('.proto'));
  return [...new Set(out)].slice(0, maxFiles);
}

module.exports = { git, repoRoot, findBase, mergeBase, protoFilesAt, workingProtoFiles };
