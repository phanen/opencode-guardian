# opencode-guardian

OpenCode plugin that auto-reviews approval requests using a guardian LLM with a risk-based decision framework. Inspired by [Codex's guardian](https://github.com/openai/codex).

## Install

```bash
npm install && npm run build
./scripts/install.sh
```

The script registers the plugin via `opencode plugin -g` and copies `commands/guardian.md` to `~/.config/opencode/commands/`. Idempotent. Set `DRY_RUN=1` to print actions without executing.

## Modes

> [!NOTE]
> Throw error is expected: see https://github.com/anomalyco/opencode/issues/28292#issuecomment-4493933602
> tui can refresh the screen by resizing.
>
> **EDIT:** opencode have `/yolo` now (`/guardian skip`) https://github.com/anomalyco/opencode/commit/0a5bed2bc2549d988ba969765ec6722615c56e01

- **user** (default) - Plugin is passive. No auto-review. All approvals go to the human.
- **auto_review** - Every approval request is routed to the guardian LLM, which returns allow/deny. The user is only asked for the actions the guardian chose to escalate.

Switch at runtime:

- `/guardian` - toggle user <-> auto_review
- `/guardian on` or `/guardian auto_review` - enable auto-review
- `/guardian off` or `/guardian user` - disable
- `/guardian skip` or `/guardian dangerously_skip` - auto-allow every approval without LLM review (escape hatch)
- `/guardian status` - show current mode
- `/guardian start` - emit a kickoff message (useful after enabling)

## Credits

- https://github.com/openai/codex/tree/main/codex-rs/core/src/guardian
- https://github.com/frankhommers/opencode-yolo

## License

MIT
