# Task dependencies: design

Status: **proposed**, implemented on `feature/task-dependencies`. Extends SPEC.md (§5.5, §5.8, §5.10, §7, the
filter semantics) and docs/design/multi-user-and-cloudflare.md (§3.3 the space schema, §8 the archive).

Conventions as in the multi-user design: MUST / SHOULD as in RFC 2119, paths relative to the repository root.

---------------------------------------------------------------------------------------------------------

## 1. Goal

A task can wait on other tasks. When one runs late, everything downstream of it moves too, and a project can
see what slipped and accept the new dates. The model is MS Project's: a task keeps the due date a person set
(its **original** due date), and gains an **adjusted** due date worked out from when its blockers finish.

Non-goals for this version: lag and lead times, link kinds other than finish-to-start, working days and
calendars, critical path, a Gantt chart. Each could follow on the same table.

## 2. Terms

- **Link**: a directed finish-to-start relation between two tasks of one space. Its **blocker** must finish
  before its **blocked task** can. Never "parent": parent/child is the epic hierarchy.
- **Downstream**: every task reachable from a task by following links forward.
- **Duration**: a task's length in calendar days, `due − start + 1` (inclusive); 1 day without a start date.
  Not the estimate, which is points or hours.
- **Adjusted start / due date**: the dates a task's blockers allow (§4).
- **Slip**: adjusted due − due, in days. A **slipped task** is an open task whose slip is above 0. It is a
  derived condition, not a status: a task can be In Progress and slipped.
- **Rebaseline**: accept the slip by copying the adjusted dates over the task's own.

## 3. Data

Space migration 4 adds one table (server/src/space/schema.ts):

```sql
CREATE TABLE task_links (
  blocker_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  blocked_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
) WITHOUT ROWID;
CREATE INDEX task_links_blocked ON task_links(blocked_id);
```

It is compatible from 1: an older build never reads it, and its task deletes cascade into it.

A link MAY join tasks of different projects of the space. A space is a database of its own, so a link can
never cross spaces. A link that would close a cycle is refused (400, path `blockerId`, "WEB-3 can't block WEB-1:
it already waits on it").

**Nothing derived is stored.** The adjusted dates depend on the reader's `today` (an open blocker past its due
date finishes "today" at the earliest), which SPEC §4 makes a client parameter. Stored dates would be stale the
next morning and need a job to refresh them, which a Durable Object has no natural place for. They are worked
out when tasks are read instead (§5).

## 4. Rules

`shared/src/schedule.ts#computeSchedule` is the one implementation; the server runs it, and the web may.
All dates are calendar days.

1. A blocker **finishes**:
   - done (a status of category `completed`): on its `completedAt`'s date;
   - open: on its adjusted due date (its adjusted start when it has no due date), or today when that has
     passed;
   - never, when it is open and has neither date: it constrains nothing.
2. A cancelled blocker, and an archived open one, no longer block. The link stays, so reopening or
   unarchiving blocks again. An archived done blocker still counts, on its `completedAt`.
3. Adjusted start = the later of the start date and the day after the latest blocker finishes.
4. Adjusted due = adjusted start + duration − 1, and never earlier than the due date. A task without a due
   date has no adjusted due date (its adjusted start still carries downstream).
5. A closed blocked task keeps its own dates (slip 0): slip is about work still to do.
6. Links never stop anything: a blocked task MAY close before its blocker.

## 5. Reading

`server/src/services/schedule.ts#readSchedule(db, today)` reads every link and the linked tasks by id, and
runs §4. A space without links reads one empty table and no task row for it. On Cloudflare the cost is the
links plus the linked tasks per request that needs dates (design §11.2).

