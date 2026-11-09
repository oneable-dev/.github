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
import { redact } from './util.mjs';

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

/** How many denied calls are listed in the job log per slot. */
export const MAX_LOGGED_DENIALS = 5;

/**
 * Counts of the denials a slot's hook logged: {total, denied, rules: {rule: count}, calls: [{rule, tool,
 * target}]}. `calls` holds the first MAX_LOGGED_DENIALS denied calls as the hook logged them, unsanitized:
 * the target comes from the model and can carry pull request text, so print it only through describeDeniedCalls.
 */
export function summarizeHookLog(logPath) {
  const out = { total: 0, denied: 0, rules: {}, calls: [] };
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
      if (out.calls.length < MAX_LOGGED_DENIALS) {
        out.calls.push({ rule, tool: String(row.tool_name ?? ''), target: String(row.target ?? '') });
      }
    }
  }
  return out;
}

export function describeHookDenials(summary) {
  const rules = Object.entries(summary.rules).map(([rule, n]) => `${rule} x${n}`).join(', ');
  return `${summary.denied} of ${summary.total} tool call(s) denied${rules ? ` (${rules})` : ''}`;
}

const TOKEN_PATTERNS = [
  // GitHub tokens (also a prefix that the hook's 200 character cut left incomplete) and token-carrying URLs.
  /x-access-token:[^\s@]*@?/gi,
  /\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]*/g,
  // Anything that looks like a base64 or hex secret.
  /[A-Za-z0-9+/=_-]{32,}/g,
];

/**
 * One line of text from a denied call, made safe for the public job log. The hook target comes from the
 * model and can carry pull request text. The steps run in this order, and the order matters:
 * 1. control characters (newlines included) and line separators become spaces, and invisible characters
 *    are removed (general category Cf, and every Default_Ignorable_Code_Point: that adds combining grapheme
 *    joiner U+034F, variation selectors U+FE00-FE0F and U+E0100-E01EF, Mongolian free variation selectors
 *    U+180B-180F, which are category Mn and render as nothing), so nothing can split or hide a token or a
 *    command marker from the later steps;
 * 2. tokens and long base64-like runs are masked (with `***`, which cannot rebuild a marker);
 * 3. `::` (workflow command) and `##[` (the runner finds it anywhere in a line) are broken up;
 * 4. the length is capped (cutting only shortens the text).
 */
export function sanitizeLogText(text, max = 200) {
  let out = String(text ?? '')
    .replace(/[\p{Cc}\p{Zl}\p{Zp}\u202f]+/gu, ' ')
    .replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}\u2060-\u2064\ufeff\u00ad]+/gu, '');
  for (const pattern of TOKEN_PATTERNS) out = out.replace(pattern, '***');
  return out
    .replace(/:(?=:)/g, ': ')
    .replace(/#(?=#\[)/g, '# ')
    .trim()
    .slice(0, max);
}

/**
 * Job log lines for the denied calls of a slot: up to MAX_LOGGED_DENIALS, then a count of the rest. Every raw
 * field is redacted against `secrets` (configured secret values) before it is sanitized, and the sanitized
 * text is redacted again: the first pass catches a secret that sanitizing would reshape, the second one a
 * secret that sanitizing would leave behind.
 */
export function describeDeniedCalls(summary, secrets = []) {
  const clean = (value, max) => redact(sanitizeLogText(redact(value, secrets), max), secrets);
  const lines = (summary.calls || []).map((c) => `  denied ${clean(c.rule, 60)}: ${clean(c.tool, 60)} ${clean(c.target)}`.trimEnd());
  const more = summary.denied - lines.length;
  if (more > 0) lines.push(`  ... and ${more} more`);
  return lines;
}
