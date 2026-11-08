/**
 * plan
 *
 * What: Decides the next step of the loop from the state alone: run L0, run a review, run a fix, or stop.
 * Why: The loop order is the core of the pipeline, so it is a pure function that tests can drive.
 *      A cycle runs L0, then L1, L2, L3, and stops at the first layer with a blocking finding to fix it.
 *      After any fix the cycle starts over from L0; the layers re-review only what changed.
 *      A layer at its fix limit (or any fix-free condition) turns on `fixes_disabled`: the layers after it
 *      are reviewed once without fixes, then the run stops.
 * Not covered: Running anything (driver.mjs).
 */
import { openBlocking } from './findings.mjs';
import { LAYERS } from './util.mjs';
import { MAX_SLOTS, MIN_SECONDS_FOR_AGENT } from './state.mjs';

/** A fix is only worth starting when a complete re-review (3 layers) can still follow it. */
const SLOTS_FOR_FIX = 4;

export function secondsLeft(state, nowMs) {
  return state.timeout_minutes * 60 - (nowMs / 1000 - state.started_at);
}

/**
 * Returns {type: 'done', reason} | {type: 'l0'} | {type: 'review', layer} | {type: 'fix', layer}.
 * Mutates `state` only to record why fixes were turned off.
 */
export function decide(state, nowMs) {
  const cfg = state.config;
  if (state.stop) return { type: 'done', reason: state.stop.reason };

  const left = secondsLeft(state, nowMs);
  const timeOk = left >= MIN_SECONDS_FOR_AGENT;
  const slotsLeft = MAX_SLOTS - state.slots_used;
  const canSpawn = timeOk && slotsLeft >= 1;
  const canFix = canSpawn && slotsLeft >= SLOTS_FOR_FIX;
  const head = state.head;

  const disableFixes = (why) => { if (!state.fixes_disabled) state.fixes_disabled = why; };
  const fixesOff = () => Boolean(state.fixes_disabled);

  // L0: deterministic gate.
  const l0 = state.l0;
  if (l0.status !== 'skipped') {
    if (l0.ran_head !== head) {
      if (!timeOk) {
        l0.status = 'incomplete';
        l0.skipped_reason = 'not enough job time left to run the checks';
      } else {
        return { type: 'l0' };
      }
    }
    if (l0.status === 'fail') {
      if (fixesOff()) {
        // No fix will happen; still review.
      } else if (l0.fixes >= cfg.max_fix_rounds) {
        l0.capped = true;
        disableFixes('cap:L0');
      } else if (!canFix) {
        disableFixes(timeOk ? 'slots' : 'time');
      } else {
        return { type: 'fix', layer: 'L0' };
      }
    }
  }

  for (const layer of LAYERS) {
    const L = state.layers[layer];
    const handled = L.reviewed_head === head || (L.attempts[head] || 0) >= 2;
    if (!handled) {
      if (!canSpawn) return { type: 'done', reason: timeOk ? 'slots' : 'time' };
      return { type: 'review', layer };
    }
    if (L.reviewed_head !== head) continue; // review failed twice; reported as incomplete
    if (openBlocking(L).length === 0 || fixesOff()) continue;
    if (L.fixes >= cfg.max_fix_rounds) {
      L.capped = true;
      disableFixes(`cap:${layer}`);
      continue;
    }
    if (!canFix) {
      disableFixes(timeOk ? 'slots' : 'time');
      continue;
    }
    return { type: 'fix', layer };
  }
  return { type: 'done', reason: 'complete' };
}
