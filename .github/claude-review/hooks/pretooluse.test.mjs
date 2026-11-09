import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { decide } from './pretooluse.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, 'pretooluse.mjs');
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clr-hook-')));
const ws = path.join(base, 'ws');
const inDir = path.join(base, 'in');
const outside = path.join(base, 'outside');
for (const dir of [ws, inDir, outside, path.join(ws, '.git'), path.join(ws, '.github/workflows'), path.join(ws, 'src')]) {
  fs.mkdirSync(dir, { recursive: true });
}
fs.writeFileSync(path.join(ws, '.git/config'), '');
fs.writeFileSync(path.join(inDir, 'diff.txt'), '');
fs.writeFileSync(path.join(outside, 'secret.txt'), '');
fs.symlinkSync(outside, path.join(ws, 'to-outside'));
fs.symlinkSync(path.join(ws, '.github'), path.join(ws, 'to-github'));
fs.symlinkSync(path.join(ws, '.git'), path.join(ws, 'to-git'));
fs.symlinkSync(path.join(base, 'does-not-exist'), path.join(ws, 'dangling'));

const as = (role) => (tool_name, tool_input = {}) => decide({ tool_name, tool_input }, { role, workspace: ws, inDir });
const review = as('review');
const fix = as('fix');
const push = as('push');
const rev = (command) => review('Bash', { command });

function assertDeny(r, rule) {
  assert.equal(r.decision, 'deny', JSON.stringify(r));
  if (rule) assert.equal(r.rule, rule);
}
function assertAllow(r) {
  assert.equal(r.decision, 'allow', JSON.stringify(r));
}

// Read tools (review and fix share the rules)
for (const [role, call] of [['review', review], ['fix', fix]]) {
  test(`${role}: Read/Grep/Glob are allowed in the workspace and the input directory`, () => {
    assertAllow(call('Read', { file_path: 'src/a.ts' }));
    assertAllow(call('Read', { file_path: path.join(ws, '.github/workflows/ci.yml') }));
    assertAllow(call('Read', { file_path: path.join(inDir, 'diff.txt') }));
    assertAllow(call('Grep', { pattern: 'token' }));
    assertAllow(call('Grep', { pattern: 'x', path: 'src', type: 'ts' }));
    assertAllow(call('Grep', { pattern: 'x', '-i': true, output_mode: 'content' }));
    assertAllow(call('Glob', { pattern: '**/*.md' }));
    assertAllow(call('Glob', { pattern: `${ws}/src/**/*.ts` }));
  });
  test(`${role}: reads outside the roots and through escaping symlinks are denied`, () => {
    assertDeny(call('Read', { file_path: '/etc/hosts' }), 'read-outside');
    assertDeny(call('Read', { file_path: '../ws2/x' }), 'read-outside');
    assertDeny(call('Read', { file_path: 'to-outside/secret.txt' }), 'read-outside');
    assertDeny(call('Grep', { pattern: 'x', path: '/' }), 'read-outside');
    assertDeny(call('Glob', { pattern: '*', path: outside }), 'read-outside');
  });
  test(`${role}: .git is unreadable, also via symlinks and different case`, () => {
    assertDeny(call('Read', { file_path: '.git/config' }), 'read-git');
    assertDeny(call('Read', { file_path: path.join(ws, '.GIT/config') }), 'read-git');
    assertDeny(call('Read', { file_path: 'to-git/config' }), 'read-git');
    assertDeny(call('Grep', { pattern: 'x', path: '.git' }), 'read-git');
    assertDeny(call('Glob', { pattern: '.git/**' }), 'read-git');
    assertDeny(call('Glob', { pattern: '{.git,src}/config' }), 'read-git');
    assertDeny(call('Glob', { pattern: `${ws}/.git/*` }), 'read-git');
  });
  test(`${role}: glob patterns cannot traverse out of the roots`, () => {
    assertDeny(call('Glob', { pattern: '../**/*.txt' }), 'read-traversal');
    assertDeny(call('Glob', { pattern: '{..,x}/y' }), 'read-traversal');
    assertDeny(call('Glob', { pattern: '/etc/*' }), 'read-outside');
    assertDeny(call('Glob', { pattern: '~/.ssh/*' }), 'read-outside');
  });
  test(`${role}: Grep rejects every non-empty glob, because it overrides the default !.git exclusion`, () => {
    for (const glob of ['*', '*.ts', '*.git', '*.git *.worktree', '*.{git,worktree}', '.git/**', '../*', ' ']) {
      assertDeny(call('Grep', { pattern: 'x', glob }), 'grep-glob-disallowed');
      assertDeny(call('Grep', { pattern: 'x', path: 'src', glob }), 'grep-glob-disallowed');
    }
    assertDeny(call('Grep', { pattern: 'x', glob: 5 }), 'read-bad-input');
    assertAllow(call('Grep', { pattern: 'x', glob: '' }));
  });
  test(`${role}: Glob returns names only, so broad patterns are allowed`, () => {
    for (const pattern of ['**/*', '*', 'src/**', '**/Dockerfile', '**/config', '*.git', '.g*']) {
      assertAllow(call('Glob', { pattern }));
    }
    assertDeny(call('Glob', { pattern: '.git/*' }), 'read-git');
  });
  test(`${role}: Grep without a glob and without a path stays allowed`, () => {
    assertAllow(call('Grep', { pattern: 'x' }));
    assertAllow(call('Grep', { pattern: 'x', path: 'src' }));
  });
  test(`${role}: dangling symlinks and malformed read inputs are denied`, () => {
    assertDeny(call('Read', { file_path: 'dangling' }), 'read-dangling-link');
    assertDeny(call('Read', {}), 'read-no-path');
    assertDeny(call('Read', { file_path: 5 }), 'read-no-path');
    assertDeny(call('Grep', { pattern: 'x', path: 5 }), 'read-bad-input');
  });
  test(`${role}: StructuredOutput is allowed; MCP, unknown and other tools are denied`, () => {
    assertAllow(call('StructuredOutput', { verdict: 'pass' }));
    for (const tool of ['mcp__github__create_issue', 'mcp__x', 'WebFetch', 'WebSearch', 'Task', 'TodoWrite', 'LS', 'Unknown']) {
      assertDeny(call(tool, {}), 'tool-not-allowed');
    }
  });
}

