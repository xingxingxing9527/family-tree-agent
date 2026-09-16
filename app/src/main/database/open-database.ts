import Database from "better-sqlite3";

export type WorkspaceDatabase = Database.Database;

export function openDatabase(file: string): WorkspaceDatabase {
  const database = new Database(file);
  try {
    database.pragma("foreign_keys = ON");
    database.pragma("journal_mode = WAL");
    database.pragma("busy_timeout = 5000");
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}
