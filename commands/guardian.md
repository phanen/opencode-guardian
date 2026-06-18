---
name: guardian
description: Toggle or inspect Guardian mode (on/off/auto_review/status)
subtask: false
arguments:
  - name: action
    description: "One of: on, off, auto_review, status, toggle"
    required: false
---

This command is implemented by the Guardian plugin.

The plugin already handled the action and set the response. Repeat the plugin's response text verbatim — do not rephrase, do not add anything, do not call any tools.