// Review: write tools and Bash
test('review: write tools are denied', () => {
  for (const tool of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) {
    assertDeny(review(tool, { file_path: 'src/a.ts' }), 'tool-not-allowed');
  }
});
test('review: single read-only git and gh commands are allowed', () => {
  for (const command of [
    'git diff',
    'git diff origin/main...HEAD',
    'git diff --stat HEAD~3 -- src/a.ts',
    'git diff --no-ext-diff HEAD',
    'git log --oneline -n 20',
    'git log --format="%h %s" -- src',
    "git show abc123:src/a.ts",
    'git show --stat HEAD',
    'gh pr view 12',
    'gh pr view 12 --json title,body',
    'gh pr diff 12',
    'gh pr diff 12 --name-only',
  ]) {
    assertAllow(rev(command));
  }
});
test('review: other commands and look-alike prefixes are denied', () => {
  for (const command of [
    '', 'ls', 'cat .git/config', 'git status', 'git difftool', 'git diffstat', 'git push origin HEAD',
    'git -c core.pager=x diff', 'gh pr merge 12', 'gh pr checkout 12', 'gh api /user', 'gh pr', 'git',
    'env git diff', 'echo git diff',
  ]) {
    assertDeny(rev(command), 'bash-not-allowed');
  }
  assertDeny(review('Bash', {}), 'bash-not-allowed');
});
test('review: shell metacharacters are denied', () => {
  for (const command of [
    'git diff; id',
    'git diff | cat',
    'git diff && id',
    'git diff &',
    'git diff $(id)',
    'git diff $HOME',
    'git diff `id`',
    'git diff > out.txt',
    'git diff < in.txt',
    'git diff (x)',
    'git diff\nid',
    'git diff\rid',
    'git diff \\x',
    'git diff\0',
    'git log --format="$(id)"',
  ]) {
    assertDeny(rev(command), 'bash-metachar');
  }
});
test('review: file-writing, program-running and out-of-repo options are denied', () => {
  for (const command of [
    'git diff --output=/tmp/x',
    'git diff --output /tmp/x',
    'git log --output=x',
    'git show --ext-diff HEAD',
    'git diff --textconv',
    'git log -p --textconv',
    'git diff --no-index /etc/passwd /dev/null',
    'git diff --outp=/tmp/x',
    'git diff --ext HEAD',
    'git diff --textc',
    'git diff "--output=/tmp/x"',
    'git diff --out"put"=/tmp/x',
    "git diff '--ext-diff'",
    'git diff -O/etc/passwd',
  ]) {
    assertDeny(rev(command), 'bash-option');
  }
});
test('review: positional paths outside the workspace or into .git are denied', () => {
  for (const command of [
    'git diff /dev/null .git/config',
    'git diff /dev/null /etc/hosts',
    'git diff HEAD /etc/hosts',
    'git diff -- /etc/hosts',
    'git diff ../x y',
    'git diff HEAD -- ../x',
    'git log -- src/../../x',
    'git show HEAD -- .GIT/config',
    'git show HEAD -- .git',
    'git diff -- -x/../y',
    'git diff to-outside/secret.txt',
    'git diff to-git/config',
    'git diff dangling',
    'git show HEAD:.git/config',
    'git show HEAD:.GIT/config',
    'git show :.git/config',
    'git show HEAD:../x',
    'git show HEAD:/etc/hosts',
    'git show HEAD:a:.git/config',
    'gh pr diff 12 --repo ../x',
    'gh pr view /etc/hosts',
    "git diff '/dev/null' '.git/config'",
  ]) {
    assertDeny(rev(command), 'bash-path-outside');
  }
});
test('review: revisions and workspace-relative paths stay allowed', () => {
  for (const command of [
    'git diff HEAD',
    'git diff HEAD~1',
    'git diff abc123..def456',
    'git diff origin/main...HEAD',
    'git diff 0123456789abcdef0123456789abcdef01234567',
    'git diff src/a.ts',
    'git diff HEAD -- src/a.ts .github/workflows/ci.yml',
    'git log -n 5 -- .',
    'git show HEAD:src/a.ts',
    'git show origin/main:src/a.ts',
    'git log --since=2.weeks.ago --author=bob HEAD',
    'gh pr view https://github.com/o/r/pull/12',
    'gh pr view 12 --json title,body',
  ]) {
    assertAllow(rev(command));
  }
});
test('review: unquoted expansions and unbalanced quotes are denied', () => {
  for (const command of ['git diff *', 'git diff -- src/*.ts', 'git diff {a,b}', 'git diff x?', 'git diff [a]', 'git diff ~/x', 'git diff ~root']) {
    assertDeny(rev(command), 'bash-expansion');
  }
  assertAllow(rev("git log -- 'src/*.ts'"));
  assertDeny(rev('git diff "abc'), 'bash-syntax');
  assertDeny(rev("git diff 'abc"), 'bash-syntax');
});