- **TaskDTO** gains `blockedBy` and `blocks` (ids, ascending), `adjustedStartDate`, `adjustedDueDate` (equal to
  the task's own unless it slipped) and `slipDays` (0 unless it slipped). `GET /api/tasks/:id` and
  `/ref/:ref` take `?today=`; a write's answer uses the server's date (SPEC §4's fallback).
- **The due date filters and sorting go by the adjusted due date of a slipped task**
  (`shared/src/filter.ts#effectiveDueDate`). In SQL (`buildTaskWhere`, `taskOrderBy`) the slipped tasks'
  adjusted dates travel as one JSON parameter, `:slips`, and `dueDateSql` replaces `t.due_date` with
  `COALESCE(json_extract(:slips, …), t.due_date)` only when something slipped, so a space without slips runs
  exactly the SQL it ran before (and keeps the due-date index). The randomized cross-check of the filter
  (`services.filter.contract.ts`) holds for both.
- **`TaskFilter.slipped: true`** keeps the slipped tasks only.
- **The dashboard** evaluates its sections on the adjusted due dates, and `DashboardDTO.slipped` counts the
  open slipped tasks (uncapped). The web lists them in a "Slipped" section while there are any.

## 6. Writing

| Method & path | Input | Output | Gate |
|---|---|---|---|
| POST `/api/tasks/:id/blockers` | `{ blockerId }` | `TaskDTO` (the blocked task) | member |
| DELETE `/api/tasks/:id/blockers/:blockerId` | – | `TaskDTO` | member (a delete) |
| POST `/api/tasks/rebaseline/preview` | `RebaselineInput` | `{ items: RebaselineItemDTO[] }` | viewer (a read sent as POST) |
| POST `/api/tasks/rebaseline` | `RebaselineInput` | `{ items: RebaselineItemDTO[] }` | member |

- Adding a link that exists, or removing one that doesn't, changes nothing and logs nothing.
- **Activity**: a link change is a `task.updated` on the blocked task with the change
  `{ field: 'blockedBy', added: [ref], removed: [ref] }` (the shape tag changes use), and bumps its
  `updated_at`. Deleting a task logs the same change, `removed: [its ref]`, on each task it blocked, before
  the cascade removes the links.
- **Rebaseline** takes `{ projectId }` or `{ ids }` (exactly one; never the whole space at once) and `today`.
  It moves each slipped, unarchived task in scope: the due date to the adjusted due date, and the start date
  (when the task has one) to the adjusted start, so the duration is kept. Each moved task records a
  `task.updated` with its `startDate` / `dueDate` changes and `data.rebaseline: true`. The preview answers the
  same list without writing. After a rebaseline the tasks it moved have no slip.

## 7. Archive

An archive v2 task row MAY carry `blockedBy: number[]`, its blockers' ids (only when it has any). An
archive without it imports as before; the format version stays 2, since an older build ignores the key
(its row schema drops unknown keys) and loses only the links. Validation (`validate.ts`): every blocker id
is a task of the file and not the task itself (400 at `tasks.<i>.blockedBy`), and the links don't loop
(400 at `tasks`). The commit inserts the links after the tasks; the estimate counts `task_links` rows at
weight 2 (the table and its index).

## 8. Web

- Task detail: a **Dependencies** section with "Blocked by" and "Blocks", each linked task with its status,
  ref, title and due date, an "Add" picker over the space's open tasks and a remove button per link.
- Task rows and cards: a slipped task's due label shows the adjusted date with the slip ("Nov 1 · +2d"); its
  title names the original. An open task with blockers shows a chain icon.
- Dashboard: the "Slipped" section (only while something slipped).
- Rebaseline: "Rebaseline slipped tasks…" in a project's menu, and "Rebaseline slipped…" in the bulk due-date
  menu of a selection (task lists and boards). Both open a dialog that previews every move first.
- History: "made it wait on WEB-3", "removed the link to WEB-3", and "(rebaseline)" after a rebaseline's
  date changes.

## 9. Decisions

1. **Read-time, not stored** (§3): correct for every client's day with no refresh job, at the cost of one
   read of the links per request that needs dates. Revisit if a space's links grow into the thousands.
2. **The adjusted date drives the lists**, so "overdue" and "due soon" show when work will really finish; the
   original stays visible as the label's title and in the slip.
3. **Never earlier**: a blocker that finishes early never pulls a task's due date in.
4. **Archive key, not a version bump** (§7): old archives keep importing, and an older build reading a new
   archive loses only the links.
