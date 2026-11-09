/**
 * util
 *
 * What: Runtime object (process, git, gh, clock), sanitized environments, text sanitizing,
 *       and small fs helpers shared by every driver module.
 * Why: The driver runs with a repository token while it also runs code from the pull request
 *      (L0 commands). Every subprocess therefore gets an explicit environment, and every
 *      piece of model-written text is neutralized before it reaches a comment or a file.
 *      git and gh are looked up only in a fixed system PATH, never in the PATH the job inherited.
 *      L0 commands run as the same OS user as the driver, so they are not isolated from it; see state.mjs.
 * Not covered: GitHub or git semantics. Those live in gitops.mjs and report.mjs.
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

export const LAYERS = ['L1', 'L2', 'L3'];
export const ZWSP = '​';

/** Environment variables that must never reach code from the pull request. */
const SECRET_NAME = /(TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE_KEY|API_KEY)/i;
const DROP_PREFIX = /^(CLAUDE_|ANTHROPIC_|ACTIONS_|CLR_|INPUT_|GITHUB_TOKEN$|GH_TOKEN$|GH_ENTERPRISE_TOKEN$)/;
const DROP_EXACT = new Set([
  'GITHUB_ENV', 'GITHUB_PATH', 'GITHUB_OUTPUT', 'GITHUB_STATE', 'GITHUB_STEP_SUMMARY',
  'ALL_INPUTS', 'ACTIONS_RUNTIME_TOKEN',
]);

/** Environment for L0 commands: no tokens, no workflow command files. */
export function sanitizedEnv(env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (DROP_PREFIX.test(k) || DROP_EXACT.has(k) || SECRET_NAME.test(k)) continue;
    out[k] = v;
  }
  out.CI = 'true';
  out.GIT_TERMINAL_PROMPT = '0';
  return out;
}

/** The only directories the driver looks in for git and gh. */
export const SYSTEM_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

/** Absolute path of `name` in the fixed system PATH. Throws when it is not there. */
export function systemBinary(name, path = SYSTEM_PATH) {
  const found = findInPath(name, { PATH: path });
  if (!found) throw new Error(`${name} was not found in the system PATH (${path})`);
  return found;
}

/** Environment for the driver's own git and gh calls: ignore user-level config a PR script could have planted. */
export function trustedEnv(env, ghConfigDir) {
  return {
    ...env,
    PATH: SYSTEM_PATH,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GH_PROMPT_DISABLED: '1',
    GH_PAGER: 'cat',
    GH_NO_UPDATE_NOTIFIER: '1',
    ...(ghConfigDir ? { GH_CONFIG_DIR: ghConfigDir } : {}),
  };
}

/** git options that stop repository-local config from running programs in the driver's process. */
export const GIT_SAFE = [
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.fsmonitor=false',
  '-c', 'core.pager=cat',
  '-c', 'core.sshCommand=false',
  '-c', 'protocol.ext.allow=never',
];

export function createRuntime(env = process.env) {
  const temp = env.RUNNER_TEMP;
  if (!temp) throw new Error('RUNNER_TEMP is not set. Run the driver from a GitHub Actions job.');
  const stateDir = join(temp, 'claude-review-state');
  const rt = {
    env,
    cwd: env.GITHUB_WORKSPACE || process.cwd(),
    temp,
    stateDir,
    inDir: join(temp, 'claude-review-in'),
    execFile: join(temp, 'claude-execution-output.json'),
    inlineBuffer: '/tmp/inline-comments-buffer.jsonl',
    claudeSettings: join(env.HOME || '', '.claude', 'settings.json'),
    now: () => Date.now(),
    log: (m) => console.log(m),
    secrets: [],
  };
  rt.trusted = () => trustedEnv(env, join(stateDir, 'gh-config'));
  const resolved = new Map();
  rt.bin = (name) => {
    if (!resolved.has(name)) resolved.set(name, systemBinary(name));
    return resolved.get(name);
  };
  rt.run = (cmd, args, opts = {}) => {
    const r = spawnSync(rt.bin(cmd), args, {
      cwd: opts.cwd || rt.cwd,
      input: opts.input,
      env: opts.env || rt.trusted(),
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      timeout: opts.timeout || 10 * 60 * 1000,
    });
    return {
      status: r.status === null ? -1 : r.status,
      stdout: r.stdout || '',
      stderr: redact(r.stderr || (r.error ? String(r.error.message) : ''), rt.secrets),
      error: r.error,
    };
  };
  rt.git = (args, opts = {}) => {
    const r = rt.run('git', [...GIT_SAFE, ...args], opts);
    if (opts.check !== false && r.status !== 0) {
      throw new Error(`git ${args.slice(0, 3).join(' ')} failed (${r.status}): ${r.stderr.trim().slice(0, 500)}`);
    }
    return r;
  };
  rt.gh = (args, opts = {}) => {
    const r = rt.run('gh', args, opts);
    if (opts.check !== false && r.status !== 0) {
      throw new Error(`gh ${args.slice(0, 3).join(' ')} failed (${r.status}): ${r.stderr.trim().slice(0, 500)}`);
    }
    return r;
  };
  return rt;
}