// Fix
test('fix: edits inside the workspace are allowed', () => {
  assertAllow(fix('Edit', { file_path: 'src/a.ts' }));
  assertAllow(fix('MultiEdit', { file_path: path.join(ws, 'src/b.ts') }));
  assertAllow(fix('Write', { file_path: 'src/new/c.ts' }));
  assertAllow(fix('Write', { file_path: 'docs/readme.md' }));
});
test('fix: protected paths are denied, nested and in any case', () => {
  for (const file of [
    '.git/config', '.github/workflows/ci.yml', '.github/CODEOWNERS', '.claude/settings.json', '.claude-pr/x',
    '.mcp.json', '.claude.json', '.gitmodules', '.ripgreprc', 'CLAUDE.md', 'CLAUDE.local.md', '.husky/pre-commit',
    'src/CLAUDE.md', 'src/.husky/x', 'sub/.github/workflows/x.yml', '.GitHub/workflows/x.yml', 'claude.md',
  ]) {
    assertDeny(fix('Write', { file_path: file }), 'write-protected');
    assertDeny(fix('Edit', { file_path: path.join(ws, file) }), 'write-protected');
  }
  assertAllow(fix('Write', { file_path: 'src/claude-notes.md' }));
  assertAllow(fix('Write', { file_path: 'src/github/x.ts' }));
});
test('fix: writes through symlinks into protected or outside paths are denied', () => {
  assertDeny(fix('Write', { file_path: 'to-github/workflows/x.yml' }), 'write-protected');
  assertDeny(fix('Edit', { file_path: 'to-git/config' }), 'write-protected');
  assertDeny(fix('Write', { file_path: 'to-outside/x.txt' }), 'write-outside-workspace');
  assertDeny(fix('Write', { file_path: 'dangling' }), 'write-dangling-link');
});
test('fix: outside the workspace, the input directory and malformed inputs are denied', () => {
  assertDeny(fix('Write', { file_path: '/etc/passwd' }), 'write-outside-workspace');
  assertDeny(fix('Write', { file_path: '../escape.txt' }), 'write-outside-workspace');
  assertDeny(fix('Write', { file_path: path.join(inDir, 'diff.txt') }), 'write-outside-workspace');
  assertDeny(fix('Edit', {}), 'write-no-path');
  assertDeny(fix('Edit', { file_path: 3 }), 'write-no-path');
});
test('fix: a nested input directory stays read-only', () => {
  const nested = path.join(ws, 'nested-in');
  fs.mkdirSync(nested, { recursive: true });
  const call = (tool, file) => decide({ tool_name: tool, tool_input: { file_path: file } }, { role: 'fix', workspace: ws, inDir: nested });
  assertDeny(call('Write', 'nested-in/x.txt'), 'write-in-dir');
  assertAllow(call('Write', 'src/x.txt'));
  assertAllow(call('Read', 'nested-in/x.txt'));
});
test('fix: Bash and NotebookEdit are denied', () => {
  assertDeny(fix('Bash', { command: 'git diff' }), 'tool-not-allowed');
  assertDeny(fix('Bash', { command: 'git push origin HEAD' }), 'tool-not-allowed');
  assertDeny(fix('NotebookEdit', { notebook_path: 'n.ipynb' }), 'tool-not-allowed');
});

// Push
test('push: only git push origin HEAD is allowed', () => {
  assertAllow(push('Bash', { command: 'git push origin HEAD' }));
  assertAllow(push('Bash', { command: '  git push origin HEAD\n' }));
  for (const command of [
    'git push', 'git push origin main', 'git push --force origin HEAD', 'git push -f origin HEAD',
    'git push origin +HEAD', 'git push origin HEAD; id', 'git push origin HEAD && id', 'git  push origin HEAD',
    'git push origin HEAD --force', 'git push origin HEAD:main', 'git push origin HEAD\nid', '',
  ]) {
    assertDeny(push('Bash', { command }), 'push-only');
  }
  assertDeny(push('Bash', {}), 'push-only');
});
test('push: every other tool is denied, StructuredOutput and reads included', () => {
  for (const tool of ['StructuredOutput', 'Read', 'Grep', 'Glob', 'Write', 'Edit', 'mcp__x', 'Unknown']) {
    assertDeny(push(tool, { file_path: 'a' }), 'push-only');
  }
});

// Mention roles (claude-code-action tag mode)
const mws = path.join(base, 'mws');
const imagesDir = path.join(base, 'github-images');
const actionPath = path.join(base, '_actions/anthropics/claude-code-action', 'a'.repeat(40));
const wrapper = path.join(actionPath, 'scripts/git-push.sh');
for (const dir of [
  path.join(mws, '.git'), path.join(mws, '.github/workflows'), path.join(mws, 'src'), path.join(mws, 'docs'),
  path.join(mws, 'pkg/.github'), path.join(mws, 'pkg2'), path.join(mws, 'vendor/deep/CLAUDE.md'), imagesDir,
]) {
  fs.mkdirSync(dir, { recursive: true });
}
fs.writeFileSync(path.join(mws, '.git/HEAD'), 'ref: refs/heads/claude/issue-7-20260101\n');
fs.writeFileSync(path.join(mws, '.git/config'), '');
fs.writeFileSync(path.join(mws, 'pkg/.github/x.yml'), '');
fs.writeFileSync(path.join(mws, 'pkg2/a.txt'), '');
fs.writeFileSync(path.join(imagesDir, 'image-1.png'), '');
fs.symlinkSync(outside, path.join(mws, 'to-outside'));
fs.symlinkSync(path.join(mws, '.github'), path.join(mws, 'to-github'));
fs.symlinkSync(path.join(mws, '.git'), path.join(mws, 'to-git'));

const mention = (role, ws2 = mws) => (tool_name, tool_input = {}) =>
  decide({ tool_name, tool_input }, { role, workspace: ws2, inDir: '', imagesDir, actionPath });
const men = mention('mention');
const menRo = mention('mention-ro');
const menBash = (command) => men('Bash', { command });
const roBash = (command) => menRo('Bash', { command });

