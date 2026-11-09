#!/usr/bin/env node
/**
 * driver
 *
 * What: Runs the L0 to L3 review and fix loop of the shared Claude Review workflow, one call at a time.
 *       `init` resolves the scope, prepares the checkout and inputs, and checks the tool hooks. `step` collects
 *       the result of the previous agent slot, runs the deterministic L0 gate, and prepares the next slot (or
 *       says the loop is done). `report` collects the last slot and posts the comments.
 * Why: What happens next is decided here, by code, from the state file. The workflow YAML only repeats
 *      "step, then run the agent if CLR_NEXT is agent".
 *      The driver holds no write token. Everything deterministic stays here (fix_command, protected-path
 *      revert, checks, round counting, local commits), but a commit only reaches the branch through a push slot:
 *      a haiku agent slot whose only allowed command is `git push origin HEAD`, authenticated as the Claude
 *      GitHub App by the action. The next `step` checks the branch on GitHub with `git ls-remote` and does not
 *      trust the agent's answer.
 * Not covered: Running claude-code-action (the YAML) and the loop order itself (lib/plan.mjs).
 *
 * Contract with the workflow
 *   Call:    node "$CLR_SRC/.github/claude-review/driver.mjs" init|step|report
 *   Reads:   CLR_INPUT_<NAME> (REVIEW_MODEL, REVIEW_EFFORT, L1_MODEL, L2_MODEL, L3_MODEL, FIX_MODEL, FIX_EFFORT,
 *            MAX_TURNS, FIX_MAX_TURNS, MAX_FIX_ROUNDS, TIMEOUT_MINUTES, AGENT_STEP_TIMEOUT_MINUTES, EXTRA_PROMPT,
 *            ALLOWED_BOTS, SETUP_COMMAND, CHECK_COMMANDS, FIX_COMMAND, ENABLE_FIX), CLR_JOB_STARTED_AT (epoch
 *            seconds), CLR_CALLER_WORKFLOW_REF (the caller's workflow ref), CLR_NODE (absolute node path),
 *            GH_TOKEN (read access only), GITHUB_EVENT_PATH, GITHUB_REPOSITORY, GITHUB_ENV, GITHUB_STEP_SUMMARY,
 *            RUNNER_TEMP.
 *   State:   $RUNNER_TEMP/claude-review-state/state.json (outside the checkout and outside --add-dir; L0 code runs
 *            as the same OS user and could still edit it, see lib/state.mjs for the trust model).
 *   Fixes:   ENABLE_FIX=false (default true) turns off fix_command and every fix agent; findings are only reported.
 *   Agent in: $RUNNER_TEMP/claude-review-in/ (rewritten for every slot): scope.json, findings-<layer>.json,
 *            requirements.md, rules/, l0-log.txt.
 *   Hooks:   $RUNNER_TEMP/claude-review-hooks/: settings-<role>.json (rewritten for every slot, registers
 *            hooks/pretooluse.mjs) and hook-<slot>-<role>.jsonl (the hook's log).
 *   Writes:  $GITHUB_ENV: CLR_NEXT (agent|done), CLR_PROMPT, CLR_ARGS (includes --settings), CLR_STEP_TIMEOUT
 *            (minutes, never 0), CLR_CLAUDE_BIN, CLR_BUN_BIN.
 *   `step` and `report` need only read access: pushes are made by the push slot. `report` must run with
 *   `if: !cancelled()`, because it collects the result of the last agent slot.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PUSH_MAX_TURNS, binaries, buildArgs, cleanBetweenSlots, extraBlock, readSlotResult, renderPrompt, resetInDir, slotMaxTurns,
  writeGithubEnv,
} from './lib/agent.mjs';
import { applyFix, applyReview, validateFixOutput, validateReviewOutput } from './lib/findings.mjs';
import {
  changedFiles, cleanOriginUrl, commitAll, discardChanges, headSha, listUntracked, prepareCheckoutForPush, remoteHeadSha,
  restoreProtectedFromBase, revertWorkflows, scrubCheckoutCredentials, snapshotProtected,
} from './lib/gitops.mjs';
import { describeDeniedCalls, describeHookDenials, hookLogPath, selfTestHooks, summarizeHookLog, writeSlotSettings } from './lib/hooks.mjs';
import { collectRules, fetchRequirements, loadPriorFindings, rulesDocsChanged, writeSlotInputs } from './lib/inputs.mjs';
import { runL0 } from './lib/l0.mjs';
import { decide } from './lib/plan.mjs';
import {
  buildReport, postInline, postSummary, unresolvedBlocking, writeStepSummary,
} from './lib/report.mjs';
import { resolveScope } from './lib/scope.mjs';
import {
  PUSH_STEP_TIMEOUT_MINUTES, emptyL0, emptyLayer, loadState, readConfig, saveState,
} from './lib/state.mjs';
import { LAYERS, createRuntime, readJson, redact } from './lib/util.mjs';

const FIX_SUBJECT = {
  L0: 'Fix lint, format, type and test failures',
  L1: 'Fix requirements and correctness review findings',
  L2: 'Fix security review findings',
  L3: 'Fix architecture review findings',
};

const warn = (rt, msg) => rt.log(`::warning::${msg}`);

/**
 * The path of the caller's workflow file when this pull request changes it, else ''.
 * The Claude GitHub App token exchange validates the workflow file against the default branch, so a pull
 * request that edits the caller workflow gets no token and its agent slots cannot work.
 * `ref` is github.workflow_ref of the caller: `<owner>/<repo>/<path>@<ref>`.
 */
