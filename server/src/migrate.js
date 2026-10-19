import { openDb, migrate } from "./db.js";

const db = openDb(process.env.DB_PATH || "./data/tracker.db");
const applied = migrate(db);
console.log(applied.length ? "applied: " + applied.join(", ") : "database is up to date");
db.close();