for (const [role, call] of [['mention', men], ['mention-ro', menRo]]) {
  test(`${role}: Read/Grep/Glob/LS follow the review and fix read rules`, () => {
    assertAllow(call('Read', { file_path: 'src/a.ts' }));
    assertAllow(call('Read', { file_path: '.github/workflows/ci.yml' }));
    assertAllow(call('Grep', { pattern: 'x', path: 'src' }));
    assertAllow(call('Glob', { pattern: '**/*.md' }));
    assertAllow(call('LS', { path: 'src' }));
    assertAllow(call('LS', {}));
    assertDeny(call('Read', { file_path: '.git/config' }), 'read-git');
    assertDeny(call('Read', { file_path: 'to-git/config' }), 'read-git');
    assertDeny(call('Grep', { pattern: 'x', glob: '*.git' }), 'grep-glob-disallowed');
    assertDeny(call('Glob', { pattern: '../**' }), 'read-traversal');
    assertDeny(call('Read', { file_path: '/etc/hosts' }), 'read-outside');
    assertDeny(call('Read', { file_path: 'to-outside/secret.txt' }), 'read-outside');
    assertDeny(call('LS', { path: '.git' }), 'read-git');
    assertDeny(call('LS', { path: '/' }), 'read-outside');
  });
  test(`${role}: the image directory of tag mode is readable but not writable`, () => {
    assertAllow(call('Read', { file_path: path.join(imagesDir, 'image-1.png') }));
    assertDeny(call('Read', { file_path: path.join(base, 'in/diff.txt') }), 'read-outside');
    assertDeny(call('Write', { file_path: path.join(imagesDir, 'x.png') }), role === 'mention' ? 'write-outside-workspace' : 'tool-not-allowed');
  });
  test(`${role}: the tracking comment tool and read-only CI tools are allowed`, () => {
    assertAllow(call('mcp__github_comment__update_claude_comment', { body: 'done' }));
    assertAllow(call('mcp__github_ci__get_ci_status', {}));
    assertAllow(call('mcp__github_ci__get_workflow_run_details', { run_id: 1 }));
    assertAllow(call('ToolSearch', { query: 'select:mcp__github_comment__update_claude_comment', max_results: 1 }));
    assertDeny(call('mcp__github_comment__update_claude_comment', {}), 'mcp-bad-input');
  });
  test(`${role}: other MCP and builtin tools are denied`, () => {
    for (const tool of [
      'mcp__github_ci__download_job_log', 'mcp__github_inline_comment__create_inline_comment', 'mcp__github__create_issue',
      'mcp__github_comment__other', 'mcp__x', 'StructuredOutput', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task',
      'TodoWrite', 'Unknown',
    ]) {
      assertDeny(call(tool, { notebook_path: 'n.ipynb' }), 'tool-not-allowed');
    }
  });
  test(`${role}: read-only git commands are allowed with the review option and path rules`, () => {
    for (const command of [
      'git status', 'git status --short', 'git diff', 'git diff origin/main...HEAD', 'git diff --stat HEAD~2 -- src/a.ts',
      'git log --oneline -n 5', 'git show HEAD:src/a.ts',
    ]) {
      assertAllow(call('Bash', { command }));
    }
    for (const command of ['git diff --output=x', 'git diff -Ox', 'git diff --no-index a b', 'git log --ext-diff']) {
      assertDeny(call('Bash', { command }), 'bash-option');
    }
    for (const command of ['git diff /dev/null /etc/hosts', 'git diff -- .git/config', 'git show HEAD:.git/config', 'git diff ../x']) {
      assertDeny(call('Bash', { command }), 'bash-path-outside');
    }
  });
  test(`${role}: gh, other git subcommands and arbitrary programs are denied`, () => {
    for (const command of [
      'gh pr view 1', 'git mv a b', 'git checkout -- .', 'git reset --hard', 'git config user.name x', 'git branch -D x',
      'git -c core.pager=x diff', 'git fetch', 'rm src/a.ts', 'mv a b', 'cp a b', 'sed -i s/a/b/ src/a.ts', 'cat src/a.ts',
      'bash -c id', 'FOO=1 git status', 'git push origin HEAD', '', '   ',
    ]) {
      assertDeny(call('Bash', { command }), 'bash-not-allowed');
    }
  });
  test(`${role}: metacharacters and command substitution outside quotes are denied`, () => {
    for (const command of [
      'git status; id', 'git status && id', 'git status | cat', 'git status > x', 'git status < x', 'git status $(id)',
      'git status `id`', 'git status\nid', 'git status \\', 'git diff (a)', 'git status\u0001',
    ]) {
      assertDeny(call('Bash', { command }), 'bash-metachar');
    }
    assertDeny(call('Bash', { command: 'git diff "$HOME"' }), 'bash-metachar');
    assertDeny(call('Bash', { command: 'git diff "`id`"' }), 'bash-metachar');
    assertDeny(call('Bash', { command: 'git diff "a\\"b"' }), 'bash-metachar');
    assertDeny(call('Bash', { command: 'git diff "a' }), 'bash-syntax');
    assertDeny(call('Bash', { command: 'git diff src/*' }), 'bash-expansion');
    assertDeny(call('Bash', { command: 'git diff ~/x' }), 'bash-expansion');
  });
}