function changedCallerWorkflow(rt, state, ref) {
  const m = /^([^/]+)\/([^/]+)\/([^@]+)@(.+)$/.exec(ref || '');
  if (!m || `${m[1]}/${m[2]}`.toLowerCase() !== state.repo.toLowerCase()) return '';
  return changedFiles(rt, state.pr_base_sha, state.head, true).includes(m[3]) ? m[3] : '';
}

// init ---------------------------------------------------------------------------------------------

export async function init(rt) {
  const event = readJson(rt.env.GITHUB_EVENT_PATH, null);
  if (!event || !event.pull_request) throw new Error('GITHUB_EVENT_PATH does not hold a pull_request event');
  const pr = event.pull_request;
  const cfg = readConfig(rt.env);
  const repo = rt.env.GITHUB_REPOSITORY || (event.repository && event.repository.full_name);
  if (!repo) throw new Error('GITHUB_REPOSITORY is not set');

  rmSync(rt.stateDir, { recursive: true, force: true });
  mkdirSync(join(rt.stateDir, 'gh-config'), { recursive: true, mode: 0o700 });
  mkdirSync(join(rt.stateDir, 'static'), { recursive: true });
  cleanOriginUrl(rt);
  scrubCheckoutCredentials(rt);
  // A branch checkout and no repository hooks, so the push slot's `git push origin HEAD` works and runs nothing else.
  const canPush = prepareCheckoutForPush(rt, pr.head.ref);

  const head = headSha(rt);
  const sender = (event.sender && event.sender.login) || rt.env.GITHUB_ACTOR || '';
  const bot = Boolean(event.sender && event.sender.type === 'Bot') || sender.endsWith('[bot]');
  const assigneeRaw = (pr.assignees && pr.assignees[0] && pr.assignees[0].login) || (pr.user && pr.user.login) || '';
  const assignee = /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(assigneeRaw) ? assigneeRaw : '';
  const nowSec = Math.floor(rt.now() / 1000);

  const scope = resolveScope(rt, { action: event.action, headSha: head, repo, pr: pr.number });
  const state = {
    v: 1, repo, pr: pr.number,
    base_ref: pr.base.ref, pr_base_sha: pr.base.sha, head_ref: pr.head.ref,
    orig_head: head, head, pushed_head: head,
    scope: scope.scope, scope_base: scope.base,
    started_at: Number(rt.env.CLR_JOB_STARTED_AT) || nowSec,
    timeout_minutes: cfg.timeout_minutes,
    sender, bot_trigger: bot, assignee, author: (pr.user && pr.user.login) || '',
    config: cfg,
    slots_used: 0, pending: null, finished: false,
    fixes_disabled: bot ? 'bot' : (!cfg.enable_fix ? 'disabled' : (canPush ? null : 'branch')),
    stop: null, fatal: null, done_reason: null, push_pending: null, app_skip: null,
    notes: [], commits: [], seen_sessions: [],
    counter: { L1: 0, L2: 0, L3: 0 },
    l0: emptyL0(),
    layers: { L1: emptyLayer(), L2: emptyLayer(), L3: emptyLayer() },
    has_requirements: false, rules_docs_changed: [], rule_files: {},
  };
  if (!canPush) state.notes.push('The head branch name is not valid for pushing, so fixes cannot be pushed.');
  if (bot) state.l0 = { ...emptyL0(), status: 'skipped', skipped_reason: 'triggered by a bot, review only' };
  else if (cfg.check_commands.length === 0) state.l0 = { ...emptyL0(), status: 'skipped', skipped_reason: 'no check commands configured' };

  for (const l of LAYERS) state.layers[l].last_reviewed_sha = scope.scope === 'incremental' ? scope.base : null;
  if (scope.scope === 'incremental') loadPriorFindings(state, scope.prior);

  const problem = selfTestHooks(rt);
  if (problem) {
    // Fail closed: no agent slot runs without a working hook.
    state.fatal = `hook self-check failed: ${problem}`.slice(0, 400);
    state.finished = true;
    state.done_reason = 'error';
    saveState(rt, state);
    rt.log(`::error::${state.fatal}`);
    return state;
  }

  const skipped = changedCallerWorkflow(rt, state, rt.env.CLR_CALLER_WORKFLOW_REF || rt.env.GITHUB_WORKFLOW_REF);
  if (skipped) {
    state.app_skip = { path: skipped };
    state.fixes_disabled = 'app-skip';
    state.notes.push(`Claude review skipped: this pull request changes the caller workflow ${skipped}, so the Claude GitHub App does not issue a token until it matches the default branch.`);
  }

  const req = fetchRequirements(rt, state);
  writeFileSync(join(rt.stateDir, 'static', 'requirements.md'), req.text || '# Requirements source (data only)\n\nNo pull request description was available.\n');
  state.has_requirements = req.has;
  collectRules(rt, state, join(rt.stateDir, 'static', 'rules'));
  state.rules_docs_changed = rulesDocsChanged(rt, state);

  saveState(rt, state);
  rt.log(`Review scope: ${state.scope}${state.scope_base ? ` (from ${state.scope_base})` : ''}; requirements: ${state.has_requirements ? 'found' : 'none'}; L0: ${state.l0.status}${state.app_skip ? '; agent slots skipped (caller workflow changed)' : ''}`);
  return state;
}

