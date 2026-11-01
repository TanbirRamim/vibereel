import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Reel } from './storyboard.js';

export type Theme = 'dark' | 'light' | 'retro' | 'dracula';
export type Aspect = '16:9' | '9:16';
export const THEMES: Theme[] = ['dark', 'light', 'retro', 'dracula'];
export const ASPECTS: Aspect[] = ['16:9', '9:16'];

const here = path.dirname(fileURLToPath(import.meta.url));
const asset = (name: string) => fs.readFileSync(path.join(here, 'player', name), 'utf8');

/** JSON safe to inline inside <script>. */
const LS = String.fromCharCode(0x2028), PS = String.fromCharCode(0x2029);
export const inlineJson = (v: unknown) =>
  JSON.stringify(v).replace(/</g, '\\u003c').split(LS).join('\\u2028').split(PS).join('\\u2029');

const escAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

export function renderHtml(reel: Reel, opts: { theme?: Theme; aspect?: Aspect } = {}): string {
  const theme = opts.theme ?? 'dark', aspect = opts.aspect ?? '16:9';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="vibereel">
<title>${escAttr(reel.title)} · vibereel</title>
<style>${asset('player.css')}</style>
</head>
<body data-theme="${theme}" data-aspect="${aspect}">
<div id="viewport"><div id="stage"></div></div>
<div class="ctl"><button onclick="dispatchEvent(new KeyboardEvent('keydown',{key:' '}))">play/pause</button><button onclick="dispatchEvent(new KeyboardEvent('keydown',{key:'t'}))">theme</button><button onclick="dispatchEvent(new KeyboardEvent('keydown',{key:'a'}))">aspect</button></div>
<script type="application/json" id="reel-data">${inlineJson(reel)}</script>
<script>${asset('client.js')}</script>
</body>
</html>
`;
}
