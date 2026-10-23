// The Db contract (design §14.4): what every Db implementation must do the same way, run on NodeDb by
// server/test/db.contract.node.test.ts and on DoDb in workerd by server/test-workers/db.contract.test.ts.
// `withDb(body)` hands `body` a fresh, empty database and returns its result; bodies are synchronous
// (a Durable Object's transactions cannot span an await). Cases that differ between the adapters say
// so in their names and run only where they apply. `limits`: the adapter applies a Durable Object's
// own SQLite limits and function allowlist (DoDb always, NodeDb on Node 24.15 and later).

import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../../src/core/db';
import { migrate, readSchemaState, withDeferredForeignKeys, type Migration, type MigrationSet } from '../../src/core/migrate';
import { DIRECTORY_MIGRATIONS, DIRECTORY_V1 } from '../../src/directory/schema';
import { SPACE_MIGRATIONS, SPACE_V1, SPACE_V4 } from '../../src/space/schema';

export type WithDb = <T>(body: (db: Db) => T) => Promise<T>;

export interface DbContractOptions {
  limits: boolean;
}

const T0 = '2026-03-01T09:00:00.000Z';

/** A test-only space schema: a parent and a child table, then an additive column. */
const PARENT_CHILD: Migration = {
  up: (db) =>
    db.exec(`
      CREATE TABLE parent (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE child (
        id        INTEGER PRIMARY KEY,
        parent_id INTEGER NOT NULL REFERENCES parent(id) ON DELETE CASCADE
      );
      CREATE INDEX child_parent ON child(parent_id); -- a trailing comment
    `),
};
const ADD_NOTE: Migration = { up: (db) => db.exec('ALTER TABLE parent ADD COLUMN note TEXT'), compatibleFrom: 1 };
const ADD_TAGS: Migration = { up: (db) => db.exec('CREATE TABLE tag (id INTEGER PRIMARY KEY, label TEXT NOT NULL)') };

const testSet = (...migrations: Migration[]): MigrationSet => ({ schema: 'space', migrations });

function meta(db: Db): Record<string, string> {
  return Object.fromEntries(db.all<{ key: string; value: string }>('SELECT key, value FROM _meta').map((r) => [r.key, r.value]));
}

function tableNames(db: Db): string[] {
  return db
    .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .map((r) => r.name);
}

/** The schema's own tables and indexes (not SQLite's or the platform's), with their SQL. */
function schemaObjects(db: Db): Array<{ type: string; name: string; sql: string }> {
  return db.all<{ type: string; name: string; sql: string }>(
    "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name",
  ).filter((o) => !/^(?:_cf_|__cf_kv$|sqlite_|__miniflare_do_name$)/i.test(o.name));
}

/** Names of the tables or indexes a DDL text creates. */
const createdNames = (ddl: string, kind: 'TABLE' | 'INDEX') =>
  [...ddl.matchAll(new RegExp(String.raw`CREATE (?:UNIQUE )?${kind} (\w+)`, 'g'))].map((m) => m[1]!).sort();

/** SUM over one VALUES row per placeholder (a + b + … would break a DO's expression depth limit of 100). */
const sumOf = (placeholders: string[]) => `SELECT SUM(column1) AS total FROM (VALUES ${placeholders.map((p) => `(${p})`).join(', ')})`;

/** A statement with `n` distinct named parameters, and its params object. */
function manyParams(n: number): { sql: string; params: Record<string, number> } {
  const names = Array.from({ length: n }, (_, i) => `p${i}`);
  return { sql: sumOf(names.map((p) => `:${p}`)), params: Object.fromEntries(names.map((p, i) => [p, i])) };
}