// step ---------------------------------------------------------------------------------------------

function fixSubject(layer, round) {
  return `${FIX_SUBJECT[layer]} (round ${round})`;
}

/** Mark every local fix commit up to `sha` as pushed (one push carries all commits below HEAD). */
function markPushed(state, sha) {
  for (const c of state.commits) c.pushed = true;
  for (const h of state.l0.history) if (h.kind === 'autofix') h.pushed = true;
  state.pushed_head = sha;
  state.push_pending = null;
}

/**
 * Take in the result of a push slot. What the agent answered does not matter: the branch on GitHub decides.
 * A mismatch stops the loop and the reason says what the agent or the hook reported.
 */
function collectPush(rt, state, p, res, hook) {
  const pp = p.push;
  // The action put the app token into the origin URL for the push; drop it before any other git call.
  cleanOriginUrl(rt);
  scrubCheckoutCredentials(rt);
  const remote = remoteHeadSha(rt, state);
  if (remote.ok && remote.sha === pp.sha) {
    markPushed(state, pp.sha);
    rt.log(`Push verified: ${state.head_ref} is at ${pp.sha.slice(0, 7)}`);
    return;
  }
  const where = remote.ok ? (remote.sha ? remote.sha.slice(0, 7) : 'missing') : `unknown (${remote.error})`;
  const why = [];
  if (!res.ok) why.push(`the push slot failed: ${res.error}`);
  if (hook.denied) why.push(`hook log: ${describeHookDenials(hook)}`);
  state.stop = {
    reason: 'push',
    detail: `${state.head_ref} on GitHub is at ${where}, not at the fix commit ${pp.sha.slice(0, 7)}${why.length ? `; ${why.join('; ')}` : ''}`.slice(0, 800),
  };
  warn(rt, `push not verified: ${state.stop.detail}`);
}