test('mention: Edit, MultiEdit and Write work inside the workspace', () => {
  assertAllow(men('Edit', { file_path: 'src/a.ts' }));
  assertAllow(men('MultiEdit', { file_path: path.join(mws, 'src/b.ts') }));
  assertAllow(men('Write', { file_path: 'docs/new/c.md' }));
});
test('mention: .github, CODEOWNERS and the other protected paths are denied, nested and in any case', () => {
  for (const file of [
    '.github/workflows/ci.yml', '.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS', 'src/codeowners', '.GitHub/workflows/x.yml',
    'pkg/.github/x.yml', '.git/config', '.claude/settings.json', '.claude-pr/x', '.mcp.json', '.claude.json', '.gitmodules',
    '.ripgreprc', 'CLAUDE.md', 'src/CLAUDE.md', 'claude.local.md', '.husky/pre-commit', 'to-github/workflows/x.yml', 'to-git/config',
  ]) {
    assertDeny(men('Write', { file_path: file }), 'write-protected');
    assertDeny(men('Edit', { file_path: path.join(mws, file) }), 'write-protected');
    assertDeny(men('MultiEdit', { file_path: file }), 'write-protected');
  }
  assertAllow(men('Write', { file_path: 'src/codeowners-notes.md' }));
  assertAllow(men('Write', { file_path: 'src/github/x.ts' }));
});
test('mention: writes outside the workspace and malformed write inputs are denied', () => {
  assertDeny(men('Write', { file_path: '/etc/passwd' }), 'write-outside-workspace');
  assertDeny(men('Write', { file_path: '../x' }), 'write-outside-workspace');
  assertDeny(men('Write', { file_path: 'to-outside/x' }), 'write-outside-workspace');
  assertDeny(men('Edit', {}), 'write-no-path');
});
test('fix still allows CODEOWNERS edits (only the mention roles protect them)', () => {
  assertAllow(fix('Write', { file_path: 'docs/CODEOWNERS' }));
});
test('mention-ro: write tools are denied', () => {
  for (const tool of ['Edit', 'MultiEdit', 'Write']) assertDeny(menRo(tool, { file_path: 'src/a.ts' }), 'tool-not-allowed');
});

test('mention: git add accepts explicit workspace paths and the -- separator', () => {
  for (const command of [
    'git add src/a.ts', 'git add src/a.ts docs/new.md', 'git add -- src/a.ts', "git add 'src/my file.ts'", 'git add pkg2', 'git add ./src/a.ts',
  ]) {
    assertAllow(menBash(command));
  }
});
test('mention: git add denies protected, .git, outside and absolute paths', () => {
  for (const command of [
    'git add .github/x', 'git add .github/workflows/x.yml', 'git add pkg/.github/x.yml', 'git add CODEOWNERS', 'git add CLAUDE.md',
    'git add src/CLAUDE.md', 'git add -- .github/x', 'git add to-github/workflows/x.yml', 'git add .claude/x', 'git add .mcp.json',
    'git add src/a.ts .github/x',
  ]) {
    assertDeny(menBash(command), 'bash-path-protected');
  }
  for (const command of ['git add .git/config', 'git add ../x', 'git add /etc/passwd', `git add ${path.join(mws, 'src/a.ts')}`, 'git add to-outside/x', 'git add src/../.git/x']) {
    assertDeny(menBash(command), 'bash-path-outside');
  }
});
test('mention: git add denies broad paths, globs, pathspec magic, options and no paths', () => {
  for (const command of ['git add .', 'git add ./', 'git add -- .', 'git add src/..']) {
    assertDeny(menBash(command), command === 'git add src/..' ? 'bash-path-outside' : 'bash-path-broad');
  }
  for (const command of ["git add 'src/*'", "git add '*.yml'", "git add 'a?'", "git add 'a[b]'", "git add ':(glob)**'", "git add ':/'", "git add ''"]) {
    assertDeny(menBash(command), 'bash-pathspec');
  }
  for (const command of ['git add -A', 'git add -u', 'git add --all', 'git add -f src/a.ts', 'git add -p', 'git add --chmod=+x src/a.ts', 'git add -N src/a.ts']) {
    assertDeny(menBash(command), 'bash-option');
  }
  assertDeny(menBash('git add'), 'bash-no-path');
  assertDeny(menBash('git add --'), 'bash-no-path');
  assertDeny(menBash('git add src/*'), 'bash-expansion');
});
test('mention: git rm denies protected paths, also inside directories', () => {
  assertAllow(menBash('git rm src/a.ts'));
  assertAllow(menBash('git rm -r pkg2'));
  assertAllow(menBash('git rm --cached -- src/a.ts'));
  assertDeny(menBash('git rm .github/workflows/x.yml'), 'bash-path-protected');
  assertDeny(menBash('git rm -r .github'), 'bash-path-protected');
  assertDeny(menBash('git rm -r pkg'), 'bash-path-protected');
  assertDeny(menBash('git rm -r vendor'), 'bash-path-protected');
  assertDeny(menBash('git rm CODEOWNERS'), 'bash-path-protected');
  assertDeny(menBash('git rm -r .'), 'bash-path-broad');
  assertDeny(menBash('git rm -rf src'), 'bash-option');
  assertDeny(menBash('git rm -f src/a.ts'), 'bash-option');
  assertDeny(menBash('git rm .git/config'), 'bash-path-outside');
  assertDeny(menBash('git rm ../x'), 'bash-path-outside');
  assertDeny(menBash('git rm'), 'bash-no-path');
});
test('mention: git commit takes a message and --signoff only', () => {
  for (const command of [
    'git commit -m "fix bug"', "git commit -m 'fix (scope): a; b | c & d'", 'git commit --message="x"', 'git commit --message x',
    'git commit -s -m x', 'git commit -m "title" -m "Co-authored-by: Ada <1+ada@users.noreply.github.com>"',
    'git commit -m "title\n\nCo-authored-by: Ada <1+ada@users.noreply.github.com>"', "git commit -m '$HOME and `id` stay literal'",
    'git commit -m "-a"',
  ]) {
    assertAllow(menBash(command));
  }
  for (const command of [
    'git commit', 'git commit -m', 'git commit -a -m x', 'git commit -am x', 'git commit --all -m x', 'git commit --amend -m x',
    'git commit -m x --amend', 'git commit -m x -- .github/x', 'git commit -m x .github/x', 'git commit -F msg.txt', 'git commit -m x --no-verify',
    'git commit -mx', 'git commit --mess x', 'git commit --allow-empty -m x', 'git commit -C HEAD', 'git commit -m x --author=a',
  ]) {
    assertDeny(menBash(command), 'bash-option');
  }
  assertDeny(menBash('git commit -m "$(id)"'), 'bash-metachar');
  assertDeny(menBash('git commit -m "`id`"'), 'bash-metachar');
  assertDeny(menBash('git commit -m x; id'), 'bash-metachar');
  assertDeny(menBash('git commit -m (x)'), 'bash-metachar');
  assertDeny(menBash('git commit -m "x'), 'bash-syntax');
});
test('mention-ro: git add, rm, commit and push are denied', () => {
  for (const command of ['git add src/a.ts', 'git rm src/a.ts', 'git commit -m x', `${wrapper} origin HEAD`]) {
    assertDeny(roBash(command), 'bash-not-allowed');
  }
});

