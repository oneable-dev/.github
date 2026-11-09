/**
 * pretooluse
 *
 * What: Role-based PreToolUse policy for the review loop's agent slots (review, fix, push) and for the
 *       `@claude` mention workflow (mention, mention-ro).
 * Why: The tool allowlists passed on the command line are prefix rules. This hook is the second,
 *      stricter layer: it resolves real paths (symlinks included), keeps agents out of .git and
 *      protected configuration, and narrows Bash to single, metacharacter-free commands.
 * Not covered: Generating the settings JSON that registers this hook (driver wiring).
 *
 * Usage: node pretooluse.mjs <role> <workspace> <inDir> <logPath>   (hook JSON on stdin)
 *   - Appends one JSONL row per call to <logPath>.
 *   - Deny: prints a PreToolUse deny decision whose reason is `CLR_HOOK_DENY:<rule>`, exits 0.
 *   - Allow: prints nothing, exits 0.
 *   - Any internal error (bad input, unknown role, unwritable log) exits 2, so the call fails closed.
 *
 * Allowlists are no broader than REVIEW_TOOLS / FIX_TOOLS in lib/agent.mjs, plus StructuredOutput,
 * the action's structured-result tool.
 *
 * The mention roles run claude-code-action in tag mode (pinned v1.0.269, src/modes/tag/index.ts). Tag mode
 * auto-allows Glob/Grep/LS/Read, the comment MCP tool, the CI MCP tools, `git add`/`git commit`/`git rm`
 * and the action's scripts/git-push.sh wrapper, and its acceptEdits permission mode lets Edit/MultiEdit/Write
 * and a few file commands (rm, mv, cp, sed) run unprompted. The mention roles allow only the subset that the
 * action's own prompt asks for, with path checks, and deny everything else (so rm/mv/cp/sed are denied):
 *   - mention:    reads, read-only git, Edit/MultiEdit/Write, `git add|rm|commit`, the push wrapper, MCP tools.
 *   - mention-ro: reads, read-only git and the MCP tools that only read or update the tracking comment.
 * `git commit` messages and file-ops commit messages with a `Co-authored-by:` trailer are denied (rule
 * `commit-attribution`): the action's prompt asks for one and has no switch to turn it off.
 * Both roles keep agents out of .git, `.github/**` (workflows included) and the other protected paths.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MARKER = 'CLR_HOOK_DENY:';
export const ROLES = ['review', 'fix', 'push', 'mention', 'mention-ro'];
const MENTION_ROLES = new Set(['mention', 'mention-ro']);

const READ_TOOLS = new Set(['Read', 'Grep', 'Glob']);
const WRITE_TOOLS = new Set(['Edit', 'MultiEdit', 'Write']);

// Same list as RESTORE_PATHS / NO_STAGE_PATHS in lib/gitops.mjs, plus the .git and .github directories.
// Matched per path segment, case-insensitively (the checkout may sit on a case-insensitive filesystem).
const PROTECTED_SEGMENTS = new Set(
  [
    '.git', '.github', '.claude', '.claude-pr', '.mcp.json', '.claude.json', '.gitmodules',
    '.ripgreprc', 'CLAUDE.md', 'CLAUDE.local.md', '.husky',
  ].map((s) => s.toLowerCase()),
);

// The mention roles also protect CODEOWNERS files, wherever they sit (the workflow's standing instructions
// name them). Other roles keep PROTECTED_SEGMENTS unchanged.
const MENTION_PROTECTED_SEGMENTS = new Set([...PROTECTED_SEGMENTS, 'codeowners']);

// Read-only Bash commands of the review role (mirrors the Bash(...) entries of REVIEW_TOOLS).
const REVIEW_BASH = [
  ['git', 'diff'], ['git', 'log'], ['git', 'show'], ['gh', 'pr', 'view'], ['gh', 'pr', 'diff'],
];
// Read-only commands of the mention roles. `git status` is added because the action's prompt suggests it;
// `gh` is not needed in tag mode.
const MENTION_READ_BASH = [['git', 'diff'], ['git', 'log'], ['git', 'show'], ['git', 'status']];

// MCP tools that tag mode registers (src/mcp/*.ts at the pin). Server names come from install-mcp-server.ts.
const MCP_COMMENT = 'mcp__github_comment__update_claude_comment';
// Pure remote reads of workflow runs. download_job_log is left out: it writes a log under RUNNER_TEMP, which
// the Read rules cannot reach, so it would be useless and writes outside the workspace.
const MCP_CI_READ = new Set(['mcp__github_ci__get_ci_status', 'mcp__github_ci__get_workflow_run_details']);
// Only registered with use_commit_signing, which the mention workflow does not enable. They commit to the
// remote branch through the API, so their paths get the same checks as Edit/Write.
const MCP_FILE_OPS = { mcp__github_file_ops__commit_files: 'files', mcp__github_file_ops__delete_files: 'paths' };

// Where tag mode saves images from comments (src/github/utils/image-downloader.ts). Readable, never writable.
const DEFAULT_IMAGES_DIR = '/tmp/github-images';
// The push wrapper is `${GITHUB_ACTION_PATH}/scripts/git-push.sh`. When GITHUB_ACTION_PATH is set, only that
// exact path is accepted. When it is not visible to the hook, only the runner's action cache is accepted:
// `<dirname(RUNNER_WORKSPACE)>/_actions/anthropics/claude-code-action/<40 hex>/scripts/git-push.sh`, with the
// root defaulting to /home/runner/work when RUNNER_WORKSPACE is unset or not an absolute path.
const DEFAULT_RUNNER_WORK_ROOT = '/home/runner/work';
const ACTION_CACHE_TAIL = /^_actions\/anthropics\/claude-code-action\/[0-9a-f]{40}\/scripts\/git-push\.sh$/;

/** Root that holds the runner's `_actions` cache: the parent of RUNNER_WORKSPACE, or the default runner layout. */
function actionCacheRoot(runnerWorkspace) {
  if (typeof runnerWorkspace === 'string' && path.isAbsolute(runnerWorkspace)) {
    const parent = path.dirname(path.normalize(runnerWorkspace));
    if (parent !== runnerWorkspace) return parent;
  }
  return DEFAULT_RUNNER_WORK_ROOT;
}
const NO_PUSH_BRANCHES = new Set(['main', 'master']);
// Options that write files, run external programs, or read outside the repository. Matched by prefix
// because git accepts unambiguous abbreviations (`--outp` is `--output`).
const FORBIDDEN_OPTIONS = ['--output', '--ext-diff', '--textconv', '--no-index'];
const PUSH_COMMAND = 'git push origin HEAD';

