import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseClaude } from '../src/parsers/claude';
import { parseCodex, patchToEdits } from '../src/parsers/codex';
import { cleanShellOutput, parseGemini } from '../src/parsers/gemini';
import { parseSession } from '../src/index';
import { storyboard } from '../src/storyboard';
import { geminiProjectHash, geminiRoot, geminiSessions, sessionsForCwd } from '../src/sessions';
import os from 'node:os';
import path from 'node:path';
import { isTestCommand, lineDiff, makeTitle } from '../src/normalize';

const demo = fs.readFileSync(new URL('../fixtures/demo-dark-mode.jsonl', import.meta.url), 'utf8');
const codex = fs.readFileSync(new URL('../fixtures/codex-sample.jsonl', import.meta.url), 'utf8');
const gemini = fs.readFileSync(new URL('../fixtures/gemini-sample.json', import.meta.url), 'utf8');
const geminiJsonl = fs.readFileSync(new URL('../fixtures/gemini-sample.jsonl', import.meta.url), 'utf8');

describe('claude parser', () => {
  const tl = parseClaude(demo);
  it('reads the prompt, project and model', () => {
    expect(tl.source).toBe('claude');
    expect(tl.project).toBe('todo-app');
    expect(tl.events[0]).toMatchObject({ kind: 'prompt' });
    expect(tl.stats.model).toBe('claude-opus-4-6');
    expect(tl.title).toBe('Add a dark mode to the todo app.');
  });
  it('turns Edit/Write into diffs with relative paths', () => {
    const edits = tl.events.filter((e) => e.kind === 'edit');
    expect(edits.map((e) => e.kind === 'edit' && e.path)).toContain('src/hooks/useTheme.ts');
    const created = edits.find((e) => e.kind === 'edit' && e.path === 'src/hooks/useTheme.ts')!;
    expect(created.kind === 'edit' && created.created && created.removed === 0).toBe(true);
  });
  it('detects the red -> green test run', () => {
    const tests = tl.events.filter((e) => e.kind === 'command' && e.isTest);
    expect(tests.map((e) => e.kind === 'command' && e.testState)).toEqual(['fail', 'pass']);
    expect(tests[1].kind === 'command' && tests[1].redToGreen).toBe(true);
  });
  it('turns TodoWrite into a plan and strips line numbers from reads', () => {
    expect(tl.events.find((e) => e.kind === 'thinking')).toBeTruthy();
    const read = tl.events.find((e) => e.kind === 'read');
    expect(read?.kind === 'read' && read.preview?.[0]).toBe("import { Header } from './components/Header';");
  });
  it('sums usage once per message id and estimates cost', () => {
    expect(tl.stats.tokens).toBeGreaterThan(50_000);
    expect(tl.stats.costUsd).toBeGreaterThan(0.5);
    expect(tl.stats.durationMs).toBe(47.2 * 60000);
    expect(tl.tokensAt.length).toBe(tl.events.length);
  });
  it('skips meta, sidechain and tool-result-only user lines', () => {
    const extra = [
      { type: 'user', isMeta: true, timestamp: '2026-10-08T09:12:05Z', message: { role: 'user', content: 'meta' } },
      { type: 'user', isSidechain: true, timestamp: '2026-10-08T09:12:05Z', message: { role: 'user', content: 'side' } },
      { type: 'user', timestamp: '2026-10-08T09:12:05Z', message: { role: 'user', content: '<command-name>/review</command-name><command-args>auth</command-args>' } },
      'not json',
    ].map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join('\n');
    const t = parseClaude(demo + extra);
    const prompts = t.events.filter((e) => e.kind === 'prompt').map((e) => e.kind === 'prompt' && e.text);
    expect(prompts).toContain('/review auth');
    expect(prompts).not.toContain('meta');
    expect(prompts).not.toContain('side');
  });
  it('throws on files with no messages', () => {
    expect(() => parseClaude('{"type":"summary"}\n')).toThrow();
  });
});

