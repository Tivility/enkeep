# User-Level Assets: One Copy on the Host

User-level assets are the files that belong to a user rather than to a space:

| Asset | Host path (authoritative) | Container path |
| --- | --- | --- |
| Global memory | `<data-root>/host-runtimes/<username>/.dsh/memory/` | `/home/dsh/.dsh/memory` |
| Skills | `<data-root>/host-runtimes/<username>/.dsh/skills/` | `/home/dsh/.dsh/skills` |
| Global instructions | `<data-root>/host-runtimes/<username>/.dsh/AGENTS.md` | `/home/dsh/.dsh/AGENTS.md` |

There is exactly **one** copy: the host DSH home of the user. Host-mode runtimes use it
directly (it is their `DSH_HOME`). Container runtimes see the same files through read-only
bind mounts. Space-level memory (`<space>/memory/`) is not a user-level asset and is unchanged:
it stays inside the space and is written locally by the runtime that owns the space.

Before this change, a container user had a second, independent copy inside the Docker volume
(`/home/dsh/.dsh/memory`, plus a legacy `/home/dsh/memory`). The two copies drifted apart
because nothing synchronized them.

## 1. How a container reads user assets

- `docker run` adds one `--mount type=bind,source=<host path>,target=<container path>,readonly`
  per asset that exists on the host. `--mount` is used instead of `-v` so a missing source fails
  the run instead of Docker silently creating an empty host directory.
- `memory/` and `skills/` are created on the host (mode `0700`) when missing. `AGENTS.md` is a
  single-file mount and is only mounted when the file exists.
- Symlinks and wrong entry types are never mounted. On Linux hosts the platform also checks that
  the container user (`1000:1000`) can read the entry; unreadable entries are skipped with a
  reason instead of being mounted and failing at read time. On macOS, Docker Desktop / OrbStack
  file sharing maps ownership, so this check is not applied.
- `memory_read` and `memory_search` read `/home/dsh/.dsh/memory` as before — it is now the host
  copy.
- The spec validator only accepts asset mounts that are read-only, target one of the three fixed
  paths, come from absolute normalized host paths whose basename matches the asset, share one
  host DSH home, and are outside protected system roots. Generic `bindMounts` remain forbidden.
  Container ownership checks expect exactly the asset mounts in the spec, require them to be
  read-only, and require each bind `Source` reported by `docker inspect` to be the expected host
  path. Sources are compared after normalization (trailing slash, `.`/`..`, and the known VM
  rewrites `/host_mnt/<path>` and `/private/{tmp,var}` -> `/{tmp,var}`); OrbStack and native Linux
  report the host path unchanged (verified on OrbStack).