// Attribution trailer that claude-code-action's prompt tells the model to add to commits. The action has no
// input to turn it off, so the hook denies it and the model retries without it. Matched anywhere in the text,
// case-insensitively, which also catches a trailer written as a literal `\n` sequence inside a quoted message.
const ATTRIBUTION_TRAILER = /co-authored-by\s*:/i;
// Extra text appended to the deny reason of some rules, so the model knows how to retry.
const RULE_HINTS = {
  'commit-attribution': 'remove Co-authored-by trailers and commit again',
};

const deny = (rule) => ({ decision: 'deny', rule });
const allow = (rule) => ({ decision: 'allow', rule });

function truncate(s) {
  return s.length > 200 ? s.slice(0, 200) : s;
}

/**
 * Real path of `p`, resolving symlinks through the nearest existing ancestor. A symlink that cannot be
 * resolved (dangling or looping) is reported as `dangling`, because writing through it would create
 * its target somewhere we cannot see.
 */
function resolveReal(p) {
  let cur = path.resolve(p);
  const rest = [];
  for (;;) {
    try {
      return { real: path.join(fs.realpathSync(cur), ...rest.reverse()), dangling: false };
    } catch {
      let isLink = false;
      try {
        isLink = fs.lstatSync(cur).isSymbolicLink();
      } catch {
        // The path does not exist; walk up to the nearest ancestor that does.
      }
      if (isLink) return { real: path.resolve(p), dangling: true };
      const parent = path.dirname(cur);
      if (parent === cur) return { real: path.resolve(p), dangling: false };
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}

function within(root, abs) {
  const rel = path.relative(root, abs);
  return rel === '' || !(rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel));
}

function segmentsOf(rel) {
  return rel === '' ? [] : rel.split(path.sep).map((s) => s.toLowerCase());
}

/**
 * Locates `raw` (relative paths resolve against the workspace) inside the allowed roots.
 * Returns { root, dangling, segments } where `root` is 'workspace', 'inDir', 'images' (mention roles only)
 * or null (outside all of them) and
 * `segments` lists the lowercase segments below that root, from the resolved path and the lexical one.
 */
function locate(ctx, raw) {
  const abs = path.resolve(ctx.workspace, raw);
  const { real, dangling } = resolveReal(abs);
  for (const name of ['workspace', 'inDir', 'images']) {
    const rootReal = ctx.real[name];
    if (rootReal && within(rootReal, real)) {
      const lexical = within(ctx[name], abs) ? path.relative(ctx[name], abs) : '';
      return {
        root: name,
        dangling,
        real,
        segments: [...segmentsOf(path.relative(rootReal, real)), ...segmentsOf(lexical)],
      };
    }
  }
  return { root: null, dangling, real, segments: [] };
}

function pathField(ti, ...keys) {
  for (const key of keys) if (ti[key] !== undefined) return ti[key];
  return undefined;
}

/**
 * Checks a Glob tool pattern for traversal, absolute escapes and .git segments. The Glob tool returns file
 * names only and never file contents, so broad patterns such as `**` or `src/**` are fine.
 */
function checkGlobPattern(ctx, pattern) {
  const p = pattern.replace(/\\/g, '/');
  if (p.includes('..')) return deny('read-traversal');
  if (p.startsWith('~')) return deny('read-outside');
  if (/(^|[\s/{,(|])\.git($|[\s/},)|])/i.test(p)) return deny('read-git');
  if (p.startsWith('/')) {
    // Only the literal prefix before the first wildcard can be located.
    const literal = p.split(/[*?[{(]/)[0];
    const dir = literal.endsWith('/') ? literal : literal.slice(0, literal.lastIndexOf('/') + 1);
    const loc = locate(ctx, dir || '/');
    if (!loc.root) return deny('read-outside');
    if (loc.segments.includes('.git')) return deny('read-git');
  }
  return null;
}

function decideRead(tool, ti, ctx) {
  const raw = tool === 'Read' ? ti.file_path : pathField(ti, 'path', 'file_path');
  if (tool === 'Read' && (typeof raw !== 'string' || raw === '')) {
    return { target: '', ...deny('read-no-path') };
  }
  if (raw !== undefined && typeof raw !== 'string') return { target: '', ...deny('read-bad-input') };
  const pattern = tool === 'Glob' ? ti.pattern : undefined;
  if (pattern !== undefined && typeof pattern !== 'string') return { target: '', ...deny('read-bad-input') };
  const glob = tool === 'Grep' ? ti.glob : undefined;
  if (glob !== undefined && glob !== null && typeof glob !== 'string') return { target: '', ...deny('read-bad-input') };
  const target = truncate(raw ?? pattern ?? ti.pattern ?? '.');

  // Grep/Glob without a path search the workspace.
  const loc = locate(ctx, raw === undefined || raw === '' ? '.' : raw);
  if (loc.dangling) return { target, ...deny('read-dangling-link') };
  if (!loc.root) return { target, ...deny('read-outside') };
  if (loc.segments.includes('.git')) return { target, ...deny('read-git') };
  if (pattern !== undefined) {
    const bad = checkGlobPattern(ctx, pattern);
    if (bad) return { target, ...bad };
  }
  // Claude Code runs Grep as `rg --glob !.git ... --glob <glob>`. ripgrep gives the later whitelist glob
  // priority, so a glob such as `*.git` or `*.{git,x}` re-includes .git/config, where the checkout token
  // lives. Matching such patterns is whack-a-mole, so Grep takes no glob at all (`path` and `type` remain).
  if (typeof glob === 'string' && glob !== '') return { target, ...deny('grep-glob-disallowed') };
  return { target, ...allow('read-ok') };
}

/** Write rule for one path: inside the workspace, outside the input directory, no protected segment. */
function checkWritePath(ctx, raw, protectedSegments) {
  const loc = locate(ctx, raw);
  if (loc.dangling) return deny('write-dangling-link');
  if (loc.root !== 'workspace') return deny('write-outside-workspace');
  // The input directory is read-only, also when it is nested inside the workspace.
  if (ctx.real.inDir && within(ctx.real.inDir, loc.real) && !within(ctx.real.inDir, ctx.real.workspace)) {
    return deny('write-in-dir');
  }
  if (loc.segments.some((s) => protectedSegments.has(s))) return deny('write-protected');
  return allow('write-ok');
}

function decideWrite(ti, ctx, protectedSegments = PROTECTED_SEGMENTS) {
  const raw = ti.file_path;
  if (typeof raw !== 'string' || raw === '') return { target: '', ...deny('write-no-path') };
  return { target: truncate(raw), ...checkWritePath(ctx, raw, protectedSegments) };
}

/**
 * Splits a command into words, honouring single and double quotes. Returns null when a quote is left
 * open. A word records whether it holds an unquoted glob/brace character or starts with an unquoted
 * tilde, because the shell would expand those (a file named `--output=x` could become an option).
 */
function tokenize(command) {
  const words = [];
  let cur = null;
  let quote = null;
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur.text += ch;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      if (cur) words.push(cur);
      cur = null;
      continue;
    }
    cur ??= { text: '', expands: false };
    if (ch === '"' || ch === "'") quote = ch;
    else {
      if ('*?[]{}'.includes(ch) || (ch === '~' && cur.text === '' && !cur.quoted)) cur.expands = true;
      cur.text += ch;
    }
    if (ch === '"' || ch === "'") cur.quoted = true;
  }
  if (quote) return null;
  if (cur) words.push(cur);
  return words;
}

/**
 * True when a positional Bash argument could reach outside the workspace or into .git: an absolute path,
 * a `..` or `.git` segment (any case), or a path that resolves elsewhere. Without this, git diffs a path
 * outside the work tree against another file (`git diff /dev/null .git/config`). Revisions such as
 * `HEAD~1`, `a..b` and `origin/main...HEAD` pass because only whole segments are compared. For git, each
 * `:`-separated part is checked too (`HEAD:path`, `:path`).
 */
function badBashPath(ctx, word, isGit) {
  for (const part of isGit ? word.split(':') : [word]) {
    if (part === '') continue;
    if (part.startsWith('/') || path.isAbsolute(part)) return true;
    const segments = part.split('/');
    if (segments.some((s) => s === '..' || s.toLowerCase() === '.git')) return true;
    const loc = locate(ctx, part);
    if (loc.root !== 'workspace' || loc.dangling || loc.segments.includes('.git')) return true;
  }
  return false;
}

/** Option and path checks shared by the read-only commands of the review and mention roles. */
function checkReadOnlyArgs(ctx, prefix, args) {
  for (const word of args) {
    const name = word.split('=')[0];
    if (name.startsWith('-O')) return deny('bash-option');
    if (name.length >= 3 && name.startsWith('--') && FORBIDDEN_OPTIONS.some((f) => f.startsWith(name))) {
      return deny('bash-option');
    }
  }
  // Positional arguments are revisions or paths. Everything after `--` is a path, even if it starts with `-`.
  const isGit = prefix[0] === 'git';
  let pathsOnly = false;
  for (const word of args) {
    if (!pathsOnly && word === '--') {
      pathsOnly = true;
      continue;
    }
    if (!pathsOnly && word.startsWith('-')) continue;
    if (badBashPath(ctx, word, isGit)) return deny('bash-path-outside');
  }
  return null;
}

function decideReviewBash(ctx, command) {
  if (typeof command !== 'string' || command.trim() === '') return deny('bash-not-allowed');
  // Metacharacters: ; | & $ ` < > ( ) newline backslash, plus control characters.
  if (/[;|&$`<>()\\\x00-\x08\x0a-\x1f\x7f]/.test(command)) return deny('bash-metachar');
  const words = tokenize(command);
  if (!words) return deny('bash-syntax');
  if (words.some((w) => w.expands)) return deny('bash-expansion');
  const cooked = words.map((w) => w.text);
  const prefix = REVIEW_BASH.find((cmd) => cmd.every((part, i) => cooked[i] === part));
  if (!prefix) return deny('bash-not-allowed');
  const bad = checkReadOnlyArgs(ctx, prefix, cooked.slice(prefix.length));
  return bad ?? allow('bash-review-ok');
}

/**
 * Splits a mention-role command into words. Stricter than a shell and more tolerant than `tokenize`: commit
 * messages need parentheses, angle brackets (`Co-authored-by: A <a@b>`), semicolons and newlines, which are
 * literal inside quotes. So metacharacters are rejected outside quotes only, while inside quotes the
 * characters that stay active (`$`, backtick, and a backslash in double quotes) are still rejected.
 * Returns { rule } on a violation or { words } where a word is { text, expands }.
 */
function parseMentionCommand(command) {
  const words = [];
  let cur = null;
  let quote = null;
  for (const ch of command) {
    const code = ch.charCodeAt(0);
    if (code === 0x7f || (code < 0x20 && ch !== '\n' && ch !== '\t')) return { rule: 'bash-metachar' };
    if (quote === "'") {
      if (ch === "'") quote = null;
      else cur.text += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === '$' || ch === '`' || ch === '\\') return { rule: 'bash-metachar' };
      else cur.text += ch;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      if (cur) words.push(cur);
      cur = null;
      continue;
    }
    if (';|&$`<>()\\\n'.includes(ch)) return { rule: 'bash-metachar' };
    cur ??= { text: '', expands: false };
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if ('*?[]{}'.includes(ch) || (ch === '~' && cur.text === '')) cur.expands = true;
    cur.text += ch;
  }
  if (quote) return { rule: 'bash-syntax' };
  if (cur) words.push(cur);
  return { words };
}

/** True when the tree below `dir` (a real path) holds an entry with a protected name. Gives up (true) on huge trees. */
function holdsProtectedEntry(dir, protectedSegments, budget = 50000) {
  try {
    // A file, a link or a missing path has nothing below it.
    if (!fs.lstatSync(dir).isDirectory()) return false;
  } catch {
    return false;
  }
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return true;
    }
    for (const entry of entries) {
      if (--budget < 0 || protectedSegments.has(entry.name.toLowerCase())) return true;
      if (entry.isDirectory()) stack.push(path.join(current, entry.name));
    }
  }
  return false;
}

