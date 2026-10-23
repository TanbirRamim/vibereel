#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { build } from './index.js';
import { allSessions, findSession, sessionsForCwd, type SessionFile } from './sessions.js';
import { exportVideo, ExportError } from './export.js';
import { ASPECTS, THEMES, type Aspect, type Theme } from './html.js';
import { redactPaths } from './redact.js';

export const VERSION = '0.1.0';

const HELP = `vibereel ${VERSION}: turn your latest Claude Code, Codex or Gemini CLI session into a short film

Usage
  npx vibereel                 latest session for this folder -> vibereel-<id>.html
  npx vibereel --gif --mp4     also export a GIF and an MP4 (needs Chrome + ffmpeg)
  npx vibereel --list          recent sessions for this folder (--all for every project)

Options
  --session <id>     pick a session by id or id prefix
  --file <path>      render a specific session file (.jsonl or Gemini .json)
  --out <file.html>  where to write the player (default: vibereel-<id>.html)
  --theme <name>     dark | light | retro            (default: dark)
  --aspect <ratio>   16:9 | 9:16                     (default: 16:9)
  --duration <sec>   target length in seconds        (default: 30)
  --gif, --mp4       export video next to the HTML file
  --open             open the result when done
  --no-redact        keep paths, emails and secrets as they are (careful)
  --json             also write the normalised timeline as JSON
  -h, --help         show this help
  -v, --version      print the version
`;

export interface CliOptions {
  list: boolean; all: boolean; session?: string; file?: string; out?: string;
  theme: Theme; aspect: Aspect; duration: number; gif: boolean; mp4: boolean;
  open: boolean; redact: boolean; json: boolean; help: boolean; version: boolean;
}

export function parseCli(argv: string[]): CliOptions {
  const redact = !argv.includes('--no-redact');
  const { values } = parseArgs({
    args: argv.filter((a) => a !== '--no-redact' && a !== '--redact'),
    strict: true,
    options: {
      list: { type: 'boolean', short: 'l' }, all: { type: 'boolean' },
      session: { type: 'string', short: 's' }, file: { type: 'string', short: 'f' },
      out: { type: 'string', short: 'o' }, theme: { type: 'string' }, aspect: { type: 'string' },
      duration: { type: 'string', short: 'd' }, gif: { type: 'boolean' }, mp4: { type: 'boolean' },
      open: { type: 'boolean' }, json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
    },
  });
  const theme = (values.theme ?? 'dark') as Theme;
  if (!THEMES.includes(theme)) throw new Error(`Unknown theme "${values.theme}". Pick one of: ${THEMES.join(', ')}`);
  const aspect = (values.aspect ?? '16:9') as Aspect;
  if (!ASPECTS.includes(aspect)) throw new Error(`Unknown aspect "${values.aspect}". Use 16:9 or 9:16`);
  const duration = values.duration === undefined ? 30 : Number(String(values.duration).replace(/s$/, ''));
  if (!Number.isFinite(duration) || duration < 8 || duration > 180) throw new Error('--duration must be a number of seconds between 8 and 180');
  if (values.out && !/\.html?$/i.test(values.out)) throw new Error('--out should end in .html (video files are written next to it)');
  return {
    list: !!values.list, all: !!values.all, session: values.session, file: values.file, out: values.out,
    theme, aspect, duration, gif: !!values.gif, mp4: !!values.mp4, open: !!values.open, redact,
    json: !!values.json, help: !!values.help, version: !!values.version,
  };
}

function ago(ms: number) {
  const s = (Date.now() - ms) / 1000;
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
const kb = (n: number) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);

function openFile(p: string) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', p] : [p];
  spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
}

export async function main(argv = process.argv.slice(2), cwd = process.cwd()): Promise<number> {
  let o: CliOptions;
  try { o = parseCli(argv); } catch (e: any) { console.error(`vibereel: ${e.message}\nRun vibereel --help for usage.`); return 2; }
  if (o.help) { console.log(HELP); return 0; }
  if (o.version) { console.log(VERSION); return 0; }

  let pick: { file: string; id: string; cwd?: string } | undefined;
  if (o.file) {
    if (!fs.existsSync(o.file)) { console.error(`vibereel: no such file ${o.file}`); return 1; }
    pick = { file: o.file, id: path.basename(o.file).replace(/\.jsonl?$/, '') };
  } else {
    const all = allSessions();
    const here = sessionsForCwd(cwd, all);
    if (o.list) {
      const rows = (o.all || !here.length ? all : here).slice(0, 20);
      if (!here.length && !o.all) console.log(`No sessions for ${redactPaths(cwd)}; showing all projects.\n`);
      for (const s of rows) {
        console.log(`${s.id.slice(0, 8)}  ${s.source.padEnd(6)}  ${ago(s.mtime).padEnd(8)}  ${kb(s.size).padStart(7)}  ${redactPaths(s.cwd ?? '?')}`);
      }
      if (!rows.length) console.log('No Claude Code, Codex or Gemini CLI sessions found in ~/.claude/projects, ~/.codex/sessions or ~/.gemini/tmp.');
      return 0;
    }
    let s: SessionFile | undefined;
    if (o.session) s = findSession(o.session, all);
    else s = here[0];
    if (!s && !o.session && all.length) {
      console.error(`vibereel: no sessions recorded for ${redactPaths(cwd)}.\nRun it inside a project you used Claude Code, Codex or Gemini CLI in, or pick one from: vibereel --list --all`);
      return 1;
    }
    if (!s) { console.error(o.session ? `vibereel: no session matching "${o.session}". Try vibereel --list --all` : 'vibereel: no Claude Code, Codex or Gemini CLI sessions found.'); return 1; }
    pick = { file: s.file, id: s.id, cwd: s.cwd ?? (here.includes(s) ? cwd : undefined) };
  }

  const text = fs.readFileSync(pick.file, 'utf8');
  let res;
  try { res = build(text, pick.file, { cwd: pick.cwd, redact: o.redact, duration: o.duration, theme: o.theme, aspect: o.aspect }); }
  catch (e: any) { console.error(`vibereel: could not read ${pick.file}: ${e.message}`); return 1; }

  const out = path.resolve(cwd, o.out ?? `vibereel-${pick.id.slice(0, 8)}.html`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, res.html);
  const st = res.timeline.stats;
  console.log(`vibereel: ${res.reel.scenes.length} beats from ${res.timeline.events.length} events, ${Math.round(st.durationMs / 60000)} min -> ${Math.round(res.reel.duration)}s`);
  if (!o.redact) console.log('  redaction is OFF: paths, emails and secrets are left as-is');
  console.log(`  ${out}`);
  if (o.json) { const j = out.replace(/\.html?$/i, '.timeline.json'); fs.writeFileSync(j, JSON.stringify(res.timeline, null, 2)); console.log(`  ${j}`); }

  if (o.gif || o.mp4) {
    const stem = out.replace(/\.html?$/i, '');
    try {
      await exportVideo({ html: res.html, aspect: o.aspect, duration: res.reel.duration, mp4: o.mp4 ? stem + '.mp4' : undefined, gif: o.gif ? stem + '.gif' : undefined, log: (s) => console.log(s) });
    } catch (e: any) {
      console.error(`vibereel: video export skipped. ${e instanceof ExportError ? e.message : e?.message ?? e}`);
      if (o.open) openFile(out);
      return e instanceof ExportError ? 0 : 1;
    }
  }
  if (o.open) openFile(o.mp4 ? out.replace(/\.html?$/i, '.mp4') : out);
  return 0;
}

const invoked = process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname);
if (invoked) main().then((c) => process.exit(c));
