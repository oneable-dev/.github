/**
 * l0
 *
 * What: The deterministic gate. Runs the caller's setup, check and fix commands in a sanitized environment,
 *       and commits what fix_command changed (locally).
 * Why: Lint, format, type and test results must come from real command exit codes, not from a model.
 *      These commands run code from the pull request, so they get no tokens, no workflow command files,
 *      and the repository's git config is restored afterwards.
 *      One call runs fix_command at most once. When that makes a commit, the call ends with
 *      `state.push_pending` set: the driver cannot push, so the push slot comes next, and the checks run
 *      again at the new head only after the push is verified.
 * Not covered: Pushing (the push slot), and the fix agent (fix-l0 slot), which the driver schedules when
 *              this gate still fails.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { clamp, cutStart, runShell, sanitizedEnv, sanitizeText } from './util.mjs';
import {
  cleanOriginUrl, commitAll, discardChanges, headSha, listUntracked, restoreProtectedFromHead,
  scrubCheckoutCredentials,
} from './gitops.mjs';
import { L0_COMMAND_SECONDS, NO_PUSH_ROOM } from './state.mjs';
import { pushRoom, secondsLeft } from './plan.mjs';

const RESERVE_SECONDS = 10 * 60;
const MAX_AUTOFIX = 3;

async function runOne(rt, state, command, env) {
  const room = secondsLeft(state, rt.now()) - RESERVE_SECONDS;
  const limit = Math.min(rt.l0CommandSeconds || L0_COMMAND_SECONDS, room);
  if (limit <= 0) return { command, skipped: true, ok: false };
  rt.log(`L0: $ ${command}`);
  const r = await runShell(command, { cwd: rt.cwd, env, timeoutMs: limit * 1000 });
  const ok = r.code === 0 && !r.timedOut;
  return { command, ok, exit_code: r.code, timed_out: r.timedOut, seconds: r.seconds, output: r.output };
}

async function runChecks(rt, state, env) {
  const cfg = state.config;
  const l0 = state.l0;
  const results = [];
  if (cfg.setup_command && !l0.setup_done) {
    const r = await runOne(rt, state, cfg.setup_command, env);
    results.push({ ...r, label: 'setup_command' });
    if (!r.ok) return results; // nothing else can run without its setup
    l0.setup_done = true;
  }
  for (const command of cfg.check_commands) results.push(await runOne(rt, state, command, env));
  return results;
}

function summarize(results) {
  const failed = results.filter((r) => !r.ok && !r.skipped);
  const skipped = results.filter((r) => r.skipped);
  return { failed, skipped, status: failed.length ? 'fail' : skipped.length ? 'incomplete' : 'pass' };
}

function formatLog(results) {
  const parts = [];
  for (const r of results) {
    if (r.ok) continue;
    const head = r.skipped ? `$ ${r.label || r.command}\n[not run: not enough job time left]`
      : `$ ${r.label || r.command}\n[${r.timed_out ? 'timed out' : `exit code ${r.exit_code}`} after ${r.seconds}s]\n${r.output}`;
    parts.push(head);
  }
  return parts.join('\n\n');
}

/** Run the gate at the current head. Updates `state.l0`, and `state.head` and `state.push_pending` when fix_command committed. */
export async function runL0(rt, state) {
  const cfg = state.config;
  const l0 = state.l0;
  cleanOriginUrl(rt);
  scrubCheckoutCredentials(rt);
  restoreProtectedFromHead(rt);
  const gitConfigPath = join(rt.git(['rev-parse', '--absolute-git-dir']).stdout.trim(), 'config');
  const configBackup = readFileSync(gitConfigPath);
  const env = sanitizedEnv(rt.env);
  const ranHead = state.head;
  let results = [];
  // Code from the pull request ran: put git config back and drop edits the checks made to tracked files.
  const afterUserCode = () => {
    writeFileSync(gitConfigPath, configBackup);
    rt.git(['reset', '-q', '--hard', 'HEAD'], { check: false });
  };
  try {
    results = await runChecks(rt, state, env);
    afterUserCode();
    const wantsFix = summarize(results).status === 'fail' && cfg.fix_command && cfg.enable_fix !== false
      && !state.fixes_disabled && l0.autofix_runs < MAX_AUTOFIX;
    if (wantsFix) {
      // fix_command first; the agent only sees what is left. A commit needs a push slot afterwards, so
      // without room for one the command is not run at all.
      if (!pushRoom(state, rt.now())) {
        state.notes.push(`fix_command was not run: ${NO_PUSH_ROOM} its commit.`);
      } else {
        l0.autofix_runs += 1;
        const before = listUntracked(rt);
        const fix = await runOne(rt, state, cfg.fix_command, env);
        writeFileSync(gitConfigPath, configBackup);
        rt.log(`L0: fix_command ${fix.ok ? 'finished' : `failed (${fix.exit_code})`}`);
        if (!pushRoom(state, rt.now())) {
          discardChanges(rt, before);
          state.notes.push(`The changes of fix_command were discarded: ${NO_PUSH_ROOM} them after it finished.`);
        } else {
          const sha = commitAll(rt, 'Apply automated fixes from the repository fix command\n\nThe review pipeline ran fix_command after the checks failed.\n', before);
          if (!sha) discardChanges(rt, before);
          else {
            state.head = sha;
            l0.history.push({ kind: 'autofix', sha, pushed: false });
            state.push_pending = { sha, layer: 'L0', round: l0.autofix_runs, kind: 'autofix' };
          }
        }
      }
    }
  } finally {
    writeFileSync(gitConfigPath, configBackup);
    const now = headSha(rt);
    if (now !== state.head) {
      rt.git(['reset', '-q', '--hard', state.head]);
      state.notes.push('A check command moved HEAD; the driver restored it.');
    }
  }

  const s = summarize(results);
  l0.status = s.status;
  l0.ran_head = ranHead;
  l0.failures = s.failed.concat(s.skipped).map((r) => ({
    command: clamp(sanitizeText(r.label || r.command), 300),
    exit_code: r.exit_code ?? null,
    timed_out: Boolean(r.timed_out),
    skipped: Boolean(r.skipped),
    tail: clamp(sanitizeText(cutStart(r.output || '', 3000)), 3200),
  }));
  writeFileSync(join(rt.stateDir, 'l0-log.txt'), cutStart(formatLog(results), 300000));
  l0.history.push({ kind: 'run', head: ranHead, status: s.status });
  if (s.status === 'incomplete') l0.skipped_reason = 'not enough job time left to run every check';
}
