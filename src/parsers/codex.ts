import type { Event, Timeline } from '../types.js';
import { finalize, isTestCommand, makeEdit, outputLooksFailed, relPath, type RawSession } from '../normalize.js';

type Json = any;

const NOISE = /^(<(environment_context|user_instructions|permissions|skills_instructions|turn_aborted|user_shell_command)|# AGENTS\.md)/;

function contentText(c: Json): string {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((x) => (typeof x === 'string' ? x : x?.text ?? '')).join('');
  return '';
}

/** Pull a JSON string value for `key` out of loosely-JSON text (Codex wraps tool calls in JS). */
function jsonStringField(src: string, key: string): string | undefined {
  const m = src.match(new RegExp(`"?${key}"?\\s*:\\s*("(?:[^"\\\\]|\\\\.)*")`));
  if (!m) return undefined;
  try { return JSON.parse(m[1]); } catch { return undefined; }
}

/** Find an apply_patch body, either raw or inside a JS/JSON string literal. */
export function extractPatch(src: string): string | undefined {
  // indexOf instead of one big regex: these strings can be huge (and CodeQL flags the regex as ReDoS)
  const BEGIN = '*** Begin Patch', END = '*** End Patch';
  const i = src.indexOf(BEGIN);
  if (i < 0) return undefined;
  const j = src.indexOf(END, i);
  if (j < 0) return undefined;
  const q = src[i - 1];
  if (q === '"' || q === '`') {
    let k = j + END.length;
    while (k < src.length && src[k] !== '"' && src[k] !== '`') k++;
    if (src[k] === q) {
      const body = src.slice(i, k);
      if (q === '`') return body;
      try { return JSON.parse(`"${body}"`); } catch { /* fall through */ }
    }
  }
  return src.slice(i, j + END.length);
}

/** Codex apply_patch format -> edit events. */
export function patchToEdits(patch: string, at: number, cwd?: string): Event[] {
  const out: Event[] = [];
  let cur: { path: string; created: boolean; before: string[]; after: string[] } | null = null;
  const flush = () => {
    if (!cur) return;
    const ev = makeEdit(at, relPath(cur.path, cwd), cur.created ? null : cur.before.join('\n'), cur.after.join('\n'));
    out.push(ev);
    cur = null;
  };
  for (const line of patch.split('\n')) {
    const head = line.match(/^\*\*\* (Add|Update|Delete) File: (.+)$/);
    if (head) {
      flush();
      if (head[1] === 'Delete') { out.push({ kind: 'tool', at, name: 'delete', detail: relPath(head[2].trim(), cwd) }); continue; }
      cur = { path: head[2].trim(), created: head[1] === 'Add', before: [], after: [] };
      continue;
    }
    if (!cur || line.startsWith('***') || line.startsWith('@@')) {
      const mv = line.match(/^\*\*\* Move to: (.+)$/); if (mv && cur) cur.path = mv[1].trim();
      continue;
    }
    const op = line[0], text = line.slice(1);
    if (op === '+') cur.after.push(text);
    else if (op === '-') cur.before.push(text);
    else { cur.before.push(text); cur.after.push(text); }
  }
  flush();
  return out;
}

function commandFrom(name: string, input: string): string | undefined {
  // new style: exec custom tool with JS calling tools.exec_command({"cmd": ...})
  if (/exec_command|"cmd"/.test(input)) return jsonStringField(input, 'cmd');
  // old style: shell({"command": ["bash","-lc","..."]})
  try {
    const a = JSON.parse(input);
    if (Array.isArray(a.command)) {
      const c: string[] = a.command.map(String);
      return c.length >= 3 && /sh$/.test(c[0]) && /^-l?c$/.test(c[1]) ? c[c.length - 1] : c.join(' ');
    }
    if (typeof a.command === 'string') return a.command;
    if (typeof a.cmd === 'string') return a.cmd;
  } catch { /* not json */ }
  if (name === 'shell') return input;
  return undefined;
}

function cleanOutput(raw: string): { text: string; ok?: boolean } {
  let text = raw, ok: boolean | undefined;
  try {
    const j = JSON.parse(raw);
    if (j && typeof j === 'object' && 'output' in j) {
      text = String(j.output);
      const code = j.metadata?.exit_code; if (typeof code === 'number') ok = code === 0;
    }
  } catch { /* plain text */ }
  const exit = text.match(/(?:Process exited with code|Exit code:?)\s*(\d+)/);
  if (exit) ok = exit[1] === '0';
  text = text.replace(/^Script (completed|failed)\nWall time [^\n]*\n(Output:\n)?/, '');
  text = text.replace(/^(Chunk ID|Wall time|Process exited with code|Original token count)[^\n]*\n/gm, '').replace(/^Output:\n/m, '');
  if (/^Script failed/.test(raw)) ok = false;
  return { text: text.trimEnd(), ok };
}

export function parseCodex(jsonl: string, idHint = 'session'): Timeline {
  let start = Infinity, end = 0, cwd: string | undefined, model: string | undefined, sessionId = idHint;
  const recs: { ts: number; d: Json }[] = [];
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    let d: Json; try { d = JSON.parse(line); } catch { continue; }
    const ts = Date.parse(d.timestamp);
    if (!Number.isFinite(ts)) continue;
    recs.push({ ts, d });
  }
  for (const { ts, d } of recs) {
    const p = d.payload ?? {};
    if (d.type === 'session_meta') { cwd ??= p.cwd; sessionId = p.id ?? p.session_id ?? sessionId; continue; }
    if (d.type === 'turn_context' && p.model) model = p.model;
    if (d.type === 'event_msg' && p.type === 'thread_settings_applied' && p.thread_settings?.model) model = p.thread_settings.model;
    if (d.type === 'response_item' || d.type === 'event_msg') { start = Math.min(start, ts); end = Math.max(end, ts); }
  }
  if (!Number.isFinite(start)) throw new Error('No Codex events found in this file.');

  const events: Event[] = [];
  const pending = new Map<string, Event[]>();
  const usage: RawSession['usage'] = [];

  for (const { ts, d } of recs) {
    const at = ts - start, p = d.payload ?? {};
    if (d.type === 'event_msg' && p.type === 'token_count' && p.info?.total_token_usage) {
      const t = p.info.total_token_usage;
      const cached = t.cached_input_tokens ?? 0;
      usage.push({ at, total: { input: Math.max(0, (t.input_tokens ?? 0) - cached), cacheRead: cached, cacheWrite: t.cache_write_input_tokens ?? 0, output: t.output_tokens ?? 0 } });
      continue;
    }
    if (d.type !== 'response_item') continue;
    if (p.type === 'message') {
      const text = contentText(p.content).trim();
      if (!text) continue;
      if (p.role === 'user' && !NOISE.test(text)) events.push({ kind: 'prompt', at, text });
      else if (p.role === 'assistant') events.push({ kind: 'message', at, text });
    } else if (p.type === 'reasoning') {
      const s = (p.summary ?? []).map((x: Json) => x.text).filter(Boolean).join('\n').trim();
      if (s) events.push({ kind: 'thinking', at, text: s.replace(/\*\*/g, '') });
    } else if (p.type === 'custom_tool_call' || p.type === 'function_call' || p.type === 'local_shell_call') {
      const input: string = typeof p.input === 'string' ? p.input : typeof p.arguments === 'string' ? p.arguments : JSON.stringify(p.action ?? p.arguments ?? {});
      const made: Event[] = [];
      const patch = input.includes('*** Begin Patch') ? extractPatch(input) : undefined;
      if (patch) made.push(...patchToEdits(patch, at, cwd));
      else {
        const cmd = p.type === 'local_shell_call' ? (p.action?.command ?? []).slice(-1)[0] : commandFrom(p.name, input);
        if (cmd) {
          const inner = cmd.match(/^apply_patch\s+<<['"]?EOF['"]?\n([\s\S]*)\nEOF/);
          if (inner) made.push(...patchToEdits(inner[1], at, cwd));
          else made.push({ kind: 'command', at, command: cmd, output: [], exitOk: true, isTest: isTestCommand(cmd) });
        } else if (/web__run|web_search/.test(input) || p.name === 'web_search') {
          made.push({ kind: 'tool', at, name: 'web', detail: jsonStringField(input, 'q') ?? jsonStringField(input, 'query') ?? '' });
        } else if (p.name && p.name !== 'wait' && p.name !== 'write_stdin') {
          made.push({ kind: 'tool', at, name: p.name === 'exec' ? (input.match(/tools\.(\w+)/)?.[1] ?? 'exec') : p.name, detail: '' });
        }
      }
      events.push(...made);
      if (p.call_id) pending.set(p.call_id, made);
    } else if (p.type === 'custom_tool_call_output' || p.type === 'function_call_output' || p.type === 'local_shell_call_output') {
      const made = pending.get(p.call_id);
      if (!made) continue;
      pending.delete(p.call_id);
      const raw = contentText(p.output) || (typeof p.output === 'object' ? JSON.stringify(p.output) : '');
      const { text, ok } = cleanOutput(raw);
      for (const ev of made) {
        if (ev.kind !== 'command') continue;
        ev.output = text.split('\n');
        ev.exitOk = ok ?? !(ev.isTest && outputLooksFailed(text));
      }
    }
  }
  return finalize({ source: 'codex', sessionId, cwd, model, startedAt: start, endedAt: end, events, usage });
}
