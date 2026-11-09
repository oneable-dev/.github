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

const PASSED_OUTPUT_CHARS = 2000;
/** Must not exceed the cap resetInDir (agent.mjs) applies when it copies the log for a slot. */
const LOG_CHARS = 60000;

/** How a command ended, in the words the reviewers read: passed | failed | timed out | not run. */
const resultOf = (r) => (r.skipped ? 'not run' : r.ok ? 'passed' : r.timed_out ? 'timed out' : 'failed');

/** The light record kept in `state.l0.results` and handed to every slot: no command output. */
function lightResult(r) {
  return {
    command: clamp(sanitizeText(r.label || r.command), 300),
    result: resultOf(r),
    exit_code: r.exit_code ?? null,
    seconds: r.seconds ?? null,
    timed_out: Boolean(r.timed_out),
    skipped: Boolean(r.skipped),
  };
}

/** The status block lists this many commands at most; the rest are only in scope.json (`l0.commands`). */
const MAX_STATUS_LINES = 50;

/**
 * The log of one L0 run: first a status block (the first line names the head and the overall status, then a
 * line per command, at most MAX_STATUS_LINES), then the output of each command. A failing command keeps its
 * whole output, a passing one only its end.
 * The whole log is at most LOG_CHARS. The status block comes first and loses only its end if it is too long
 * itself (the first line always survives); the output sections lose their start when the rest is too long.
 * Output sections are written only for the commands listed in the status block.
 */
function formatLog(results, head, status) {
  const listed = results.slice(0, MAX_STATUS_LINES);
  const lines = listed.map((r) => {
    const light = lightResult(r);
    const code = r.skipped ? '' : light.exit_code === null ? ', no exit code' : `, exit code ${light.exit_code}`;
    const secs = r.skipped ? '' : `, ${light.seconds}s`;
    return `${light.result}${code}${secs}: $ ${light.command}`;
  });
  if (results.length > listed.length) {
    lines.push(`... and ${results.length - listed.length} more commands; see scope.json l0.commands`);
  }
  const firstLine = `L0 run at commit ${head}: ${status}`.slice(0, LOG_CHARS);
  const top = [firstLine, ...lines].join('\n');
  // Leave room for "\n\n" + a section text + "\n"; when the block alone is too long, it is all there is.
  if (top.length > LOG_CHARS - 1) return `${top.slice(0, LOG_CHARS - 1)}\n`;
  const sections = listed.map((r) => {
    const name = `$ ${r.label || r.command}`;
    if (r.skipped) return `${name}\n[not run: not enough job time left]`;
    if (r.ok) return `${name}\n[passed, exit code ${r.exit_code} after ${r.seconds}s; end of output]\n${cutStart(r.output || '', PASSED_OUTPUT_CHARS)}`;
    return `${name}\n[${r.timed_out ? 'timed out' : `exit code ${r.exit_code}`} after ${r.seconds}s]\n${r.output}`;
  });
  const room = LOG_CHARS - top.length - 3;
  return room > 0 ? `${top}\n\n${fitEnd(sections.join('\n\n'), room)}\n` : `${top}\n`;
}

/** The end of `text` with cutStart's marker included, in at most `max` characters: the marker takes room too. */
function fitEnd(text, max) {
  let keep = Math.max(0, max);
  let out = cutStart(text, keep);
  while (out.length > max && keep > 0) {
    keep = Math.max(0, keep - (out.length - max));
    out = cutStart(text, keep);
  }
  return out.length > max ? out.slice(out.length - Math.max(0, max)) : out;
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
  l0.results = results.map(lightResult);
  writeFileSync(join(rt.stateDir, 'l0-log.txt'), formatLog(results, ranHead, s.status));
  l0.history.push({ kind: 'run', head: ranHead, status: s.status });
  l0.skipped_reason = s.status === 'incomplete' ? 'not enough job time left to run every check' : '';
}