- On reconnect, a container whose asset mounts come from another host path (for example the
  user's host DSH home moved after a username change) is served with its actual mounts and
  flagged for an idle rebuild. Until then its global memory write route is not bound (`404`), so
  the platform never writes a directory the container does not read.

## 2. How a container writes global memory

The container cannot write the mount. `memory_write` with `scope: "global"` is sent through the
existing runtime tunnel to the platform, which writes the host copy:

```
memory_write (container)
  -> POST /api/user-assets/memory/write   (platform proxy over the bound tunnel)
     body: { scope: "global", path, content, mode, expectedEtag? }
  -> platform resolves the memory root from its own user record
  -> applyMemoryWriteAtRoot(<host-dsh-home>/memory, ...)   (same code as the local write)
```

- **Identity** comes from the tunnel binding (`platformUserId` + `runtimeIdentity`), never from
  the request. Any identity or location field in the body (`userId`, `spaceId`, `memoryRoot`,
  ...) is rejected with `400 FORBIDDEN_FIELD`. A request on a tunnel bound to another runtime
  identity is rejected with `403`.
- **Paths** must be relative, without `.`/`..` segments, backslashes or NUL, and at most 512
  characters. Symlinks under the memory root are rejected. Rejections return
  `400 PATH_REJECTED`; nothing is written outside `<host-dsh-home>/memory`.
- **Optimistic concurrency** is the same as for local writes: if `expectedEtag` does not match
  the current file (or the file does not exist), the platform returns
  `409 MEMORY_WRITE_CONFLICT` and the tool raises `MemoryWriteConflictError`. Re-read with
  `memory_read` and retry.
- There is **no local fallback**: if the platform is unreachable the write fails.
- Retries: each `memory_write` call sends one `Idempotency-Key` (UUID-v4) and the client retries
  up to 2 times on timeouts, connection errors and 429/502/503/504 with the same key. The
  platform remembers the outcome per memory root and key (200 or 409) for 15 minutes and
  replays it instead of writing again, so an `append` whose response was lost is applied once.
  Reusing a key for a different write is `422 IDEMPOTENCY_KEY_REUSED`. The store is in the
  platform process (it survives tunnel reconnects, not a platform restart). Requests without
  the header (older runtimes) are accepted and not deduplicated.
- Permissions: the platform keeps the replaced file's mode (and owner, when it may), and new
  files/directories get the read access of their parent, so the container keeps reading them.
- The runtime only uses this path when the platform started the container with the memory mount
  (`ENKEEP_USER_MEMORY_WRITE=platform`). The route exists only for runtimes the platform bound to
  a host memory root; for host-mode runtimes and containers without the mount it returns `404`.

Skills and `AGENTS.md` are read-only inside the container. There is no container write path for
them. The admin console writes global instructions to the host copy; because `AGENTS.md` is a
single-file bind mount (bound to an inode), the container is marked for an idle rebuild after
such a write so it picks up the new file.

## 3. When mounts take effect

Mounts are fixed when a container is created, so existing containers keep their current mounts
until they are rebuilt.

- **New volume** (first container for a user): mounts are enabled immediately, and the marker
  (`<data-root>/user-assets-migrations/<volume>.json`, `origin: new_volume`) is written
  **before** the container is created. If the marker cannot be written, the container is created
  without mounts — a volume is never served from the host copy without a durable record.
- **Existing volume**: mounts are enabled only after the one-time convergence below has written a
  marker for that exact volume id. Until then the container keeps using its own copy
  (`migration_pending`).
- Once a volume has a converged marker, every later start, platform restart, image upgrade and
  rebuild of that volume gets the mounts again. A running container found with the mounts but
  without a marker (`observed_mounted`) gets one on reconnect.
- When the desired mounts differ from what a running container has, the runtime is reported as
  outdated and the existing auto-upgrader rebuilds it **only when it has been idle** (no active
  or queued turns, jobs or subagents). Rebuild stops and removes the container; the volume and
  all its data are kept.
- Kill switch: see "Rolling back" below.

### Rolling back: `ENKEEP_USER_ASSET_MOUNTS=0`

Set the variable on the platform process and restart the platform. Containers are not stopped
by this; they move back to the volume-only layout on the same idle rebuild path:

1. **Until the rebuild**, a container that still runs with the mounts keeps working as before:
   the platform binds the write route from the mounts the container *actually* has, so global
   `memory_write` still reaches the host copy, and admin edits of the global `AGENTS.md` still go
   to the host copy. The container is reported outdated (`userAssetMountsPending`).
2. **At the rebuild** (idle only, volume kept), the new container gets no mounts and no
   `ENKEEP_USER_MEMORY_WRITE`, and the marker is changed to `status: suspended` (kept for audit).
3. **At daemon boot** in the new container, the empty placeholders Docker created in the volume
   for the bind mountpoints (`.dsh/memory/`, `.dsh/skills/` as `root:root` empty directories,
   `.dsh/AGENTS.md` as an empty `root:root` file) are removed, so uid 1000 can create and write
   its own global memory again. Only entries that are not mount points, are owned by root, and
   are empty are removed; anything else is left alone.
4. The container now uses its own copy in the volume. It does **not** contain what was written
   to the host copy while the mounts were on; copy that content into the volume if needed.

If a container still runs with `ENKEEP_USER_MEMORY_WRITE=platform` but the platform no longer
serves its route (for example a manual container change), `memory_write` fails with a clear
`HTTP 404 ... read-only until the runtime is rebuilt` error and writes nothing.

Turning mounts back on for a suspended volume requires running `user-assets-migrate` again
(the volume may hold new local content); new volumes are enabled directly as usual.

## 4. One-time convergence: `user-assets-migrate`

Run once per deployment, before mounts are enabled for existing users:

```bash
node packages/demo-runner/dist/demo-runner.js user-assets-migrate --data-dir <data-root> --dry-run
node packages/demo-runner/dist/demo-runner.js user-assets-migrate --data-dir <data-root>
```

For every active platform user with a container, the command:

1. Verifies container ownership (labels, full container id, single user volume at `/home/dsh`)
   and that the runtime is idle. Busy runtimes are skipped (`busy`), never touched.
2. Builds manifests (relative path, size, sha256) of the container's `.dsh/memory`,
   `.dsh/skills`, `.dsh/AGENTS.md` and legacy `memory`, and of the host copy.
3. Compares each asset:
   - `absent` / `identical` (every container file exists on the host byte-for-byte) /
     `skeleton_only` (only the default empty `global.md`): safe.
   - `divergent`: files only in the container or with different content.
4. If every asset is safe: moves the container copies, including the legacy `/home/dsh/memory`,
   to `/home/dsh/.enkeep-archive/user-assets-single-copy/<timestamp>/` inside the volume and
   writes the marker. Nothing is deleted.
5. If any asset is divergent: prints the differing relative paths and sizes (never contents),
   changes nothing and writes no marker. The operator decides: merge the needed content into
   the host copy and re-run, or re-run with `--archive-divergent` to archive the container copy
   as is. The host copy is never overwritten by this command.

Properties:

- `--dry-run` only reads and reports.
- Exit status: `0` all users converged / already converged / nothing to do; `1` a user failed
  or was busy (retry later); `2` a user's copies are divergent and need an operator decision.
  The same codes apply with `--dry-run`, so scripts can gate on them.
- Idempotent: a user whose marker matches the current volume id is reported as
  `already_converged`; a container that already has the mounts is `already_mounted`, and the
  marker is backfilled for it (except with `--dry-run`).
- An empty container `AGENTS.md` (the leftover mountpoint of a single-file bind) counts as
  `absent`, not divergent.
- `--user <username>` (repeatable) restricts the run; `--json` prints machine-readable reports.
- The script that runs inside the container only reads or moves the four whitelisted paths
  into `.enkeep-archive/`, as the runtime user.

## 5. Known limits

- Containers must be rebuilt to pick up mounts. Between convergence and rebuild, a still-running
  old container writes to its local copy; after the rebuild that copy is shadowed by the mount
  (still in the volume, not lost). Converge while the user is idle and let the idle rebuild
  follow.
- uid `1000` read access through macOS VM file sharing depends on the Docker distribution's
  ownership mapping and should be verified on the target host.
- A space running in host mode and a space running in a container for the same user now share
  the same global memory — this is intended.
- Skills mounted into the container are present but not yet discovered by the runtime skill
  loader; enabling discovery is a separate change.
