// A space's database (design §3.3): one per space, <spacesDir>/<id>.db on Node and the SpaceDO named
// by the space id on Cloudflare. Today's domain schema (db/schema.ts V1) without sessions, with a
// users mirror in place of the accounts (§3.5), fold columns for case-insensitive uniqueness and
// search (§3.4), import provenance on comments, work logs and activity (§8.6), and _meta (§3.7);
// migration 2 adds tasks.tag_ids, migration 3 tasks.comment_count and tasks.worklog_minutes, migration 4
// task_links. Every other
// table and column is exactly as in db/schema.ts V1, so the route and service SQL keeps working. Append new migrations to SPACE_MIGRATIONS and never edit
// one that has shipped.
//
// Fold columns are NOT NULL without a default on purpose: an INSERT that forgets one fails in tests.
// Every statement that writes a folded column also writes its fold, fold(value) from core/fold.ts.
//
// Conventions: snake_case columns; timestamps are ISO-8601 UTC TEXT ('2026-10-13T20:15:00.000Z');
// calendar dates are TEXT 'YYYY-MM-DD'; booleans are INTEGER 0/1; JSON is TEXT.

import type { Migration, MigrationSet } from '../core/migrate';

/** Migration 1 (§3.3). */
export const SPACE_V1 = /* sql */ `
CREATE TABLE _meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;

-- Users mirror (§3.5). Rows are never deleted while referenced; FKs below keep pointing here.
CREATE TABLE users (
  id           INTEGER PRIMARY KEY,                 -- = directory users.id (> 0), or a placeholder (< 0)
  kind         TEXT NOT NULL DEFAULT 'account' CHECK (kind IN ('account', 'placeholder')),
  display_name TEXT NOT NULL,
  email        TEXT,                                -- accounts only; NULL after the account was deleted
  is_member    INTEGER NOT NULL DEFAULT 0 CHECK (is_member IN (0, 1)),
  deleted      INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),  -- the directory account no longer exists
  updated_at   TEXT NOT NULL,
  CHECK (id <> 0),
  CHECK ((kind = 'placeholder') = (id < 0)),
  CHECK (kind = 'account' OR (is_member = 0 AND email IS NULL))
);

CREATE TABLE settings (                             -- keys: estimateUnit, defaultBoardId, _seeded (§3.6)
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL                               -- JSON
);

CREATE TABLE projects (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  key              TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name             TEXT NOT NULL,
  name_fold        TEXT NOT NULL,                   -- fold(name)
  description      TEXT NOT NULL DEFAULT '',
  description_fold TEXT NOT NULL,                   -- fold(description)
  color            TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','on_hold','completed','archived')),
  position         INTEGER NOT NULL DEFAULT 0,
  task_counter     INTEGER NOT NULL DEFAULT 0,      -- last task number issued in this project
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE TABLE milestones (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id       INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  name_fold        TEXT NOT NULL,
  description      TEXT NOT NULL DEFAULT '',
  description_fold TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','active','completed','cancelled')),
  start_date       TEXT,
  due_date         TEXT,
  position         INTEGER NOT NULL DEFAULT 0,
  completed_at     TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX milestones_project ON milestones(project_id, position);

CREATE TABLE epics (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id       INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  milestone_id     INTEGER REFERENCES milestones(id) ON DELETE SET NULL,  -- must be in the same project (app-enforced)
  name             TEXT NOT NULL,
  name_fold        TEXT NOT NULL,
  description      TEXT NOT NULL DEFAULT '',
  description_fold TEXT NOT NULL,
  color            TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','done','cancelled')),
  start_date       TEXT,
  due_date         TEXT,
  position         INTEGER NOT NULL DEFAULT 0,
  completed_at     TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX epics_project ON epics(project_id, position);
CREATE INDEX epics_milestone ON epics(milestone_id);

CREATE TABLE statuses (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE COLLATE NOCASE,   -- kept: an ASCII-insensitive guard, as before
  name_fold  TEXT NOT NULL,                         -- fold(name); uniqueness is checked against it in JS
  category   TEXT NOT NULL CHECK (category IN ('backlog','unstarted','started','completed','cancelled')),
  color      TEXT NOT NULL,
  position   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX statuses_name_fold ON statuses(name_fold);

CREATE TABLE tasks (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id       INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  number           INTEGER NOT NULL,
  epic_id          INTEGER REFERENCES epics(id) ON DELETE SET NULL,      -- must be in the same project (app-enforced)
  status_id        INTEGER NOT NULL REFERENCES statuses(id) ON DELETE RESTRICT,
  title            TEXT NOT NULL,
  title_fold       TEXT NOT NULL,
  description      TEXT NOT NULL DEFAULT '',
  description_fold TEXT NOT NULL,
  priority         INTEGER NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 4),
  start_date       TEXT,
  due_date         TEXT,
  estimate         REAL,
  rank             TEXT NOT NULL,                  -- fractional index (manual order)
  completed_at     TEXT,                           -- set while status category is completed/cancelled
  archived_at      TEXT,
  created_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  UNIQUE (project_id, number)
);
CREATE INDEX tasks_epic ON tasks(epic_id);
CREATE INDEX tasks_status ON tasks(status_id);
CREATE INDEX tasks_due ON tasks(due_date);
CREATE INDEX tasks_rank ON tasks(rank);
CREATE INDEX tasks_archived ON tasks(archived_at);
CREATE INDEX tasks_updated ON tasks(updated_at);

CREATE TABLE tags (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE COLLATE NOCASE,   -- kept: an ASCII-insensitive guard, as before
  name_fold  TEXT NOT NULL,                         -- fold(name); uniqueness is checked against it in JS
  color      TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX tags_name_fold ON tags(name_fold);

CREATE TABLE task_tags (
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  tag_id  INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, tag_id)
) WITHOUT ROWID;
CREATE INDEX task_tags_tag ON task_tags(tag_id);

-- imported_by / imported_at (comments, work_logs, activity): import provenance (§8.6), NULL for rows
-- written in this space. imported_by is the importer, when the mapped author is someone else.

CREATE TABLE comments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id     INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  body        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  edited_at   TEXT,
  imported_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  imported_at TEXT
);
CREATE INDEX comments_task ON comments(task_id, created_at);

CREATE TABLE work_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id     INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  date        TEXT NOT NULL,
  minutes     INTEGER,
  note        TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  imported_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  imported_at TEXT
);
CREATE INDEX work_logs_task ON work_logs(task_id, date);
CREATE INDEX work_logs_date ON work_logs(date);

CREATE TABLE activity (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  project_id  INTEGER REFERENCES projects(id) ON DELETE CASCADE,  -- NULL for project.deleted
  task_id     INTEGER REFERENCES tasks(id) ON DELETE CASCADE,     -- NULL for non-task events and task.deleted
  entity_type TEXT NOT NULL,
  entity_id   INTEGER,
  action      TEXT NOT NULL,
  data        TEXT NOT NULL DEFAULT '{}',                         -- JSON (ActivityData)
  created_at  TEXT NOT NULL,
  imported_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  imported_at TEXT
);
CREATE INDEX activity_project ON activity(project_id, id);
CREATE INDEX activity_task ON activity(task_id, id);

CREATE TABLE boards (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  INTEGER REFERENCES projects(id) ON DELETE CASCADE,  -- NULL = global board; else a project board
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  config      TEXT NOT NULL,                  -- JSON (BoardConfig)
  position    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX boards_project ON boards(project_id, position);
`;

