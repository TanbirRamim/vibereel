# vibereel

Turn your last Claude Code, Codex or Gemini CLI session into a 30-second film you can actually share.

[![CI](https://github.com/TanbirRamim/vibereel/actions/workflows/ci.yml/badge.svg)](https://github.com/TanbirRamim/vibereel/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

![A 47-minute session adding dark mode to a todo app, replayed in 30 seconds](assets/demo.gif)

That's a 47-minute session squeezed into 30 seconds: the prompt, the plan, the edits, a failing test run, the fix, and the green run. ([MP4](assets/demo.mp4) · [interactive HTML](assets/demo.html))

```sh
npx github:TanbirRamim/vibereel
```

(The npm package is on its way. Until then this installs straight from GitHub; once it's live it's just `npx vibereel`.)

Run it inside a project you've used Claude Code, Codex or Gemini CLI in. You get one self-contained `vibereel-<id>.html` file. Open it in any browser, or drop it anywhere you'd host a static page. No CDN, no tracking, nothing to install for the viewer.

Want a video for X, Slack or a PR?

```sh
npx github:TanbirRamim/vibereel --gif --mp4
```

## As a Claude Code slash command

```
/plugin marketplace add TanbirRamim/vibereel
/plugin install vibereel@vibereel
```

Then type `/vibereel` at the end of any session (or `/vibereel --gif --mp4`) and it films the session you're in.

## What's in the film

- your prompt, typed out
- the agent's plan, when it made one
- a file tree that lights up as files get read and changed
- diffs sliding in, with green and red where they belong
- a terminal running the commands, with a red to green test badge when a broken run gets fixed
- live counters for real time, tokens and an estimated cost
- an end card with the totals

It doesn't play everything back. It picks the moments that tell the story (the first prompt, the biggest edits, red to green runs, the final message), skips the noise (`ls`, re-reads, tiny chatter) and fits them into the length you ask for.

Three themes: `dark` (default), `light` and `retro`. Two shapes: `16:9` and `9:16` for phones. In the HTML player, press `space` to pause, `←`/`→` to scrub, `t` to switch themes and `a` to switch aspect.

## Privacy

Session logs are private, so vibereel is careful with them.

- **It runs only on your machine.** Nothing is uploaded. The HTML file is the only output, plus the GIF/MP4 if you ask for them.
- **Redaction is on by default.** Your home folder becomes `~`. API keys (Anthropic, OpenAI, GitHub, AWS, Stripe, Slack, Google and more), JWTs, bearer tokens, passwords in URLs, `SECRET=...` style assignments and email addresses are masked. Every value in `.env` files is blanked.
- **Long output is cut.** Command output and file contents are trimmed to what fits on screen anyway.

Pattern matching can't catch everything. Watch your reel once before you post it. `--no-redact` turns redaction off if the session is yours to show.

## Options

```
npx github:TanbirRamim/vibereel [options]

  --list             recent sessions for this folder (add --all for every project)
  --session <id>     pick a session by id or id prefix
  --file <path>      render a specific .jsonl file
  --out <file.html>  where to write the player (default: vibereel-<id>.html)
  --theme <name>     dark | light | retro
  --aspect <ratio>   16:9 | 9:16
  --duration <sec>   target length, 8-180 (default 30)
  --gif, --mp4       also export video next to the HTML
  --open             open the result when done
  --no-redact        keep paths, emails and secrets as they are
  --json             also write the normalised timeline JSON
```

Exporting video needs Chrome (or Chromium, Edge or Brave) and `ffmpeg` on your machine. vibereel finds them on its own; set `CHROME_PATH` if it doesn't. If either is missing, it tells you and still writes the HTML.

Sessions are read from `~/.claude/projects`, `~/.codex/sessions` and `~/.gemini/tmp`. `CLAUDE_CONFIG_DIR`, `CODEX_HOME` and `GEMINI_CLI_HOME` are respected (Gemini CLI's legacy `.json` and current `.jsonl` chats are both read).

## What it doesn't do yet

- Cursor, Aider and other agents. The timeline format is shared, so a parser is the only missing piece. PRs welcome.
- Cost is an estimate from public list prices. It won't match your bill exactly, and subscription plans don't pay per token anyway.
- Subagent work is skipped; only the main conversation is shown.
- Line numbers in diffs are relative to the edited snippet, not the real file.
- Video export takes about a minute, because it renders each frame in headless Chrome.
- Redaction is pattern-based. It's good, not perfect.

## FAQ

**Does anything leave my machine?**
No. vibereel reads the session file, writes an HTML file, and that's it. No network calls, no telemetry. The player itself has no external requests either.

**Which agents work?**
Claude Code, Codex CLI and Gemini CLI today. A Cursor parser is an open issue if you want to help.

**Why is my reel only a few seconds long?**
Short sessions don't have enough moments to fill 30 seconds, so vibereel doesn't pad them. Use `--duration` to ask for a different length.

**Video export says Chrome or ffmpeg is missing.**
Install ffmpeg (`brew install ffmpeg`, `apt install ffmpeg`, `winget install ffmpeg`) and point `CHROME_PATH` at any Chromium based browser. The HTML is still written either way.

**Can I post a reel of someone else's session?**
Only with their OK. Sessions often contain private code even after redaction.

## Contributing

Issues labelled [good first issue](https://github.com/TanbirRamim/vibereel/labels/good%20first%20issue) are a nice way in, and new parsers and themes are very welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, and please never attach real session logs to issues or PRs. Changes are listed in the [CHANGELOG](CHANGELOG.md). Security reports go through [SECURITY.md](SECURITY.md).

## Development

```sh
npm install
npm test          # vitest, synthetic fixtures only
npm run demo      # rebuilds assets/demo.* from fixtures/demo-dark-mode.jsonl
```

The demo session in `fixtures/` is written by hand (`node fixtures/make-demo.mjs`). No real transcripts live in this repo.

## License

[MIT](LICENSE)
