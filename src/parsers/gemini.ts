import type { Event, Timeline } from '../types.js';
import { finalize, isTestCommand, makeEdit, outputLooksFailed, relPath, type RawSession } from '../normalize.js';

type Json = any;

/**
 * Gemini CLI saves each chat as one JSON file under
 * ~/.gemini/tmp/<project>/chats/session-*.json:
 * { sessionId, startTime, messages: [{ type: 'user' | 'gemini' | 'info' | 'error', content, thoughts, tokens, model, toolCalls }] }
 */

function text(c: Json): string {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((x) => (typeof x === 'string' ? x : x?.text ?? '')).join('');
  if (c && typeof c.text === 'string') return c.text;
  return '';
}

/** Tool results are stored as functionResponse parts; dig the output string out. */
function resultText(r: Json): string {
  if (r == null) return '';
  if (typeof r === 'string') return r;
  if (Array.isArray(r)) return r.map(resultText).filter(Boolean).join('\n');
  if (r.functionResponse) return resultText(r.functionResponse.response);
  if (typeof r.output === 'string') return r.output;
  if (typeof r.error === 'string') return r.error;
  if (typeof r.text === 'string') return r.text;
  if (typeof r.llmContent === 'string') return r.llmContent;
  return '';
}

/** run_shell_command output looks like "Command: ...\nDirectory: ...\nOutput: ...\nError: ...\nExit Code: 1" */
export function cleanShellOutput(raw: string): { text: string; ok?: boolean } {
  let ok: boolean | undefined;
  const exit = raw.match(/^Exit Code:\s*(\S+)/m);
  if (exit) ok = exit[1] === '0' || exit[1] === '(none)';
  const out = raw.match(/^Output:[ \t]?([\s\S]*?)(?=^(?:Error|Exit Code|Signal|Background PIDs|Process Group PGID):|$(?![\s\S]))/m);
  let body = out ? out[1] : raw;
  if (/^\(empty\)\s*$/.test(body)) body = '';
  const err = raw.match(/^Error:[ \t]?([\s\S]*?)(?=^(?:Exit Code|Signal|Background PIDs|Process Group PGID):|$(?![\s\S]))/m);
  if (err && !/^\(none\)\s*$/.test(err[1])) { body = `${body}\n${err[1]}`; ok ??= false; }
  return { text: body.trim(), ok };
}

function toolEvents(call: Json, at: number, cwd?: string): Event[] {
  const a = call.args ?? {};
  const name: string = call.name ?? '';
  const file = a.file_path ?? a.absolute_path ?? a.path;
  const failed = call.status === 'error' || call.status === 'cancelled';
  switch (name) {
    case 'run_shell_command': {
      const cmd = String(a.command ?? '');
      const { text: out, ok } = cleanShellOutput(resultText(call.result) || String(call.resultDisplay ?? ''));
      const isTest = isTestCommand(cmd);
      return [{ kind: 'command', at, command: cmd, output: out ? out.split('\n') : [], isTest, exitOk: failed ? false : ok ?? !(isTest && outputLooksFailed(out)) }];
    }
    case 'replace':
    case 'edit':
      if (failed || !file) return [];
      return [makeEdit(at, relPath(file, cwd), String(a.old_string ?? ''), String(a.new_string ?? ''))];
    case 'write_file':
      if (failed || !file) return [];
      return [makeEdit(at, relPath(file, cwd), null, String(a.content ?? ''))];
    case 'read_file':
      return file ? [{ kind: 'read', at, path: relPath(file, cwd) }] : [];
    case 'read_many_files':
      return (a.paths ?? a.include ?? []).map((p: string) => ({ kind: 'read', at, path: relPath(String(p), cwd) }));
    case 'search_file_content':
    case 'grep':
    case 'glob':
      return [{ kind: 'search', at, query: String(a.pattern ?? ''), path: a.path ? relPath(a.path, cwd) : undefined }];
    case 'google_web_search':
      return [{ kind: 'tool', at, name: 'web', detail: String(a.query ?? '') }];
    case 'web_fetch':
      return [{ kind: 'tool', at, name: 'web', detail: String(a.prompt ?? a.url ?? '').slice(0, 120) }];
    case 'list_directory':
      return [{ kind: 'tool', at, name: 'ls', detail: a.path ? relPath(a.path, cwd) : '' }];
    default:
      return name ? [{ kind: 'tool', at, name, detail: '' }] : [];
  }
}

export function parseGemini(json: string, idHint = 'session', cwdHint?: string): Timeline {
  let d: Json;
  try { d = JSON.parse(json); } catch { throw new Error('This Gemini CLI session file is not valid JSON.'); }
  const messages: Json[] = Array.isArray(d) ? d : d?.messages;
  if (!Array.isArray(messages) || !messages.length) throw new Error('No Gemini CLI messages found in this file.');
  const cwd: string | undefined = d.cwd ?? d.projectRoot ?? cwdHint;
  const sessionId = String(d.sessionId ?? idHint);

  const stamps = messages.map((m) => Date.parse(m.timestamp)).filter(Number.isFinite);
  const begin = Date.parse(d.startTime);
  const start = Number.isFinite(begin) ? Math.min(begin, ...stamps) : stamps.length ? Math.min(...stamps) : NaN;
  if (!Number.isFinite(start)) throw new Error('No timestamps found in this Gemini CLI session.');
  const last = Date.parse(d.lastUpdated);
  const end = Math.max(start, ...stamps, Number.isFinite(last) ? last : start);

  const events: Event[] = [];
  const usage: RawSession['usage'] = [];
  const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let model: string | undefined;

  for (const m of messages) {
    const ts = Date.parse(m.timestamp);
    const at = Number.isFinite(ts) ? ts - start : 0;
    const body = text(m.content).trim();
    if (m.type === 'user') {
      if (body && !body.startsWith('/')) events.push({ kind: 'prompt', at, text: body });
      continue;
    }
    if (m.type !== 'gemini' && m.type !== 'model') continue;
    if (m.model) model = m.model;
    const thoughts = (m.thoughts ?? []).map((t: Json) => [t.subject, t.description].filter(Boolean).join(': ')).filter(Boolean).join('\n').trim();
    if (thoughts) events.push({ kind: 'thinking', at, text: thoughts });
    for (const call of m.toolCalls ?? []) {
      const cts = Date.parse(call.timestamp);
      events.push(...toolEvents(call, Number.isFinite(cts) ? Math.max(0, cts - start) : at, cwd));
    }
    if (body) events.push({ kind: 'message', at, text: body });
    const t = m.tokens;
    if (t) {
      const cached = t.cached ?? 0;
      total.input += Math.max(0, (t.input ?? 0) - cached);
      total.cacheRead += cached;
      total.output += (t.output ?? 0) + (t.thoughts ?? 0);
      usage.push({ at, total: { ...total } });
    }
  }
  return finalize({ source: 'gemini', sessionId, cwd, model, startedAt: start, endedAt: end, events, usage });
}
