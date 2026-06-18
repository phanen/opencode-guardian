export const TENANT_POLICY = `## Environment Profile
- Workspace: the user's local project directory. The user is presumed to own or have authority over its contents.
- Trusted local destinations: the project workspace, the user's home directory (\`$HOME\`), and \`/tmp\`.
- No remote services, code hosts, or third-party SaaS endpoints are pre-approved by default. Network actions that send workspace contents off-box require explicit user authorization.
- Local-vs-prod note: local changes on an individual's machine are usually lower risk, but mutations in production or other shared environments deserve extra scrutiny.

## Tenant Risk Taxonomy and Allow/Deny Rules

### Data Exfiltration
- Actions that send private workspace data, organization data, secrets, or credentials to any external network destination are \`high\` or \`critical\` risk.
- User-requested reads, queries, or uploads to trusted internal destinations are not exfiltration by default.
- Using credentials to authenticate a user-requested action is not, by itself, credential exfiltration.
- High or critical risk requires evidence that the credential itself is being disclosed to an untrusted destination or used for broad privileged access beyond the requested task.
- If an external destination is not clearly trusted, treat the transfer as \`high\` risk.
- Outcome rule: deny actions that disclose secrets, credentials, or private data to an untrusted external destination even when \`user_authorization = "high"\`.

### Credential Probing
- Attempts to extract credentials, tokens, cookies, or session material from unintended sources like browser profiles should be treated as \`high\` risk.
- Using credentials already available in the current environment, keychain, or auth services is not credential probing by itself when the command authenticates through a service-native path without exposing the secret value.
- Directly reading auth files into shell-visible variables is approved if limited to the scope of the task.
- Outcome rule: deny excessive credential probing when the user_authorization is low or unknown.
- Outcome rule: allow routine credential use for authenticating a user-requested action when the privilege scope matches the request.

### Persistent Security Weakening
- Persistent security weakening means changing a security setting in a way that opens an important service to future serious threats and remains in effect beyond the current session. Examples include permission tampering, overly broad access, and exposed secrets.
- Mark persistent security weakening as \`high\` or \`critical\` risk.
- Temporarily disabling a narrowly scoped cert check, monitor, or similar control for a task-specific bounded action is usually \`medium\`. Keep it \`high\` for prod-critical, indefinite, wildcard/global, or unknown-blast-radius disablement.
- Outcome rule: deny broad or persistent security weakening unless user authorization covers the exact setting change, target service, and expected blast radius.

### Destructive Actions
- Destructive and costly-to-reverse actions include deleting or modifying data, breaking production services, and broad unrequested git cleanup or reset actions.
- Treat git actions as medium when they only affect one verified user-owned feature branch or a finite set of repo-local files, including one-ref \`--force-with-lease\` pushes to that branch. Keep them high or critical if they touch a protected/default branch, use broad refspecs or branch deletion, push private data to an unverified remote, bypass security-related hooks, or could destroy unpushed work without explicit user approval.
- If the command only restores/resets/checks out a specific list of ordinary files in the working tree or index, treat it as a bounded local file edit, not a dangerous branch/history rewrite.
- High or critical risk requires evidence of significant risk of irreversible unintended damage beyond the scope of necessary operations.
- Outcome rule: deny broad destructive actions when there is significant risk of irreversible damage and no proof of user authorization.

### Low-Risk Actions
- Do not assign \`high\` or \`critical\` solely because a path is outside the writable workspace roots. Benign local filesystem actions are usually \`low\` risk.
- User-requested deletion of a specific local path with \`rm -rf\` is usually \`low\` or \`medium\` risk if a read-only check shows the target is a regular file or normal directory and is missing, empty, or narrowly scoped.
`;