/**
 * Migration 2 (design Appendix D 42): each task's tag ids as a JSON array in the task's own row, kept by
 * triggers, so that a task list reads no task_tags rows (a Durable Object bills every row read). The
 * triggers recompute the list from task_tags after every change of it, the cascades of a deleted tag or
 * task included, so every write path keeps it, the ones of older builds too (hence compatible from 1).
 */
export const SPACE_V2 = /* sql */ `
ALTER TABLE tasks ADD COLUMN tag_ids TEXT NOT NULL DEFAULT '[]';   -- JSON array of tag ids, ascending

UPDATE tasks SET tag_ids = (SELECT json_group_array(tag_id) FROM task_tags WHERE task_id = tasks.id)
 WHERE id IN (SELECT task_id FROM task_tags);

CREATE TRIGGER task_tags_inserted AFTER INSERT ON task_tags BEGIN
  UPDATE tasks SET tag_ids = (SELECT json_group_array(tag_id) FROM task_tags WHERE task_id = NEW.task_id)
   WHERE id = NEW.task_id;
END;

CREATE TRIGGER task_tags_deleted AFTER DELETE ON task_tags BEGIN
  UPDATE tasks SET tag_ids = (SELECT json_group_array(tag_id) FROM task_tags WHERE task_id = OLD.task_id)
   WHERE id = OLD.task_id;
END;

CREATE TRIGGER task_tags_updated AFTER UPDATE ON task_tags BEGIN
  UPDATE tasks SET tag_ids = (SELECT json_group_array(tag_id) FROM task_tags WHERE task_id = tasks.id)
   WHERE id IN (OLD.task_id, NEW.task_id);
END;
`;

