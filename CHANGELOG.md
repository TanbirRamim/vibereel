# Changelog

All notable changes to this project are written down here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [semver](https://semver.org/).

## [Unreleased]

## [0.3.0] - 2026-10-23

- Task subagents show up as their own scenes, so you can see what each one did (#22).
- 9:16 file tree: a flat path list, so folders never get split across columns (#23).
- An end-to-end MP4/GIF export test that runs in CI (#21).
- Fix CodeQL alerts: open the output without a shell on Windows, escape quotes in player HTML attributes, and match `--!>` comment ends in the highlighter (#19).

## [0.2.0] - 2026-10-23

- Gemini CLI sessions: found under `~/.gemini/tmp` and parsed into the same timeline (prompts, shell runs, edits, thoughts, tokens).
- Gemini CLI: read the current append-only `.jsonl` session logs (with `$set`, `$patch` and `$rewindTo` records) as well as legacy `.json` files, match slug-named project folders via `.project_root`, and honour `GEMINI_CLI_HOME` instead of the non-existent `GEMINI_DIR`. User prompts use `displayContent` when present.
- Transcript parsers for Claude Code and Codex no longer use regexes that could backtrack for a long time on huge lines (CodeQL polynomial ReDoS).
- `/vibereel` slash command: install as a Claude Code plugin from this repo.

## [0.1.0] - 2026-10-10

First public release.

### Added

- `npx vibereel` turns the latest Claude Code or Codex session for the current folder into one self-contained HTML player.
- Storyboard that picks the moments worth showing (first prompt, plan, biggest edits, red to green test runs, final reply) and fits them into `--duration` seconds.
- Player with a file tree, diffs, a terminal with a test status badge, live counters for time, tokens and estimated cost, and an end card.
- Themes `dark`, `light` and `retro`; aspect ratios `16:9` and `9:16`. Keyboard controls in the player.
- `--gif` and `--mp4` export through a local Chrome and ffmpeg.
- Redaction on by default: home paths, API keys, tokens, URL passwords, `SECRET=` style assignments, emails and `.env` values. `--no-redact` to turn it off.
- `--list`, `--session`, `--file`, `--json` and `--open`.

[Unreleased]: https://github.com/TanbirRamim/vibereel/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/TanbirRamim/vibereel/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/TanbirRamim/vibereel/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/TanbirRamim/vibereel/releases/tag/v0.1.0