/**
 * Checks one path argument of `git add` / `git rm`. Rejects what git would expand or reinterpret (globs,
 * pathspec magic), anything outside the workspace or in .git, protected paths, and the workspace root itself
 * (which would sweep in every protected path). `removing` also rejects directories that contain protected
 * entries, because `git rm -r dir` would delete them.
 */
function checkGitPathArg(ctx, word, removing) {
  if (word === '' || /[*?[\\]/.test(word) || word.startsWith(':')) return deny('bash-pathspec');
  if (word.startsWith('/') || path.isAbsolute(word)) return deny('bash-path-outside');
  if (word.split('/').some((s) => s === '..' || s.toLowerCase() === '.git')) return deny('bash-path-outside');
  const loc = locate(ctx, word);
  if (loc.root !== 'workspace' || loc.dangling) return deny('bash-path-outside');
  if (loc.real === ctx.real.workspace) return deny('bash-path-broad');
  if (loc.segments.some((s) => MENTION_PROTECTED_SEGMENTS.has(s))) return deny('bash-path-protected');
  if (removing && holdsProtectedEntry(loc.real, MENTION_PROTECTED_SEGMENTS)) return deny('bash-path-protected');
  return null;
}

/** Name of the checked-out branch, or null for a detached HEAD or an unreadable repository. */
function currentBranch(workspace) {
  try {
    let gitDir = path.join(workspace, '.git');
    if (fs.statSync(gitDir).isFile()) {
      const match = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(gitDir, 'utf8'));
      if (!match) return null;
      gitDir = path.resolve(workspace, match[1].trim());
    }
    const head = /^ref: refs\/heads\/(.+)$/.exec(fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim());
    return head ? head[1] : null;
  } catch {
    return null;
  }
}

