import type { Event, Usage } from '../types.js';
import { finalize, isTestCommand, makeEdit, outputLooksFailed, relPath, zeroUsage, type RawSession } from '../normalize.js';
import type { Timeline } from '../types.js';

type Json = any;

const NOISE_PROMPT = /^(<(command-|local-command|system-reminder|bash-|user-memory|task-notification)|Base directory for this skill|\[Request interrupted|Caveat: |This session is being continued)/;

function textOf(content: Json): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content))
    return content.map((b) => (typeof b === 'string' ? b : b?.type === 'text' ? b.text : '')).filter(Boolean).join('\n');
  return '';
}

/** Turn a slash-command wrapper into "/name args"; returns null for other wrappers. */
function slashCommand(text: string): string | null {
  const name = text.match(/<command-name>([^<]*)<\/command-name>/)?.[1];
  if (!name) return null;
  const a = text.indexOf('<command-args>'), b = a < 0 ? -1 : text.indexOf('</command-args>', a);
  const args = b < 0 ? undefined : text.slice(a + '<command-args>'.length, b).trim();
  return [name.trim(), args].filter(Boolean).join(' ');
}

const stripLineNumbers = (s: string) => s.split('\n').map((l) => l.replace(/^ *\d+[\t→]/, ''));

export function parseClaude(jsonl: string, idHint = 'session'): Timeline {
  const lines = jsonl.split('\n');
  let start = Infinity, end = 0, cwd: string | undefined, title: string | undefined, model: string | undefined;
  let sessionId = idHint;
  const events: (Event & { _id?: string })[] = [];
  const pending = new Map<string, Event>();
  const usageById = new Map<string, Usage>();
  const usageOrder: { at: number; id: string }[] = [];
  const records: { ts: number; d: Json }[] = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    let d: Json;
    try { d = JSON.parse(line); } catch { continue; }
    if (d.type === 'ai-title' && d.aiTitle) title = d.aiTitle;
    if (d.type === 'summary' && d.summary && !title) title = d.summary;
    if (d.type !== 'user' && d.type !== 'assistant') continue;
    if (d.isSidechain) continue;
    const ts = Date.parse(d.timestamp);
    if (!Number.isFinite(ts)) continue;
    records.push({ ts, d });
    start = Math.min(start, ts); end = Math.max(end, ts);
    cwd ??= d.cwd; if (d.sessionId) sessionId = d.sessionId;
  }
  if (!records.length) throw new Error('No Claude Code messages found in this file.');

  for (const { ts, d } of records) {
    const at = ts - start;
    const msg = d.message ?? {};
    if (d.type === 'user') {
      if (d.isMeta || d.isCompactSummary) continue;
      const content = msg.content;
      const blocks = Array.isArray(content) ? content : [];
      for (const b of blocks) {
        if (b?.type !== 'tool_result') continue;
        const ev = pending.get(b.tool_use_id);
        if (!ev) continue;
        pending.delete(b.tool_use_id);
        const out = textOf(b.content);
        const res = d.toolUseResult;
        if (ev.kind === 'command') {
          const stdout = typeof res === 'object' && res ? [res.stdout, res.stderr].filter(Boolean).join('\n') : out;
          ev.output = (stdout || out).split('\n').filter((l: string) => !/^Shell cwd was reset/.test(l));
          ev.exitOk = !b.is_error && !(ev.isTest && outputLooksFailed(stdout || out));
        } else if (ev.kind === 'read') {
          const body = typeof res === 'object' && res?.file?.content ? String(res.file.content) : out;
          ev.preview = stripLineNumbers(body).slice(0, 40);
        } else if (ev.kind === 'edit' && b.is_error) {
          // failed edit: drop it
          const i = events.indexOf(ev); if (i >= 0) events.splice(i, 1);
        } else if (ev.kind === 'edit' && ev.created && typeof res === 'object' && res?.type === 'update' && typeof res.originalFile === 'string') {
          const fixed = makeEdit(ev.at, ev.path, res.originalFile, res.content ?? '');
          Object.assign(ev, fixed);
        }
      }
      if (blocks.some((b: Json) => b?.type === 'tool_result') || d.toolUseResult) continue;
      const text = textOf(content).trim();
      if (!text) continue;
      const slash = slashCommand(text);
      if (slash) { if (/\s/.test(slash)) events.push({ kind: 'prompt', at, text: slash }); continue; }
      if (NOISE_PROMPT.test(text)) continue;
      events.push({ kind: 'prompt', at, text });
      continue;
    }

    // assistant
    if (msg.model && msg.model !== '<synthetic>') model = msg.model;
    if (msg.id && msg.usage) {
      const u = msg.usage;
      if (!usageById.has(msg.id)) usageOrder.push({ at, id: msg.id });
      usageById.set(msg.id, {
        input: u.input_tokens ?? 0,
        output: u.output_tokens ?? 0,
        cacheRead: u.cache_read_input_tokens ?? 0,
        cacheWrite: u.cache_creation_input_tokens ?? 0,
      });
    }
    for (const b of Array.isArray(msg.content) ? msg.content : []) {
      if (b.type === 'text' && b.text?.trim()) events.push({ kind: 'message', at, text: b.text.trim() });
      else if (b.type === 'thinking' && b.thinking?.trim()) events.push({ kind: 'thinking', at, text: b.thinking.trim() });
      else if (b.type === 'tool_use') {
        const ev = toolEvent(b.name, b.input ?? {}, at, cwd);
        if (!ev) continue;
        events.push(ev);
        pending.set(b.id, ev);
      }
    }
  }

  const usage: RawSession['usage'] = [];
  const run = zeroUsage();
  for (const { at, id } of usageOrder) {
    const u = usageById.get(id)!;
    run.input += u.input; run.output += u.output; run.cacheRead += u.cacheRead; run.cacheWrite += u.cacheWrite;
    usage.push({ at, total: { ...run } });
  }

  return finalize({ source: 'claude', sessionId, cwd, title, model, startedAt: start, endedAt: end, events, usage });
}

function toolEvent(name: string, input: Json, at: number, cwd?: string): Event | null {
  const p = (x: unknown) => relPath(String(x ?? ''), cwd);
  switch (name) {
    case 'Bash': {
      const command = String(input.command ?? '');
      return { kind: 'command', at, command, output: [], exitOk: true, isTest: isTestCommand(command) };
    }
    case 'Read':
      return { kind: 'read', at, path: p(input.file_path) };
    case 'Edit':
      return makeEdit(at, p(input.file_path), String(input.old_string ?? ''), String(input.new_string ?? ''));
    case 'MultiEdit': {
      const edits: Json[] = Array.isArray(input.edits) ? input.edits : [];
      const ev = makeEdit(at, p(input.file_path), edits.map((e) => e.old_string).join('\n'), edits.map((e) => e.new_string).join('\n'));
      return ev;
    }
    case 'Write':
      return makeEdit(at, p(input.file_path), null, String(input.content ?? ''));
    case 'Grep':
    case 'Glob':
      return { kind: 'search', at, query: String(input.pattern ?? ''), path: input.path ? p(input.path) : undefined };
    case 'TodoWrite': {
      const todos: Json[] = Array.isArray(input.todos) ? input.todos : [];
      if (!todos.length) return null;
      return { kind: 'thinking', at, text: todos.map((t, i) => `${i + 1}. ${t.content ?? t.subject ?? ''}`).join('\n') };
    }
    default: {
      const detail = String(input.description ?? input.url ?? input.query ?? input.skill ?? input.prompt ?? '').split('\n')[0];
      return { kind: 'tool', at, name, detail: detail.slice(0, 120) };
    }
  }
}
