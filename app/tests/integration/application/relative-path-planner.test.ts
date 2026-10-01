import { beforeEach, describe, expect, it } from "vitest";
import { FactCommandService } from "../../../src/main/application/facts/fact-command-service";
import { RelativePathPlanner } from "../../../src/main/application/facts/relative-path-planner";
import { applyMigrations } from "../../../src/main/database/migrations";
import { openDatabase, type WorkspaceDatabase } from "../../../src/main/database/open-database";

const workspaceId = "workspace-relative-planner";
const source = (key: string) => ({ sourceKey: key, title: key, kind: "test" });

describe("RelativePathPlanner", () => {
  let database: WorkspaceDatabase;
  let facts: FactCommandService;

  beforeEach(() => {
    database = openDatabase(":memory:");
    applyMigrations(database);
    facts = new FactCommandService(database, workspaceId);
  });

  const person = (id: string, displayName: string, gender: "male" | "female" | "unknown") => {
    facts.execute({ type: "person.create", draft: { id, workspaceId, displayName, gender }, source: source(id) });
  };
  const parentChild = (parentId: string, childId: string, parentRole: "father" | "mother") => {
    facts.execute({ type: "parentChild.add", draft: { workspaceId, parentId, childId, parentRole }, source: source(`${parentId}-${childId}`) }, { confirmWarnings: true });
  };

  it("plans an uncle only through existing and proposed parent-child edges", () => {
    person("anchor", "王小明", "male");
    person("parent", "王建国", "male");
    person("grandparent", "王守义", "male");
    person("target", "王建军", "male");
    parentChild("parent", "anchor", "father");
    parentChild("grandparent", "parent", "father");

    const plan = new RelativePathPlanner(database, workspaceId).plan({
      anchorId: "anchor", targetId: "target", templateId: "uncle", selectedIntermediaryIds: {}
    });

    expect(plan.requiredSelections).toEqual([]);
    expect(plan.resultingPath.personIds).toEqual(["anchor", "parent", "grandparent", "target"]);
    expect(plan.intents).toEqual([expect.objectContaining({
      type: "parentChild.add",
      draft: expect.objectContaining({ parentId: "grandparent", childId: "target", parentRole: "father" })
    })]);
    expect(plan.intents.every((intent) => intent.type === "parentChild.add")).toBe(true);
    expect(JSON.stringify(plan.intents)).not.toContain("叔叔");
  });

  it("requires an explicit existing intermediary when the path is missing", () => {
    person("anchor", "王小明", "male");
    person("target", "王守义", "male");
    person("candidate", "王建国", "male");

    const plan = new RelativePathPlanner(database, workspaceId).plan({
      anchorId: "anchor", targetId: "target", templateId: "grandparent", selectedIntermediaryIds: {}
    });

    expect(plan.intents).toEqual([]);
    expect(plan.requiredSelections).toContainEqual(expect.objectContaining({ role: "parent", candidateIds: ["candidate"] }));
  });

  it("requires a choice instead of guessing when several parents fit", () => {
    person("anchor", "王小明", "male");
    person("father", "王建国", "male");
    person("mother", "赵秀兰", "female");
    person("target", "王守义", "male");
    parentChild("father", "anchor", "father");
    parentChild("mother", "anchor", "mother");

    const plan = new RelativePathPlanner(database, workspaceId).plan({
      anchorId: "anchor", targetId: "target", templateId: "grandparent", selectedIntermediaryIds: {}
    });

    expect(plan.requiredSelections).toContainEqual(expect.objectContaining({ role: "parent", candidateIds: ["father", "mother"] }));
  });
});