function isPushWrapper(ctx, word) {
  if (!path.isAbsolute(word) || path.normalize(word) !== word) return false;
  // A script the agent wrote into the checkout must never count as the action's wrapper.
  if (within(ctx.workspace, word) || within(ctx.real.workspace, resolveReal(word).real)) return false;
  // GITHUB_ACTION_PATH decides when it is set: no other location is a fallback.
  if (ctx.actionPath) return word === path.join(ctx.actionPath, 'scripts', 'git-push.sh');
  const root = ctx.actionCacheRoot;
  return word.startsWith(`${root}/`) && ACTION_CACHE_TAIL.test(word.slice(root.length + 1));
}

/**
 * `<action>/scripts/git-push.sh origin HEAD|<current branch>`: the only push form tag mode allows. The
 * wrapper itself rejects flags and other remotes; this also pins the ref to the checked-out branch and
 * refuses the default-branch names.
 */
function decideMentionPush(ctx, cooked) {
  if (cooked.length !== 3 || !isPushWrapper(ctx, cooked[0]) || cooked[1] !== 'origin') {
    return deny('bash-not-allowed');
  }
  const ref = cooked[2];
  const branch = currentBranch(ctx.workspace);
  if (!branch) return deny('push-no-branch');
  if (NO_PUSH_BRANCHES.has(branch.toLowerCase())) return deny('push-default-branch');
  if (ref !== 'HEAD' && ref !== branch) return deny('push-ref');
  if (!/^[A-Za-z0-9_][A-Za-z0-9._/-]*$/.test(branch) || branch.includes('..') || branch.includes('//')) {
    return deny('push-ref');
  }
  return allow('bash-push-ok');
}

