/**
 * state
 *
 * What: Reads the workflow inputs (CLR_INPUT_*), and loads and saves the loop state file.
 * Why: The state file is the only memory between driver calls. It lives outside the checkout
 *      and outside the agent's --add-dir, so an agent (read-only tools, or edit tools limited to the
 *      checkout) cannot edit it.
 *      Trust model: L0 commands run code from the pull request as the same OS user as the driver, with a
 *      sanitized environment but no sandbox. That code can read and rewrite the state file, HOME and anything
 *      else the user can reach. What bounds this is who can reach L0 at all: fork pull requests are excluded
 *      by the workflow, and a bot trigger skips L0, so L0 only runs code from people with write access to
 *      this repository. Do not treat the state file as tamper-proof against such a person.
 * Not covered: Deciding what happens next (plan.mjs).
 */
import { join } from 'node:path';
import { readJson, writeJsonAtomic } from './util.mjs';

/** Agent slots per run. The workflow YAML repeats its step/agent pair this many times. */
export const MAX_SLOTS = 60;
/** Job time that must be left to start a review slot. */
export const MIN_SECONDS_FOR_AGENT = 25 * 60;
/** Job time that must be left to start a fix slot: the fix (up to 20 minutes) plus the push that follows it. */
export const MIN_SECONDS_FOR_FIX = 35 * 60;
/** Job time that must be left to start a push slot (which has a 5 minute timeout). */
export const MIN_SECONDS_FOR_PUSH = 10 * 60;
export const PUSH_STEP_TIMEOUT_MINUTES = 5;
export const DEFAULT_AGENT_STEP_TIMEOUT_MINUTES = 20;
export const L0_COMMAND_SECONDS = 15 * 60;
/** Why a fix commit was left unpushed when no push slot could be started. */
export const NO_PUSH_ROOM = 'not enough job time or agent steps left to push';

const num = (v, d) => {
  if (v === undefined || v === '') return d;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : d;
};

/** `defaults` apply only when the variable is unset. An empty string is a deliberate "off". */
export function readConfig(env) {
  const raw = (name, def = '') => {
    const v = env[`CLR_INPUT_${name}`];
    return v === undefined ? def : String(v);
  };
  const reviewModel = raw('REVIEW_MODEL', 'claude-opus-5-5').trim();
  const lines = (s) => s.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  return {
    review_model: reviewModel,
    review_effort: raw('REVIEW_EFFORT', 'high').trim(),
    models: {
      L1: raw('L1_MODEL').trim() || reviewModel,
      L2: raw('L2_MODEL').trim() || reviewModel,
      L3: raw('L3_MODEL').trim() || reviewModel,
    },
    fix_model: raw('FIX_MODEL', 'claude-sonnet-5-5').trim(),
    fix_effort: raw('FIX_EFFORT', 'medium').trim(),
    max_turns: num(raw('MAX_TURNS'), 30),
    fix_max_turns: num(raw('FIX_MAX_TURNS'), 40),
    max_fix_rounds: num(raw('MAX_FIX_ROUNDS'), 3),
    timeout_minutes: num(raw('TIMEOUT_MINUTES'), 60),
    // Never 0: the workflow reads CLR_STEP_TIMEOUT through fromJSON, and '0' would fall back to the input.
    agent_step_timeout_minutes: num(raw('AGENT_STEP_TIMEOUT_MINUTES'), DEFAULT_AGENT_STEP_TIMEOUT_MINUTES) || DEFAULT_AGENT_STEP_TIMEOUT_MINUTES,
    extra_prompt: raw('EXTRA_PROMPT'),
    allowed_bots: raw('ALLOWED_BOTS', '*'),
    setup_command: raw('SETUP_COMMAND').trim(),
    check_commands: lines(raw('CHECK_COMMANDS')),
    fix_command: raw('FIX_COMMAND').trim(),
    enable_fix: raw('ENABLE_FIX', 'true').trim().toLowerCase() !== 'false',
  };
}

export const statePath = (rt) => join(rt.stateDir, 'state.json');

export function loadState(rt) {
  return readJson(statePath(rt), null);
}

export function saveState(rt, state) {
  writeJsonAtomic(statePath(rt), state);
}

export function emptyLayer() {
  return {
    last_reviewed_sha: null,
    reviewed_head: null,
    attempts: {},
    fixes: 0,
    capped: false,
    findings: [],
    requirements: [],
    review_passes: 0,
    errors: [],
  };
}

export function emptyL0() {
  return {
    status: 'unrun', // unrun | pass | fail | skipped | incomplete
    ran_head: null,
    fixes: 0,
    autofix_runs: 0,
    setup_done: false,
    capped: false,
    failures: [],
    results: [], // every command of the last run: {command, result, exit_code, seconds, timed_out, skipped}
    history: [],
    skipped_reason: '',
  };
}