test('mention: the action push wrapper is allowed for origin HEAD and the checked-out branch', () => {
  assertAllow(menBash(`${wrapper} origin HEAD`));
  assertAllow(menBash(`${wrapper} origin claude/issue-7-20260101`));
  assertAllow(menBash(`"${wrapper}" origin HEAD`));
});
test('mention: push denies other refs, remotes, flags, extra words and default branches', () => {
  for (const ref of ['main', 'other-branch', 'HEAD:main', '+HEAD', '--force', '-f', 'refs/heads/x']) {
    assertDeny(menBash(`${wrapper} origin ${ref}`), 'push-ref');
  }
  for (const command of [
    `${wrapper} upstream HEAD`, `${wrapper} origin`, `${wrapper}`, `${wrapper} origin HEAD extra`, `${wrapper} --force origin HEAD`,
    'git push origin HEAD', 'git push --force origin HEAD', 'git push origin +HEAD', 'git push -f', 'git push origin HEAD:main',
  ]) {
    assertDeny(menBash(command), 'bash-not-allowed');
  }
});
test('mention: push refuses a wrapper path that is not the action checkout', () => {
  const planted = path.join(mws, 'scripts/git-push.sh');
  for (const word of [
    planted, 'scripts/git-push.sh', './scripts/git-push.sh', 'git-push.sh', '/tmp/git-push.sh', '/tmp/x/_actions/anthropics/claude-code-action/main/scripts/git-push.sh',
    '/tmp/_actions/evil/claude-code-action/' + 'a'.repeat(40) + '/scripts/git-push.sh', `${actionPath}/scripts/../scripts/git-push.sh`,
    path.join(actionPath, 'scripts/other.sh'), `${actionPath}/scripts/git-push.sh.bak`,
  ]) {
    assertDeny(menBash(`${word} origin HEAD`), 'bash-not-allowed');
  }
  // Inside the checkout nothing counts, not even a path that matches the runner layout.
  const inside = path.join(mws, '_actions/anthropics/claude-code-action', 'b'.repeat(40), 'scripts/git-push.sh');
  assertDeny(menBash(`${inside} origin HEAD`), 'bash-not-allowed');
});
test('mention: without GITHUB_ACTION_PATH only the runner action cache layout is accepted', () => {
  const call = (command) => decide({ tool_name: 'Bash', tool_input: { command } }, { role: 'mention', workspace: mws, inDir: '', imagesDir, actionPath: '' });
  const cached = `/home/runner/work/_actions/anthropics/claude-code-action/${'c'.repeat(40)}/scripts/git-push.sh`;
  assertAllow(call(`${cached} origin HEAD`));
  assertDeny(call(`/home/runner/work/other/scripts/git-push.sh origin HEAD`), 'bash-not-allowed');
  assertDeny(call(`/home/runner/work/_actions/other/claude-code-action/${'c'.repeat(40)}/scripts/git-push.sh origin HEAD`), 'bash-not-allowed');
});
test('mention: GITHUB_ACTION_PATH locates the wrapper when the runner layout differs', () => {
  const call = (command) => decide({ tool_name: 'Bash', tool_input: { command } }, { role: 'mention', workspace: mws, inDir: '', imagesDir, actionPath: '/opt/ca' });
  assertAllow(call('/opt/ca/scripts/git-push.sh origin HEAD'));
  assertDeny(call('/opt/ca/scripts/other.sh origin HEAD'), 'bash-not-allowed');
  assertDeny(call('/opt/ca2/scripts/git-push.sh origin HEAD'), 'bash-not-allowed');
});
test('mention: with GITHUB_ACTION_PATH set, no other location is accepted, not even the runner layout', () => {
  const sha = 'c'.repeat(40);
  const call = (command) => decide({ tool_name: 'Bash', tool_input: { command } }, { role: 'mention', workspace: mws, inDir: '', imagesDir, actionPath: '/opt/ca', runnerWorkspace: '/home/runner/work/repo' });
  assertAllow(call('/opt/ca/scripts/git-push.sh origin HEAD'));
  assertDeny(call(`/home/runner/work/_actions/anthropics/claude-code-action/${sha}/scripts/git-push.sh origin HEAD`), 'bash-not-allowed');
  assertDeny(call(`/tmp/github-images/_actions/anthropics/claude-code-action/${sha}/scripts/git-push.sh origin HEAD`), 'bash-not-allowed');
});
test('mention: without GITHUB_ACTION_PATH the cache root is fixed by RUNNER_WORKSPACE or the default', () => {
  const sha = 'c'.repeat(40);
  const tail = `_actions/anthropics/claude-code-action/${sha}/scripts/git-push.sh`;
  const call = (command, runnerWorkspace) => decide({ tool_name: 'Bash', tool_input: { command } }, { role: 'mention', workspace: mws, inDir: '', imagesDir, actionPath: '', runnerWorkspace });
  // Arbitrary prefixes are refused, with or without RUNNER_WORKSPACE.
  for (const prefix of ['/tmp/github-images', '/tmp', '/home/runner/work/repo', '/home/runner/work/x/y', '/opt']) {
    assertDeny(call(`${prefix}/${tail} origin HEAD`, undefined), 'bash-not-allowed');
    assertDeny(call(`${prefix}/${tail} origin HEAD`, '/home/runner/work/repo'), 'bash-not-allowed');
  }
  // Default root.
  assertAllow(call(`/home/runner/work/${tail} origin HEAD`, undefined));
  assertAllow(call(`/home/runner/work/${tail} origin HEAD`, ''));
  assertAllow(call(`/home/runner/work/${tail} origin HEAD`, 'relative/path'));
  // Root derived from RUNNER_WORKSPACE.
  assertAllow(call(`/srv/runner/work/${tail} origin HEAD`, '/srv/runner/work/repo'));
  assertAllow(call(`/srv/runner/work/${tail} origin HEAD`, '/srv/runner/work/repo/'));
  assertDeny(call(`/home/runner/work/${tail} origin HEAD`, '/srv/runner/work/repo'), 'bash-not-allowed');
  assertDeny(call(`/srv/runner/work/repo/${tail} origin HEAD`, '/srv/runner/work/repo'), 'bash-not-allowed');
  // A traversal or a short sha stays refused.
  assertDeny(call(`/srv/runner/work/x/../${tail} origin HEAD`, '/srv/runner/work/repo'), 'bash-not-allowed');
  assertDeny(call(`/home/runner/work/_actions/anthropics/claude-code-action/${'c'.repeat(39)}/scripts/git-push.sh origin HEAD`, undefined), 'bash-not-allowed');
});
test('mention: push is refused on default branches and without a branch', () => {
  const make = (name, head) => {
    const dir = path.join(base, name);
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    if (head !== undefined) fs.writeFileSync(path.join(dir, '.git/HEAD'), head);
    return mention('mention', dir);
  };
  const push2 = (call, ref) => call('Bash', { command: `${wrapper} origin ${ref}` });
  assertAllow(push2(make('b-feature', 'ref: refs/heads/feature/x\n'), 'HEAD'));
  assertDeny(push2(make('b-main', 'ref: refs/heads/main\n'), 'HEAD'), 'push-default-branch');
  assertDeny(push2(make('b-main2', 'ref: refs/heads/main\n'), 'main'), 'push-default-branch');
  assertDeny(push2(make('b-master', 'ref: refs/heads/Master\n'), 'HEAD'), 'push-default-branch');
  assertDeny(push2(make('b-detached', '0123456789012345678901234567890123456789\n'), 'HEAD'), 'push-no-branch');
  assertDeny(push2(make('b-nohead'), 'HEAD'), 'push-no-branch');
  assertDeny(push2(make('b-weird', 'ref: refs/heads/a..b\n'), 'HEAD'), 'push-ref');
});