/** `git commit` takes a message and optionally --signoff, nothing else: no -a, --amend, pathspecs or -F. */
function checkCommitArgs(args) {
  let messages = 0;
  for (let i = 0; i < args.length; i++) {
    const word = args[i];
    if (word === '-m' || word === '--message') {
      if (++i >= args.length) return deny('bash-option');
      messages++;
    } else if (word.startsWith('--message=')) {
      messages++;
    } else if (word !== '-s' && word !== '--signoff') {
      return deny('bash-option');
    }
  }
  return messages > 0 ? null : deny('bash-option');
}

/**
 * Bash policy of the mention roles. Read-only git commands are allowed for both. `mention` additionally allows
 * what tag mode lists (git add, git rm, git commit, the push wrapper) with the checks above; everything else
 * (git mv/checkout/reset/config, rm/mv/cp/sed, gh, shells) is denied.
 */
function decideMentionBash(ctx, command, { readOnly }) {
  if (typeof command !== 'string' || command.trim() === '') return deny('bash-not-allowed');
  // Checked on the raw command, before parsing: a trailer written with a literal `\n` inside double quotes
  // would otherwise be reported as a metacharacter, and the model would not learn what to remove.
  if (!readOnly && /^\s*git\s+commit(\s|$)/.test(command) && ATTRIBUTION_TRAILER.test(command)) {
    return deny('commit-attribution');
  }
  const parsed = parseMentionCommand(command);
  if (parsed.rule) return deny(parsed.rule);
  if (parsed.words.some((w) => w.expands)) return deny('bash-expansion');
  const cooked = parsed.words.map((w) => w.text);

  const readPrefix = MENTION_READ_BASH.find((cmd) => cmd.every((part, i) => cooked[i] === part));
  if (readPrefix) return checkReadOnlyArgs(ctx, readPrefix, cooked.slice(readPrefix.length)) ?? allow('bash-read-ok');
  if (readOnly) return deny('bash-not-allowed');

  if (cooked[0] === 'git' && (cooked[1] === 'add' || cooked[1] === 'rm')) {
    const removing = cooked[1] === 'rm';
    const optionsAllowed = removing ? new Set(['-r', '-q', '--cached']) : new Set();
    let paths = 0;
    let pathsOnly = false;
    for (const word of cooked.slice(2)) {
      if (!pathsOnly && word === '--') {
        pathsOnly = true;
      } else if (!pathsOnly && word.startsWith('-')) {
        if (!optionsAllowed.has(word)) return deny('bash-option');
      } else {
        const bad = checkGitPathArg(ctx, word, removing);
        if (bad) return bad;
        paths++;
      }
    }
    return paths > 0 ? allow(removing ? 'bash-git-rm-ok' : 'bash-git-add-ok') : deny('bash-no-path');
  }
  if (cooked[0] === 'git' && cooked[1] === 'commit') {
    return checkCommitArgs(cooked.slice(2)) ?? allow('bash-git-commit-ok');
  }
  return decideMentionPush(ctx, cooked);
}

