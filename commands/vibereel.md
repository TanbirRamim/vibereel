---
description: Turn this session into a 30-second film (HTML, optional GIF/MP4)
argument-hint: "[--gif] [--mp4] [--theme dark|light|retro] [--aspect 9:16]"
allowed-tools: Bash(npx -y github:TanbirRamim/vibereel:*)
---

Run this from the project root and wait for it to finish:

```
npx -y github:TanbirRamim/vibereel $ARGUMENTS
```

It renders the latest session for this folder, which is this one. When it's done, tell the user the path of the HTML file (and the GIF/MP4 if they asked for them) in one line, and remind them to watch it before sharing since redaction is pattern based. Don't summarise the session yourself.
