import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Source } from './types.js';

export interface SessionFile {
  source: Source;
  id: string;
  file: string;
  mtime: number;
  size: number;
  cwd?: string;
}

export const claudeRoot = () => path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
export const codexRoot = () => path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');

/** GEMINI_CLI_HOME replaces the home dir; Gemini CLI then uses <home>/.gemini. */
export const geminiRoot = () => path.join(process.env.GEMINI_CLI_HOME || os.homedir(), '.gemini', 'tmp');
/**
 * Older Gemini CLI keyed the per-project folder by sha256 of the project root. Newer versions use a
 * slug of the folder name (registered in ~/.gemini/projects.json) with the root in <slug>/.project_root.
 */
export const geminiProjectHash = (cwd: string) => crypto.createHash('sha256').update(cwd).digest('hex');

/** Claude Code names a project folder after its cwd with every non-alphanumeric char turned into "-". */
export const claudeProjectDir = (cwd: string) => cwd.replace(/[^A-Za-z0-9]/g, '-');

function walk(dir: string, match: (f: string) => boolean, out: string[] = [], depth = 0): string[] {
  if (depth > 6) return out;
  let ents: fs.Dirent[];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, match, out, depth + 1);
    else if (match(e.name)) out.push(p);
  }
  return out;
}

function head(file: string, bytes = 64 * 1024): string {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString('utf8');
  } finally { fs.closeSync(fd); }
}

function stat(file: string) { const s = fs.statSync(file); return { mtime: s.mtimeMs, size: s.size }; }

export function claudeSessions(root = claudeRoot()): SessionFile[] {
  return walk(root, (n) => n.endsWith('.jsonl'))
    .filter((f) => !f.includes(`${path.sep}subagents${path.sep}`))
    .map((file) => {
      let cwd: string | undefined;
      const m = head(file, 32 * 1024).match(/"cwd":"((?:[^"\\]|\\.)*)"/);
      if (m) { try { cwd = JSON.parse(`"${m[1]}"`); } catch { /* ignore */ } }
      return { source: 'claude' as const, id: path.basename(file, '.jsonl'), file, cwd, ...stat(file) };
    });
}

export function codexSessions(root = codexRoot()): SessionFile[] {
  return walk(root, (n) => /^rollout-.*\.jsonl$/.test(n)).map((file) => {
    let cwd: string | undefined, id = path.basename(file, '.jsonl').replace(/^rollout-[\dT:-]+?-(?=[0-9a-f]{8}-)/, '');
    try {
      const first = JSON.parse(head(file).split('\n')[0]);
      cwd = first.payload?.cwd; id = first.payload?.id ?? id;
    } catch { /* partial first line */ }
    return { source: 'codex' as const, id, file, cwd, ...stat(file) };
  });
}

export function geminiSessions(root = geminiRoot()): SessionFile[] {
  const roots = new Map<string, string | undefined>();
  const rootOf = (dir: string) => {
    if (!roots.has(dir)) {
      let r: string | undefined;
      try { r = fs.readFileSync(path.join(dir, '.project_root'), 'utf8').trim() || undefined; } catch { /* legacy hash dir */ }
      roots.set(dir, r);
    }
    return roots.get(dir);
  };
  // Subagent chats live one level deeper (chats/<parent id>/<id>.jsonl) and are skipped.
  return walk(root, (n) => /^session-.*\.jsonl?$/.test(n))
    .filter((f) => path.basename(path.dirname(f)) === 'chats')
    .map((file) => {
      let id = path.basename(file).replace(/\.jsonl?$/, '').replace(/^session-/, '');
      const m = head(file, 4096).match(/"sessionId"\s*:\s*"([^"]+)"/);
      if (m) id = m[1];
      return { source: 'gemini' as const, id, file, cwd: rootOf(path.dirname(path.dirname(file))), ...stat(file) };
    });
}

export function allSessions(opts: { claudeDir?: string; codexDir?: string; geminiDir?: string } = {}): SessionFile[] {
  return [...claudeSessions(opts.claudeDir), ...codexSessions(opts.codexDir), ...geminiSessions(opts.geminiDir)]
    .filter((s) => s.size > 0)
    .sort((a, b) => b.mtime - a.mtime);
}

export function sessionsForCwd(cwd: string, all: SessionFile[]): SessionFile[] {
  const enc = claudeProjectDir(cwd);
  const hash = geminiProjectHash(cwd);
  return all.filter((s) => s.cwd === cwd
    || (s.source === 'claude' && path.basename(path.dirname(s.file)) === enc)
    || (s.source === 'gemini' && path.basename(path.dirname(path.dirname(s.file))) === hash));
}

export function findSession(id: string, all: SessionFile[]): SessionFile | undefined {
  return all.find((s) => s.id === id) ?? all.find((s) => s.id.startsWith(id)) ?? all.find((s) => s.file.includes(id));
}

export function detectSource(file: string, text: string): Source {
  if (/rollout-/.test(path.basename(file))) return 'codex';
  const first = text.slice(0, 4000);
  if (/^\s*\{/.test(first) && /"sessionId"\s*:/.test(first) && /"projectHash"\s*:/.test(first)) return 'gemini';
  if (/"type":"session_meta"|"type":\s*"response_item"/.test(first)) return 'codex';
  return 'claude';
}
