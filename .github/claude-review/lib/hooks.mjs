/**
 * hooks
 *
 * What: Wires the PreToolUse hook (hooks/pretooluse.mjs) into every agent slot: writes the per-slot Claude
 *       settings file, checks at init that the hook really denies, and counts its denials after a slot.
 * Why: The command line tool allowlists are prefix rules. The hook is the second layer, and the push slot
 *      depends on it (the only Bash command it may run is `git push origin HEAD`). A slot without a working
 *      hook must not run, so the self-check fails closed.
 * Not covered: The hook policy itself (hooks/pretooluse.mjs).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './agent.mjs';

export const HOOK_ROLES = ['review', 'fix', 'push'];
export const DENY_MARKER = 'CLR_HOOK_DENY:';

// Paths end up inside a shell command line in the settings file and inside claude_args.
const UNSAFE_PATH = /[\s"'$`\\]/;

export const hooksDir = (rt) => join(rt.temp, 'claude-review-hooks');
export const settingsPath = (rt, role) => join(hooksDir(rt), `settings-${role}.json`);
export const hookScript = () => join(ROOT, 'hooks', 'pretooluse.mjs');
export const nodeBin = (rt) => rt.env.CLR_NODE || process.execPath;

/** One input per role that the hook must deny. */
const SELF_TEST_INPUTS = {
  review: { tool_name: 'Write', tool_input: { file_path: 'self-test.txt', content: 'x' } },
  fix: { tool_name: 'Bash', tool_input: { command: 'git push origin HEAD' } },
  push: { tool_name: 'Bash', tool_input: { command: 'git push --force origin HEAD' } },
};

function assertSafePath(label, value) {
  if (UNSAFE_PATH.test(value)) throw new Error(`${label} contains a character that is not allowed in a hook command: ${JSON.stringify(value)}`);
}

/** The argument vector of one hook run: node, script, role, workspace, input directory ('' for none), log. */
export function hookArgv(rt, role, inDir, logPath) {
  const argv = [nodeBin(rt), hookScript(), role, rt.cwd, inDir, logPath];
  const labels = ['node', 'hook script', 'role', 'workspace', 'input directory', 'log'];
  argv.forEach((p, i) => { if (i !== 4 || p !== '') assertSafePath(labels[i], p); });
  return argv;
}

/** The shell command that runs the hook for one slot. An empty inDir is passed as an empty argument. */
export const hookCommand = (rt, role, inDir, logPath) => hookArgv(rt, role, inDir, logPath).map((p) => (p === '' ? "''" : p)).join(' ');

/**
 * Write the settings file of one slot and return its path. `disableAllHooks: false` is required: a project
 * `.claude/settings.json` that sets it to true would otherwise switch these hooks off.
 */
export function writeSlotSettings(rt, role, { inDir, logPath }) {
  mkdirSync(hooksDir(rt), { recursive: true });
  const file = settingsPath(rt, role);
  assertSafePath('settings path', file);
  const settings = {
    disableAllHooks: false,
    hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: hookCommand(rt, role, inDir, logPath) }] }] },
  };
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
  return file;
}

/** Path of the hook log of one slot. */
export const hookLogPath = (rt, slot, role) => join(hooksDir(rt), `hook-${slot}-${role}.jsonl`);

/**
 * Run the hook once per role with an input it must deny. Returns '' when every role denies, else the problem.
 * Nothing here trusts the settings file: the same command line is built and executed.
 */
export function selfTestHooks(rt) {
  const log = join(hooksDir(rt), 'self-test.jsonl');
  try {
    mkdirSync(hooksDir(rt), { recursive: true });
    if (!existsSync(hookScript())) return `the hook script is missing: ${hookScript()}`;
    for (const role of HOOK_ROLES) {
      const inDir = role === 'push' ? '' : rt.inDir;
      const [node, script, ...args] = hookArgv(rt, role, inDir, log);
      const r = spawnSync(node, [script, ...args], {
        input: JSON.stringify(SELF_TEST_INPUTS[role]), encoding: 'utf8', timeout: 30000, env: { PATH: rt.env.PATH || '' },
      });
      if (r.status !== 0 || !String(r.stdout).includes(DENY_MARKER)) {
        return `the ${role} hook did not deny a forbidden call (exit ${r.status === null ? 'none' : r.status}${r.error ? `, ${r.error.message}` : ''})`;
      }
    }
    return '';
  } catch (e) {
    return String(e && e.message ? e.message : e);
  } finally {
    rmSync(log, { force: true });
  }
}

/** Counts of the denials a slot's hook logged: {total, denied, rules: {rule: count}}. */
export function summarizeHookLog(logPath) {
  const out = { total: 0, denied: 0, rules: {} };
  if (!logPath || !existsSync(logPath)) return out;
  for (const line of readFileSync(logPath, 'utf8').split('\n')) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (!row || typeof row !== 'object') continue;
    out.total += 1;
    if (row.decision === 'deny') {
      out.denied += 1;
      const rule = String(row.rule || 'unknown').slice(0, 60);
      out.rules[rule] = (out.rules[rule] || 0) + 1;
    }
  }
  return out;
}

export function describeHookDenials(summary) {
  const rules = Object.entries(summary.rules).map(([rule, n]) => `${rule} x${n}`).join(', ');
  return `${summary.denied} of ${summary.total} tool call(s) denied${rules ? ` (${rules})` : ''}`;
}
