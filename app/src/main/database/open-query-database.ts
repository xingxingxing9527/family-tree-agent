import Database from "better-sqlite3";
import type { WorkspaceDatabase } from "./open-database.js";

/** Open an existing workspace database for queries without enabling WAL or any write path. */
export function openQueryDatabase(file: string): WorkspaceDatabase {
  const database = new Database(file, { readonly: true, fileMustExist: true });
  try {
    database.pragma("foreign_keys = ON");
    database.pragma("query_only = ON");
    database.pragma("busy_timeout = 5000");
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}
