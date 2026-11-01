import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { main, parseCli } from '../src/cli';
import { claudeProjectDir, findSession, sessionsForCwd, type SessionFile } from '../src/sessions';

describe('parseCli', () => {
  it('has sane defaults', () => {
    expect(parseCli([])).toMatchObject({ theme: 'dark', aspect: '16:9', duration: 30, redact: true, gif: false, mp4: false, list: false });
  });
    it('accepts the dracula theme', () => {
    expect(parseCli(['--theme', 'dracula']).theme).toBe('dracula');
  });
  it('reads every flag', () => {
    const o = parseCli(['--session', 'abc', '--out', 'x.html', '--theme', 'retro', '--aspect', '9:16', '--duration', '45s', '--gif', '--mp4', '--open', '--no-redact', '--json']);
    expect(o).toMatchObject({ session: 'abc', out: 'x.html', theme: 'retro', aspect: '9:16', duration: 45, gif: true, mp4: true, open: true, redact: false, json: true });
    expect(parseCli(['-l']).list).toBe(true);
  });
  it('rejects bad values', () => {
    expect(() => parseCli(['--theme', 'neon'])).toThrow(/theme/);
    expect(() => parseCli(['--aspect', '4:3'])).toThrow(/aspect/);
    expect(() => parseCli(['--duration', '2'])).toThrow(/duration/);
    expect(() => parseCli(['--out', 'x.mp4'])).toThrow(/html/);
    expect(() => parseCli(['--wat'])).toThrow();
  });
});

describe('sessions', () => {
  it('encodes project dirs like Claude Code', () => {
    expect(claudeProjectDir('/Users/a/my.app')).toBe('-Users-a-my-app');
  });
  it('finds sessions by cwd and id prefix', () => {
    const all: SessionFile[] = [
      { source: 'claude', id: 'aaaa1111', file: '/p/-Users-a-x/aaaa1111.jsonl', mtime: 2, size: 1 },
      { source: 'codex', id: 'bbbb2222', file: '/c/rollout-bbbb.jsonl', mtime: 1, size: 1, cwd: '/Users/a/x' },
      { source: 'codex', id: 'cccc', file: '/c/rollout-cccc.jsonl', mtime: 3, size: 1, cwd: '/elsewhere' },
    ];
    expect(sessionsForCwd('/Users/a/x', all).map((s) => s.id)).toEqual(['aaaa1111', 'bbbb2222']);
    expect(findSession('bbbb', all)?.id).toBe('bbbb2222');
  });
});

describe('main', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibereel-test-'));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fixture = path.resolve(__dirname, '../fixtures/demo-dark-mode.jsonl');
  it('renders a file to html and json', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await main(['--file', fixture, '--out', 'r.html', '--json'], dir);
    log.mockRestore();
    expect(code).toBe(0);
    const html = fs.readFileSync(path.join(dir, 'r.html'), 'utf8');
    expect(html).toContain('vibereel');
    expect(html).not.toContain('/Users/alex');
    expect(fs.existsSync(path.join(dir, 'r.timeline.json'))).toBe(true);
  });
  it('fails cleanly on bad args and missing files', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await main(['--theme', 'x'], dir)).toBe(2);
    expect(await main(['--file', path.join(dir, 'nope.jsonl')], dir)).toBe(1);
    err.mockRestore();
  });
});