export function redact(text, secrets) {
  let out = String(text);
  for (const s of secrets || []) if (s && s.length > 3) out = out.split(s).join('***');
  return out;
}

/**
 * Run one L0 command line with a hard time limit. The command runs in its own process group,
 * so a timeout also stops its children. Output is kept as a bounded head and tail.
 */
export function runShell(command, { cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn('bash', ['-eo', 'pipefail', '-c', command], {
      cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const LIMIT = 400_000;
    let head = '';
    let tail = '';
    let total = 0;
    const onData = (b) => {
      const s = b.toString('utf8');
      total += s.length;
      if (head.length < LIMIT) head += s.slice(0, LIMIT - head.length);
      tail = (tail + s).slice(-LIMIT);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
    }, timeoutMs);
    const finish = (code, signal) => {
      clearTimeout(timer);
      const output = total <= 2 * LIMIT ? (total <= LIMIT ? head : head + tail.slice(-(total - LIMIT))) : `${head}\n[... ${total - 2 * LIMIT} characters omitted ...]\n${tail}`;
      resolve({
        code: code === null ? -1 : code, signal, timedOut, output,
        seconds: Math.round((Date.now() - started) / 1000),
      });
    };
    child.on('error', (e) => { head += `\n${e.message}`; finish(-1, null); });
    child.on('close', finish);
  });
}

/** Keep the end of long text: L0 failures are usually reported last. */
export function cutStart(text, max) {
  if (text.length <= max) return text;
  return `[... ${text.length - max} characters cut from the start ...]\n${text.slice(text.length - max)}`;
}

export function clamp(value, max) {
  const s = value === undefined || value === null ? '' : String(value);
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/**
 * Neutralize text written by a model before it goes into a comment or a state file:
 * @mentions would notify people, HTML comments could forge the pipeline's markers,
 * and images could leak data through a URL when the comment renders.
 * Idempotent.
 */
export function sanitizeText(text) {
  return String(text ?? '')
    .replace(/\u0000/g, '')
    .replace(/<!--/g, '&lt;!--')
    .replace(/-->/g, '--&gt;')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '[image removed: $1]')
    .replace(/<img\b[^>]*>/gi, '[image removed]')
    .replace(/@(?=[A-Za-z0-9_])/g, `@${ZWSP}`);
}

export function readJson(path, fallback = undefined) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}

export function writeJsonAtomic(path, data) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}

export function removeFile(path) {
  try { rmSync(path, { force: true, recursive: true }); } catch { /* best effort */ }
}

export function fileMtimeMs(path) {
  try { return statSync(path).mtimeMs; } catch { return null; }
}

export function exists(path) {
  return existsSync(path);
}

export function findInPath(name, env) {
  for (const dir of (env.PATH || '').split(':')) {
    if (!dir) continue;
    const p = join(dir, name);
    try { if (statSync(p).isFile()) return p; } catch { /* next */ }
  }
  return '';
}

export function shortSha(sha) {
  return sha ? String(sha).slice(0, 7) : '';
}