/** MCP tools of tag mode. Writes through the file-ops server get the same path rules as Edit and Write. */
function decideMentionMcp(tool, ti, ctx, readOnly) {
  if (tool === MCP_COMMENT) {
    return typeof ti.body === 'string' ? allow('mcp-comment-ok') : deny('mcp-bad-input');
  }
  if (MCP_CI_READ.has(tool)) return allow('mcp-ci-read-ok');
  const field = MCP_FILE_OPS[tool];
  if (field && !readOnly) {
    const paths = ti[field];
    if (!Array.isArray(paths) || paths.length === 0 || paths.some((p) => typeof p !== 'string' || p === '')) {
      return deny('mcp-bad-input');
    }
    if (typeof ti.message === 'string' && ATTRIBUTION_TRAILER.test(ti.message)) return deny('commit-attribution');
    for (const p of paths) {
      const verdict = checkWritePath(ctx, p, MENTION_PROTECTED_SEGMENTS);
      if (verdict.decision === 'deny') return verdict;
    }
    return allow('mcp-file-ops-ok');
  }
  return deny('tool-not-allowed');
}

/** Policy of the `mention` and `mention-ro` roles (claude-code-action tag mode). */
function decideMention(role, tool, ti, ctx) {
  const readOnly = role === 'mention-ro';
  // ToolSearch only loads tool schemas; the action's prompt tells the agent to load the comment tool with it.
  if (tool === 'ToolSearch') return allow('tool-search');
  if (READ_TOOLS.has(tool) || tool === 'LS') return decideRead(tool, ti, ctx);
  if (!readOnly && WRITE_TOOLS.has(tool)) return decideWrite(ti, ctx, MENTION_PROTECTED_SEGMENTS);
  if (tool === 'Bash') return decideMentionBash(ctx, ti.command, { readOnly });
  if (tool.startsWith('mcp__')) return decideMentionMcp(tool, ti, ctx, readOnly);
  return deny('tool-not-allowed');
}

