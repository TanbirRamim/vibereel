import os from 'node:os';
import type { Event, Timeline } from './types.js';

export const MASK = '•••••';

/** Patterns for things that should never end up in a shared video. Order matters: specific first. */
export const SECRET_PATTERNS: { name: string; re: RegExp; keep?: number }[] = [
  { name: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g },
  { name: 'anthropic', re: /\bsk-ant-[A-Za-z0-9_-]{8,}/g, keep: 7 },
  { name: 'openai', re: /\bsk-(proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g, keep: 3 },
  { name: 'stripe', re: /\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]{10,}/g, keep: 8 },
  { name: 'github', re: /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, keep: 4 },
  { name: 'gitlab', re: /\bglpat-[A-Za-z0-9_-]{16,}/g, keep: 6 },
  { name: 'slack', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, keep: 5 },
  { name: 'aws-key-id', re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, keep: 4 },
  { name: 'google', re: /\bAIza[0-9A-Za-z_-]{35}\b/g, keep: 4 },
  { name: 'huggingface', re: /\bhf_[A-Za-z0-9]{30,}/g, keep: 3 },
  { name: 'npm', re: /\bnpm_[A-Za-z0-9]{30,}/g, keep: 4 },
  { name: 'resend', re: /\bre_[A-Za-z0-9]{8,}_[A-Za-z0-9]{8,}/g, keep: 3 },
  { name: 'sendgrid', re: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, keep: 3 },
  { name: 'twilio', re: /\bSK[0-9a-f]{32}\b/g, keep: 2 },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, keep: 3 },
  { name: 'bearer', re: /\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{16,}/gi },
  { name: 'url-credentials', re: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s:/@]+:[^\s@/]+@/gi },
  { name: 'email', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
];

/** KEY=value in env/shell style, e.g. OPENAI_API_KEY=abc or export DB_PASSWORD="x". */
const ENV_ASSIGN =
  /\b([A-Z][A-Z0-9_]*(SECRET|TOKEN|PASSWORD|PASSWD|PWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIALS?|DSN|DATABASE_URL)[A-Z0-9_]*)(\s*=\s*["']?)([^\s"']+)/g;
/** "apiKey": "value" / password: 'value' (quoted values only, so prose survives). */
const QUOTED_KV =
  /(["']?)([A-Za-z0-9_.-]*(secret|token|password|passwd|api[_-]?key|apikey|access[_-]?key|private[_-]?key)[A-Za-z0-9_.-]*)\1(\s*[:=]\s*)(["'`])([^"'`\s]{6,})\5/gi;

export interface RedactOptions {
  home?: string;
  maxOutputLines?: number;
  maxLineLength?: number;
  maxTextChars?: number;
}

export function redactPaths(s: string, home = os.homedir()): string {
  let out = s;
  if (home && home.length > 1) out = out.split(home).join('~');
  return out.replace(/\/(Users|home)\/[A-Za-z0-9._-]+(?=\/|\b)/g, '~').replace(/C:\\Users\\[^\\\s]+/gi, '~');
}

export function redactSecrets(s: string): string {
  let out = s;
  for (const { name, re, keep } of SECRET_PATTERNS) {
    out = out.replace(re, (m, ...g) => {
      if (name === 'url-credentials') return `${g[0]}${MASK}@`;
      if (name === 'bearer') return `${m.split(/\s+/)[0]} ${MASK}`;
      if (name === 'email') return `${MASK}@${MASK}`;
      return (keep ? m.slice(0, keep) : '') + MASK;
    });
  }
  out = out.replace(ENV_ASSIGN, (m, key, _w, sep, val) => (val.endsWith(MASK) || val.startsWith('$') ? m : `${key}${sep}${MASK}`));
  out = out.replace(QUOTED_KV, (m, q, key, _w, sep, vq, val) => (val.endsWith(MASK) ? m : `${q}${key}${q}${sep}${vq}${MASK}${vq}`));
  return out;
}

/** Mask every value in a dotenv-style body. */
export function redactEnvBody(s: string): string {
  return s.replace(/^(\s*(export\s+)?[A-Za-z_][A-Za-z0-9_.-]*\s*=\s*)(.+)$/gm, (_m, k) => `${k}${MASK}`);
}

export const isEnvPath = (p: string) => /(^|\/)\.env($|\.|rc$)|\.(pem|key|p12|pfx)$|(^|\/)(credentials|secrets?)(\.[a-z]+)?$/i.test(p);

export function redactText(s: string, o: RedactOptions = {}): string {
  return redactSecrets(redactPaths(s, o.home));
}

export function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

export function clipLines(lines: string[], max: number, width: number): string[] {
  const cut = lines.map((l) => clip(l.replace(/\t/g, '  ').replace(/\x1b\[[0-9;]*[A-Za-z]/g, ''), width));
  // drop trailing blanks
  while (cut.length && !cut[cut.length - 1].trim()) cut.pop();
  if (cut.length <= max) return cut;
  const head = Math.ceil((max - 1) * 0.6), tail = max - 1 - head;
  return [...cut.slice(0, head), `… ${cut.length - head - tail} more lines`, ...cut.slice(cut.length - tail)];
}

/** Trim long payloads. Runs whether or not redaction is on: the film can't show 3,000 lines anyway. */
export function trimTimeline(tl: Timeline, o: RedactOptions = {}): Timeline {
  const maxOut = o.maxOutputLines ?? 14, width = o.maxLineLength ?? 140, chars = o.maxTextChars ?? 700;
  const events = tl.events.map((e): Event => {
    switch (e.kind) {
      case 'prompt': case 'thinking': case 'message': case 'subagent': return { ...e, text: clip(e.text, chars) };
      case 'command': return { ...e, command: clip(e.command, 300), output: clipLines(e.output, maxOut, width) };
      case 'read': return { ...e, preview: e.preview ? clipLines(e.preview, 24, width) : undefined };
      case 'edit': return { ...e, diff: e.diff.slice(0, 400).map((d) => ({ ...d, text: clip(d.text.replace(/\t/g, '  '), width) })) };
      default: return e;
    }
  });
  return { ...tl, events };
}

export function redactTimeline(tl: Timeline, o: RedactOptions = {}): Timeline {
  const r = (s: string) => redactText(s, o);
  const events = tl.events.map((e): Event => {
    switch (e.kind) {
      case 'prompt': case 'thinking': case 'message': return { ...e, text: r(e.text) };
      case 'read': {
        const env = isEnvPath(e.path);
        return { ...e, path: r(e.path), preview: e.preview?.map((l) => (env ? redactEnvBody(r(l)) : r(l))) };
      }
      case 'search': return { ...e, query: r(e.query), path: e.path && r(e.path) };
      case 'edit': {
        const env = isEnvPath(e.path);
        return { ...e, path: r(e.path), diff: e.diff.map((d) => ({ ...d, text: env ? redactEnvBody(r(d.text)) : r(d.text) })) };
      }
      case 'command': return { ...e, command: r(e.command), output: e.output.map(r) };
      case 'tool': return { ...e, detail: r(e.detail) };
      case 'subagent': return { ...e, task: r(e.task), text: r(e.text) };
    }
  });
  return {
    ...tl,
    cwd: tl.cwd && redactPaths(tl.cwd, o.home),
    title: r(tl.title),
    events,
    stats: { ...tl.stats, filesTouched: tl.stats.filesTouched.map(r) },
  };
}
