import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyMigrations } from "../../../src/main/database/migrations";
import { openDatabase } from "../../../src/main/database/open-database";
import { SqliteUnitOfWork } from "../../../src/main/database/unit-of-work";

describe("UnitOfWork", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("rolls back the operation group, mutation, and audit as one transaction", async () => {
    const root = await mkdtemp(join(tmpdir(), "family-agent-transaction-"));
    roots.push(root);
    const database = openDatabase(join(root, "genealogy.sqlite"));
    applyMigrations(database);
    const unitOfWork = new SqliteUnitOfWork(database, "workspace-1");

    try {
      expect(() => unitOfWork.run("person.create", (ctx) => {
        ctx.people.create(ctx, {
          id: "11111111-1111-4111-8111-111111111111",
          displayName: "Rollback Person",
          gender: "unknown"
        });
        throw new Error("fail after audit insert");
      })).toThrow("fail after audit insert");

      for (const table of ["person", "operation_group", "audit_log"]) {
        expect(database.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get()).toBe(0);
      }

      unitOfWork.run("person.create", (ctx) => ctx.people.create(ctx, {
        id: "22222222-2222-4222-8222-222222222222",
        displayName: "Committed Person",
        gender: "female"
      }));

      expect(database.prepare("SELECT COUNT(*) FROM person").pluck().get()).toBe(1);
      expect(database.prepare("SELECT COUNT(*) FROM operation_group").pluck().get()).toBe(1);
      expect(database.prepare("SELECT COUNT(*) FROM audit_log").pluck().get()).toBe(1);
    } finally {
      database.close();
    }
  });

  it("increments row versions, records before and after JSON, and hides archived rows", async () => {
    const root = await mkdtemp(join(tmpdir(), "family-agent-transaction-"));
    roots.push(root);
    const database = openDatabase(join(root, "genealogy.sqlite"));
    applyMigrations(database);
    const unitOfWork = new SqliteUnitOfWork(database, "workspace-1");
    const id = "33333333-3333-4333-8333-333333333333";

    try {
      unitOfWork.run("person.create", (ctx) => ctx.people.create(ctx, { id, displayName: "Before", gender: "unknown" }));
      const updated = unitOfWork.run("person.update", (ctx) => ctx.people.update(ctx, id, { displayName: "After" }));
      expect(updated.rowVersion).toBe(2);
      const archived = unitOfWork.run("person.archive", (ctx) => ctx.people.archive(ctx, id));
      expect(archived.rowVersion).toBe(3);

      const visible = unitOfWork.run("person.read", (ctx) => ctx.people.get(id));
      const withArchived = unitOfWork.run("person.read", (ctx) => ctx.people.get(id, { includeArchived: true }));
      expect(visible).toBeNull();
      expect(withArchived?.deletedAt).not.toBeNull();
      const updateAudit = database.prepare("SELECT before_json, after_json FROM audit_log WHERE action = 'update'").get() as { before_json: string; after_json: string };
      expect(JSON.parse(updateAudit.before_json)).toMatchObject({ displayName: "Before", rowVersion: 1 });
      expect(JSON.parse(updateAudit.after_json)).toMatchObject({ displayName: "After", rowVersion: 2 });
      expect(() => database.prepare("DELETE FROM audit_log").run()).toThrow("audit_log is append-only");
    } finally {
      database.close();
    }
  });

  it("audits aliases and permits reusing an alias only after archival", async () => {
    const root = await mkdtemp(join(tmpdir(), "family-agent-transaction-"));
    roots.push(root);
    const database = openDatabase(join(root, "genealogy.sqlite"));
    applyMigrations(database);
    const unitOfWork = new SqliteUnitOfWork(database, "workspace-1");
    const personId = "44444444-4444-4444-8444-444444444444";

    try {
      unitOfWork.run("person.create", (ctx) => ctx.people.create(ctx, { id: personId, displayName: "Alias Owner", gender: "unknown" }));
      const alias = unitOfWork.run("person.alias.create", (ctx) => ctx.people.addAlias(ctx, { id: "alias-1", personId, name: "  Other Name  " }));
      expect(alias).toMatchObject({ name: "Other Name", normalizedName: "other name", rowVersion: 1 });
      expect(() => unitOfWork.run("person.alias.create", (ctx) => ctx.people.addAlias(ctx, { personId, name: "OTHER NAME" }))).toThrow();
      const archived = unitOfWork.run("person.alias.archive", (ctx) => ctx.people.archiveAlias(ctx, alias.id));
      expect(archived.rowVersion).toBe(2);
      expect(unitOfWork.run("person.alias.create", (ctx) => ctx.people.addAlias(ctx, { personId, name: "Other Name" }))).toMatchObject({ normalizedName: "other name" });
      expect(database.prepare("SELECT COUNT(*) FROM audit_log WHERE entity_type = 'person_alias'").pluck().get()).toBe(3);
    } finally {
      database.close();
    }
  });

  it("rejects invalid persisted partial dates and rolls back their operation groups", async () => {
    const root = await mkdtemp(join(tmpdir(), "family-agent-transaction-"));
    roots.push(root);
    const database = openDatabase(join(root, "genealogy.sqlite"));
    applyMigrations(database);
    const unitOfWork = new SqliteUnitOfWork(database, "workspace-1");
    const firstId = "55555555-5555-4555-8555-555555555555";
    const secondId = "66666666-6666-4666-8666-666666666666";

    try {
      unitOfWork.run("person.create", (ctx) => ctx.people.create(ctx, { id: firstId, displayName: "First", gender: "unknown" }));
      unitOfWork.run("person.create", (ctx) => ctx.people.create(ctx, { id: secondId, displayName: "Second", gender: "unknown" }));

      expect(() => unitOfWork.run("person.update", (ctx) => ctx.people.update(ctx, firstId, {
        death: { calendar: "solar", year: 2024, month: 2, day: 30, leapMonth: false, precision: "day" }
      }))).toThrow("Invalid solar calendar day");
      expect(() => unitOfWork.run("person.create", (ctx) => ctx.people.create(ctx, {
        displayName: "Invalid birth", gender: "unknown",
        birth: { calendar: "solar", year: 2024, month: 2, day: 1, leapMonth: true, precision: "day" }
      }))).toThrow("Solar dates cannot use leap months");
      expect(() => unitOfWork.run("marriage.create", (ctx) => ctx.relations.createMarriage(ctx, {
        spouseAId: firstId, spouseBId: secondId,
        start: { calendar: "lunar", year: 2024, month: 13, day: null, leapMonth: false, precision: "month" }
      }))).toThrow();
      expect(() => unitOfWork.run("marriage.create", (ctx) => ctx.relations.createMarriage(ctx, {
        spouseAId: firstId, spouseBId: secondId,
        end: { calendar: "lunar", year: 0, month: 1, day: null, leapMonth: false, precision: "month" }
      }))).toThrow();

      expect(database.prepare("SELECT row_version, death_calendar FROM person WHERE id = ?").get(firstId)).toEqual({ row_version: 1, death_calendar: null });
      expect(database.prepare("SELECT COUNT(*) FROM person").pluck().get()).toBe(2);
      expect(database.prepare("SELECT COUNT(*) FROM marriage").pluck().get()).toBe(0);
      expect(database.prepare("SELECT COUNT(*) FROM operation_group").pluck().get()).toBe(2);
      expect(database.prepare("SELECT COUNT(*) FROM audit_log").pluck().get()).toBe(2);
    } finally {
      database.close();
    }
  });

  it("allows an active remarriage after divorce but rejects concurrent active duplicates", async () => {
    const root = await mkdtemp(join(tmpdir(), "family-agent-transaction-"));
    roots.push(root);
    const database = openDatabase(join(root, "genealogy.sqlite"));
    applyMigrations(database);
    const unitOfWork = new SqliteUnitOfWork(database, "workspace-1");
    const firstId = "77777777-7777-4777-8777-777777777777";
    const secondId = "88888888-8888-4888-8888-888888888888";

    try {
      unitOfWork.run("person.create", (ctx) => ctx.people.create(ctx, { id: firstId, displayName: "First", gender: "unknown" }));
      unitOfWork.run("person.create", (ctx) => ctx.people.create(ctx, { id: secondId, displayName: "Second", gender: "unknown" }));
      const historical = unitOfWork.run("marriage.create", (ctx) => ctx.relations.createMarriage(ctx, { spouseAId: secondId, spouseBId: firstId, status: "divorced" }));
      const active = unitOfWork.run("marriage.create", (ctx) => ctx.relations.createMarriage(ctx, { spouseAId: firstId, spouseBId: secondId }));

      expect(historical).toMatchObject({ spouseAId: firstId, spouseBId: secondId, status: "divorced" });
      expect(active).toMatchObject({ spouseAId: firstId, spouseBId: secondId, status: "active" });
      expect(() => unitOfWork.run("marriage.create", (ctx) => ctx.relations.createMarriage(ctx, { spouseAId: secondId, spouseBId: firstId }))).toThrow();
      expect(database.prepare("SELECT marriage_status FROM marriage ORDER BY marriage_status").pluck().all()).toEqual(["active", "divorced"]);
      expect(database.prepare("SELECT COUNT(*) FROM operation_group").pluck().get()).toBe(4);
      expect(database.prepare("SELECT COUNT(*) FROM audit_log").pluck().get()).toBe(4);
    } finally {
      database.close();
    }
  });
});
