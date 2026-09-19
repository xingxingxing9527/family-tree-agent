export const initialSchemaMigration = {
  version: 1,
  name: "initial schema",
  sql: String.raw`
    CREATE TABLE workspace_meta (
      workspace_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      origin_person_id TEXT REFERENCES person(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1)
    );

    CREATE TABLE source (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      source_key TEXT NOT NULL,
      title TEXT NOT NULL,
      kind TEXT,
      uri TEXT,
      citation TEXT,
      notes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1)
    );

    CREATE UNIQUE INDEX source_active_key_uq
      ON source(workspace_id, source_key) WHERE deleted_at IS NULL;

    CREATE TABLE operation_group (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1)
    );

    CREATE TABLE person (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      gender TEXT NOT NULL CHECK (gender IN ('male','female','unknown')),
      birth_calendar TEXT,
      birth_year INTEGER,
      birth_month INTEGER,
      birth_day INTEGER,
      birth_leap_month INTEGER NOT NULL DEFAULT 0 CHECK (birth_leap_month IN (0,1)),
      birth_precision TEXT CHECK (birth_precision IN ('month','day')),
      death_calendar TEXT,
      death_year INTEGER,
      death_month INTEGER,
      death_day INTEGER,
      death_leap_month INTEGER NOT NULL DEFAULT 0 CHECK (death_leap_month IN (0,1)),
      death_precision TEXT CHECK (death_precision IN ('month','day')),
      notes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
      CHECK (
        (birth_calendar IS NULL AND birth_year IS NULL AND birth_month IS NULL AND birth_day IS NULL AND birth_precision IS NULL AND birth_leap_month = 0)
        OR
        (birth_calendar IS NOT NULL AND birth_year IS NOT NULL AND birth_month IS NOT NULL AND birth_precision IS NOT NULL)
      ),
      CHECK (
        (death_calendar IS NULL AND death_year IS NULL AND death_month IS NULL AND death_day IS NULL AND death_precision IS NULL AND death_leap_month = 0)
        OR
        (death_calendar IS NOT NULL AND death_year IS NOT NULL AND death_month IS NOT NULL AND death_precision IS NOT NULL)
      )
    );

    CREATE TABLE person_alias (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      person_id TEXT NOT NULL REFERENCES person(id),
      name TEXT NOT NULL,
      normalized_name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1)
    );

    CREATE UNIQUE INDEX person_alias_active_uq
      ON person_alias(workspace_id, person_id, normalized_name) WHERE deleted_at IS NULL;

    CREATE TABLE lineage (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      name TEXT NOT NULL,
      founder_person_id TEXT NOT NULL REFERENCES person(id),
      description TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1)
    );

    CREATE TABLE lineage_membership (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      lineage_id TEXT NOT NULL REFERENCES lineage(id),
      person_id TEXT NOT NULL REFERENCES person(id),
      lineage_role TEXT NOT NULL CHECK (lineage_role IN ('blood','married_in','associated')),
      is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0,1)),
      declared_generation INTEGER CHECK (declared_generation IS NULL OR declared_generation >= 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1)
    );

    CREATE UNIQUE INDEX lineage_membership_active_uq
      ON lineage_membership(workspace_id, lineage_id, person_id) WHERE deleted_at IS NULL;
    CREATE UNIQUE INDEX lineage_membership_primary_uq
      ON lineage_membership(workspace_id, person_id) WHERE is_primary = 1 AND deleted_at IS NULL;

    CREATE TABLE parent_child (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      parent_id TEXT NOT NULL REFERENCES person(id),
      child_id TEXT NOT NULL REFERENCES person(id),
      parent_role TEXT NOT NULL CHECK (parent_role IN ('father','mother')),
      relationship_type TEXT NOT NULL DEFAULT 'biological' CHECK (relationship_type = 'biological'),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
      CHECK (parent_id <> child_id)
    );

    CREATE UNIQUE INDEX parent_child_active_pair_uq
      ON parent_child(workspace_id, parent_id, child_id) WHERE deleted_at IS NULL;
    CREATE UNIQUE INDEX parent_child_active_father_uq
      ON parent_child(workspace_id, child_id) WHERE parent_role = 'father' AND relationship_type = 'biological' AND deleted_at IS NULL;
    CREATE UNIQUE INDEX parent_child_active_mother_uq
      ON parent_child(workspace_id, child_id) WHERE parent_role = 'mother' AND relationship_type = 'biological' AND deleted_at IS NULL;

    CREATE TABLE marriage (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      spouse_a_id TEXT NOT NULL REFERENCES person(id),
      spouse_b_id TEXT NOT NULL REFERENCES person(id),
      marriage_status TEXT NOT NULL DEFAULT 'active' CHECK (marriage_status IN ('active','divorced')),
      start_calendar TEXT,
      start_year INTEGER,
      start_month INTEGER,
      start_day INTEGER,
      start_leap_month INTEGER NOT NULL DEFAULT 0 CHECK (start_leap_month IN (0,1)),
      start_precision TEXT CHECK (start_precision IN ('month','day')),
      end_calendar TEXT,
      end_year INTEGER,
      end_month INTEGER,
      end_day INTEGER,
      end_leap_month INTEGER NOT NULL DEFAULT 0 CHECK (end_leap_month IN (0,1)),
      end_precision TEXT CHECK (end_precision IN ('month','day')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
      CHECK (spouse_a_id <> spouse_b_id),
      CHECK (spouse_a_id < spouse_b_id),
      CHECK (
        (start_calendar IS NULL AND start_year IS NULL AND start_month IS NULL AND start_day IS NULL AND start_precision IS NULL AND start_leap_month = 0)
        OR
        (start_calendar IS NOT NULL AND start_year IS NOT NULL AND start_month IS NOT NULL AND start_precision IS NOT NULL)
      ),
      CHECK (
        (end_calendar IS NULL AND end_year IS NULL AND end_month IS NULL AND end_day IS NULL AND end_precision IS NULL AND end_leap_month = 0)
        OR
        (end_calendar IS NOT NULL AND end_year IS NOT NULL AND end_month IS NOT NULL AND end_precision IS NOT NULL)
      )
    );

    CREATE UNIQUE INDEX marriage_active_pair_uq
      ON marriage(workspace_id, spouse_a_id, spouse_b_id)
      WHERE marriage_status = 'active' AND deleted_at IS NULL;

    CREATE TABLE import_identity (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      source_id TEXT REFERENCES source(id),
      source_key TEXT NOT NULL,
      external_person_id TEXT NOT NULL,
      person_id TEXT NOT NULL REFERENCES person(id),
      raw_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
      UNIQUE (workspace_id, source_key, external_person_id)
    );

    CREATE TABLE merge_record (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      survivor_person_id TEXT NOT NULL REFERENCES person(id),
      merged_person_id TEXT NOT NULL REFERENCES person(id),
      operation_group_id TEXT NOT NULL REFERENCES operation_group(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
      CHECK (survivor_person_id <> merged_person_id)
    );

    CREATE TABLE id_redirect (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      old_person_id TEXT NOT NULL,
      new_person_id TEXT NOT NULL REFERENCES person(id),
      merge_record_id TEXT NOT NULL REFERENCES merge_record(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
      UNIQUE (workspace_id, old_person_id),
      CHECK (old_person_id <> new_person_id)
    );

    CREATE TABLE media_asset (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
      relative_path TEXT NOT NULL,
      metadata_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1)
    );

    CREATE UNIQUE INDEX media_asset_active_hash_uq
      ON media_asset(workspace_id, sha256) WHERE deleted_at IS NULL;

    CREATE TABLE media_person (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      media_asset_id TEXT NOT NULL REFERENCES media_asset(id),
      person_id TEXT NOT NULL REFERENCES person(id),
      caption TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1)
    );

    CREATE UNIQUE INDEX media_person_active_uq
      ON media_person(workspace_id, media_asset_id, person_id) WHERE deleted_at IS NULL;

    CREATE TABLE wiki_entry (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      slug TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1)
    );

    CREATE UNIQUE INDEX wiki_entry_active_slug_uq
      ON wiki_entry(workspace_id, slug) WHERE deleted_at IS NULL;

    CREATE TABLE wiki_person (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      wiki_entry_id TEXT NOT NULL REFERENCES wiki_entry(id),
      person_id TEXT NOT NULL REFERENCES person(id),
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1)
    );

    CREATE UNIQUE INDEX wiki_person_active_uq
      ON wiki_person(workspace_id, wiki_entry_id, person_id) WHERE deleted_at IS NULL;

    CREATE TABLE audit_log (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      operation_group_id TEXT NOT NULL REFERENCES operation_group(id),
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      action TEXT NOT NULL,
      before_json TEXT,
      after_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1)
    );

    CREATE INDEX audit_log_operation_group_idx ON audit_log(workspace_id, operation_group_id);
    CREATE INDEX audit_log_entity_idx ON audit_log(workspace_id, entity_type, entity_id);

    CREATE TRIGGER audit_log_no_update
      BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
    CREATE TRIGGER audit_log_no_delete
      BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
  `
} as const;