describe('claude subagents', () => {
  const rec = (o: object) => JSON.stringify({ cwd: '/w', sessionId: 's', ...o });
  const jsonl = [
    rec({ type: 'user', timestamp: '2026-10-08T09:00:00Z', message: { role: 'user', content: 'Audit the repo' } }),
    rec({ type: 'assistant', timestamp: '2026-10-08T09:00:05Z', message: { id: 'm1', model: 'claude-x', usage: { input_tokens: 100, output_tokens: 10 }, content: [
      { type: 'tool_use', id: 't1', name: 'Task', input: { description: 'Find dead code', prompt: 'Look for unused exports\nin src', subagent_type: 'Explore' } },
    ] } }),
    rec({ type: 'user', isSidechain: true, timestamp: '2026-10-08T09:00:06Z', message: { role: 'user', content: 'Look for unused exports' } }),
    rec({ type: 'assistant', isSidechain: true, timestamp: '2026-10-08T09:00:08Z', message: { id: 'side1', usage: { input_tokens: 5000, output_tokens: 500 }, content: [{ type: 'text', text: 'side work' }] } }),
    rec({ type: 'user', timestamp: '2026-10-08T09:01:00Z', toolUseResult: { status: 'completed', content: [{ type: 'text', text: 'Two unused exports in src/a.ts' }], totalToolUseCount: 7 },
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'Two unused exports in src/a.ts' }] }] } }),
  ].join('\n');
  const t = parseClaude(jsonl);
  it('turns a Task call into a subagent event with its result and tool count', () => {
    const sub = t.events.find((e) => e.kind === 'subagent');
    expect(sub).toMatchObject({ kind: 'subagent', agent: 'Explore', task: 'Find dead code', text: 'Two unused exports in src/a.ts', tools: 7 });
    expect(t.events.some((e) => e.kind === 'message' && e.text === 'side work')).toBe(false);
  });
  it('counts subagent tokens once (sidechain usage is not added)', () => {
    expect(t.stats.usage.input).toBe(100);
  });
  it('gets a scene in the film', () => {
    expect(storyboard(t).scenes.some((s) => s.kind === 'subagent')).toBe(true);
  });
});

describe('codex parser', () => {
  const tl = parseCodex(codex);
  it('reads meta, skips environment context', () => {
    expect(tl.source).toBe('codex');
    expect(tl.project).toBe('api');
    expect(tl.stats.model).toBe('gpt-5-codex');
    const prompts = tl.events.filter((e) => e.kind === 'prompt');
    expect(prompts).toHaveLength(1);
  });
  it('handles exec_command, shell and apply_patch inside JS', () => {
    const cmds = tl.events.filter((e) => e.kind === 'command');
    expect(cmds.map((c) => c.kind === 'command' && c.command)).toEqual(['pytest -q', 'pytest -q']);
    expect(cmds.map((c) => c.kind === 'command' && c.testState)).toEqual(['fail', 'pass']);
    expect(cmds[1].kind === 'command' && cmds[1].redToGreen).toBe(true);
    expect(cmds[0].kind === 'command' && cmds[0].output.join('\n')).not.toMatch(/Wall time/);
    const edits = tl.events.filter((e) => e.kind === 'edit');
    expect(edits.map((e) => e.kind === 'edit' && e.path)).toEqual(['app/page.py', 'tests/test_edge.py']);
  });
  it('uses reasoning summaries and token_count totals', () => {
    expect(tl.events.find((e) => e.kind === 'thinking')).toMatchObject({ text: 'Looking at pagination first' });
    expect(tl.stats.usage.cacheRead).toBe(40000);
    expect(tl.stats.usage.input).toBe(12000);
  });
  it('auto-detects the source', () => {
    expect(parseSession(codex, 'rollout-x.jsonl').source).toBe('codex');
    expect(parseSession(demo, 'abc.jsonl').source).toBe('claude');
  });
  it('parses patches with moves and deletes', () => {
    const ev = patchToEdits('*** Begin Patch\n*** Delete File: a.txt\n*** Update File: b.txt\n*** Move to: c.txt\n@@\n-x\n+y\n*** End Patch', 0);
    expect(ev[0]).toMatchObject({ kind: 'tool', name: 'delete' });
    expect(ev[1]).toMatchObject({ kind: 'edit', path: 'c.txt', added: 1, removed: 1 });
  });
});

