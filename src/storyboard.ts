import type { Event, Timeline } from './types.js';

export interface Scene {
  kind: Event['kind'];
  /** film seconds */
  start: number;
  dur: number;
  /** real ms since session start */
  realAt: number;
  tokens: number;
  cost: number;
  ev: Event;
}

export interface FileTouch {
  path: string;
  /** film seconds */
  at: number;
  type: 'read' | 'edit' | 'create';
}

export interface Reel {
  version: 1;
  title: string;
  project: string;
  source: Timeline['source'];
  model?: string;
  duration: number;
  endCardAt: number;
  scenes: Scene[];
  touches: FileTouch[];
  stats: Timeline['stats'];
  generator: string;
}

export interface StoryboardOptions {
  /** target film length in seconds */
  duration?: number;
}

const NOISE_CMD = /^\s*(ls|pwd|cd|echo|which|cat|head|tail|wc|true|clear|date|whoami|mkdir|sleep)\b(?![^|;&]*(test|build))/;

/** How much a beat deserves to be in the film. -1 = never, Infinity = always. */
export function score(e: Event, i: number, firstPromptIdx: number, prev?: Event): number {
  switch (e.kind) {
    case 'prompt': return i === firstPromptIdx ? Infinity : 45;
    case 'edit': return 22 + Math.min(45, e.added + e.removed) + (e.created ? 4 : 0);
    case 'command':
      if (e.isTest) return e.redToGreen ? 85 : e.testState === 'fail' ? 60 : 40;
      if (NOISE_CMD.test(e.command)) return 4;
      return e.exitOk ? 16 : 24;
    case 'thinking': return /^\s*1[.)]/.test(e.text) ? 30 : 14;
    // the agent explaining a failure is the story; other chatter is filler
    case 'message': return e.final ? Infinity : e.text.length < 24 ? 2 : prev?.kind === 'command' && !prev.exitOk ? 50 : 10;
    case 'read': return 7;
    case 'search': return 3;
    case 'tool': return 2;
    case 'subagent': return e.text ? 34 : 6;
  }
}

/** Seconds a beat wants on screen before global scaling. */
export function baseDuration(e: Event): number {
  switch (e.kind) {
    case 'prompt': return clamp(1.4 + Math.min(e.text.length, 280) * 0.011, 2.2, 4.0);
    case 'edit': return clamp(1.7 + Math.min(e.diff.length, 30) * 0.03, 1.8, 2.8);
    case 'command': return e.isTest ? 2.6 : 1.7;
    case 'thinking': return 2.0;
    case 'message': return e.final ? 2.8 : 2.2;
    case 'read': return 1.1;
    case 'search': return 0.9;
    case 'tool': return 0.9;
    case 'subagent': return 2.4;
  }
}

const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));

export function storyboard(tl: Timeline, o: StoryboardOptions = {}): Reel {
  const target = clamp(o.duration ?? 30, 8, 180);
  const endCard = target >= 20 ? 4.5 : 3;
  const budget = target - endCard;
  const ev = tl.events;
  const firstPrompt = ev.findIndex((e) => e.kind === 'prompt');

  // red->green: keep the failing run right before each green one
  const forced = new Set<number>();
  // only the last red->green moment is guaranteed; earlier ones compete on score
  let lastGreen = -1;
  ev.forEach((e, i) => { if (e.kind === 'command' && e.redToGreen) lastGreen = i; });
  ev.forEach((e, i) => {
    const s = score(e, i, firstPrompt, ev[i - 1]);
    if (s === Infinity || i === lastGreen) forced.add(i);
    if (i === lastGreen) {
      for (let j = i - 1; j >= 0; j--) {
        const f = ev[j];
        if (f.kind === 'command' && f.isTest && f.testState === 'fail') { forced.add(j); break; }
      }
    }
  });

  const picked = new Set<number>(forced);
  let used = [...picked].reduce((s, i) => s + baseDuration(ev[i]), 0);
  const ranked = ev
    .map((e, i) => ({ i, s: score(e, i, firstPrompt, ev[i - 1]) }))
    .filter((x) => !picked.has(x.i) && x.s >= 5)
    .sort((a, b) => b.s - a.s || a.i - b.i);
  for (const { i } of ranked) {
    const d = baseDuration(ev[i]);
    if (used + d > budget * 1.05) continue;
    picked.add(i);
    used += d;
  }

  const order = [...picked].sort((a, b) => a - b);
  // don't stretch a short session into slow motion
  const factor = used > 0 ? Math.min(budget / used, 1.35) : 1;
  const scenes: Scene[] = [];
  let t = 0;
  for (const i of order) {
    const e = ev[i];
    const dur = +(baseDuration(e) * factor).toFixed(3);
    scenes.push({ kind: e.kind, start: +t.toFixed(3), dur, realAt: e.at, tokens: tl.tokensAt[i] ?? 0, cost: tl.costAt[i] ?? 0, ev: e });
    t += dur;
  }
  const endCardAt = +t.toFixed(3);

  // every touched file lights up, even when its beat was skipped: map real time onto film time
  const toFilm = (ms: number) => {
    if (!scenes.length) return 0;
    if (ms <= scenes[0].realAt) return 0;
    for (let k = 0; k < scenes.length; k++) {
      const a = scenes[k], b = scenes[k + 1];
      if (!b) return a.start + Math.min(a.dur, 0.25);
      if (ms < b.realAt) {
        const f = (ms - a.realAt) / Math.max(1, b.realAt - a.realAt);
        return a.start + f * a.dur;
      }
    }
    return endCardAt;
  };
  const touches: FileTouch[] = [];
  for (const e of ev) {
    if (e.kind === 'edit') touches.push({ path: e.path, at: +toFilm(e.at).toFixed(3), type: e.created ? 'create' : 'edit' });
    else if (e.kind === 'read') touches.push({ path: e.path, at: +toFilm(e.at).toFixed(3), type: 'read' });
  }
  // a shown scene touches its file at its own start, so the tree and editor agree
  for (const s of scenes) {
    if (s.ev.kind === 'edit' || s.ev.kind === 'read') {
      const p = s.ev.path;
      const tch = touches.find((x) => x.path === p && Math.abs(x.at - s.start) < s.dur + 0.5);
      if (tch) tch.at = s.start;
    }
  }

  return {
    version: 1,
    title: tl.title,
    project: tl.project,
    source: tl.source,
    model: tl.stats.model,
    duration: +(endCardAt + endCard).toFixed(3),
    endCardAt,
    scenes,
    touches,
    stats: tl.stats,
    generator: 'vibereel',
  };
}