test('mention: file-ops MCP tools get the write path rules, mention-ro denies them', () => {
  assertAllow(men('mcp__github_file_ops__commit_files', { files: ['src/a.ts', 'docs/b.md'], message: 'x' }));
  assertAllow(men('mcp__github_file_ops__delete_files', { paths: ['src/a.ts'], message: 'x' }));
  assertDeny(men('mcp__github_file_ops__commit_files', { files: ['src/a.ts', '.github/workflows/x.yml'], message: 'x' }), 'write-protected');
  assertDeny(men('mcp__github_file_ops__delete_files', { paths: ['CODEOWNERS'], message: 'x' }), 'write-protected');
  assertDeny(men('mcp__github_file_ops__commit_files', { files: ['../x'], message: 'x' }), 'write-outside-workspace');
  assertDeny(men('mcp__github_file_ops__commit_files', { files: [], message: 'x' }), 'mcp-bad-input');
  assertDeny(men('mcp__github_file_ops__commit_files', { files: 'src/a.ts' }), 'mcp-bad-input');
  assertDeny(men('mcp__github_file_ops__delete_files', { paths: [1] }), 'mcp-bad-input');
  assertDeny(men('mcp__github_file_ops__commit_files', {}), 'mcp-bad-input');
  assertDeny(menRo('mcp__github_file_ops__commit_files', { files: ['src/a.ts'], message: 'x' }), 'tool-not-allowed');
  assertDeny(menRo('mcp__github_file_ops__delete_files', { paths: ['src/a.ts'], message: 'x' }), 'tool-not-allowed');
});
test('mention: the other roles are unchanged (LS, MCP and ToolSearch stay denied for review and fix)', () => {
  for (const call of [review, fix]) {
    for (const tool of ['LS', 'ToolSearch', 'mcp__github_comment__update_claude_comment']) assertDeny(call(tool, { body: 'x' }), 'tool-not-allowed');
  }
});

test('CLI: mention roles deny with the rule marker, allow silently, and read GITHUB_ACTION_PATH', () => {
  const log = path.join(base, 'mention.jsonl');
  const call = (role, input, env = {}) =>
    spawnSync(process.execPath, [script, role, mws, '', log], {
      input: JSON.stringify(input),
      encoding: 'utf8',
      env: { ...process.env, GITHUB_ACTION_PATH: '', ...env },
    });
  const denied = call('mention', { tool_name: 'Write', tool_input: { file_path: '.github/workflows/x.yml' } });
  assert.equal(denied.status, 0, denied.stderr);
  assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecisionReason, 'CLR_HOOK_DENY:write-protected');
  const roDenied = call('mention-ro', { tool_name: 'Edit', tool_input: { file_path: 'src/a.ts' } });
  assert.equal(JSON.parse(roDenied.stdout).hookSpecificOutput.permissionDecisionReason, 'CLR_HOOK_DENY:tool-not-allowed');
  const comment = call('mention-ro', { tool_name: 'mcp__github_comment__update_claude_comment', tool_input: { body: 'x' } });
  assert.equal(comment.status, 0, comment.stderr);
  assert.equal(comment.stdout, '');
  const pushCommand = { tool_name: 'Bash', tool_input: { command: '/opt/ca/scripts/git-push.sh origin HEAD' } };
  assert.equal(JSON.parse(call('mention', pushCommand).stdout).hookSpecificOutput.permissionDecisionReason, 'CLR_HOOK_DENY:bash-not-allowed');
  const pushed = call('mention', pushCommand, { GITHUB_ACTION_PATH: '/opt/ca' });
  assert.equal(pushed.status, 0, pushed.stderr);
  assert.equal(pushed.stdout, '');
  const rows = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(rows.map((r) => r.decision), ['deny', 'deny', 'allow', 'deny', 'allow']);
});

