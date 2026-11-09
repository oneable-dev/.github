/**
 * agent
 *
 * What: Everything about one agent slot: the input directory, prompt and CLI arguments, the cleanup
 *       between slots, and parsing the execution file the action leaves behind.
 * Why: claude-code-action runs once per YAML step, so the driver prepares each slot and reads its result
 *      itself. A missing, stale, errored or unstructured result is "review incomplete", never a pass.
 *      There are three kinds of slot: review (read-only), fix (edits files, no shell) and push (one fixed
 *      shell command). Only the push slot ever pushes; it runs with the Claude GitHub App token.
 * Not covered: Folding results into the state (findings.mjs).
 */
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cutStart, fileMtimeMs, findInPath, removeFile } from './util.mjs';
import { cleanOriginUrl, scrubCheckoutCredentials } from './gitops.mjs';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));

export const REVIEW_TOOLS = 'Read,Grep,Glob,Bash(git diff:*),Bash(git log:*),Bash(git show:*),Bash(gh pr view:*),Bash(gh pr diff:*)';
export const FIX_TOOLS = 'Read,Grep,Glob,Edit,MultiEdit,Write';
export const PUSH_COMMAND = 'git push origin HEAD';
export const PUSH_TOOLS = `Bash(${PUSH_COMMAND})`;
export const PUSH_MODEL = 'haiku';
export const PUSH_MAX_TURNS = 2;

const SAFE_VALUE = /^[A-Za-z0-9._:[\]-]+$/;

export function loadSchema(name) {
  const text = readFileSync(join(ROOT, 'schemas', `${name}.json`), 'utf8');
  const compact = JSON.stringify(JSON.parse(text));
  if (compact.includes("'")) throw new Error(`schema ${name} must not contain a single quote`);
  return compact;
}

/** The --max-turns value a slot runs with, or 0 when it runs without a limit. */
export function slotMaxTurns(cfg, role) {
  const turns = role === 'review' ? cfg.max_turns : cfg.fix_max_turns;
  return turns > 0 ? Math.floor(turns) : 0;
}

/**
 * claude_args for one slot. Effort and model are left out when the input is empty.
 * `settings` is the path of the slot's Claude settings file (the PreToolUse hook).
 */
export function buildArgs(cfg, { role, layer, inDir, settings }) {
  if (role === 'push') {
    // No structured output and no input directory: the slot runs one fixed command.
    return ['--model', PUSH_MODEL, '--max-turns', String(PUSH_MAX_TURNS), '--allowedTools', `"${PUSH_TOOLS}"`, ...(settings ? ['--settings', settings] : [])].join(' ');
  }
  const review = role === 'review';
  const model = review ? cfg.models[layer] : cfg.fix_model;
  const effort = review ? cfg.review_effort : cfg.fix_effort;
  const turns = slotMaxTurns(cfg, role);
  const parts = [];
  if (model && SAFE_VALUE.test(model)) parts.push('--model', model);
  if (effort && SAFE_VALUE.test(effort)) parts.push('--effort', effort);
  if (turns > 0) parts.push('--max-turns', String(turns));
  parts.push('--allowedTools', `"${review ? REVIEW_TOOLS : FIX_TOOLS}"`);
  if (!review) parts.push('--permission-mode', 'acceptEdits');
  parts.push('--json-schema', `'${loadSchema(review ? 'review' : 'fix')}'`);
  parts.push('--add-dir', inDir);
  if (settings) parts.push('--settings', settings);
  return parts.join(' ');
}

export function renderPrompt(name, vars) {
  const dir = join(ROOT, 'prompts');
  let text = readFileSync(join(dir, `${name}.md`), 'utf8');
  text = text.replace(/\{\{include:([A-Za-z0-9_.-]+)\}\}/g, (_, f) => readFileSync(join(dir, f), 'utf8').trimEnd());
  return text.replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => {
    if (!(key in vars)) throw new Error(`prompt ${name} uses unknown placeholder ${key}`);
    return vars[key];
  }).trimEnd() + '\n';
}

export function extraBlock(extra) {
  const t = (extra || '').trim();
  return t ? `## Additional repository-specific instructions\n\nThese come from the repository owner's own workflow file and are trusted:\n\n${t}` : '';
}

