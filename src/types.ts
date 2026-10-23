export type Source = 'claude' | 'codex' | 'gemini';

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface DiffLine {
  op: '+' | '-' | ' ';
  text: string;
}

interface Base {
  /** ms since session start */
  at: number;
}

export type Event =
  | (Base & { kind: 'prompt'; text: string })
  | (Base & { kind: 'thinking'; text: string })
  | (Base & { kind: 'read'; path: string; preview?: string[] })
  | (Base & { kind: 'search'; query: string; path?: string })
  | (Base & {
      kind: 'edit';
      path: string;
      created: boolean;
      diff: DiffLine[];
      added: number;
      removed: number;
    })
  | (Base & {
      kind: 'command';
      command: string;
      output: string[];
      exitOk: boolean;
      isTest: boolean;
      /** set by the normaliser: a failing test run later turned green */
      testState?: 'fail' | 'pass';
      redToGreen?: boolean;
    })
  | (Base & { kind: 'tool'; name: string; detail: string })
  | (Base & { kind: 'message'; text: string; final?: boolean });

export type EventKind = Event['kind'];

export interface Stats {
  durationMs: number;
  toolCalls: number;
  filesTouched: string[];
  tokens: number;
  usage: Usage;
  costUsd: number;
  model?: string;
  linesAdded: number;
  linesRemoved: number;
  prompts: number;
}

export interface Timeline {
  version: 1;
  source: Source;
  sessionId: string;
  project: string;
  cwd?: string;
  title: string;
  startedAt: string;
  events: Event[];
  /** cumulative tokens at each event index, for the live counter */
  tokensAt: number[];
  costAt: number[];
  stats: Stats;
}
