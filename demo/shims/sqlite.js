// node:sqlite DatabaseSync API on top of sql.js (SQLite compiled to WebAssembly).
let SQL = null;
export const setSqlJs = (module) => { SQL = module; };

const norm = (params) => params.map((p) => (p === undefined ? null : p));

class Statement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
  }
  run(...params) {
    const st = this.db.prepare(this.sql);
    st.run(norm(params));
    st.free();
    const changes = this.db.getRowsModified();
    const lastInsertRowid = this.db.exec('SELECT last_insert_rowid()')[0].values[0][0];
    return { changes, lastInsertRowid };
  }
  get(...params) {
    const st = this.db.prepare(this.sql);
    st.bind(norm(params));
    const row = st.step() ? st.getAsObject() : undefined;
    st.free();
    return row;
  }
  all(...params) {
    const st = this.db.prepare(this.sql);
    st.bind(norm(params));
    const rows = [];
    while (st.step()) rows.push(st.getAsObject());
    st.free();
    return rows;
  }
}

export class DatabaseSync {
  constructor() {
    if (!SQL) throw new Error('sql.js is not loaded');
    this.db = new SQL.Database();
  }
  exec(sql) { this.db.exec(sql); }
  prepare(sql) { return new Statement(this.db, sql); }
  close() { this.db.close(); }
}
