import type { DiffLine, Event, Source, Timeline, Usage } from './types.js';

export const zeroUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

/** $ per million tokens. Rough public list prices; the counter is labelled "est." */
const PRICES: { match: RegExp; in: number; out: number; cacheRead: number; cacheWrite: number }[] = [
  { match: /opus-4-[01]|opus-3|claude-3-opus/i, in: 15, out: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  { match: /opus/i, in: 5, out: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  { match: /haiku/i, in: 1, out: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  { match: /sonnet|claude/i, in: 3, out: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  // before /mini/: "gemini" contains "mini"
  { match: /gemini.*(flash|lite)/i, in: 0.3, out: 2.5, cacheRead: 0.075, cacheWrite: 0 },
  { match: /gemini/i, in: 1.25, out: 10, cacheRead: 0.31, cacheWrite: 0 },
  { match: /mini/i, in: 0.25, out: 2, cacheRead: 0.025, cacheWrite: 0 },
  { match: /gpt|codex|^o\d/i, in: 1.25, out: 10, cacheRead: 0.125, cacheWrite: 0 },
];

export function costOf(u: Usage, model = ''): number {
  const p = PRICES.find((x) => x.match.test(model)) ?? PRICES[3];
  return (u.input * p.in + u.output * p.out + u.cacheRead * p.cacheRead + u.cacheWrite * p.cacheWrite) / 1e6;
}

/** Tokens shown on the counter: fresh input + cache writes + output (cache reads are cheap re-reads). */
export const tokenCount = (u: Usage) => u.input + u.output + u.cacheWrite;

const TEST_RE =
  /(^|[\s;&|(])((npm|pnpm|yarn|bun)\s+(run\s+)?test\b|npx\s+(vitest|jest|mocha|playwright\s+test)|vitest\b|jest\b|pytest\b|python3?\s+-m\s+(pytest|unittest)|cargo\s+(test|nextest)|go\s+test\b|mix\s+test|rspec\b|phpunit\b|deno\s+test|swift\s+test|dotnet\s+test|gradle\w*\s+test|mvn\s+test|make\s+test|tox\b)/;

export const isTestCommand = (cmd: string) => TEST_RE.test(cmd);

/** Best-effort pass/fail from output when the exit status is unknown. */
export function outputLooksFailed(out: string): boolean {
  return /(\b[1-9]\d* (failed|failing|errors?)\b|^FAIL\b|\bFAILED\b|Tests?:\s+\d+ failed|test result: FAILED|AssertionError|panicked at|exit code [1-9]|Exit code [1-9])/m.test(
    out,
  );
}

/** Line diff via LCS; falls back to replace-all for very large inputs. */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before === '' ? [] : before.split('\n');
  const b = after === '' ? [] : after.split('\n');
  if (a.length * b.length > 250_000) {
    return [...a.map((text) => ({ op: '-' as const, text })), ...b.map((text) => ({ op: '+' as const, text }))];
  }
  const n = a.length, m = b.length;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ op: ' ', text: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ op: '-', text: a[i++] });
    else out.push({ op: '+', text: b[j++] });
  }
  while (i < n) out.push({ op: '-', text: a[i++] });
  while (j < m) out.push({ op: '+', text: b[j++] });
  return out;
}

export function makeEdit(at: number, path: string, before: string | null, after: string): Event {
  const diff = lineDiff(before ?? '', after);
  return {
    kind: 'edit', at, path, created: before === null, diff,
    added: diff.filter((d) => d.op === '+').length,
    removed: diff.filter((d) => d.op === '-').length,
  };
}

export interface RawSession {
  source: Source;
  sessionId: string;
  cwd?: string;
  title?: string;
  model?: string;
  startedAt: number;
  endedAt: number;
  events: Event[];
  /** cumulative usage snapshots: ms since start, running usage */
  usage: { at: number; total: Usage }[];
}

export function finalize(raw: RawSession): Timeline {
  const events = raw.events.slice().sort((x, y) => x.at - y.at);

  // red -> green: a failing test run followed by a passing one
  let sawFail = false;
  for (const e of events) {
    if (e.kind !== 'command' || !e.isTest) continue;
    e.testState = e.exitOk ? 'pass' : 'fail';
    if (!e.exitOk) sawFail = true;
    else if (sawFail) { e.redToGreen = true; sawFail = false; }
  }
  // last assistant message is the closing summary
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.kind === 'message') { e.final = true; break; }
  }

  const final = raw.usage.length ? raw.usage[raw.usage.length - 1].total : zeroUsage();
  const usageAt = (t: number) => {
    let u = zeroUsage();
    for (const s of raw.usage) { if (s.at <= t) u = s.total; else break; }
    return u;
  };
  const tokensAt = events.map((e) => tokenCount(usageAt(e.at)));
  const costAt = events.map((e) => costOf(usageAt(e.at), raw.model));

  const files = new Set<string>();
  let added = 0, removed = 0, tools = 0, prompts = 0;
  for (const e of events) {
    if (e.kind === 'edit') { files.add(e.path); added += e.added; removed += e.removed; }
    if (e.kind === 'read') files.add(e.path);
    if (['read', 'edit', 'command', 'search', 'tool'].includes(e.kind)) tools++;
    if (e.kind === 'prompt') prompts++;
  }
  const firstPrompt = events.find((e) => e.kind === 'prompt');
  const cwd = raw.cwd;
  return {
    version: 1,
    source: raw.source,
    sessionId: raw.sessionId,
    project: cwd ? cwd.split(/[\\/]/).filter(Boolean).pop() ?? 'project' : 'project',
    cwd,
    title: makeTitle(firstPrompt?.kind === 'prompt' ? firstPrompt.text : '', raw.title),
    startedAt: new Date(raw.startedAt).toISOString(),
    events,
    tokensAt,
    costAt,
    stats: {
      durationMs: Math.max(0, raw.endedAt - raw.startedAt),
      toolCalls: tools,
      filesTouched: [...files],
      tokens: tokenCount(final),
      usage: final,
      costUsd: costOf(final, raw.model),
      model: raw.model,
      linesAdded: added,
      linesRemoved: removed,
      prompts,
    },
  };
}

/** Make a path relative to cwd when possible. */
export function relPath(p: string, cwd?: string): string {
  if (cwd && p.startsWith(cwd.endsWith('/') ? cwd : cwd + '/')) return p.slice(cwd.length + (cwd.endsWith('/') ? 0 : 1));
  return p;
}

/** First sentence of the first prompt, else the tool's own title, else a clipped prompt. */
export function makeTitle(prompt: string, toolTitle?: string): string {
  const line = prompt.replace(/\s+/g, ' ').trim();
  const sentence = line.match(/^(.{8,90}?[.!?])(\s|$)/)?.[1];
  if (sentence) return sentence;
  if (toolTitle) {
    const t = /^[a-z0-9]+(-[a-z0-9]+)+$/.test(toolTitle) ? toolTitle.replace(/-/g, ' ') : toolTitle;
    return t.charAt(0).toUpperCase() + t.slice(1);
  }
  if (!line) return 'Untitled session';
  if (line.length <= 72) return line;
  return line.slice(0, 72).replace(/\s+\S*$/, '') + '…';
}