/** Write a value to $GITHUB_ENV with a delimiter that cannot occur in it. */
export function writeGithubEnv(rt, values) {
  const file = rt.env.GITHUB_ENV;
  if (!file) { rt.log('GITHUB_ENV is not set; outputs not exported'); return; }
  let out = '';
  for (const [name, value] of Object.entries(values)) {
    let delim;
    do { delim = `CLR_EOF_${randomBytes(8).toString('hex')}`; } while (String(value).includes(delim));
    out += `${name}<<${delim}\n${value}\n${delim}\n`;
  }
  appendFileSync(file, out);
}

/** Clean up so one slot cannot leave anything behind for the next. Also removes the origin URL the action sets for a push. */
export function cleanBetweenSlots(rt) {
  removeFile(rt.execFile);
  removeFile(rt.inlineBuffer);
  try {
    mkdirSync(dirname(rt.claudeSettings), { recursive: true });
    writeFileSync(rt.claudeSettings, '{}\n');
  } catch { /* no HOME in some test setups */ }
  cleanOriginUrl(rt);
  scrubCheckoutCredentials(rt);
}

/** Reset the agent input directory and copy the static inputs into it. */
export function resetInDir(rt) {
  rmSync(rt.inDir, { recursive: true, force: true });
  mkdirSync(rt.inDir, { recursive: true, mode: 0o700 });
  const staticDir = join(rt.stateDir, 'static');
  if (existsSync(join(staticDir, 'requirements.md'))) cpSync(join(staticDir, 'requirements.md'), join(rt.inDir, 'requirements.md'));
  if (existsSync(join(staticDir, 'rules'))) cpSync(join(staticDir, 'rules'), join(rt.inDir, 'rules'), { recursive: true });
  const log = join(rt.stateDir, 'l0-log.txt');
  if (existsSync(log)) writeFileSync(join(rt.inDir, 'l0-log.txt'), cutStart(readFileSync(log, 'utf8'), 60000));
}

export function binaries(rt) {
  const claude = join(rt.env.HOME || '', '.local', 'bin', 'claude');
  return {
    CLR_CLAUDE_BIN: rt.env.HOME && existsSync(claude) ? claude : '',
    CLR_BUN_BIN: findInPath('bun', rt.env),
  };
}

/**
 * Read the result of the slot that was just issued.
 * Returns {ok: true, output, sessionId} or {ok: false, error}.
 * `pending.max_turns` is the --max-turns the slot ran with. Like claude-code-action (base-action
 * run-claude-sdk.ts, "exceeding the configured maximum"), a result that reports more turns than that
 * limit is not trusted: the slot counts as incomplete.
 */
export function readSlotResult(rt, pending, seenSessions) {
  const mtime = fileMtimeMs(rt.execFile);
  if (mtime === null) return { ok: false, error: 'no execution file was written' };
  if (mtime < pending.issued_at - 2000) return { ok: false, error: 'the execution file is older than this slot' };
  let data;
  try { data = JSON.parse(readFileSync(rt.execFile, 'utf8')); } catch { return { ok: false, error: 'the execution file is not valid JSON' }; }
  const messages = Array.isArray(data) ? data : [data];
  const result = [...messages].reverse().find((m) => m && m.type === 'result');
  if (!result) return { ok: false, error: 'the execution file has no result message' };
  const init = messages.find((m) => m && m.type === 'system' && m.subtype === 'init');
  const sessionId = result.session_id || (init && init.session_id) || '';
  if (sessionId && seenSessions.includes(sessionId)) return { ok: false, error: 'the execution file belongs to an earlier slot' };
  if (result.is_error || result.subtype !== 'success') {
    return { ok: false, sessionId, error: `the agent run failed (${result.subtype || 'unknown'}${result.is_error ? ', is_error' : ''})` };
  }
  if (pending.max_turns > 0 && Number.isFinite(result.num_turns) && result.num_turns > pending.max_turns) {
    return { ok: false, sessionId, error: `the agent reported ${result.num_turns} turns, over the limit of ${pending.max_turns}` };
  }
  // The push slot has no schema: whether it worked is decided by the branch on GitHub, not by its answer.
  if (pending.role === 'push') return { ok: true, output: null, sessionId };
  const out = result.structured_output;
  if (!out || typeof out !== 'object') return { ok: false, sessionId, error: 'the agent returned no structured output' };
  return { ok: true, output: out, sessionId };
}