// Input validation
test('decide throws on an unknown role, a missing tool name and a broken tool_input', () => {
  assert.throws(() => decide({ tool_name: 'Read', tool_input: {} }, { role: 'admin', workspace: ws, inDir }));
  assert.throws(() => decide({ tool_name: 'Read', tool_input: {} }, { workspace: ws, inDir }));
  assert.throws(() => decide({ tool_input: {} }, { role: 'review', workspace: ws, inDir }));
  assert.throws(() => decide({ tool_name: 'Read', tool_input: [] }, { role: 'review', workspace: ws, inDir }));
  assert.throws(() => decide({ tool_name: 'Read' }, { role: 'review', inDir }));
});
test('decide works without an input directory', () => {
  const call = (tool_name, tool_input) => decide({ tool_name, tool_input }, { role: 'review', workspace: ws, inDir: '' });
  assertAllow(call('Read', { file_path: 'src/a.ts' }));
  assertDeny(call('Read', { file_path: path.join(inDir, 'diff.txt') }), 'read-outside');
});

// CLI behaviour
function run(role, input, logName, dirOverride = inDir) {
  const log = path.join(base, logName);
  const res = spawnSync(process.execPath, [script, role, ws, dirOverride, log], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
  });
  const rows = fs.existsSync(log)
    ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];
  return { res, rows };
}

test('CLI: deny prints the decision JSON with the rule marker, exits 0 and logs a row', () => {
  const cases = [
    ['fix', { tool_name: 'Write', tool_input: { file_path: '.github/workflows/x.yml' } }, 'write-protected'],
    ['review', { tool_name: 'Bash', tool_input: { command: 'git diff --output=x' } }, 'bash-option'],
    ['review', { tool_name: 'Read', tool_input: { file_path: '.git/config' } }, 'read-git'],
    ['push', { tool_name: 'Bash', tool_input: { command: 'git push --force origin HEAD' } }, 'push-only'],
    ['review', { tool_name: 'mcp__x__y', tool_input: {} }, 'tool-not-allowed'],
  ];
  const logName = 'deny.jsonl';
  for (const [role, input, rule] of cases) {
    const { res } = run(role, input, logName);
    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(JSON.parse(res.stdout), {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `CLR_HOOK_DENY:${rule}`,
      },
    });
  }
  const rows = fs.readFileSync(path.join(base, logName), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows.length, cases.length);
  for (const row of rows) {
    assert.equal(row.decision, 'deny');
    assert.ok(row.ts && row.tool_name && row.target && row.rule);
  }
});
test('CLI: allow prints nothing, exits 0 and still logs', () => {
  const cases = [
    ['review', { tool_name: 'Bash', tool_input: { command: 'git diff HEAD' } }, 'git diff HEAD'],
    ['fix', { tool_name: 'Edit', tool_input: { file_path: 'src/a.ts' } }, 'src/a.ts'],
    ['push', { tool_name: 'Bash', tool_input: { command: 'git push origin HEAD' } }, 'git push origin HEAD'],
  ];
  for (const [role, input, target] of cases) {
    const { res, rows } = run(role, input, 'allow.jsonl');
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout, '');
    assert.equal(rows.at(-1).decision, 'allow');
    assert.equal(rows.at(-1).target, target);
  }
});
test('CLI: an empty input directory argument is accepted', () => {
  const { res, rows } = run('review', { tool_name: 'Read', tool_input: { file_path: 'a' } }, 'noindir.jsonl', '');
  assert.equal(res.status, 0, res.stderr);
  assert.equal(rows.at(-1).decision, 'allow');
});
test('CLI: target is truncated to 200 characters', () => {
  const command = `git diff ${'x'.repeat(500)}`;
  const { res, rows } = run('review', { tool_name: 'Bash', tool_input: { command } }, 'trunc.jsonl');
  assert.equal(res.status, 0, res.stderr);
  assert.equal(rows[0].target.length, 200);
});
test('CLI: invalid input, unknown role and missing arguments fail closed with exit 2', () => {
  assert.equal(run('review', 'not json', 'bad1.jsonl').res.status, 2);
  assert.equal(run('review', { tool_input: {} }, 'bad2.jsonl').res.status, 2);
  assert.equal(run('admin', { tool_name: 'Read', tool_input: {} }, 'bad3.jsonl').res.status, 2);
  const noArgs = spawnSync(process.execPath, [script], { input: '{}', encoding: 'utf8' });
  assert.equal(noArgs.status, 2);
  assert.match(noArgs.stderr, /CLR_HOOK_ERROR/);
});
test('CLI: unwritable log fails closed with exit 2', () => {
  const blocker = path.join(base, 'blocker');
  fs.writeFileSync(blocker, '');
  const res = spawnSync(process.execPath, [script, 'review', ws, inDir, path.join(blocker, 'x.jsonl')], {
    input: JSON.stringify({ tool_name: 'Read', tool_input: { file_path: 'a' } }),
    encoding: 'utf8',
  });
  assert.equal(res.status, 2);
});