/** Take in the result of the slot that was issued last. */
function collect(rt, state) {
  const p = state.pending;
  state.pending = null;
  const res = readSlotResult(rt, p, state.seen_sessions);
  if (res.sessionId) state.seen_sessions.push(res.sessionId);
  const hook = summarizeHookLog(p.hook_log);
  rt.log(`${p.role} slot hook: ${describeHookDenials(hook)}`);
  for (const line of describeDeniedCalls(hook, rt.secrets)) rt.log(redact(line, rt.secrets));
  if (!res.ok && p.slot === 1 && /no execution file/.test(res.error)) {
    state.notes.push('The first agent slot wrote no execution file, so the action may have skipped (for example workflow validation).');
  }

  if (p.role === 'push') {
    collectPush(rt, state, p, res, hook);
    return;
  }

  if (p.role === 'review') {
    const L = state.layers[p.layer];
    L.attempts[p.head] = (L.attempts[p.head] || 0) + 1;
    let error = res.ok ? '' : res.error;
    if (res.ok) {
      const errors = validateReviewOutput(res.output, p.layer);
      if (errors.length) error = `invalid output: ${errors.slice(0, 3).join('; ')}`;
      else if (!res.output.completed) error = 'the reviewer reported that it did not finish';
    }
    if (error) {
      L.errors.push(error);
      warn(rt, `${p.layer} review incomplete: ${error}`);
      return;
    }
    const added = applyReview(state, p.layer, res.output, p.head);
    rt.log(`${p.layer} review done: ${added} new blocking finding(s)`);
    return;
  }

  // fix slot
  const L = p.layer === 'L0' ? state.l0 : state.layers[p.layer];
  L.fixes += 1;
  const round = L.fixes;
  if (snapshotProtected(rt) !== p.protected_snapshot) {
    restoreProtectedFromBase(rt, state);
    state.notes.push(`The ${p.layer} fix agent changed protected files (.claude, CLAUDE.md, .husky and similar); those changes were reverted.`);
  }
  const touched = revertWorkflows(rt);
  if (touched.length) state.notes.push(`The ${p.layer} fix agent changed workflow files; those changes were reverted: ${touched.slice(0, 5).join(', ')}.`);

  let out = null;
  let error = res.ok ? '' : res.error;
  if (res.ok) {
    const errors = validateFixOutput(res.output);
    if (errors.length) error = `invalid output: ${errors.slice(0, 3).join('; ')}`;
    else out = res.output;
  }
  if (!out) {
    discardChanges(rt, p.untracked_before);
    warn(rt, `${p.layer} fix failed: ${error}`);
    state.notes.push(`The ${p.layer} fix attempt (round ${round}) failed and its edits were discarded: ${error}.`);
    if (p.layer !== 'L0') applyFix(state, p.layer, null, null, round);
    return;
  }

  const ids = out.addressed.filter((id) => /^(L0|L[123]-\d+)$/.test(id)).slice(0, 30);
  const body = p.layer === 'L0'
    ? `Failing commands: ${state.l0.failures.map((f) => f.command).join('; ')}\n`
    : `Findings: ${ids.join(', ') || 'none listed'}\n`;
  const sha = commitAll(rt, `${fixSubject(p.layer, round)}\n\n${body}`, p.untracked_before);
  if (sha) {
    // The commit stays local. The next decision is the push slot, which puts it on the branch.
    state.head = sha;
    state.commits.push({ sha, layer: p.layer, round, subject: fixSubject(p.layer, round), ids: p.layer === 'L0' ? [] : ids,
      files: changedFiles(rt, `${sha}^`, sha).slice(0, 200), pushed: false });
    state.push_pending = { sha, layer: p.layer, round, kind: 'fix' };
  } else {
    discardChanges(rt, p.untracked_before);
    rt.log(`${p.layer} fix round ${round} made no changes; it still counts as a round`);
  }
  if (p.layer !== 'L0') applyFix(state, p.layer, out, sha, round);
}

/** Write the per-slot settings (the hook) and return the settings path and the hook log path. */
function slotHook(rt, state, role) {
  const logPath = hookLogPath(rt, state.slots_used + 1, role);
  const settings = writeSlotSettings(rt, role, { inDir: role === 'push' ? '' : rt.inDir, logPath });
  return { settings, logPath };
}

function prepareSlot(rt, state, d) {
  if (d.type === 'push') return preparePush(rt, state);
  const role = d.type === 'review' ? 'review' : 'fix';
  const layer = d.layer;
  resetInDir(rt);
  writeSlotInputs(rt, state, { role, layer });
  restoreProtectedFromBase(rt, state);
  const round = role === 'review' ? state.layers[layer].review_passes + 1 : (layer === 'L0' ? state.l0.fixes : state.layers[layer].fixes) + 1;
  const template = role === 'review' ? `review-${layer.toLowerCase()}` : (layer === 'L0' ? 'fix-l0' : 'fix');
  const prompt = renderPrompt(template, { IN_DIR: rt.inDir, LAYER: layer, ROUND: String(round), EXTRA: extraBlock(state.config.extra_prompt) });
  const hook = slotHook(rt, state, role);
  const args = buildArgs(state.config, { role, layer, inDir: rt.inDir, settings: hook.settings });
  state.slots_used += 1;
  state.pending = {
    role, layer, head: state.head, round, issued_at: rt.now(), max_turns: slotMaxTurns(state.config, role),
    slot: state.slots_used, hook_log: hook.logPath,
    protected_snapshot: snapshotProtected(rt),
    untracked_before: listUntracked(rt).slice(0, 5000),
  };
  writeGithubEnv(rt, {
    CLR_NEXT: 'agent', CLR_PROMPT: prompt, CLR_ARGS: args, CLR_STEP_TIMEOUT: String(state.config.agent_step_timeout_minutes), ...binaries(rt),
  });
  rt.log(`Slot ${state.slots_used}: ${role} ${layer} round ${round}`);
}

