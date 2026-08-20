#!/usr/bin/env node
/**
 * active-turns launcher.
 *
 * The active-turns script opens session DBs via better-sqlite3, whose native
 * binding is compiled for the Node version the NanoClaw HOST runs (the shell's
 * default node may differ and fail with a NODE_MODULE_VERSION mismatch). This
 * launcher detects the host's node (the process running dist/index.js) and
 * re-execs the real script under it when the current node can't load the
 * binding.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, 'active-turns.ts');

function resolveTsxCli() {
  const candidates = [
    path.join(__dirname, '..', 'node_modules', '.bin', 'tsx'),
  ];
  const pnpmTsx = path.join(__dirname, '..', 'node_modules', '.pnpm');
  if (fs.existsSync(pnpmTsx)) {
    for (const dir of fs.readdirSync(pnpmTsx)) {
      if (!dir.startsWith('tsx@')) continue;
      const cli = path.join(pnpmTsx, dir, 'node_modules', 'tsx', 'dist', 'cli.mjs');
      if (fs.existsSync(cli)) return cli;
    }
  }
  return candidates[0];
}

function hostNodePath() {
  try {
    const out = spawnSync('ps', ['ax', '-o', 'command='], { encoding: 'utf-8' });
    const line = out.stdout
      .split('\n')
      .find((l) => l.includes('dist/index.js') && l.includes('node'));
    if (!line) return null;
    const match = line.match(/(\S*node\S*)\s+.*dist\/index\.js/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function tryRun(nodePath, tsxCli) {
  const isJsCli = tsxCli.endsWith('.mjs') || tsxCli.endsWith('.cjs');
  const args = isJsCli ? [tsxCli, SCRIPT] : [tsxCli, SCRIPT];
  // tsx spawns its worker under `node` from PATH — prepend the target node's
  // dir so the whole tree uses the matching runtime.
  const nodeDir = path.dirname(nodePath);
  const env = { ...process.env, PATH: `${nodeDir}:${process.env.PATH ?? ''}` };
  const res = spawnSync(nodePath, args, { stdio: 'inherit', env });
  return res.status;
}

const tsxCli = resolveTsxCli();

// Run under the host's Node (the one running dist/index.js) — better-sqlite3's
// native binding is compiled for it. Falling back to the shell's node can hit
// a NODE_MODULE_VERSION mismatch (the script imports better-sqlite3 directly).
const hostNode = hostNodePath() || process.execPath;
if (!fs.existsSync(tsxCli)) {
  console.error('active-turns: tsx not found');
  process.exit(1);
}
process.exit(tryRun(hostNode, tsxCli) ?? 1);
