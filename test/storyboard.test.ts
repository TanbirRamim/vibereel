import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseClaude } from '../src/parsers/claude';
import { storyboard } from '../src/storyboard';
import { renderHtml, THEMES } from '../src/html';
import type { Event, Timeline } from '../src/types';

const tl = parseClaude(fs.readFileSync(new URL('../fixtures/demo-dark-mode.jsonl', import.meta.url), 'utf8'));

function big(n: number): Timeline {
  const events: Event[] = [{ kind: 'prompt', at: 0, text: 'do it' }];
  for (let i = 1; i < n; i++) events.push(i % 3 ? { kind: 'read', at: i * 1000, path: `f${i}.ts` } : { kind: 'edit', at: i * 1000, path: `f${i}.ts`, created: false, added: i % 40, removed: 1, diff: [] });
  events.push({ kind: 'message', at: n * 1000, text: 'all done here, thanks', final: true });
  return { ...tl, events, tokensAt: events.map(() => 0), costAt: events.map(() => 0) };
}

describe('storyboard', () => {
  it('fits the target duration', () => {
    for (const d of [15, 30, 60]) {
      const r = storyboard(tl, { duration: d });
      expect(r.duration).toBeLessThanOrEqual(d + 1.5);
    }
    const r = storyboard(big(2000), { duration: 30 });
    expect(r.duration).toBeGreaterThan(27);
    expect(r.duration).toBeLessThanOrEqual(31.5);
  });
  it('keeps first prompt, final message and red->green pair', () => {
    const r = storyboard(tl, { duration: 15 });
    expect(r.scenes[0].kind).toBe('prompt');
    expect(r.scenes.at(-1)!.ev).toMatchObject({ kind: 'message', final: true });
    const tests = r.scenes.filter((s) => s.ev.kind === 'command' && s.ev.isTest).map((s) => s.ev.kind === 'command' && s.ev.testState);
    expect(tests).toEqual(['fail', 'pass']);
  });
  it('keeps chronological order without overlaps', () => {
    const r = storyboard(big(500));
    for (let i = 1; i < r.scenes.length; i++) {
      expect(r.scenes[i].realAt).toBeGreaterThanOrEqual(r.scenes[i - 1].realAt);
      expect(r.scenes[i].start).toBeCloseTo(r.scenes[i - 1].start + r.scenes[i - 1].dur, 2);
    }
  });
  it('prefers big edits over reads', () => {
    const r = storyboard(big(300));
    const kinds = r.scenes.map((s) => s.kind);
    expect(kinds.filter((k) => k === 'edit').length).toBeGreaterThan(kinds.filter((k) => k === 'read').length);
  });
  it('lights up every touched file, even skipped ones', () => {
    const r = storyboard(big(300));
    expect(new Set(r.touches.map((t) => t.path)).size).toBe(299);
    expect(r.touches.every((t) => t.at >= 0 && t.at <= r.endCardAt)).toBe(true);
  });
  it('does not stretch tiny sessions into slow motion', () => {
    const tiny = { ...tl, events: [tl.events[0]], tokensAt: [0], costAt: [0] };
    expect(storyboard(tiny).duration).toBeLessThan(12);
  });
});

describe('themes', () => {
  const css = fs.readFileSync(new URL('../src/player/player.css', import.meta.url), 'utf8');
  const client = fs.readFileSync(new URL('../src/player/client.js', import.meta.url), 'utf8');
  it('every theme has colors in player.css', () => {
    for (const theme of THEMES) expect(css).toContain(`[data-theme="${theme}"]`);
  });
  it('the player cycles through the same themes as the CLI', () => {
    const list = client.match(/var THEMES = \[([^\]]*)\]/)?.[1] ?? '';
    expect(list.split(',').map((s) => s.trim().replace(/'/g, ''))).toEqual(THEMES);
  });
});

describe('html', () => {
  const r = storyboard(tl);
  const html = renderHtml(r, { theme: 'retro', aspect: '9:16' });
  it('is self-contained', () => {
    expect(html).not.toMatch(/<script[^>]+src=|<link[^>]+href=|https?:\/\/(?!www\.w3)/);
    expect(html).toContain('data-theme="retro"');
    expect(html).toContain('data-aspect="9:16"');
  });
  it('cannot be broken out of by session text', () => {
    const evil = { ...r, title: '</script><script>alert(1)</script>' };
    const h = renderHtml(evil);
    expect(h.match(/<\/script>/g)!.length).toBe(2);
  });
});
