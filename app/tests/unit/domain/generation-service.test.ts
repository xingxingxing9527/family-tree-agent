import { describe, expect, it } from "vitest";
import { GenerationService } from "../../../src/main/domain/lineage/generation-service";
import { LineageService } from "../../../src/main/application/lineages/lineage-service";
import { applyMigrations } from "../../../src/main/database/migrations";
import { openDatabase } from "../../../src/main/database/open-database";
import { SqliteUnitOfWork } from "../../../src/main/database/unit-of-work";

describe("GenerationService", () => {
  it("computes the founder as generation 1 and increments each biological descendant", () => {
    const displays = new GenerationService().calculate({
      founderPersonId: "founder",
      memberships: [
        { personId: "founder", lineageRole: "blood", declaredGeneration: null },
        { personId: "child", lineageRole: "blood", declaredGeneration: null },
        { personId: "grandchild", lineageRole: "blood", declaredGeneration: null }
      ],
      parentChildFacts: [
        { parentId: "founder", childId: "child", relationshipType: "biological" },
        { parentId: "child", childId: "grandchild", relationshipType: "biological" }
      ]
    });

    expect(displays).toEqual({
      founder: { declared: null, computed: 1, displayed: 1, source: "computed", conflict: false },
      child: { declared: null, computed: 2, displayed: 2, source: "computed", conflict: false },
      grandchild: { declared: null, computed: 3, displayed: 3, source: "computed", conflict: false }
    });
  });

  it("does not assign computed blood generations to married-in or associated memberships", () => {
    const displays = new GenerationService().calculate({
      founderPersonId: "founder",
      memberships: [
        { personId: "founder", lineageRole: "blood", declaredGeneration: null },
        { personId: "spouse", lineageRole: "married_in", declaredGeneration: null },
        { personId: "associate", lineageRole: "associated", declaredGeneration: null }
      ],
      parentChildFacts: [
        { parentId: "founder", childId: "spouse", relationshipType: "biological" },
        { parentId: "spouse", childId: "associate", relationshipType: "biological" }
      ]
    });

    expect(displays.spouse).toEqual({ declared: null, computed: null, displayed: null, source: "none", conflict: false });
    expect(displays.associate).toEqual({ declared: null, computed: null, displayed: null, source: "none", conflict: false });
  });

  it("does not traverse through non-blood memberships to reach a blood member", () => {
    const displays = new GenerationService().calculate({
      founderPersonId: "founder",
      memberships: [
        { personId: "founder", lineageRole: "blood", declaredGeneration: null },
        { personId: "married-in", lineageRole: "married_in", declaredGeneration: null },
        { personId: "leaf", lineageRole: "blood", declaredGeneration: null }
      ],
      parentChildFacts: [
        { parentId: "founder", childId: "married-in", relationshipType: "biological" },
        { parentId: "married-in", childId: "leaf", relationshipType: "biological" }
      ]
    });

    expect(displays.leaf.computed).toBeNull();
  });

  it("shows the declared generation and flags a conflict when computation differs", () => {
    const displays = new GenerationService().calculate({
      founderPersonId: "founder",
      memberships: [
        { personId: "founder", lineageRole: "blood", declaredGeneration: 1 },
        { personId: "child", lineageRole: "blood", declaredGeneration: 5 }
      ],
      parentChildFacts: [
        { parentId: "founder", childId: "child", relationshipType: "biological" }
      ]
    });

    expect(displays.child).toEqual({
      declared: 5,
      computed: 2,
      displayed: 5,
      source: "declared",
      conflict: true
    });
  });

  it("keeps computation scoped independently to each lineage founder", () => {
    const service = new GenerationService();
    const parentChildFacts = [
      { parentId: "ancestor", childId: "middle", relationshipType: "biological" as const },
      { parentId: "middle", childId: "leaf", relationshipType: "biological" as const }
    ];

    const elderLineage = service.calculate({
      founderPersonId: "ancestor",
      memberships: [
        { personId: "ancestor", lineageRole: "blood", declaredGeneration: null },
        { personId: "middle", lineageRole: "blood", declaredGeneration: null },
        { personId: "leaf", lineageRole: "blood", declaredGeneration: null }
      ],
      parentChildFacts
    });
    const youngerLineage = service.calculate({
      founderPersonId: "middle",
      memberships: [
        { personId: "middle", lineageRole: "blood", declaredGeneration: null },
        { personId: "leaf", lineageRole: "blood", declaredGeneration: null }
      ],
      parentChildFacts
    });

    expect(elderLineage.leaf.computed).toBe(3);
    expect(youngerLineage.leaf.computed).toBe(2);
  });

  it("reads active lineage memberships and biological facts through the lineage application service", () => {
    const database = openDatabase(":memory:");
    applyMigrations(database);
    const unitOfWork = new SqliteUnitOfWork(database, "workspace-1");

    try {
      unitOfWork.run("lineage.fixture", (ctx) => {
        ctx.people.create(ctx, { id: "founder", displayName: "Founder", gender: "unknown" });
        ctx.people.create(ctx, { id: "child", displayName: "Child", gender: "unknown" });
        ctx.people.create(ctx, { id: "spouse", displayName: "Spouse", gender: "unknown" });
        ctx.lineages.create(ctx, { id: "lineage-a", name: "A branch", founderPersonId: "founder" });
        ctx.lineages.addMembership(ctx, { id: "membership-child", lineageId: "lineage-a", personId: "child", lineageRole: "blood", declaredGeneration: 4 });
        ctx.lineages.addMembership(ctx, { id: "membership-spouse", lineageId: "lineage-a", personId: "spouse", lineageRole: "married_in" });
        ctx.relations.createParentChild(ctx, { id: "founder-child", parentId: "founder", childId: "child", parentRole: "father" });
      });

      const displays = new LineageService(database, "workspace-1").generationDisplays("lineage-a");

      expect(displays.child).toEqual({ declared: 4, computed: 2, displayed: 4, source: "declared", conflict: true });
      expect(displays.founder).toEqual({ declared: null, computed: 1, displayed: 1, source: "computed", conflict: false });
      expect(displays.spouse).toEqual({ declared: null, computed: null, displayed: null, source: "none", conflict: false });
    } finally {
      database.close();
    }
  });

  it("rejects cross-workspace founders on create and update without partial transaction writes", () => {
    const database = openDatabase(":memory:");
    applyMigrations(database);
    const local = new SqliteUnitOfWork(database, "workspace-1");
    const foreign = new SqliteUnitOfWork(database, "workspace-2");

    try {
      local.run("person.fixture", (ctx) => ctx.people.create(ctx, { id: "local", displayName: "Local", gender: "unknown" }));
      foreign.run("person.fixture", (ctx) => ctx.people.create(ctx, { id: "foreign", displayName: "Foreign", gender: "unknown" }));
      local.run("lineage.fixture", (ctx) => ctx.lineages.create(ctx, { id: "local-lineage", name: "Local branch", founderPersonId: "local" }));

      const countsBefore = {
        lineages: database.prepare("SELECT COUNT(*) FROM lineage").pluck().get(),
        memberships: database.prepare("SELECT COUNT(*) FROM lineage_membership").pluck().get(),
        operations: database.prepare("SELECT COUNT(*) FROM operation_group").pluck().get(),
        audits: database.prepare("SELECT COUNT(*) FROM audit_log").pluck().get()
      };

      expect(() => local.run("lineage.cross-workspace.create", (ctx) => ctx.lineages.create(ctx, {
        id: "invalid-lineage",
        name: "Invalid branch",
        founderPersonId: "foreign"
      }))).toThrow("active person in workspace");
      expect(() => local.run("lineage.cross-workspace.update", (ctx) => ctx.lineages.update(ctx, "local-lineage", {
        founderPersonId: "foreign"
      }))).toThrow("active person in workspace");

      expect(database.prepare("SELECT COUNT(*) FROM lineage").pluck().get()).toBe(countsBefore.lineages);
      expect(database.prepare("SELECT COUNT(*) FROM lineage_membership").pluck().get()).toBe(countsBefore.memberships);
      expect(database.prepare("SELECT COUNT(*) FROM operation_group").pluck().get()).toBe(countsBefore.operations);
      expect(database.prepare("SELECT COUNT(*) FROM audit_log").pluck().get()).toBe(countsBefore.audits);
      expect(database.prepare("SELECT founder_person_id FROM lineage WHERE id = 'local-lineage'").pluck().get()).toBe("local");
    } finally {
      database.close();
    }
  });

  it("creates and preserves exactly one active blood membership for the current founder", () => {
    const database = openDatabase(":memory:");
    applyMigrations(database);
    const unitOfWork = new SqliteUnitOfWork(database, "workspace-1");

    try {
      unitOfWork.run("lineage.fixture", (ctx) => {
        ctx.people.create(ctx, { id: "first", displayName: "First", gender: "unknown" });
        ctx.people.create(ctx, { id: "replacement", displayName: "Replacement", gender: "unknown" });
        ctx.lineages.create(ctx, { id: "lineage-a", name: "A branch", founderPersonId: "first" });
        ctx.lineages.addMembership(ctx, { id: "replacement-membership", lineageId: "lineage-a", personId: "replacement", lineageRole: "married_in" });
      });

      expect(new LineageService(database, "workspace-1").generationDisplays("lineage-a").first).toEqual({
        declared: null,
        computed: 1,
        displayed: 1,
        source: "computed",
        conflict: false
      });

      unitOfWork.run("lineage.founder.update", (ctx) => ctx.lineages.update(ctx, "lineage-a", { founderPersonId: "replacement" }));
      const replacementMemberships = database.prepare("SELECT lineage_role FROM lineage_membership WHERE lineage_id = 'lineage-a' AND person_id = 'replacement' AND deleted_at IS NULL").pluck().all();
      expect(replacementMemberships).toEqual(["blood"]);
      expect(new LineageService(database, "workspace-1").generationDisplays("lineage-a").replacement.computed).toBe(1);
      expect(() => unitOfWork.run("lineage.founder.demote", (ctx) => ctx.lineages.updateMembership(ctx, "replacement-membership", {
        lineageRole: "married_in"
      }))).toThrow("founder blood membership");
      expect(() => unitOfWork.run("lineage.founder.archive", (ctx) => ctx.lineages.archiveMembership(ctx, "replacement-membership"))).toThrow("founder blood membership");
    } finally {
      database.close();
    }
  });
});
