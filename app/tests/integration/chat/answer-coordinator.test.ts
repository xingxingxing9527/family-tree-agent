import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnswerCoordinator } from "../../../src/main/application/chat/answer-coordinator";
import { FactCommandService } from "../../../src/main/application/facts/fact-command-service";
import { QueryToolRegistry } from "../../../src/main/application/query/query-tool-registry";
import { applyMigrations } from "../../../src/main/database/migrations";
import { openDatabase, type WorkspaceDatabase } from "../../../src/main/database/open-database";

const workspaceId = "workspace-answer-coordinator";
const source = (key: string) => ({ sourceKey: key, title: `来源 ${key}`, kind: "form" });
const solar = (year: number) => ({
  calendar: "solar" as const,
  year,
  month: 1,
  day: null,
  leapMonth: false,
  precision: "month" as const
});

describe("AnswerCoordinator", () => {
  let database: WorkspaceDatabase;
  let facts: FactCommandService;
  let model: { continueWithTools: ReturnType<typeof vi.fn>; extractDraft: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    database = openDatabase(":memory:");
    applyMigrations(database);
    facts = new FactCommandService(database, workspaceId);
    facts.execute({ type: "person.create", draft: { id: "viewpoint", workspaceId, displayName: "王明", gender: "male" }, source: source("viewpoint") });
    model = { extractDraft: vi.fn(), continueWithTools: vi.fn() };
  });

  afterEach(() => database.close());

  it("returns candidates instead of guessing when an exact name matches two people", async () => {
    facts.execute({ type: "person.create", draft: { id: "same-a", workspaceId, displayName: "张敏", gender: "female" }, source: source("same-a") });
    facts.execute({ type: "person.create", draft: { id: "same-b", workspaceId, displayName: "张敏", gender: "male" }, source: source("same-b") });
    const coordinator = new AnswerCoordinator(model, new QueryToolRegistry(database, workspaceId));

    const answer = await coordinator.ask({ question: "张敏有几个孩子？", viewpointId: "viewpoint", selectedPersonId: null });

    expect(answer).toMatchObject({
      status: "needs_disambiguation",
      viewpoint: { id: "viewpoint", displayName: "王明" },
      candidates: [{ id: "same-a", displayName: "张敏" }, { id: "same-b", displayName: "张敏" }]
    });
    expect(model.continueWithTools).not.toHaveBeenCalled();
  });

  it("returns insufficient instead of zero for an unconfirmed empty child list", async () => {
    facts.execute({ type: "person.create", draft: { id: "partial", workspaceId, displayName: "王强", gender: "male" }, source: source("partial") });
    const coordinator = new AnswerCoordinator(model, new QueryToolRegistry(database, workspaceId));

    const answer = await coordinator.ask({ question: "王强有几个孩子？", viewpointId: "viewpoint", selectedPersonId: "partial" });

    expect(answer.status).toBe("insufficient");
    expect(answer.conclusion).toContain("资料尚未确认完整");
    expect(answer.missingFacts).toEqual([expect.objectContaining({ code: "children_completeness", personId: "partial" })]);
    expect(model.continueWithTools).not.toHaveBeenCalled();
  });

  it("returns zero only after an administrator confirms child completeness", async () => {
    facts.execute({ type: "person.create", draft: { id: "complete", workspaceId, displayName: "王芳", gender: "female" }, source: source("complete") });
    facts.execute({ type: "person.childrenCompleteness.set", personId: "complete", complete: true, expectedVersion: 1, source: source("complete-check") });
    const coordinator = new AnswerCoordinator(model, new QueryToolRegistry(database, workspaceId));

    const answer = await coordinator.ask({ question: "王芳有几个孩子？", viewpointId: "viewpoint", selectedPersonId: "complete" });

    expect(answer).toMatchObject({ status: "answered", conclusion: expect.stringContaining("0 个"), candidates: [], missingFacts: [] });
    expect(answer.evidence).toEqual([expect.objectContaining({ title: "来源 complete" })]);
    expect(model.continueWithTools).not.toHaveBeenCalled();
  });

  it("turns an inspected relationship path into human-readable names", async () => {
    facts.execute({ type: "person.create", draft: { id: "daughter", workspaceId, displayName: "王芳", gender: "female" }, source: source("daughter") });
    facts.execute({ type: "parentChild.add", draft: { id: "viewpoint-daughter", workspaceId, parentId: "viewpoint", childId: "daughter", parentRole: "father" }, source: source("viewpoint-daughter") });
    model.continueWithTools
      .mockResolvedValueOnce({ answer: null, toolCalls: [{ callId: "relationship", name: "calculate_relationship", arguments: { viewpointId: "viewpoint", targetId: "daughter" } }] })
      .mockResolvedValueOnce({ answer: "王芳是你的女儿。", toolCalls: [] });
    const coordinator = new AnswerCoordinator(model, new QueryToolRegistry(database, workspaceId));

    const answer = await coordinator.ask({ question: "我和王芳是什么关系？", viewpointId: "viewpoint", selectedPersonId: "daughter" });

    expect(answer).toMatchObject({
      status: "answered",
      conclusion: "王芳是你的“女儿”。",
      relationshipPath: [{ personId: "viewpoint", displayName: "王明" }, { personId: "daughter", displayName: "王芳" }],
      evidence: [expect.objectContaining({ title: "来源 viewpoint-daughter" })]
    });
  });

  it("uses the approved Gongyi term for a direct call-form question", async () => {
    for (const person of [
      { id: "father", displayName: "父亲", gender: "male" as const, birth: solar(1980) },
      { id: "grandmother", displayName: "祖母", gender: "female" as const, birth: solar(1955) },
      { id: "great-grandfather", displayName: "曾外祖父", gender: "male" as const, birth: solar(1930) },
      { id: "grand-aunt", displayName: "李小梅", gender: "female" as const, birth: solar(1950) }
    ]) {
      facts.execute({ type: "person.create", draft: { ...person, workspaceId }, source: source(person.id) });
    }
    for (const relation of [
      { id: "father-viewpoint", parentId: "father", childId: "viewpoint", parentRole: "father" as const },
      { id: "grandmother-father", parentId: "grandmother", childId: "father", parentRole: "mother" as const },
      { id: "great-grandfather-grandmother", parentId: "great-grandfather", childId: "grandmother", parentRole: "father" as const },
      { id: "great-grandfather-grand-aunt", parentId: "great-grandfather", childId: "grand-aunt", parentRole: "father" as const }
    ]) {
      facts.execute({ type: "parentChild.add", draft: { ...relation, workspaceId }, source: source(relation.id) });
    }
    model.continueWithTools
      .mockResolvedValueOnce({ answer: null, toolCalls: [{ callId: "relationship", name: "calculate_relationship", arguments: { viewpointId: "viewpoint", targetId: "grand-aunt" } }] })
      .mockResolvedValueOnce({ answer: "模型原始回答不会覆盖确定性称谓。", toolCalls: [] });
    const coordinator = new AnswerCoordinator(model, new QueryToolRegistry(database, workspaceId));

    const answer = await coordinator.ask({ question: "我该怎么称呼李小梅？", viewpointId: "viewpoint", selectedPersonId: "grand-aunt" });

    expect(answer.conclusion).toBe("按巩义的常用叫法，李小梅是你的“姨奶奶”。正式称谓是“姨祖母”，她是你祖母的姐姐。");
    expect(answer.relationship).toMatchObject({
      formalTerm: "姨祖母",
      regionalTerm: "姨奶奶",
      displayTerm: "姨奶奶",
      pathDescription: "祖母的姐姐"
    });
  });

  it("keeps a broader multi-intent model answer while retaining the structured relationship", async () => {
    facts.execute({ type: "person.create", draft: { id: "daughter", workspaceId, displayName: "王芳", gender: "female" }, source: source("daughter") });
    facts.execute({ type: "parentChild.add", draft: { id: "viewpoint-daughter", workspaceId, parentId: "viewpoint", childId: "daughter", parentRole: "father" }, source: source("viewpoint-daughter") });
    model.continueWithTools
      .mockResolvedValueOnce({ answer: null, toolCalls: [{ callId: "relationship", name: "calculate_relationship", arguments: { viewpointId: "viewpoint", targetId: "daughter" } }] })
      .mockResolvedValueOnce({ answer: "王芳是你的女儿；她的其他资料请查看人物卡。", toolCalls: [] });
    const coordinator = new AnswerCoordinator(model, new QueryToolRegistry(database, workspaceId));

    const answer = await coordinator.ask({ question: "我和王芳是什么关系，也介绍一下她的资料。", viewpointId: "viewpoint", selectedPersonId: "daughter" });

    expect(answer.conclusion).toBe("王芳是你的女儿；她的其他资料请查看人物卡。");
    expect(answer.relationship).toMatchObject({ formalTerm: "女儿", displayTerm: "女儿" });
  });

  it("keeps conflicted direct relationships insufficient", async () => {
    facts.execute({ type: "person.create", draft: { id: "daughter", workspaceId, displayName: "王芳", gender: "female" }, source: source("daughter") });
    facts.execute({ type: "parentChild.add", draft: { id: "viewpoint-daughter", workspaceId, parentId: "viewpoint", childId: "daughter", parentRole: "father" }, source: source("viewpoint-daughter") });
    facts.execute({ type: "marriage.add", draft: { id: "conflict", workspaceId, spouseAId: "viewpoint", spouseBId: "daughter" }, source: source("conflict") });
    model.continueWithTools
      .mockResolvedValueOnce({ answer: null, toolCalls: [{ callId: "relationship", name: "calculate_relationship", arguments: { viewpointId: "viewpoint", targetId: "daughter" } }] })
      .mockResolvedValueOnce({ answer: "不应使用的模型回答", toolCalls: [] });
    const coordinator = new AnswerCoordinator(model, new QueryToolRegistry(database, workspaceId));

    const answer = await coordinator.ask({ question: "我该怎么称呼王芳？", viewpointId: "viewpoint", selectedPersonId: "daughter" });

    expect(answer.status).toBe("insufficient");
    expect(answer.relationship).toMatchObject({ formalTerm: null, regionalTerm: null, displayTerm: null });
  });
});
