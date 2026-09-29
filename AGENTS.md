# AGENTS.md

Rules for any agent (and human) that writes code, tests, docs, scripts, or commits in this repository.
This repository is **public**. Everything committed here is published, including history.

See also: [`docs/safety.md`](docs/safety.md) for runtime guardrails (ports, data boundaries, preflight).

---

## 1. No real data in the repository — ever

Never write real user or deployment data into any tracked file, test, fixture, doc, script, or commit message. This includes:

- **Identifiers from real systems**: user ids, account ids, space/session/turn ids, channel binding ids, Feishu/Lark chat/open/message ids (`oc_…`, `ou_…`, `om_…`), app ids (`cli_…`), WeChat user ids (`…@im.wechat`), QQ ids, HappyClaw workspace folder names or JIDs.
- **Credentials of any kind**: tokens, app secrets, bot tokens, context tokens, cookies, API keys, passwords or password hashes — even if they look expired.
- **Local environment details**: absolute home paths (`/Users/<name>/…`, `/home/<name>/…`), workspace directory names, machine hostnames, VPN/tailnet hostnames, LAN IPs, launchd/systemd labels tied to a person, OS usernames.
- **Private content**: message text, task prompts, memory files, notes, file names or folder names taken from a real user's workspace.

If you investigated a production issue and saw real values in logs, databases, or reports: **describe the shape of the problem, not the values.** Reproduce it with synthetic data.

### Where real data lives (never read it into tracked files)

These locations hold real runtime data and are git-ignored. Treat them as read-only evidence, never as a source for fixtures or docs:

- `.demo-data/`, `.demo-data-*/` — the platform data directory (databases, spaces, runtime homes). In a real deployment this is **production data**.
- `reports/`, `backups/`, `credentials/`, `privatekeys/`, `.dsh/`
- Anything outside the repository (user config directories, other services' data directories).

Do not `git add -f` anything under these paths. Do not weaken `.gitignore` or `.dockerignore` entries for them.

## 2. Tests and fixtures: synthetic only

- Build fixtures from obviously fake, deterministic values: `user-alice`, `alice@example.com`, `spc_` + fixed hex like `spc_00000000000000000000000000000001`, `oc_test0000000000000000000000000001`, `test-peer-01@im.wechat`.
- Keep the **format** realistic (prefixes, lengths, character sets) so validators are exercised, but never copy a real value, even partially.
- Paths in tests come from `os.tmpdir()` / `mkdtemp` or are clearly fake (`/tmp/enkeep-test/...`). Never hardcode a home directory.
- When a bug only reproduces with "production-shaped" data, copy the **structure** (fields, nesting, lengths, ordering), then replace every value.

## 3. Scripts: no machine-specific defaults

- One-off operational scripts (migrations of a specific deployment, cutovers, canaries, audits of a specific run) **do not belong in this repository.** Keep them outside the repo.
- Scripts that are committed must be reusable: every path, username, account id, host, or port comes from a CLI flag or environment variable. If a required value is missing, **fail with a clear error** — do not fall back to a value from the author's machine.
- Scripts must not print secrets. Log ids and counts, not values of credentials or message content.

## 4. Docs: placeholders only

- Use placeholders such as `<repo-root>`, `<release-worktree>`, `<data-dir>`, `$ENKEEP_DATA_DIR`, `<launchd-label>`, `<account-id>`, `<chat-id>`.
- Never paste a real deployment report, log excerpt, or command history into docs without replacing every real value.
- Deployment-specific values belong in a private, untracked config outside the repo; docs reference the variable name only.

## 5. Commits and pull requests

- One logical change per commit; conventional messages: `type(scope): summary` (e.g. `fix(channel-wechat): …`, `test(platform-server): …`, `docs: …`).
- Stage exactly the hunks of the change. Never sweep unrelated working-tree changes into a commit. Never commit report files, patch files, or scratch JSON to the repo root.
- Commit messages and PR descriptions follow the same rules as code: no real ids, paths, hostnames, or user content.
- **Before every push**, scan the full range being pushed (all commits, not only the final diff) for the categories in §1. If anything is found, rewrite the offending commits before pushing — a follow-up "cleanup" commit does not remove data from history.
- Do not push release, snapshot, or backup branches. They may contain deployment-specific material.

## 6. Working in this repo

- Package manager: `pnpm` (see `packageManager` in `package.json`); Node per `engines`.
- Build: `pnpm run build` · Typecheck: `pnpm run typecheck` · Tests: `pnpm run test` (or `pnpm --filter <package> test <file>` for a focused run) · Full gate: `pnpm run verify`.
- Tests must run offline. Never call real Feishu/Lark, WeChat, or model provider endpoints from tests; use local fake servers or in-memory transports.
- Services bind to `127.0.0.1` only. Do not start, stop, or bind to ports used by other local services (see `docs/safety.md`).

## 7. When in doubt

If you are unsure whether a value is real, treat it as real and replace it with a synthetic one.