/** Let pending callbacks run: an unhandled rejection among them fails the test run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

export function defineDbContract(kind: Db['kind'], withDb: WithDb, options: DbContractOptions): void {
  const node = kind === 'node';

  describe(`Db contract (${kind})`, () => {
    it('reports its kind', async () => {
      expect(await withDb((db) => db.kind)).toBe(kind);
    });

    describe('parameters', () => {
      it('binds named parameters by name, repeated names once, and ignores extra keys', () =>
        withDb((db) => {
          expect(db.get('SELECT :a AS a, :b AS b, :a || :b AS ab', { a: 'x', b: 'y', extra: 'ignored' })).toEqual({
            a: 'x',
            b: 'y',
            ab: 'xy',
          });
        }));

      it('binds positional parameters from an array', () =>
        withDb((db) => {
          expect(db.get('SELECT ? AS a, ? AS b', ['one', 'two'])).toEqual({ a: 'one', b: 'two' });
        }));

      it('throws for a missing named parameter, also when no params are given', () =>
        withDb((db) => {
          expect(() => db.get('SELECT :a AS a, :b AS b', { a: 1 })).toThrow('SQL parameter :b missing');
          expect(() => db.get('SELECT :a AS a')).toThrow('SQL parameter :a missing');
        }));

      it('does not take :x inside string literals, quoted names or comments for a parameter', () =>
        withDb((db) => {
          db.exec('CREATE TABLE "odd:name" (v TEXT)');
          expect(
            db.get(`SELECT ':nope' AS v, strftime('%H:%M', '2026-01-01 10:20') AS w, :x AS x -- :y
                    FROM "odd:name" /* :z */ UNION ALL SELECT 'a', 'b', :x`, { x: 1 }),
          ).toEqual({ v: 'a', w: 'b', x: 1 });
        }));

      it('allows 100 distinct parameters and one parameter used 150 times', () =>
        withDb((db) => {
          const hundred = manyParams(100);
          expect(db.get<{ total: number }>(hundred.sql, hundred.params)!.total).toBe(4950);
          const reused = sumOf(Array.from({ length: 150 }, () => ':x'));
          expect(db.get<{ total: number }>(reused, { x: 2 })!.total).toBe(300);
        }));

      it('refuses more than 100 parameters, named or positional', () =>
        withDb((db) => {
          const many = manyParams(101);
          expect(() => db.get(many.sql, many.params)).toThrow();
          const marks = Array.from({ length: 101 }, () => '?');
          expect(() => db.all(sumOf(marks), Array.from({ length: 101 }, (_, i) => i))).toThrow();
        }));

      it('ignores an object, or an empty array, given to SQL without parameters', () =>
        withDb((db) => {
          expect(db.get('SELECT 1 AS a', { unused: 1 })).toEqual({ a: 1 });
          expect(db.get('SELECT 1 AS a', [])).toEqual({ a: 1 });
        }));

      it('refuses parameters that do not fit the SQL, instead of binding NULL', () =>
        withDb((db) => {
          db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
          db.run('INSERT INTO t (id) VALUES (1), (2)');
          const refused: Array<[() => unknown, string]> = [
            [() => db.get('SELECT :a AS a, ? AS b', { a: 1 }), 'SQL mixes :name and ? parameters'],
            [() => db.get('SELECT ? AS a, ? AS b', [1]), 'SQL with 2 ? parameter(s) takes an array of 2 value(s)'],
            [() => db.get('SELECT ? AS a', [1, 2]), 'takes an array of 1 value(s)'],
            [() => db.get('SELECT ? AS a'), 'takes an array of 1 value(s)'],
            [() => db.get('SELECT ? AS a', { a: 1 }), 'takes an array of 1 value(s)'],
            // A hole is not undefined: node:sqlite refuses it, a DO binds NULL.
            [() => db.get('SELECT ? AS a, ? AS b', [, 1]), 'SQL parameter ?1 missing'],
            [() => db.get('SELECT ? AS a, ? AS b', new Array(2)), 'SQL parameter ?1 missing'],
            [() => db.get('SELECT :a AS a, :b AS b', ['x', 'y']), 'SQL with :name parameters takes an object, not an array'],
            [() => db.get('SELECT 1 AS a', [1]), 'SQL without parameters was given 1 value(s)'],
            [() => db.get('SELECT :constructor AS a', {}), 'SQL parameter :constructor missing'],
            [() => db.get('SELECT :toString AS a', {}), 'SQL parameter :toString missing'],
            [() => db.get('SELECT :a AS a', Object.create({ a: 9 }) as Record<string, number>), 'SQL parameter :a missing'],
          ];
          for (const [call, message] of refused) expect(call).toThrow(message);
          expect(db.all('SELECT id FROM t ORDER BY id')).toEqual([{ id: 1 }, { id: 2 }]);
        }));

      it('refuses parameter forms other than :name and ? ($name, @name, :1, non-ASCII names, ?NNN)', () =>
        withDb((db) => {
          db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
          db.run('INSERT INTO t (id) VALUES (1), (2)');
          const refused: Array<[() => unknown, string]> = [
            [() => db.run('DELETE FROM t WHERE id = $id', { id: 1 }), 'SQL parameter $id: use the :name form'],
            [() => db.get('SELECT @a AS a', { a: 1 }), 'SQL parameter @a'],
            [() => db.get('SELECT :1 AS a', { 1: 'x' }), 'SQL parameter :1'],
            [() => db.get('SELECT :café AS a', { café: 1 }), 'SQL parameter :café'],
            [() => db.get('SELECT :a$b AS a', { a$b: 1, a: 2 }), 'SQL parameter :a$b'],
            [() => db.get('SELECT :a AS x, $a AS y', { a: 1 }), 'SQL parameter $a'],
            // node:sqlite 22 cannot bind ?NNN; Node 24 and a DO can.
            [() => db.get('SELECT ?2 AS b, ?1 AS a', ['x', 'y']), 'SQL parameter ?2'],
            [() => db.get('SELECT ?100 AS a', [7]), 'SQL parameter ?100'],
          ];
          for (const [call, message] of refused) expect(call).toThrow(message);
          expect(db.all('SELECT id FROM t ORDER BY id')).toEqual([{ id: 1 }, { id: 2 }]);
        }));
    });

    describe('values', () => {
      it('binds booleans as 0/1 and undefined as NULL', () =>
        withDb((db) => {
          db.exec('CREATE TABLE t (a INTEGER, b INTEGER, c TEXT)');
          db.run('INSERT INTO t (a, b, c) VALUES (:a, :b, :c)', { a: true, b: false, c: undefined });
          expect(db.get('SELECT a, b, c, typeof(a) AS ta FROM t')).toEqual({ a: 1, b: 0, c: null, ta: 'integer' });
        }));

      it('binds a bigint in the safe range and refuses one outside it', () =>
        withDb((db) => {
          db.exec('CREATE TABLE t (n INTEGER)');
          db.run('INSERT INTO t (n) VALUES (:n)', { n: 42n });
          db.run('INSERT INTO t (n) VALUES (:n)', { n: BigInt(Number.MAX_SAFE_INTEGER) });
          expect(db.all<{ n: number }>('SELECT n FROM t ORDER BY n').map((r) => Number(r.n))).toEqual([42, Number.MAX_SAFE_INTEGER]);
          expect(() => db.run('INSERT INTO t (n) VALUES (:n)', { n: 2n ** 60n })).toThrow(RangeError);
          expect(db.get<{ c: number }>('SELECT COUNT(*) AS c FROM t')!.c).toBe(2);
          // Like a number, a bigint binds as REAL (a DO binds numbers only).
          expect(db.get("SELECT typeof(:n) AS t, :n || '' AS s, json_object('n', :n) AS j", { n: 42n })).toEqual({
            t: 'real',
            s: '42.0',
            j: '{"n":42.0}',
          });
        }));

      it('stores a lone surrogate as U+FFFD', () =>
        withDb((db) => {
          expect(db.get('SELECT :s AS s, hex(:s) AS h', { s: 'x\ud800y' })).toEqual({ s: 'x\ufffdy', h: '78EFBFBD79' });
          expect(db.get('SELECT :s AS s', { s: 'pair \ud83d\ude00' })).toEqual({ s: 'pair 😀' });
        }));

      it('refuses objects (a Durable Object would store "[object Object]")', () =>
        withDb((db) => {
          db.exec('CREATE TABLE t (v)');
          for (const value of [{ a: 1 }, [1, 2], new Date(0), new Uint8Array([1, 2]).buffer]) {
            expect(() => db.run('INSERT INTO t (v) VALUES (:v)', { v: value as never })).toThrow(TypeError);
          }
          expect(db.get<{ c: number }>('SELECT COUNT(*) AS c FROM t')!.c).toBe(0);
        }));

      it('round-trips BLOBs as Uint8Array', () =>
        withDb((db) => {
          db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, b BLOB)');
          const bytes = new Uint8Array([0, 1, 2, 127, 128, 255]);
          const view = new Uint8Array([9, 9, 3, 4, 5, 9]).subarray(2, 5);
          db.run('INSERT INTO t (id, b) VALUES (1, :b)', { b: bytes });
          db.run('INSERT INTO t (id, b) VALUES (2, :b)', { b: view });
          const rows = db.all<{ b: Uint8Array; t: string }>('SELECT b, typeof(b) AS t FROM t ORDER BY id');
          expect(rows.map((r) => r.t)).toEqual(['blob', 'blob']);
          expect(rows[0]!.b).toBeInstanceOf(Uint8Array);
          expect([...rows[0]!.b]).toEqual([...bytes]);
          expect([...rows[1]!.b]).toEqual([3, 4, 5]);
        }));
    });

    describe('results', () => {
      it('returns plain rows; get returns the first row or undefined', () =>
        withDb((db) => {
          db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, created_at TEXT)');
          db.run('INSERT INTO t (created_at) VALUES (:t), (:t)', { t: T0 });
          expect(db.all('SELECT id, created_at FROM t ORDER BY id')).toEqual([
            { id: 1, created_at: T0 },
            { id: 2, created_at: T0 },
          ]);
          expect(db.get('SELECT id FROM t ORDER BY id DESC')).toEqual({ id: 2 });
          expect(db.get('SELECT id FROM t WHERE id = 99')).toBeUndefined();
        }));

      it('returns rows without a prototype', () =>
        withDb((db) => {
          expect(Object.getPrototypeOf(db.get('SELECT 1 AS a'))).toBeNull();
          expect(Object.getPrototypeOf(db.all('SELECT 1 AS a')[0])).toBeNull();
          expect(Object.keys(db.get("SELECT 'y' AS constructor, 'z' AS hasOwnProperty")!)).toEqual(['constructor', 'hasOwnProperty']);
        }));

      it('reports changes and lastInsertRowid', () =>
        withDb((db) => {
          db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)');
          expect(db.run("INSERT INTO t (v) VALUES ('a')")).toEqual({ changes: 1, lastInsertRowid: 1 });
          expect(db.run("INSERT INTO t (v) VALUES ('b'), ('c')")).toEqual({ changes: 2, lastInsertRowid: 3 });
          expect(db.run("UPDATE t SET v = 'x' WHERE id >= 2").changes).toBe(2);
          expect(db.run('DELETE FROM t WHERE id = 99').changes).toBe(0);
        }));

      it('drains RETURNING cursors, so a transaction can follow', () =>
        withDb((db) => {
          db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)');
          expect(db.get("INSERT INTO t (v) VALUES ('a') RETURNING id")).toEqual({ id: 1 });
          expect(db.run("INSERT INTO t (v) VALUES ('b') RETURNING id").lastInsertRowid).toBe(2);
          db.tx(() => db.run("INSERT INTO t (v) VALUES ('c')"));
          db.exec('DROP TABLE t');
          expect(tableNames(db)).not.toContain('t');
        }));
    });

    describe('transactions', () => {
      it('nests three levels; an inner rollback keeps the outer writes', () =>
        withDb((db) => {
          db.exec('CREATE TABLE t (v TEXT)');
          expect(db.inTransaction).toBe(false);
          db.tx(() => {
            db.run("INSERT INTO t VALUES ('outer')");
            db.tx(() => {
              db.run("INSERT INTO t VALUES ('middle')");
              expect(() =>
                db.tx(() => {
                  expect(db.inTransaction).toBe(true);
                  db.run("INSERT INTO t VALUES ('inner')");
                  throw new Error('boom');
                }),
              ).toThrow('boom');
              db.run("INSERT INTO t VALUES ('middle-after')");
            });
            db.run("INSERT INTO t VALUES ('outer-after')");
          });
          expect(db.inTransaction).toBe(false);
          expect(db.all<{ v: string }>('SELECT v FROM t').map((r) => r.v)).toEqual(['outer', 'middle', 'middle-after', 'outer-after']);
        }));

      it('returns the callback value, and rolls back and rethrows the same error when it throws', () =>
        withDb((db) => {
          db.exec('CREATE TABLE t (v TEXT)');
          expect(db.tx(() => 42)).toBe(42);
          const failure = new Error('failed');
          let caught: unknown;
          try {
            db.tx(() => {
              db.run("INSERT INTO t VALUES ('lost')");
              throw failure;
            });
          } catch (err) {
            caught = err;
          }
          expect(caught).toBe(failure);
          expect(db.inTransaction).toBe(false);
          expect(db.all('SELECT v FROM t')).toEqual([]);
        }));

      it('refuses a callback that returns a Promise, and rolls back what it wrote', () =>
        withDb((db) => {
          db.exec('CREATE TABLE t (v TEXT)');
          expect(() =>
            db.tx(() => {
              db.run("INSERT INTO t VALUES ('lost')");
              return Promise.resolve(1);
            }),
          ).toThrow('Db.tx() callback must be synchronous');
          expect(db.inTransaction).toBe(false);
          expect(db.all('SELECT v FROM t')).toEqual([]);
        }));

      it('refuses an async callback that rejects, without an unhandled rejection', async () => {
        await withDb((db) => {
          db.exec('CREATE TABLE t (v TEXT)');
          expect(() =>
            db.tx(async () => {
              db.run("INSERT INTO t VALUES ('lost')");
              throw new Error('async failure');
            }),
          ).toThrow('Db.tx() callback must be synchronous');
          expect(db.all('SELECT v FROM t')).toEqual([]);
        });
        await settle();
      });
    });

    describe('statements', () => {
      it('runs multi-statement DDL in exec, a trailing comment included', () =>
        withDb((db) => {
          db.exec('CREATE TABLE a (x INTEGER);\nCREATE TABLE b (y INTEGER); -- done\n');
          expect(tableNames(db)).toEqual(expect.arrayContaining(['a', 'b']));
        }));

      it('takes one statement per all/get/run call, and no parameters in exec', () =>
        withDb((db) => {
          db.exec('CREATE TABLE t (a INTEGER)');
          expect(() => db.run('INSERT INTO t VALUES (1); INSERT INTO t VALUES (2)')).toThrow('One statement per call');
          expect(() => db.get('SELECT 1 AS a; SELECT 2 AS a')).toThrow('One statement per call');
          expect(() => db.all('INSERT INTO t VALUES (1); SELECT :b AS b', { b: 2 })).toThrow('One statement per call');
          expect(() => db.get('  -- nothing')).toThrow('SQL contains no statement');
          expect(() => db.exec('CREATE TABLE u (a); INSERT INTO u VALUES (:x)')).toThrow('exec() takes no parameters');
          expect(tableNames(db)).not.toContain('u');
          expect(db.all('SELECT a FROM t')).toEqual([]);
          // A trailing semicolon or comment is not a second statement.
          expect(db.get('SELECT 1 AS a; -- note')).toEqual({ a: 1 });
          expect(db.get('SELECT :a AS a; \n', { a: 2 })).toEqual({ a: 2 });
        }));

      it('runs a trigger, whose body holds statements and CASE … END, as one statement', () =>
        withDb((db) => {
          db.exec(`
            CREATE TABLE t (v TEXT);
            CREATE TABLE log (m TEXT);
            CREATE TRIGGER t_log AFTER INSERT ON t BEGIN
              INSERT INTO log VALUES (CASE WHEN new.v = 'a' THEN 'first; of all' ELSE 'other' END);
              INSERT INTO log VALUES ('done');
            END; -- trailing
          `);
          db.run(`CREATE TRIGGER t_guard BEFORE DELETE ON t BEGIN SELECT RAISE(ABORT, 'kept'); END`);
          db.run("INSERT INTO t VALUES ('a')");
          expect(db.all('SELECT m FROM log')).toEqual([{ m: 'first; of all' }, { m: 'done' }]);
          expect(() => db.run('DELETE FROM t')).toThrow('kept');
          expect(db.all('SELECT v FROM t')).toEqual([{ v: 'a' }]);
        }));

      it('runs a table named changes, and a trigger writing a column named end (neither a call nor the body\'s end)', () =>
        withDb((db) => {
          db.exec(`
            CREATE TABLE changes (a INTEGER);
            CREATE INDEX changes_a ON changes (a);
            CREATE TABLE t (id INTEGER PRIMARY KEY, end INTEGER);
            CREATE TABLE h (end INTEGER, n TEXT);
            CREATE TRIGGER t_h AFTER INSERT ON t BEGIN
              INSERT INTO h (end, n) VALUES (NEW.end, CASE WHEN NEW.end > 0 THEN 'pos' ELSE 'neg' END);
              UPDATE h SET end = end + 1 WHERE end IS NOT NULL;
            END;
            CREATE VIEW last_insert_rowid (a) AS SELECT a FROM changes;
          `);
          db.run('INSERT INTO changes (a) VALUES (1)');
          db.run('INSERT INTO t (end) VALUES (5)');
          expect(db.all('SELECT end, n FROM h')).toEqual([{ end: 6, n: 'pos' }]);
          expect(db.all('WITH total_changes(n) AS (SELECT a FROM last_insert_rowid) SELECT n FROM total_changes')).toEqual([{ n: 1 }]);
        }));

      it('allows the pragmas a Durable Object allows', () =>
        withDb((db) => {
          db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
          expect(db.get('PRAGMA foreign_keys')).toEqual({ foreign_keys: 1 });
          expect(db.all<{ name: string }>('PRAGMA table_info(t)').map((c) => c.name)).toEqual(['id', 'v']);
          expect(db.all('PRAGMA foreign_key_check')).toEqual([]);
        }));

      it('refuses transaction statements, VACUUM, ATTACH and Node-only pragmas', () =>
        withDb((db) => {
          db.exec('CREATE TABLE t (v TEXT)');
          const refused: Array<() => unknown> = [
            () => db.exec('BEGIN'),
            () => db.run('BEGIN IMMEDIATE'),
            () => db.exec('COMMIT'),
            () => db.exec('END'),
            () => db.run('END TRANSACTION'),
            () => db.exec('ROLLBACK'),
            () => db.exec('SAVEPOINT sp'),
            () => db.run('RELEASE sp'),
            () => db.exec('VACUUM'),
            () => db.exec("ATTACH DATABASE ':memory:' AS other"),
            () => db.exec('DETACH DATABASE other'),
            () => db.get('PRAGMA user_version'),
            () => db.exec('PRAGMA user_version = 3'),
            () => db.exec('PRAGMA journal_mode = DELETE'),
          ];
          for (const statement of refused) expect(statement).toThrow();
          expect(db.inTransaction).toBe(false);
          db.run("INSERT INTO t VALUES ('still works')");
          expect(db.all('SELECT v FROM t')).toEqual([{ v: 'still works' }]);
          // END inside tx() would commit early on Node; the tx rolls back instead.
          expect(() =>
            db.tx(() => {
              db.run("INSERT INTO t VALUES ('lost')");
              db.run('END');
            }),
          ).toThrow(/END/);
          expect(db.all('SELECT v FROM t')).toEqual([{ v: 'still works' }]);
        }));

      it('refuses ROLLBACK as a conflict resolution (in a Durable Object it loses every write of the invocation)', () =>
        withDb((db) => {
          db.exec('CREATE TABLE t (v TEXT PRIMARY KEY)');
          db.run("INSERT INTO t VALUES ('a')");
          const refused: Array<() => unknown> = [
            () => db.run("INSERT OR ROLLBACK INTO t VALUES ('a')"),
            () => db.run("UPDATE OR ROLLBACK t SET v = 'b'"),
            () => db.exec('CREATE TABLE u (v TEXT UNIQUE ON CONFLICT ROLLBACK)'),
            () => db.exec("CREATE TRIGGER g BEFORE INSERT ON t BEGIN SELECT RAISE(ROLLBACK, 'guarded'); END"),
          ];
          for (const statement of refused) expect(statement).toThrow(/ROLLBACK as a conflict resolution/);
          expect(tableNames(db)).not.toContain('u');
          db.run("INSERT INTO t VALUES ('b')");
          expect(db.all('SELECT v FROM t ORDER BY v')).toEqual([{ v: 'a' }, { v: 'b' }]);
        }));

      it('refuses deferred foreign keys and setting foreign_keys, outside withDeferredForeignKeys', () =>
        withDb((db) => {
          db.exec('CREATE TABLE p (id INTEGER PRIMARY KEY)');
          const deferredKey = 'CREATE TABLE k (id INTEGER PRIMARY KEY, p_id INTEGER REFERENCES p(id) DEFERRABLE INITIALLY DEFERRED)';
          expect(() => db.exec(deferredKey)).toThrow(/DEFERRABLE INITIALLY DEFERRED/);
          expect(() => db.run(deferredKey)).toThrow(/DEFERRABLE INITIALLY DEFERRED/);
          expect(() => db.run('PRAGMA defer_foreign_keys = ON')).toThrow(/withDeferredForeignKeys/);
          expect(() => db.tx(() => db.exec('PRAGMA defer_foreign_keys(1)'))).toThrow(/withDeferredForeignKeys/);
          expect(() => db.exec('PRAGMA foreign_keys = OFF')).toThrow(/PRAGMA foreign_keys/);
          expect(() => db.run('PRAGMA foreign_keys = ON')).toThrow(/PRAGMA foreign_keys/);
          expect(db.get('PRAGMA foreign_keys')).toEqual({ foreign_keys: 1 });
          expect(db.get('PRAGMA defer_foreign_keys')).toEqual({ defer_foreign_keys: 0 });
          // Immediate keys hold, whatever they are called.
          db.exec('CREATE TABLE k (id INTEGER PRIMARY KEY, p_id INTEGER REFERENCES p(id) DEFERRABLE INITIALLY IMMEDIATE)');
          expect(() => db.run('INSERT INTO k (id, p_id) VALUES (1, 99)')).toThrow(/FOREIGN KEY/);
        }));

      it("refuses last_insert_rowid(), changes() and total_changes() (a Durable Object's own writes move them)", () =>
        withDb((db) => {
          db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
          db.run('INSERT INTO t (id) VALUES (41)');
          for (const sql of ['SELECT last_insert_rowid() AS id', 'SELECT changes() AS c', 'SELECT total_changes() AS c']) {
            expect(() => db.get(sql)).toThrow(/use RETURNING or run\(\)'s result/);
          }
          expect(db.get('INSERT INTO t (id) VALUES (42) RETURNING id')).toEqual({ id: 42 });
        }));

      it('refuses temporary tables, _cf_ names and literal LIKE patterns over 50 bytes', () =>
        withDb((db) => {
          const refused: Array<() => unknown> = [
            () => db.exec('CREATE TEMP TABLE tt (x)'),
            () => db.exec('CREATE TEMPORARY VIEW tv AS SELECT 1 AS x'),
            () => db.exec('CREATE TABLE _cf_mine (x)'),
            () => db.get("SELECT 'abc' LIKE '" + 'a'.repeat(60) + "%' AS m"),
            () => db.get("SELECT 'abc' GLOB '" + 'a'.repeat(60) + "*' AS m"),
          ];
          for (const statement of refused) expect(statement).toThrow();
          expect(db.get("SELECT 'abc' LIKE '" + 'a'.repeat(49) + "%' AS m")).toEqual({ m: 0 });
          expect(tableNames(db)).toEqual([]);
        }));

      it.runIf(options.limits)("applies a Durable Object's SQLite limits, functions and virtual tables", () =>
        withDb((db) => {
          const union = (n: number) => Array.from({ length: n }, (_, i) => `SELECT ${i} AS v`).join(' UNION ALL ');
          expect(db.all(union(5))).toHaveLength(5);
          expect(() => db.all(union(6))).toThrow(/too many terms in compound SELECT/);
          expect(() => db.exec(`CREATE VIEW v6 AS ${union(6)}`)).toThrow(/too many terms in compound SELECT/);
          const chain = Array.from({ length: 120 }, () => "instr('abc', 'b') > 0").join(' AND ');
          expect(() => db.get(`SELECT ${chain} AS v`)).toThrow(/Expression tree is too large/);
          const columns = Array.from({ length: 101 }, (_, i) => `${i} AS c${i}`).join(', ');
          expect(() => db.get(`SELECT ${columns}`)).toThrow(/too many columns/);
          const args = Array.from({ length: 128 }, (_, i) => i).join(', ');
          expect(() => db.get(`SELECT json_array(${args}) AS v`)).toThrow(/too many arguments/);
          for (const sql of ['SELECT sqlite_version() AS v', "SELECT json_pretty('[]') AS v", 'SELECT unistr(\'a\') AS v']) {
            expect(() => db.get(sql), sql).toThrow();
          }
          expect(() => db.exec('CREATE VIRTUAL TABLE f4 USING fts4(body)')).toThrow();
          db.exec('CREATE VIRTUAL TABLE f5 USING fts5(body)');
          db.run("INSERT INTO f5 (body) VALUES ('portable full text')");
          expect(db.all("SELECT body FROM f5 WHERE f5 MATCH 'text'")).toEqual([{ body: 'portable full text' }]);
        }));

      it('refuses a statement over 100,000 bytes', () =>
        withDb((db) => {
          const sql = (bytes: number) => `SELECT '${'x'.repeat(bytes - 14)}' AS v`;
          expect(sql(100_001)).toHaveLength(100_001);
          expect(db.get<{ v: string }>(sql(99_000))!.v).toHaveLength(98_986);
          expect(() => db.get(sql(100_001))).toThrow();
        }));
    });

    describe('migrate (test-only migration set)', () => {
      it('migrates an empty database and records the state in _meta', () =>
        withDb((db) => {
          expect(readSchemaState(db)).toEqual({ schema: null, version: 0, compatibleFrom: 0, empty: true });
          const beforeUpgrade = vi.fn();
          const set = testSet(PARENT_CHILD, ADD_NOTE);
          expect(migrate(db, set, { appVersion: '1.2.3', now: () => T0, beforeUpgrade })).toEqual({ from: 0, to: 2 });
          expect(beforeUpgrade).not.toHaveBeenCalled();
          expect(meta(db)).toEqual({ schema: 'space', version: '2', compatible_from: '1', app_version: '1.2.3', created_at: T0 });
          expect(readSchemaState(db)).toEqual({ schema: 'space', version: 2, compatibleFrom: 1, empty: false });
          expect(db.all<{ name: string }>('PRAGMA table_info(parent)').map((c) => c.name)).toEqual(['id', 'name', 'note']);
          // Current: nothing to do.
          expect(migrate(db, set, { appVersion: '1.2.4', beforeUpgrade })).toEqual({ from: 2, to: 2 });
          expect(beforeUpgrade).not.toHaveBeenCalled();
          expect(meta(db).app_version).toBe('1.2.3');
        }));

      it('calls beforeUpgrade once for an existing database and keeps created_at', () =>
        withDb((db) => {
          migrate(db, testSet(PARENT_CHILD), { appVersion: '1.0.0', now: () => T0 });
          const beforeUpgrade = vi.fn();
          const result = migrate(db, testSet(PARENT_CHILD, ADD_NOTE, ADD_TAGS), {
            appVersion: '1.1.0',
            now: () => '2026-04-01T00:00:00.000Z',
            beforeUpgrade,
          });
          expect(result).toEqual({ from: 1, to: 3 });
          expect(beforeUpgrade).toHaveBeenCalledTimes(1);
          expect(beforeUpgrade).toHaveBeenCalledWith(1, 3);
          expect(meta(db)).toEqual({ schema: 'space', version: '3', compatible_from: '3', app_version: '1.1.0', created_at: T0 });
          expect(tableNames(db)).toEqual(expect.arrayContaining(['_meta', 'child', 'parent', 'tag']));
        }));

      it('rolls back a migration that leaves a foreign key violation, and one that throws', () =>
        withDb((db) => {
          migrate(db, testSet(PARENT_CHILD), { appVersion: '1.0.0' });
          const orphan: Migration = {
            up: (d) => {
              // Deferred, the orphan gets in until the check at the end (in a DO it would otherwise
              // reset the object at commit).
              d.exec('CREATE TABLE note (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id))');
              withDeferredForeignKeys(d, () => d.run('INSERT INTO note (parent_id) VALUES (:p)', { p: 99 }));
            },
          };
          expect(() => migrate(db, testSet(PARENT_CHILD, orphan), { appVersion: '1.1.0' })).toThrow(
            'Deferred foreign key check failed: 1 violation(s)',
          );
          const immediate: Migration = {
            up: (d) => {
              d.exec('CREATE TABLE note (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id))');
              d.run('INSERT INTO note (parent_id) VALUES (:p)', { p: 99 });
            },
          };
          expect(() => migrate(db, testSet(PARENT_CHILD, immediate), { appVersion: '1.1.0' })).toThrow(/FOREIGN KEY/);
          const failing: Migration = {
            up: (d) => {
              d.exec('CREATE TABLE half (id INTEGER PRIMARY KEY)');
              throw new Error('migration failed');
            },
          };
          expect(() => migrate(db, testSet(PARENT_CHILD, failing), { appVersion: '1.1.0' })).toThrow('migration failed');
          expect(readSchemaState(db).version).toBe(1);
          expect(meta(db).app_version).toBe('1.0.0');
          expect(tableNames(db)).not.toContain('note');
          expect(tableNames(db)).not.toContain('half');
          expect(db.inTransaction).toBe(false);
        }));

      it('refuses an async up() and rolls back what it wrote', async () => {
        await withDb((db) => {
          migrate(db, testSet(PARENT_CHILD), { appVersion: '1.0.0' });
          const asyncUp: Migration = {
            up: async (d) => {
              d.exec('CREATE TABLE sync_part (a)');
              await null;
            },
          };
          expect(() => migrate(db, testSet(PARENT_CHILD, asyncUp), { appVersion: '1.1.0' })).toThrow(
            'Migration 2: up() must be synchronous',
          );
          expect(readSchemaState(db).version).toBe(1);
          expect(tableNames(db)).not.toContain('sync_part');
        });
        await settle();
      });

      it('checks every compatibleFrom before migrating anything', () =>
        withDb((db) => {
          const misnumbered = testSet(PARENT_CHILD, ADD_TAGS, { ...ADD_NOTE, compatibleFrom: 4 });
          expect(() => migrate(db, misnumbered, { appVersion: '1.0.0' })).toThrow('Migration 3: compatibleFrom must be between 1 and 3');
          expect(readSchemaState(db).empty).toBe(true);
          migrate(db, testSet(PARENT_CHILD), { appVersion: '1.0.0' });
          const beforeUpgrade = vi.fn();
          expect(() => migrate(db, misnumbered, { appVersion: '1.1.0', beforeUpgrade })).toThrow('Migration 3');
          expect(beforeUpgrade).not.toHaveBeenCalled();
          expect(readSchemaState(db).version).toBe(1);
          expect(tableNames(db)).not.toContain('tag');
        }));

      it('refuses a database of the other kind, and one without _meta', () =>
        withDb((db) => {
          migrate(db, testSet(PARENT_CHILD), { appVersion: '1.0.0' });
          expect(() => migrate(db, { schema: 'directory', migrations: [PARENT_CHILD] }, { appVersion: '1.0.0' })).toThrow(
            'This database is a space database, not a directory database',
          );
          db.exec('DROP TABLE _meta');
          expect(readSchemaState(db)).toEqual({ schema: null, version: 0, compatibleFrom: 0, empty: false });
          expect(() => migrate(db, testSet(PARENT_CHILD), { appVersion: '1.0.0' })).toThrow(/not a space database/);
        }));

      it('refuses a newer schema, unless its newer migrations are compatible with this build', () =>
        withDb((db) => {
          migrate(db, testSet(PARENT_CHILD, ADD_NOTE), { appVersion: '1.1.0' });
          // ADD_NOTE is compatible from 1: a build that knows one migration still runs.
          const beforeUpgrade = vi.fn();
          expect(migrate(db, testSet(PARENT_CHILD), { appVersion: '1.0.0', beforeUpgrade })).toEqual({ from: 2, to: 2 });
          expect(beforeUpgrade).not.toHaveBeenCalled();
          expect(meta(db).version).toBe('2');
          // ADD_TAGS is compatible only from 3.
          migrate(db, testSet(PARENT_CHILD, ADD_NOTE, ADD_TAGS), { appVersion: '1.2.0' });
          expect(() => migrate(db, testSet(PARENT_CHILD, ADD_NOTE), { appVersion: '1.1.0' })).toThrow(
            'Database schema version 3 is newer than this build supports (2). Upgrade the app.',
          );
        }));
    });

    describe('migrate (the directory and space schemas)', () => {
      const sets = [
        {
          set: DIRECTORY_MIGRATIONS,
          ddl: DIRECTORY_V1,
          tables: [
            '_meta', 'auth_throttle', 'device_tokens', 'email_tokens', 'instance_settings', 'invitations', 'memberships',
            'passkeys', 'security_events', 'sessions', 'space_people', 'spaces', 'users', 'webauthn_challenges',
          ],
          triggers: [],
        },
        {
          set: SPACE_MIGRATIONS,
          // Migration 4 adds task_links (task dependencies).
          ddl: SPACE_V1 + SPACE_V4,
          tables: [
            '_meta', 'activity', 'boards', 'comments', 'epics', 'milestones', 'projects', 'settings', 'statuses', 'tags',
            'task_links', 'task_tags', 'tasks', 'users', 'work_logs',
          ],
          // Migration 2: tasks.tag_ids and the triggers that keep it (Appendix D 42); migration 3: the comment
          // counts and logged minutes (Appendix D 46).
          triggers: [
            'comments_deleted', 'comments_inserted', 'comments_moved', 'task_tags_deleted', 'task_tags_inserted', 'task_tags_updated',
            'work_logs_deleted', 'work_logs_inserted', 'work_logs_updated',
          ],
        },
      ];

      for (const { set, ddl, tables, triggers } of sets) {
        it(`migrates the ${set.schema} schema from empty, cleanly, and a second run changes nothing`, () =>
          withDb((db) => {
            const n = set.migrations.length;
            const migrated = { schema: set.schema, version: String(n), compatible_from: '1', app_version: '2.0.0', created_at: T0 };
            expect(readSchemaState(db).empty).toBe(true);
            const beforeUpgrade = vi.fn();
            expect(migrate(db, set, { appVersion: '2.0.0', now: () => T0, beforeUpgrade })).toEqual({ from: 0, to: n });
            expect(meta(db)).toEqual(migrated);
            const objects = schemaObjects(db);
            expect(objects.filter((o) => o.type === 'table').map((o) => o.name)).toEqual(tables);
            expect(createdNames(ddl, 'TABLE')).toEqual(tables);
            expect(objects.filter((o) => o.type === 'index').map((o) => o.name)).toEqual(createdNames(ddl, 'INDEX'));
            expect(objects.filter((o) => o.type === 'trigger').map((o) => o.name)).toEqual(triggers);
            expect(db.all('PRAGMA foreign_key_check')).toEqual([]);

            expect(migrate(db, set, { appVersion: '2.0.1', now: () => '2026-04-01T00:00:00.000Z', beforeUpgrade })).toEqual({ from: n, to: n });
            expect(beforeUpgrade).not.toHaveBeenCalled();
            expect(meta(db)).toEqual(migrated);
            expect(schemaObjects(db)).toEqual(objects);
            // The other kind's set refuses it.
            const other = set.schema === 'space' ? DIRECTORY_MIGRATIONS : SPACE_MIGRATIONS;
            expect(() => migrate(db, other, { appVersion: '2.0.0' })).toThrow(`This database is a ${set.schema} database, not a ${other.schema} database`);
          }));
      }

      it('space: a row in every table passes foreign_key_check; content points at the users mirror', () =>
        withDb((db) => {
          migrate(db, SPACE_MIGRATIONS, { appVersion: '2.0.0' });
          const t = { t: T0 };
          db.run("INSERT INTO users (id, kind, display_name, email, is_member, updated_at) VALUES (1, 'account', 'Ann', 'ann@example.com', 1, :t)", t);
          db.run("INSERT INTO users (id, kind, display_name, updated_at) VALUES (-1, 'placeholder', 'Former member', :t)", t);
          db.run(`INSERT INTO settings (key, value) VALUES ('estimateUnit', '"points"')`);
          db.run(
            "INSERT INTO projects (id, key, name, name_fold, description, description_fold, color, created_at, updated_at) VALUES (1, 'WEB', 'Web', 'web', '', '', '#6366f1', :t, :t)",
            t,
          );
          db.run("INSERT INTO milestones (id, project_id, name, name_fold, description_fold, created_at, updated_at) VALUES (1, 1, 'M', 'm', '', :t, :t)", t);
          db.run(
            "INSERT INTO epics (id, project_id, milestone_id, name, name_fold, description_fold, color, created_at, updated_at) VALUES (1, 1, 1, 'E', 'e', '', '#8b5cf6', :t, :t)",
            t,
          );
          db.run("INSERT INTO statuses (id, name, name_fold, category, color, created_at, updated_at) VALUES (1, 'Todo', 'todo', 'unstarted', '#64748b', :t, :t)", t);
          db.run(
            `INSERT INTO tasks (id, project_id, number, epic_id, status_id, title, title_fold, description_fold, rank, created_by, created_at, updated_at)
             VALUES (1, 1, 1, 1, 1, 'Task', 'task', '', 'a0', 1, :t, :t)`,
            t,
          );
          db.run("INSERT INTO tags (id, name, name_fold, color, created_at, updated_at) VALUES (1, 'Bug', 'bug', '#64748b', :t, :t)", t);
          db.run('INSERT INTO task_tags (task_id, tag_id) VALUES (1, 1)');
          db.run(
            "INSERT INTO comments (id, task_id, user_id, body, created_at, updated_at, imported_by, imported_at) VALUES (1, 1, -1, 'hi', :t, :t, 1, :t)",
            t,
          );
          db.run("INSERT INTO work_logs (id, task_id, user_id, date, minutes, created_at, updated_at) VALUES (1, 1, 1, '2026-03-01', 30, :t, :t)", t);
          db.run(
            "INSERT INTO activity (id, user_id, project_id, task_id, entity_type, entity_id, action, created_at, imported_by, imported_at) VALUES (1, 1, 1, 1, 'task', 1, 'task.created', :t, 1, :t)",
            t,
          );
          db.run("INSERT INTO boards (id, project_id, name, config, created_at, updated_at) VALUES (1, 1, 'Board', '{}', :t, :t)", t);
          expect(db.all('PRAGMA foreign_key_check')).toEqual([]);

          expect(() => db.run("INSERT INTO comments (task_id, user_id, body, created_at, updated_at) VALUES (1, 99, 'x', :t, :t)", t)).toThrow(/FOREIGN KEY/);
          expect(() => db.run('UPDATE work_logs SET imported_by = 99')).toThrow(/FOREIGN KEY/);
          // Rows outlive their author's mirror row (SET NULL), as with today's users table.
          db.run('DELETE FROM users WHERE id = 1');
          expect(db.get('SELECT created_by FROM tasks')).toEqual({ created_by: null });
          expect(db.get('SELECT user_id, imported_by FROM comments')).toEqual({ user_id: -1, imported_by: null });
          expect(db.get('SELECT user_id FROM work_logs')).toEqual({ user_id: null });
          expect(db.get('SELECT user_id, imported_by FROM activity')).toEqual({ user_id: null, imported_by: null });
          expect(db.all('PRAGMA foreign_key_check')).toEqual([]);
        }));

      it('space migration 2: a database of migration 1 gets its tasks\' tag lists, and the triggers keep them', () =>
        withDb((db) => {
          migrate(db, { schema: 'space', migrations: SPACE_MIGRATIONS.migrations.slice(0, 1) }, { appVersion: '2.0.0' });
          const t = { t: T0 };
          db.run("INSERT INTO users (id, kind, display_name, email, is_member, updated_at) VALUES (1, 'account', 'Ann', 'ann@example.com', 1, :t)", t);
          db.run(
            "INSERT INTO projects (id, key, name, name_fold, description, description_fold, color, created_at, updated_at) VALUES (1, 'WEB', 'Web', 'web', '', '', '#6366f1', :t, :t)",
            t,
          );
          db.run("INSERT INTO statuses (id, name, name_fold, category, color, created_at, updated_at) VALUES (1, 'Todo', 'todo', 'unstarted', '#64748b', :t, :t)", t);
          for (const id of [1, 2, 3]) {
            db.run(
              `INSERT INTO tasks (id, project_id, number, status_id, title, title_fold, description_fold, rank, created_at, updated_at)
               VALUES (:id, 1, :id, 1, 'Task', 'task', '', 'a0', :t, :t)`,
              { id, ...t },
            );
          }
          for (const id of [3, 1, 2]) {
            db.run("INSERT INTO tags (id, name, name_fold, color, created_at, updated_at) VALUES (:id, :name, :name, '#64748b', :t, :t)", {
              id,
              name: `tag${id}`,
              ...t,
            });
          }
          db.run('INSERT INTO task_tags (task_id, tag_id) VALUES (1, 3), (1, 1), (2, 2)');
          const lists = () => db.all<{ id: number; tag_ids: string }>('SELECT id, tag_ids FROM tasks ORDER BY id').map((r) => r.tag_ids);

          expect(migrate(db, { schema: 'space', migrations: SPACE_MIGRATIONS.migrations.slice(0, 2) }, { appVersion: '2.0.1' })).toEqual({
            from: 1,
            to: 2,
          });
          expect(meta(db)).toMatchObject({ version: '2', compatible_from: '1' });
          expect(lists()).toEqual(['[1,3]', '[2]', '[]']);
          // Every change of task_tags, whatever writes it.
          db.run('INSERT INTO task_tags (task_id, tag_id) SELECT 3, value FROM json_each(:ids)', { ids: '[2,1]' });
          db.run('DELETE FROM task_tags WHERE task_id = 1 AND tag_id = 1');
          db.run('UPDATE task_tags SET task_id = 2 WHERE task_id = 1 AND tag_id = 3');
          expect(lists()).toEqual(['[]', '[2,3]', '[1,2]']);
          // The cascade of a deleted tag; a deleted task's own rows touch no other task.
          db.run('DELETE FROM tags WHERE id = 2');
          expect(lists()).toEqual(['[]', '[3]', '[1]']);
          db.run('DELETE FROM tasks WHERE id = 2');
          expect(lists()).toEqual(['[]', '[1]']);
          expect(db.all('SELECT * FROM task_tags')).toEqual([{ task_id: 3, tag_id: 1 }]);
          // A build that knows only migration 1 may still open the database (an additive change).
          expect(migrate(db, { schema: 'space', migrations: SPACE_MIGRATIONS.migrations.slice(0, 1) }, { appVersion: '2.0.0' })).toEqual({
            from: 2,
            to: 2,
          });
        }));

      it("space migration 3: a database of migration 2 gets its tasks' counts, and the triggers keep them", () =>
        withDb((db) => {
          migrate(db, { schema: 'space', migrations: SPACE_MIGRATIONS.migrations.slice(0, 2) }, { appVersion: '2.0.0' });
          const t = { t: T0 };
          db.run("INSERT INTO users (id, kind, display_name, email, is_member, updated_at) VALUES (1, 'account', 'Ann', 'ann@example.com', 1, :t)", t);
          db.run(
            "INSERT INTO projects (id, key, name, name_fold, description, description_fold, color, created_at, updated_at) VALUES (1, 'WEB', 'Web', 'web', '', '', '#6366f1', :t, :t)",
            t,
          );
          db.run("INSERT INTO statuses (id, name, name_fold, category, color, created_at, updated_at) VALUES (1, 'Todo', 'todo', 'unstarted', '#64748b', :t, :t)", t);
          for (const id of [1, 2, 3]) {
            db.run(
              `INSERT INTO tasks (id, project_id, number, status_id, title, title_fold, description_fold, rank, created_at, updated_at)
               VALUES (:id, 1, :id, 1, 'Task', 'task', '', 'a0', :t, :t)`,
              { id, ...t },
            );
          }
          const comment = (taskId: number) =>
            db.run("INSERT INTO comments (task_id, user_id, body, created_at, updated_at) VALUES (:taskId, 1, 'hi', :t, :t)", { taskId, ...t });
          const log = (taskId: number, minutes: number | null) =>
            db.run("INSERT INTO work_logs (task_id, user_id, date, minutes, note, created_at, updated_at) VALUES (:taskId, 1, '2026-03-01', :minutes, 'n', :t, :t)", {
              taskId,
              minutes,
              ...t,
            });
          comment(1);
          comment(1);
          comment(2);
          log(1, 30);
          log(1, null);
          log(2, 15);
          const counts = () =>
            db.all<{ comment_count: number; worklog_minutes: number }>('SELECT comment_count, worklog_minutes FROM tasks ORDER BY id').map(
              (r) => [r.comment_count, r.worklog_minutes],
            );

          expect(migrate(db, { schema: 'space', migrations: SPACE_MIGRATIONS.migrations.slice(0, 3) }, { appVersion: '2.0.1' })).toEqual({
            from: 2,
            to: 3,
          });
          expect(meta(db)).toMatchObject({ version: '3', compatible_from: '1' });
          expect(counts()).toEqual([[2, 30], [1, 15], [0, 0]]);
          // Every change of comments and work logs, whatever writes it.
          comment(3);
          log(3, 45);
          db.run('DELETE FROM comments WHERE id = (SELECT MIN(id) FROM comments WHERE task_id = 1)');
          db.run('UPDATE comments SET task_id = 3 WHERE task_id = 2');
          db.run('UPDATE work_logs SET minutes = 40 WHERE task_id = 1 AND minutes = 30');
          db.run('UPDATE work_logs SET minutes = 5 WHERE task_id = 1 AND minutes IS NULL');
          db.run('UPDATE work_logs SET task_id = 1 WHERE task_id = 2');
          db.run("UPDATE work_logs SET note = 'edited', minutes = minutes WHERE task_id = 3");
          expect(counts()).toEqual([[1, 60], [0, 0], [2, 45]]);
          db.run('DELETE FROM work_logs WHERE task_id = 3');
          // A deleted task's own rows touch no other task.
          db.run('DELETE FROM tasks WHERE id = 1');
          expect(counts()).toEqual([[0, 0], [2, 0]]);
          // A build that knows only migrations 1 and 2 may still open the database (an additive change).
          expect(migrate(db, { schema: 'space', migrations: SPACE_MIGRATIONS.migrations.slice(0, 2) }, { appVersion: '2.0.0' })).toEqual({
            from: 3,
            to: 3,
          });
        }));

      it('space migration 4: a database of migration 3 gets task_links, which its tasks\' deletes clear', () =>
        withDb((db) => {
          migrate(db, { schema: 'space', migrations: SPACE_MIGRATIONS.migrations.slice(0, 3) }, { appVersion: '2.0.0' });
          const t = { t: T0 };
          db.run(
            "INSERT INTO projects (id, key, name, name_fold, description, description_fold, color, created_at, updated_at) VALUES (1, 'WEB', 'Web', 'web', '', '', '#6366f1', :t, :t)",
            t,
          );
          db.run("INSERT INTO statuses (id, name, name_fold, category, color, created_at, updated_at) VALUES (1, 'Todo', 'todo', 'unstarted', '#64748b', :t, :t)", t);
          for (const id of [1, 2, 3]) {
            db.run(
              `INSERT INTO tasks (id, project_id, number, status_id, title, title_fold, description_fold, rank, created_at, updated_at)
               VALUES (:id, 1, :id, 1, 'Task', 'task', '', 'a0', :t, :t)`,
              { id, ...t },
            );
          }
          expect(migrate(db, SPACE_MIGRATIONS, { appVersion: '2.0.1' })).toEqual({ from: 3, to: 4 });
          expect(meta(db)).toMatchObject({ version: '4', compatible_from: '1' });
          db.run('INSERT INTO task_links (blocker_id, blocked_id, created_at) VALUES (1, 2, :t), (2, 3, :t)', t);
          expect(() => db.run('INSERT INTO task_links (blocker_id, blocked_id, created_at) VALUES (3, 3, :t)', t)).toThrow(/CHECK/);
          expect(() => db.run('INSERT INTO task_links (blocker_id, blocked_id, created_at) VALUES (1, 9, :t)', t)).toThrow(/FOREIGN KEY/);
          db.run('DELETE FROM tasks WHERE id = 2');
          expect(db.all('SELECT * FROM task_links')).toEqual([]);
          expect(db.all('PRAGMA foreign_key_check')).toEqual([]);
        }));

      it('space: the users mirror refuses rows its CHECKs forbid', () =>
        withDb((db) => {
          migrate(db, SPACE_MIGRATIONS, { appVersion: '2.0.0' });
          const insert = (id: number, kind: string, o: { email?: string | null; isMember?: number; deleted?: number } = {}) =>
            db.run(
              'INSERT INTO users (id, kind, display_name, email, is_member, deleted, updated_at) VALUES (:id, :kind, :name, :email, :isMember, :deleted, :t)',
              { id, kind, name: `User ${id}`, email: o.email ?? null, isMember: o.isMember ?? 0, deleted: o.deleted ?? 0, t: T0 },
            );
          const refused: Array<[string, () => unknown]> = [
            ['id 0', () => insert(0, 'account')],
            ['an account with a negative id', () => insert(-2, 'account')],
            ['a placeholder with a positive id', () => insert(2, 'placeholder')],
            ['a placeholder that is a member', () => insert(-2, 'placeholder', { isMember: 1 })],
            ['a placeholder with an email', () => insert(-2, 'placeholder', { email: 'p@example.com' })],
            ['another kind', () => insert(2, 'guest')],
            ['is_member 2', () => insert(2, 'account', { isMember: 2 })],
            ['deleted 2', () => insert(2, 'account', { deleted: 2 })],
          ];
          for (const [what, call] of refused) expect(call, what).toThrow(/CHECK constraint failed/);
          expect(() => db.run("INSERT INTO users (id, updated_at) VALUES (3, :t)", { t: T0 })).toThrow(/NOT NULL constraint failed/);
          insert(1, 'account', { email: 'ann@example.com', isMember: 1 });
          insert(2, 'account', { deleted: 1 });
          insert(-1, 'placeholder');
          expect(db.all('SELECT id, kind FROM users ORDER BY id')).toEqual([
            { id: -1, kind: 'placeholder' },
            { id: 1, kind: 'account' },
            { id: 2, kind: 'account' },
          ]);
          expect(() => db.run('UPDATE users SET id = -5 WHERE id = 1')).toThrow(/CHECK constraint failed/);
        }));

      it('space: fold columns are required, and names stay unique ASCII-insensitively (the folds decide the rest, §3.4)', () =>
        withDb((db) => {
          migrate(db, SPACE_MIGRATIONS, { appVersion: '2.0.0' });
          const t = { t: T0 };
          const forgotten = [
            "INSERT INTO tags (name, color, created_at, updated_at) VALUES ('Bug', '#64748b', :t, :t)",
            "INSERT INTO statuses (name, category, color, created_at, updated_at) VALUES ('Todo', 'unstarted', '#64748b', :t, :t)",
            "INSERT INTO projects (key, name, description_fold, color, created_at, updated_at) VALUES ('WEB', 'Web', '', '#6366f1', :t, :t)",
            "INSERT INTO projects (key, name, name_fold, color, created_at, updated_at) VALUES ('WEB', 'Web', 'web', '#6366f1', :t, :t)",
          ];
          for (const sql of forgotten) expect(() => db.run(sql, t), sql).toThrow(/NOT NULL constraint failed/);

          const tag = (name: string) =>
            db.run('INSERT INTO tags (name, name_fold, color, created_at, updated_at) VALUES (:name, :fold, :color, :t, :t)', {
              name,
              fold: name.toLowerCase(),
              color: '#64748b',
              t: T0,
            });
          const status = (name: string) =>
            db.run(
              "INSERT INTO statuses (name, name_fold, category, color, created_at, updated_at) VALUES (:name, :fold, 'started', '#64748b', :t, :t)",
              { name, fold: name.toLowerCase(), t: T0 },
            );
          tag('Bug');
          expect(() => tag('BUG')).toThrow(/UNIQUE constraint failed/);
          status('Doing');
          expect(() => status('doing')).toThrow(/UNIQUE constraint failed/);
          db.run(
            "INSERT INTO projects (key, name, name_fold, description_fold, color, created_at, updated_at) VALUES ('WEB', 'Web', 'web', '', '#6366f1', :t, :t)",
            t,
          );
          expect(() =>
            db.run(
              "INSERT INTO projects (key, name, name_fold, description_fold, color, created_at, updated_at) VALUES ('web', 'Web 2', 'web 2', '', '#6366f1', :t, :t)",
              t,
            ),
          ).toThrow(/UNIQUE constraint failed/);
          // NOCASE folds ASCII only, on both runtimes: Ärger and ärger both get in, and their folds
          // are what the routes check (SELECT 1 FROM tags WHERE name_fold = :fold …).
          tag('Ärger');
          tag('ärger');
          status('Überprüfen');
          status('überprüfen');
          expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM tags WHERE name_fold = 'ärger'")!.n).toBe(2);
          expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM statuses WHERE name_fold = 'überprüfen'")!.n).toBe(2);
          for (const [table, index] of [['tags', 'tags_name_fold'], ['statuses', 'statuses_name_fold']] as const) {
            expect(db.all<{ name: string }>(`PRAGMA index_list(${table})`).map((i) => i.name)).toContain(index);
            expect(db.all<{ name: string }>(`PRAGMA index_info(${index})`).map((c) => c.name)).toEqual(['name_fold']);
          }
        }));

      it('directory: accounts, spaces and invitations refuse what their constraints forbid', () =>
        withDb((db) => {
          migrate(db, DIRECTORY_MIGRATIONS, { appVersion: '2.0.0' });
          const user = (id: number, o: { email?: string | null; key?: string | null; username?: string | null }) =>
            db.run(
              'INSERT INTO users (id, email, email_key, username, display_name, webauthn_user_id, created_at, updated_at) VALUES (:id, :email, :key, :username, :name, :handle, :t, :t)',
              { id, email: o.email ?? null, key: o.key ?? null, username: o.username ?? null, name: `User ${id}`, handle: `handle-${id}`, t: T0 },
            );
          expect(() => user(1, {})).toThrow(/CHECK constraint failed/);
          expect(() => user(1, { email: 'Ann@example.com' })).toThrow(/CHECK constraint failed/);
          user(1, { email: 'Ann@example.com', key: 'ann@example.com' });
          user(2, { username: 'owner' });
          expect(() => user(3, { email: 'ANN@example.com', key: 'ann@example.com' })).toThrow(/UNIQUE constraint failed/);
          expect(() => user(3, { username: 'OWNER' })).toThrow(/UNIQUE constraint failed/);

          db.run(
            "INSERT INTO spaces (id, public_id, name, status, created_by, created_at, updated_at) VALUES (1, '7k2m9q4w8x1c3v5b', 'Team', 'active', 1, :t, :t)",
            { t: T0 },
          );
          expect(() =>
            db.run(
              "INSERT INTO spaces (public_id, name, status, created_at, updated_at, deleted_at) VALUES ('0000000000000000', 'Gone', 'active', :t, :t, :t)",
              { t: T0 },
            ),
          ).toThrow(/CHECK constraint failed/);
          const member = (userId: number, role: string) =>
            db.run("INSERT INTO memberships (space_id, user_id, role, created_at, updated_at) VALUES (1, :userId, :role, :t, :t)", { userId, role, t: T0 });
          member(1, 'owner');
          expect(() => member(2, 'superuser')).toThrow(/CHECK constraint failed/);
          db.run('INSERT INTO space_people (space_id, user_id) VALUES (1, 1)');

          const invite = (o: { hash: string; spaceId: number | null; role: string | null; email?: string }) =>
            db.run(
              `INSERT INTO invitations (token_hash, space_id, email, email_key, role, invited_by, delivery, created_at, expires_at, last_sent_at)
               VALUES (:hash, :spaceId, :email, :email, :role, 1, 'link', :t, :t, :t)`,
              { ...o, email: o.email ?? 'bob@example.com', t: T0 },
            );
          expect(() => invite({ hash: 'h0', spaceId: 1, role: 'owner' })).toThrow(/CHECK constraint failed/);
          expect(() => invite({ hash: 'h0', spaceId: 1, role: null })).toThrow(/CHECK constraint failed/);
          expect(() => invite({ hash: 'h0', spaceId: null, role: 'member' })).toThrow(/CHECK constraint failed/);
          invite({ hash: 'h1', spaceId: 1, role: 'member' });
          invite({ hash: 'h2', spaceId: null, role: null });
          // One open invitation per space (or instance) and address.
          expect(() => invite({ hash: 'h3', spaceId: 1, role: 'viewer' })).toThrow(/UNIQUE constraint failed/);
          expect(() => invite({ hash: 'h3', spaceId: null, role: null })).toThrow(/UNIQUE constraint failed/);
          db.run("UPDATE invitations SET revoked_at = :t WHERE token_hash = 'h1'", { t: T0 });
          invite({ hash: 'h3', spaceId: 1, role: 'viewer' });

          db.run(
            "INSERT INTO sessions (token_hash, user_id, auth_method, reauth_at, created_at, last_seen_at, expires_at) VALUES ('s1', 1, 'password', :t, :t, :t, :t)",
            { t: T0 },
          );
          expect(() =>
            db.run(
              "INSERT INTO sessions (token_hash, user_id, auth_method, reauth_at, created_at, last_seen_at, expires_at) VALUES ('s2', 1, 'magic', :t, :t, :t, :t)",
              { t: T0 },
            ),
          ).toThrow(/CHECK constraint failed/);
          expect(db.all('PRAGMA foreign_key_check')).toEqual([]);
          // Deleting an account cascades to its sessions, memberships and space_people; its other traces are kept.
          db.run('DELETE FROM users WHERE id = 1');
          for (const table of ['sessions', 'memberships', 'space_people']) {
            expect(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)!.n, table).toBe(0);
          }
          expect(db.get('SELECT created_by FROM spaces')).toEqual({ created_by: null });
          expect(db.all('SELECT DISTINCT invited_by FROM invitations')).toEqual([{ invited_by: null }]);
        }));
    });

    describe('withDeferredForeignKeys', () => {
      it('defers foreign key checks to its end and leaves defer_foreign_keys at 0', () =>
        withDb((db) => {
          migrate(db, testSet(PARENT_CHILD), { appVersion: '1.0.0' });
          const result = withDeferredForeignKeys(db, () => {
            db.run('INSERT INTO child (id, parent_id) VALUES (1, 5)');
            db.run("INSERT INTO parent (id, name) VALUES (5, 'late parent')");
            return 'done';
          });
          expect(result).toBe('done');
          expect(db.get('PRAGMA defer_foreign_keys')).toEqual({ defer_foreign_keys: 0 });
          expect(db.all('SELECT id, parent_id FROM child')).toEqual([{ id: 1, parent_id: 5 }]);
          // Checks are immediate again.
          expect(() => db.run('INSERT INTO child (id, parent_id) VALUES (2, 77)')).toThrow(/FOREIGN KEY/);
        }));

      it('throws and rolls back on a violation left at its end, inside an outer transaction too', () =>
        withDb((db) => {
          migrate(db, testSet(PARENT_CHILD), { appVersion: '1.0.0' });
          db.tx(() => {
            db.run("INSERT INTO parent (id, name) VALUES (1, 'kept')");
            expect(() =>
              withDeferredForeignKeys(db, () => {
                db.run("INSERT INTO parent (id, name) VALUES (2, 'lost')");
                db.run('INSERT INTO child (id, parent_id) VALUES (1, 99)');
              }),
            ).toThrow('Deferred foreign key check failed: 1 violation(s)');
            expect(db.get('PRAGMA defer_foreign_keys')).toEqual({ defer_foreign_keys: 0 });
          });
          expect(db.all('SELECT id FROM parent')).toEqual([{ id: 1 }]);
          expect(db.all('SELECT id FROM child')).toEqual([]);
          expect(db.get('PRAGMA defer_foreign_keys')).toEqual({ defer_foreign_keys: 0 });
        }));

      it('can be used inside a migration', () =>
        withDb((db) => {
          const childFirst: Migration = {
            up: (d) => {
              d.exec('CREATE TABLE owner (id INTEGER PRIMARY KEY); CREATE TABLE pet (id INTEGER PRIMARY KEY, owner_id INTEGER NOT NULL REFERENCES owner(id))');
              withDeferredForeignKeys(d, () => {
                d.run('INSERT INTO pet (id, owner_id) VALUES (1, 1)');
                d.run('INSERT INTO owner (id) VALUES (1)');
              });
            },
          };
          expect(migrate(db, testSet(childFirst), { appVersion: '1.0.0' })).toEqual({ from: 0, to: 1 });
          expect(db.get('PRAGMA defer_foreign_keys')).toEqual({ defer_foreign_keys: 0 });
          expect(db.all('SELECT owner_id FROM pet')).toEqual([{ owner_id: 1 }]);
        }));
    });

    describe('where the adapters differ', () => {
      if (node) {
        it('NodeDb only: the strict checks refuse LIKE/GLOB with a bound or computed pattern', () =>
          withDb((db) => {
            db.exec("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('abc')");
            expect(db.all("SELECT v FROM t WHERE v LIKE 'a%' ESCAPE '\\' OR v GLOB 'a*'")).toEqual([{ v: 'abc' }]);
            expect(() => db.all('SELECT v FROM t WHERE v LIKE :p', { p: 'a%' })).toThrow(/LIKE or GLOB/);
            expect(() => db.all("SELECT v FROM t WHERE v LIKE '%' || :q", { q: 'b' })).toThrow(/LIKE or GLOB/);
            expect(() => db.all("SELECT v FROM t WHERE v NOT LIKE lower('A%')")).toThrow(/LIKE or GLOB/);
            expect(() => db.all('SELECT v FROM t WHERE v GLOB :p', { p: 'a*' })).toThrow(/LIKE or GLOB/);
          }));

        it('NodeDb only: there is no meter', async () => {
          expect(await withDb((db) => db.meter)).toBeUndefined();
        });

        it('NodeDb only: an integer beyond 2^53 - 1 throws when it is read (a DO rounds it)', () =>
          withDb((db) => {
            expect(db.get('SELECT 9007199254740991 AS x')).toEqual({ x: Number.MAX_SAFE_INTEGER });
            expect(() => db.get('SELECT 9007199254740993 AS x')).toThrow(RangeError);
          }));

        it('NodeDb only: migrate checks foreign keys itself (deferred through raw here)', () =>
          withDb((db) => {
            migrate(db, testSet(PARENT_CHILD), { appVersion: '1.0.0' });
            const raw = (db as unknown as { raw: { exec(sql: string): void } }).raw;
            const orphan: Migration = {
              up: (d) => {
                raw.exec('PRAGMA defer_foreign_keys = ON');
                d.run('INSERT INTO child (id, parent_id) VALUES (1, 99)');
              },
            };
            expect(() => migrate(db, testSet(PARENT_CHILD, orphan), { appVersion: '1.1.0' })).toThrow(
              'Migration 2 left 1 foreign key violation(s)',
            );
            expect(db.all('SELECT id FROM child')).toEqual([]);
            expect(db.get('PRAGMA defer_foreign_keys')).toEqual({ defer_foreign_keys: 0 });
          }));
      } else {
        it('Durable Object only: bound LIKE patterns over 50 bytes fail at run time (why NodeDb refuses them)', () =>
          withDb((db) => {
            expect(db.get("SELECT 'abc' LIKE :p AS m", { p: 'a%' })).toEqual({ m: 1 });
            expect(() => db.get("SELECT 'abc' LIKE :p AS m", { p: `${'a'.repeat(60)}%` })).toThrow(/pattern too complex/);
          }));

        it('Durable Object only: the meter adds up the rows each cursor read and wrote', () =>
          withDb((db) => {
            const meter = db.meter!;
            db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
            const before = { ...meter };
            db.run("INSERT INTO t (v) VALUES ('a'), ('b'), ('c')");
            expect(meter.rowsWritten - before.rowsWritten).toBeGreaterThanOrEqual(3);
            const read = meter.rowsRead;
            expect(db.all('SELECT v FROM t')).toHaveLength(3);
            expect(meter.rowsRead - read).toBeGreaterThanOrEqual(3);
            // exec() meters each of its statements, not only the last.
            const written = meter.rowsWritten;
            db.exec("INSERT INTO t (v) VALUES ('d'); INSERT INTO t (v) VALUES ('e'); INSERT INTO t (v) VALUES ('f')");
            expect(meter.rowsWritten - written).toBe(3);
          }));

        it('Durable Object only: an integer beyond 2^53 - 1 is rounded when it is read (NodeDb throws)', () =>
          withDb((db) => {
            expect(db.get('SELECT 9007199254740993 AS x')).toEqual({ x: 9007199254740992 });
          }));
      }
    });
  });
}
