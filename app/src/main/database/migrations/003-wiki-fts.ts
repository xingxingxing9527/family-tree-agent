export const wikiFtsMigration = {
  version: 3,
  name: "wiki full-text search",
  sql: String.raw`
    CREATE TABLE wiki_source (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      wiki_entry_id TEXT NOT NULL REFERENCES wiki_entry(id),
      source_id TEXT NOT NULL REFERENCES source(id),
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1)
    );
    CREATE UNIQUE INDEX wiki_source_active_uq
      ON wiki_source(workspace_id, wiki_entry_id, source_id) WHERE deleted_at IS NULL;

    CREATE VIRTUAL TABLE wiki_fts USING fts5(
      wiki_entry_id UNINDEXED,
      workspace_id UNINDEXED,
      title,
      body,
      tokenize = 'unicode61'
    );

    CREATE TRIGGER wiki_fts_after_insert AFTER INSERT ON wiki_entry
    WHEN new.deleted_at IS NULL BEGIN
      INSERT INTO wiki_fts (wiki_entry_id, workspace_id, title, body)
      VALUES (
        new.id,
        new.workspace_id,
        COALESCE((WITH RECURSIVE chars(i, character) AS (
          SELECT 1, substr(new.title, 1, 1)
          UNION ALL SELECT i + 1, substr(new.title, i + 1, 1) FROM chars WHERE i < length(new.title)
        ) SELECT group_concat(character, ' ') FROM chars), ''),
        COALESCE((WITH RECURSIVE chars(i, character) AS (
          SELECT 1, substr(new.content, 1, 1)
          UNION ALL SELECT i + 1, substr(new.content, i + 1, 1) FROM chars WHERE i < length(new.content)
        ) SELECT group_concat(character, ' ') FROM chars), '')
      );
    END;

    CREATE TRIGGER wiki_fts_after_update AFTER UPDATE OF title, content, deleted_at, workspace_id ON wiki_entry BEGIN
      DELETE FROM wiki_fts WHERE wiki_entry_id = old.id AND workspace_id = old.workspace_id;
      INSERT INTO wiki_fts (wiki_entry_id, workspace_id, title, body)
      SELECT
        new.id,
        new.workspace_id,
        COALESCE((WITH RECURSIVE chars(i, character) AS (
          SELECT 1, substr(new.title, 1, 1)
          UNION ALL SELECT i + 1, substr(new.title, i + 1, 1) FROM chars WHERE i < length(new.title)
        ) SELECT group_concat(character, ' ') FROM chars), ''),
        COALESCE((WITH RECURSIVE chars(i, character) AS (
          SELECT 1, substr(new.content, 1, 1)
          UNION ALL SELECT i + 1, substr(new.content, i + 1, 1) FROM chars WHERE i < length(new.content)
        ) SELECT group_concat(character, ' ') FROM chars), '')
      WHERE new.deleted_at IS NULL;
    END;

    CREATE TRIGGER wiki_fts_after_delete AFTER DELETE ON wiki_entry BEGIN
      DELETE FROM wiki_fts WHERE wiki_entry_id = old.id AND workspace_id = old.workspace_id;
    END;

    INSERT INTO wiki_fts (wiki_entry_id, workspace_id, title, body)
    SELECT
      id,
      workspace_id,
      COALESCE((WITH RECURSIVE chars(i, character) AS (
        SELECT 1, substr(title, 1, 1)
        UNION ALL SELECT i + 1, substr(title, i + 1, 1) FROM chars WHERE i < length(title)
      ) SELECT group_concat(character, ' ') FROM chars), ''),
      COALESCE((WITH RECURSIVE chars(i, character) AS (
        SELECT 1, substr(content, 1, 1)
        UNION ALL SELECT i + 1, substr(content, i + 1, 1) FROM chars WHERE i < length(content)
      ) SELECT group_concat(character, ' ') FROM chars), '')
    FROM wiki_entry WHERE deleted_at IS NULL;
  `
} as const;
