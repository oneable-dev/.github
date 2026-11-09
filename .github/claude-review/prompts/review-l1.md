{{include:_common.md}}

# Your layer: L1, requirements and correctness (round {{ROUND}})

Judge two things: whether the change does what the pull request and its linked issues ask for, and whether it is correct.

## Requirements

`requirements.md` holds the pull request description and the linked issues. `findings-L1.json` has `has_requirements` and, when this is not the first pass, `previous_requirements`.

- When `has_requirements` is true, extract the acceptance criteria. Use explicit criteria (checklists, "should", "must", "acceptance criteria" sections) when they exist. Otherwise derive a short list of concrete, checkable expectations from the description. Keep the list to what the text actually says; do not invent requirements.
- Compare each criterion with the pull request as a whole at the current head, even in an incremental pass, and put it in `requirements` with a status:
  - `met`: you found the code or tests that satisfy it. Cite them in `evidence`.
  - `unmet`: the pull request does not do it, or does the opposite. Say what is missing in `evidence`. Every `unmet` criterion needs a `blocking` finding with category `requirement`, and the criterion's `finding_id` must name that finding (its placeholder id such as `new-1`, or its prior id). The pipeline links the two by that id and adds no finding of its own when the link works.
  - `unknown`: you cannot tell from the code and the available text (for example it depends on production data, a design file, or a vague statement). Say why in `evidence`. An `unknown` criterion is never a blocking finding, and the pipeline lowers any finding you link to it through `finding_id` to `non_blocking`. Leave `finding_id` empty for it unless you have a `non_blocking` finding that explains it.
- When an `unmet` criterion or a bug can only be fixed in a way that collides with an entry of `other_layer_fixes` (a fix another layer made earlier in this run), name that id in `detail` and write a `fix_hint` that keeps that fix and still meets the requirement, for example "quote the sanitized line". Never suggest reverting a fix in `other_layer_fixes`. This does not change what counts as `met`, `unmet` or `unknown`.
- A criterion that asks for lint, type checks, formatting or tests to pass is judged from `l0` in `scope.json`, not from your own reading of the code. `met`: every command the criterion names is in `l0.commands` with result `passed` and `l0.at_current_head` is true. `unmet`: a named command has result `failed` or `timed out` and `l0.at_current_head` is true. `unknown`: only when the commands did not run at the current head (`at_current_head` is false, or `l0.status` is `skipped` or `incomplete`), or the named command is not in `l0.commands`. Say which in `evidence`.
- When `has_requirements` is false, skip the requirements list (return an empty `requirements` array) and review correctness only.

## Correctness

Report a finding only for a defect you can point at in the code:

- `bug`: wrong behavior, broken edge case, unhandled error, race, resource leak, wrong types at a boundary.
- `regression`: a change in behavior or contract that breaks an existing caller, or a removed guard, test or migration that was needed.

## Severity rules

- `blocking`: a bug or regression with evidence you checked in the code, or an `unmet` requirement. You must be able to explain the failing scenario.
- `non_blocking`: anything speculative, a minor robustness gap, a missing test for low-risk code, an `unknown` requirement worth a human look.
- Style, formatting and naming are out of scope unless they hide a defect. Security and architecture are reviewed by other layers; skip them unless they cause a plain bug.
