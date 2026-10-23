import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { main } from '../../src/cli';

// Real MP4/GIF export through Chrome + ffmpeg. Run with `npm run test:e2e`.
const fixture = path.resolve(__dirname, '../../fixtures/demo-dark-mode.jsonl');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibereel-e2e-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

function probe(file: string): string {
  return execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', file], { encoding: 'utf8' }).trim();
}

describe.each([
  ['16:9', '1920x1080'],
  ['9:16', '1080x1920'],
])('export %s', (aspect, size) => {
  it('writes a non-empty MP4 and GIF', async () => {
    const out = `reel-${aspect.replace(':', 'x')}.html`;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await main(['--file', fixture, '--out', out, '--aspect', aspect, '--duration', '8', '--mp4', '--gif'], dir);
    log.mockRestore();
    expect(code).toBe(0);
    const stem = path.join(dir, out.replace(/\.html$/, ''));
    for (const ext of ['.mp4', '.gif']) expect(fs.statSync(stem + ext).size).toBeGreaterThan(1000);
    expect(probe(stem + '.mp4')).toBe(size);
  }, 240_000);
});
