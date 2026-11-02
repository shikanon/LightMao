import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** A small owner-scoped repository. Cloud and local daemon use separate databases. */
export class Store {
  db: DatabaseSync;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL, id TEXT NOT NULL, owner TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(kind,id));
      CREATE INDEX IF NOT EXISTS records_owner ON records(kind,owner);`);
  }
  get<T>(kind: string, id: string, owner?: string): T | undefined {
    const row = (
      owner === undefined
        ? this.db.prepare('SELECT data FROM records WHERE kind=? AND id=?').get(kind, id)
        : this.db
            .prepare('SELECT data FROM records WHERE kind=? AND id=? AND owner=?')
            .get(kind, id, owner)
    ) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }
  list<T>(kind: string, owner?: string): T[] {
    const rows = (
      owner === undefined
        ? this.db.prepare('SELECT data FROM records WHERE kind=? ORDER BY rowid').all(kind)
        : this.db
            .prepare('SELECT data FROM records WHERE kind=? AND owner=? ORDER BY rowid')
            .all(kind, owner)
    ) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data));
  }
  put<T extends { id: string }>(kind: string, owner: string, value: T): T {
    this.db
      .prepare(
        'INSERT INTO records(kind,id,owner,data) VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data WHERE records.owner=excluded.owner',
      )
      .run(kind, value.id, owner, JSON.stringify(value));
    return value;
  }
  remove(kind: string, id: string, owner: string) {
    this.db.prepare('DELETE FROM records WHERE kind=? AND id=? AND owner=?').run(kind, id, owner);
  }
  close() {
    this.db.close();
  }
}
