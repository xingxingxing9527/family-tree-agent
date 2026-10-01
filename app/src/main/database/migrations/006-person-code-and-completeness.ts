export const personCodeAndCompletenessMigration = {
  version: 6,
  name: "person code and children completeness",
  sql: String.raw`
    ALTER TABLE person ADD COLUMN person_code TEXT;
    ALTER TABLE person ADD COLUMN children_complete INTEGER NOT NULL DEFAULT 0 CHECK (children_complete IN (0,1));

    WITH ranked AS (
      SELECT id, workspace_id,
        ROW_NUMBER() OVER (PARTITION BY workspace_id ORDER BY created_at, id) AS sequence
      FROM person
    )
    UPDATE person
    SET person_code = (
      SELECT printf('P%06d', ranked.sequence)
      FROM ranked
      WHERE ranked.id = person.id AND ranked.workspace_id = person.workspace_id
    );

    CREATE UNIQUE INDEX person_workspace_code_uq ON person(workspace_id, person_code);

    CREATE TABLE person_code_counter (
      workspace_id TEXT PRIMARY KEY,
      last_value INTEGER NOT NULL CHECK (last_value >= 0 AND last_value <= 999999)
    );

    INSERT INTO person_code_counter (workspace_id, last_value)
    SELECT workspace_id, MAX(CAST(substr(person_code, 2) AS INTEGER))
    FROM person
    GROUP BY workspace_id;

    CREATE TRIGGER person_code_after_insert
      AFTER INSERT ON person
      WHEN NEW.person_code IS NULL
      BEGIN
        INSERT INTO person_code_counter (workspace_id, last_value)
        VALUES (NEW.workspace_id, 0)
        ON CONFLICT(workspace_id) DO NOTHING;
        UPDATE person_code_counter
        SET last_value = last_value + 1
        WHERE workspace_id = NEW.workspace_id;
        UPDATE person
        SET person_code = printf('P%06d', (
          SELECT last_value FROM person_code_counter WHERE workspace_id = NEW.workspace_id
        ))
        WHERE id = NEW.id AND workspace_id = NEW.workspace_id;
      END;

    CREATE TRIGGER person_code_immutable
      BEFORE UPDATE OF person_code ON person
      WHEN OLD.person_code IS NOT NULL AND OLD.person_code IS NOT NEW.person_code
      BEGIN
        SELECT RAISE(ABORT, 'person_code is immutable');
      END;
  `
} as const;
