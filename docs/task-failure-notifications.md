# Task failure notifications

Scheduled tasks report their own failures on the task's route. The feature uses the task
notification subsystem (subscriptions + deliveries) through the `task_route` channel.

## What is reported

| Situation | How it is detected | Event |
|---|---|---|
| A run fails (dispatch error, invalid result, script killed) | `fail()` in the platform task worker, plus the maintenance pass | `failed` |
| A run times out (script timeout, execution budget, lease expired, platform restart) | maintenance pass over `task_runs` (`failed` / `timeout` / `lease_lost`) | `timeout` |
| A run does not start: an enabled, unpaused pending task is still not started 30 minutes after its due time | maintenance pass over `platform_tasks` / `task_schedules` | `timeout` (`kind: missed_run`) |

The maintenance pass runs inside the task worker on its own 60-second timer. It runs in the
same platform process as the scheduler, with no extra process or OS job. It only looks at
runs that ended after migration 045 was applied and within the last 24 hours, so enabling the
feature does not replay old failures.

`silent` hides only the normal output of a successful run. A silent task is still notified when
it fails, and a silent task may now set a `delivery` target. The output of non-silent tasks does
not change.

## Where the notice goes

1. `payload.delivery` (lark / wechat). It is used only when the account belongs to the user, is
   active, and has a binding for that chat.
2. Otherwise, the lark / wechat chat bound to the task's anchor session, or the only chat bound
   to that session's space. A thread suffix (`chat:thread`) is dropped.
3. Otherwise, an assistant message in the anchor web session.

When the IM route has used up its retries, the notice is also written to the anchor session.

## Delivery, retry and dedup

- Each failed run gets at most one notice: idempotency key `task_route:run:<runId>`. Each missed
  due time gets at most one: `task_route:missed:<taskId>:<dueAt>`.
- A delivery is retried up to 5 times with the subsystem's backoff (5s, 30s, 2m, 10m). Every
  attempt reuses the outbox id `out_tfn_<deliveryId>`, so the IM gateway does not send a notice
  twice when it was already delivered.
- Delivery history appears in `GET /api/manage/tasks/:id/notifications/deliveries`.

## Message

The message is in Chinese and can be read on its own. It contains:

- the task title;
- the scheduled run time in the task's time zone;
- a plain-language explanation of what happened, with a short error excerpt;
- the next run;
- how to rerun by hand: Web console → 任务流水 → 立即执行, or `POST /api/manage/tasks/:id/run`.

Internal ids appear only in parentheses.

## Turning it off for one task

Failure notices are on by default. The `task_route` subscription is created the first time it is
needed, and there is one per task.

- `GET /api/manage/tasks/:id/notifications/failure` returns `{ enabled, events, subscriptionId, route }`.
- `PUT /api/manage/tasks/:id/notifications/failure` with body `{ "enabled": false }`.

Both routes are available on the web management API and through the runtime platform proxy.
The generic subscription API rejects creating or deleting a `task_route` subscription. Through
that API, you can change only its `enabled` flag and its `failed` / `timeout` events.

## Limitation: a platform outage cannot report itself

Detection, missed-run checks and sending all run inside the platform process. If that process
is down, or the host is asleep or offline, nothing is reported while the outage lasts. After a
restart:

- runs interrupted by the outage are reported when lease recovery marks them failed;
- tasks that are now more than 30 minutes overdue are reported as missed, unless the
  scheduler starts them first.

Outages that need alerting while the platform is down require an external monitor. That monitor
is outside the scope of this feature.