function targetOf(ti) {
  if (typeof ti.command === 'string') return truncate(ti.command);
  const first = ti.file_path ?? ti.path ?? ti.pattern;
  return truncate(typeof first === 'string' ? first : JSON.stringify(ti));
}

/**
 * Pure decision function. `input` is the hook JSON; `opts` is { role, workspace, inDir }, plus optional
 * overrides for tests: `imagesDir` (read-only image directory of the mention roles), `actionPath`
 * (GITHUB_ACTION_PATH, which locates the push wrapper) and `runnerWorkspace` (RUNNER_WORKSPACE, which locates
 * the runner's action cache when `actionPath` is empty). Both default to the process environment.
 * Returns { target, decision, rule }. Throws on malformed input or an unknown role.
 */
export function decide(
  input,
  {
    role,
    workspace,
    inDir,
    imagesDir = DEFAULT_IMAGES_DIR,
    actionPath = process.env.GITHUB_ACTION_PATH,
    runnerWorkspace = process.env.RUNNER_WORKSPACE,
  } = {},
) {
  if (!ROLES.includes(role)) throw new Error(`unknown role: ${role}`);
  if (typeof workspace !== 'string' || workspace === '') throw new Error('missing workspace');
  const tool = input?.tool_name;
  if (typeof tool !== 'string' || tool === '') throw new Error('missing tool_name');
  const ti = input.tool_input ?? {};
  if (typeof ti !== 'object' || Array.isArray(ti)) throw new Error('invalid tool_input');

  const ctx = {
    workspace: path.resolve(workspace),
    inDir: inDir ? path.resolve(inDir) : null,
    images: MENTION_ROLES.has(role) ? path.resolve(imagesDir) : null,
    actionPath: actionPath || null,
    actionCacheRoot: actionCacheRoot(runnerWorkspace),
  };
  ctx.real = {
    workspace: resolveReal(ctx.workspace).real,
    inDir: ctx.inDir ? resolveReal(ctx.inDir).real : null,
    images: ctx.images ? resolveReal(ctx.images).real : null,
  };
  const target = targetOf(ti);

  if (role === 'push') {
    if (tool === 'Bash' && typeof ti.command === 'string' && ti.command.trim() === PUSH_COMMAND) {
      return { target, ...allow('push-ok') };
    }
    return { target, ...deny('push-only') };
  }

  if (MENTION_ROLES.has(role)) return { target, ...decideMention(role, tool, ti, ctx) };

  if (tool === 'StructuredOutput') return { target, ...allow('structured-output') };
  if (READ_TOOLS.has(tool)) return decideRead(tool, ti, ctx);
  if (role === 'fix' && WRITE_TOOLS.has(tool)) return decideWrite(ti, ctx);
  if (role === 'review' && tool === 'Bash') return { target, ...decideReviewBash(ctx, ti.command) };
  // Everything else: write tools for review, Bash and NotebookEdit for fix, MCP and unknown tools.
  return { target, ...deny('tool-not-allowed') };
}

function main() {
  const [role, workspace, inDir, logPath] = process.argv.slice(2);
  if (!role || !workspace || !logPath) {
    throw new Error('usage: pretooluse.mjs <role> <workspace> <inDir> <logPath>');
  }
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  const result = decide(input, { role, workspace, inDir });
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(
    logPath,
    `${JSON.stringify({
      ts: new Date().toISOString(),
      tool_name: input.tool_name,
      target: result.target,
      decision: result.decision,
      rule: result.rule,
    })}\n`,
  );
  if (result.decision === 'deny') {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: `${MARKER}${result.rule}${RULE_HINTS[result.rule] ? `: ${RULE_HINTS[result.rule]}` : ''}`,
        },
      }),
    );
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`CLR_HOOK_ERROR: ${err?.message ?? err}\n`);
    process.exit(2);
  }
}