describe('gemini parser', () => {
  const tl = parseGemini(gemini, 'x', '/Users/dev/blog');
  it('reads the prompt, model and session id', () => {
    expect(tl.source).toBe('gemini');
    expect(tl.sessionId).toBe('9f2c1a7e-4b3d-4e8a-b1c2-0d5e6f7a8b9c');
    expect(tl.project).toBe('blog');
    expect(tl.stats.model).toBe('gemini-2.5-pro');
    expect(tl.events[0]).toMatchObject({ kind: 'prompt' });
    expect(tl.stats.durationMs).toBe(390_000);
  });
  it('maps shell commands and tracks red to green', () => {
    const cmds = tl.events.filter((e) => e.kind === 'command');
    expect(cmds.map((c) => c.kind === 'command' && c.testState)).toEqual(['fail', 'pass']);
    expect(cmds[1].kind === 'command' && cmds[1].redToGreen).toBe(true);
    expect(cmds[0].kind === 'command' && cmds[0].output.join('\n')).not.toMatch(/Exit Code|Directory/);
  });
  it('turns replace/write_file into diffs and skips failed edits', () => {
    const edits = tl.events.filter((e) => e.kind === 'edit');
    expect(edits.map((e) => e.kind === 'edit' && e.path)).toEqual(['src/slug.ts', 'test/accents.test.ts']);
    expect(edits[1]).toMatchObject({ created: true, added: 2 });
    expect(tl.events.find((e) => e.kind === 'read')).toMatchObject({ path: 'src/slug.ts' });
    expect(tl.events.find((e) => e.kind === 'search')).toMatchObject({ query: 'slugify\\(' });
  });
  it('sums per-message tokens, thoughts and the final reply', () => {
    expect(tl.stats.usage).toEqual({ input: 14000, cacheRead: 24000, cacheWrite: 0, output: 1300 });
    expect(tl.stats.costUsd).toBeGreaterThan(0);
    expect(tl.events.find((e) => e.kind === 'thinking')).toMatchObject({ text: 'Finding the helper: Look at src/slug.ts first' });
    expect(tl.events.at(-1)).toMatchObject({ kind: 'message', final: true });
  });
  it('auto-detects Gemini files', () => {
    expect(parseSession(gemini, 'session-2026.json').source).toBe('gemini');
  });
  it('auto-detects Gemini JSONL files', () => {
    expect(parseSession(geminiJsonl, 'session-2026-10-20T09-00-9f2c1a7e.jsonl').source).toBe('gemini');
  });
  it('replays the JSONL log (re-appended messages, $patch, $rewindTo, $set) to the same timeline', () => {
    const j = parseGemini(geminiJsonl, 'x', '/Users/dev/blog');
    expect(j.events).toEqual(tl.events);
    expect(j.stats).toEqual(tl.stats);
    expect(j.events.some((e) => e.kind === 'message' && e.text.includes('rewrite the whole file'))).toBe(false);
  });
  it('works without token data', () => {
    const t = parseGemini(JSON.stringify({ sessionId: 's', messages: [{ type: 'user', timestamp: '2026-01-01T00:00:00Z', content: 'hi' }] }));
    expect(t.stats.tokens).toBe(0);
  });
  it('cleans shell output', () => {
    expect(cleanShellOutput('Command: ls\nOutput: (empty)\nError: (none)\nExit Code: 0')).toEqual({ text: '', ok: true });
    expect(cleanShellOutput('Command: x\nOutput: \nError: boom\nExit Code: 2').ok).toBe(false);
  });
  it('finds sessions for a folder by its .project_root marker', () => {
    const all = [{ source: 'gemini' as const, id: '1', file: '/h/.gemini/tmp/blog/chats/session-1.jsonl', mtime: 1, size: 1, cwd: '/Users/dev/blog' }];
    expect(sessionsForCwd('/Users/dev/blog', all)).toHaveLength(1);
    expect(sessionsForCwd('/Users/other/blog', all)).toHaveLength(0);
  });
  it('scans <GEMINI_CLI_HOME>/.gemini/tmp for .json and .jsonl chats, skipping subagents', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vr-gem-'));
    const prev = process.env.GEMINI_CLI_HOME;
    process.env.GEMINI_CLI_HOME = home;
    try {
      const root = geminiRoot();
      expect(root).toBe(path.join(home, '.gemini', 'tmp'));
      fs.mkdirSync(path.join(root, 'blog', 'chats', 'parent'), { recursive: true });
      fs.writeFileSync(path.join(root, 'blog', '.project_root'), '/Users/dev/blog');
      fs.writeFileSync(path.join(root, 'blog', 'chats', 'session-2026-10-20T09-00-9f2c1a7e.jsonl'), geminiJsonl);
      fs.writeFileSync(path.join(root, 'blog', 'chats', 'parent', 'sub.jsonl'), geminiJsonl);
      fs.mkdirSync(path.join(root, 'abc123', 'chats'), { recursive: true });
      fs.writeFileSync(path.join(root, 'abc123', 'chats', 'session-old.json'), gemini);
      const found = geminiSessions().sort((a, b) => a.file.localeCompare(b.file));
      expect(found).toHaveLength(2);
      expect(found.map((s) => s.cwd)).toEqual([undefined, '/Users/dev/blog']);
    } finally {
      if (prev === undefined) delete process.env.GEMINI_CLI_HOME; else process.env.GEMINI_CLI_HOME = prev;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
  it('finds sessions for a folder by legacy project hash', () => {
    const f = `/h/.gemini/tmp/${geminiProjectHash('/Users/dev/blog')}/chats/session-1.json`;
    const all = [{ source: 'gemini' as const, id: '1', file: f, mtime: 1, size: 1 }];
    expect(sessionsForCwd('/Users/dev/blog', all)).toHaveLength(1);
    expect(sessionsForCwd('/Users/dev/other', all)).toHaveLength(0);
  });
});

describe('helpers', () => {
  it('diffs lines', () => {
    expect(lineDiff('a\nb\nc', 'a\nB\nc').map((d) => d.op).join('')).toBe(' -+ ');
  });
  it('recognises test commands', () => {
    for (const c of ['npm test', 'pnpm run test', 'npx vitest run', 'pytest -q', 'cargo test', 'go test ./...', 'cd api && python -m pytest'])
      expect(isTestCommand(c), c).toBe(true);
    for (const c of ['npm run build', 'git commit -m "test it"', 'ls tests'])
      expect(isTestCommand(c), c).toBe(false);
  });
  it('makes titles', () => {
    expect(makeTitle('Fix the login bug. Then deploy.')).toBe('Fix the login bug.');
    expect(makeTitle('', 'configure-claude-defaults')).toBe('Configure claude defaults');
  });
});