/** The push slot: a haiku agent whose one allowed command is `git push origin HEAD`. */
function preparePush(rt, state) {
  const pp = state.push_pending;
  if (headSha(rt) !== pp.sha) throw new Error('HEAD is not the fix commit that is waiting to be pushed');
  const hook = slotHook(rt, state, 'push');
  const prompt = renderPrompt('push', {});
  const args = buildArgs(state.config, { role: 'push', settings: hook.settings });
  state.slots_used += 1;
  state.pending = {
    role: 'push', layer: pp.layer, head: state.head, round: pp.round, issued_at: rt.now(), max_turns: PUSH_MAX_TURNS,
    slot: state.slots_used, hook_log: hook.logPath, push: { ...pp },
  };
  writeGithubEnv(rt, {
    CLR_NEXT: 'agent', CLR_PROMPT: prompt, CLR_ARGS: args, CLR_STEP_TIMEOUT: String(PUSH_STEP_TIMEOUT_MINUTES), ...binaries(rt),
  });
  rt.log(`Slot ${state.slots_used}: push ${pp.layer} round ${pp.round} (${pp.sha.slice(0, 7)})`);
}

const writeDone = (rt) => writeGithubEnv(rt, { CLR_NEXT: 'done', CLR_PROMPT: '', CLR_ARGS: '', CLR_STEP_TIMEOUT: '', ...binaries(rt) });

export async function step(rt) {
  const state = loadState(rt);
  if (!state) throw new Error('No state file. Run `init` first.');
  const done = (reason) => {
    state.finished = true;
    state.done_reason = state.done_reason || reason;
    saveState(rt, state);
    writeDone(rt);
    rt.log(`Loop finished: ${reason}`);
  };
  if (state.finished) { writeDone(rt); return; }
  try {
    if (state.pending) collect(rt, state);
    cleanBetweenSlots(rt);
    for (let i = 0; i < 60; i++) {
      const d = decide(state, rt.now());
      if (d.type === 'done') return done(d.reason);
      if (d.type === 'l0') { await runL0(rt, state); saveState(rt, state); continue; }
      prepareSlot(rt, state, d);
      saveState(rt, state);
      return undefined;
    }
    throw new Error('the loop did not settle after 60 decisions');
  } catch (e) {
    state.fatal = String(e && e.message ? e.message : e).slice(0, 400);
    state.pending = null;
    warn(rt, `driver error: ${state.fatal}`);
    return done('error');
  }
}

// report -------------------------------------------------------------------------------------------

export async function report(rt) {
  const state = loadState(rt);
  if (!state) { rt.log('No state file: the driver never initialized, so there is nothing to report.'); return; }
  if (state.pending) {
    try { collect(rt, state); } catch (e) { state.fatal = String(e && e.message ? e.message : e).slice(0, 400); state.pending = null; }
    state.finished = true;
    state.done_reason = state.done_reason || 'ended';
    saveState(rt, state);
  }
  cleanBetweenSlots(rt);
  let inlined = new Set();
  inlined.failed = new Set();
  try { inlined = postInline(rt, state); } catch (e) { warn(rt, `inline comments failed: ${e.message}`); }
  const r = buildReport(rt, state, inlined);
  writeStepSummary(rt, r.visible);
  postSummary(rt, state, r.body);
  rt.log(`Summary posted. Unresolved blocking findings: ${unresolvedBlocking(state).length}`);
}

// main ---------------------------------------------------------------------------------------------

export async function main(argv, rt = createRuntime()) {
  const cmd = argv[0];
  if (cmd === 'init') return init(rt);
  if (cmd === 'step') return step(rt);
  if (cmd === 'report') return report(rt);
  throw new Error('usage: driver.mjs init|step|report');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(`::error::${e && e.message ? e.message : e}`);
    process.exit(1);
  });
}