/**
 * Migration 3 (design Appendix D 46): each task's comment count and the minutes of its work logs in the task's
 * own row, kept by triggers, so that a task list reads no comment or work-log rows: a correlated count read
 * one billed row per comment and per work log of every task it listed, so a list cost more the more a space
 * was discussed. The triggers adjust the row by each change (a recount would read every comment of the task
 * again for each one added, a burden for an import), every write path of every build included, so this is
 * compatible from 1 too. A work log without minutes (or with 0) changes no task row.
 */
export const SPACE_V3 = /* sql */ `
ALTER TABLE tasks ADD COLUMN comment_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN worklog_minutes INTEGER NOT NULL DEFAULT 0;

UPDATE tasks SET comment_count = (SELECT COUNT(*) FROM comments WHERE task_id = tasks.id)
 WHERE id IN (SELECT task_id FROM comments);
UPDATE tasks SET worklog_minutes = (SELECT COALESCE(SUM(minutes), 0) FROM work_logs WHERE task_id = tasks.id)
 WHERE id IN (SELECT task_id FROM work_logs WHERE minutes <> 0);

CREATE TRIGGER comments_inserted AFTER INSERT ON comments BEGIN
  UPDATE tasks SET comment_count = comment_count + 1 WHERE id = NEW.task_id;
END;

CREATE TRIGGER comments_deleted AFTER DELETE ON comments BEGIN
  UPDATE tasks SET comment_count = comment_count - 1 WHERE id = OLD.task_id;
END;

CREATE TRIGGER comments_moved AFTER UPDATE OF task_id ON comments WHEN OLD.task_id IS NOT NEW.task_id BEGIN
  UPDATE tasks SET comment_count = comment_count + (id = NEW.task_id) - (id = OLD.task_id)
   WHERE id IN (OLD.task_id, NEW.task_id);
END;

CREATE TRIGGER work_logs_inserted AFTER INSERT ON work_logs WHEN NEW.minutes <> 0 BEGIN
  UPDATE tasks SET worklog_minutes = worklog_minutes + NEW.minutes WHERE id = NEW.task_id;
END;

CREATE TRIGGER work_logs_deleted AFTER DELETE ON work_logs WHEN OLD.minutes <> 0 BEGIN
  UPDATE tasks SET worklog_minutes = worklog_minutes - OLD.minutes WHERE id = OLD.task_id;
END;

CREATE TRIGGER work_logs_updated AFTER UPDATE OF task_id, minutes ON work_logs
  WHEN OLD.task_id IS NOT NEW.task_id OR OLD.minutes IS NOT NEW.minutes BEGIN
  UPDATE tasks
     SET worklog_minutes = worklog_minutes
           + CASE WHEN id = NEW.task_id THEN COALESCE(NEW.minutes, 0) ELSE 0 END
           - CASE WHEN id = OLD.task_id THEN COALESCE(OLD.minutes, 0) ELSE 0 END
   WHERE id IN (OLD.task_id, NEW.task_id);
END;
`;

/**
 * Migration 4 (docs/design/task-dependencies.md): finish-to-start links between tasks. A link's blocked task
 * can't finish on time until its blocker has finished; the adjusted dates this implies are worked out when tasks
 * are read (services/schedule.ts), so nothing else is stored. Deleting either task deletes the link. An older
 * build never reads the table and its deletes cascade into it, so this is compatible from 1.
 */
export const SPACE_V4 = /* sql */ `
CREATE TABLE task_links (
  blocker_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  blocked_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
) WITHOUT ROWID;
CREATE INDEX task_links_blocked ON task_links(blocked_id);
`;

const MIGRATIONS: ReadonlyArray<Migration> = [
  { up: (db) => db.exec(SPACE_V1) },
  { up: (db) => db.exec(SPACE_V2), compatibleFrom: 1 },
  { up: (db) => db.exec(SPACE_V3), compatibleFrom: 1 },
  { up: (db) => db.exec(SPACE_V4), compatibleFrom: 1 },
];

export const SPACE_MIGRATIONS: MigrationSet = { schema: 'space', migrations: MIGRATIONS };
