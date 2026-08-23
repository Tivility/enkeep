# enkeep

Multi-user, multi-entrypoint platform around [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

Design: [`docs/design.md`](../DSH-Claw/docs/design.md) (moving into this repo).

## Not published

Every package here is `private: true`. They are consumed from a working copy, not
from npm. Generic, reusable plugins belong in
[`dsh-plugins`](https://github.com/Tivility/dsh-plugins) instead — the test is
whether the package still makes sense if enkeep did not exist.

## Planned layout

```
packages/
├── bridge/        plugin: platform HTTP — followup / cancel / event stream
├── tools/         plugin: outbound tools (send_message, send_file, create_task)
├── im-approval/   plugin: approval + question answerers routed to IM channels
├── dsh-enkeep/    bundle: one cordis.patch.yml mounting the plugins above
├── platform/      server: users, ACL, quota, channels, cron, container pool
└── import/        offline importer: happyclaw messages.db -> dsh session logs
```

`dsh-enkeep` is a [bundle](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md#profiles-and-bundles):
a package whose `package.json` carries `dsh.bundle.patch`, so a profile mounts the
whole set with one entry in its `dsh.profile.bundles` list.

## Conventions

Same as `dsh-plugins`: `dsh` / `cordis` packages are `peerDependencies` (plus dev),
never `dependencies`; do not mix plugin export forms; read optional services with
`ctx.get(name)`.
