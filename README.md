# opencode-guardian

OpenCode plugin that auto-reviews approval requests using a guardian LLM with a risk-based decision framework. Inspired by [Codex's guardian](https://github.com/openai/codex).

## Install

```bash
npm install && npm run build
./scripts/install.sh
```

The script registers the plugin via `opencode plugin -g` and copies `commands/guardian.md` to `~/.config/opencode/commands/`. Idempotent. Set `DRY_RUN=1` to print actions without executing.

## Modes

- **user** (default) - Plugin is passive. No auto-review. All approvals go to the human.
- **auto_review** - Every approval request is routed to the guardian LLM, which returns allow/deny. The user is only asked for the actions the guardian chose to escalate.

Switch at runtime:

- `/guardian` - toggle user <-> auto_review
- `/guardian on` or `/guardian auto_review` - enable auto-review
- `/guardian off` or `/guardian user` - disable
- `/guardian status` - show current mode
- `/guardian start` - emit a kickoff message (useful after enabling)

## Credits

- https://github.com/openai/codex/tree/main/codex-rs/core/src/guardian
- https://github.com/frankhommers/opencode-yolo

## License

MIT