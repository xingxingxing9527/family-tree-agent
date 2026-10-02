import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import type { PersonDetailReadModel, TreeProjectionDto, WorkspaceSnapshotDto } from "../../src/shared/contracts";
import { ensureFamily, openArea, rpc, stageAndConfirm } from "./helpers";

async function createPerson(request: APIRequestContext, displayName: string, gender: "male" | "female"): Promise<string> {
  const receipt = await stageAndConfirm(request, [{
    type: "person.create",
    draft: { displayName, aliases: [], gender, birth: null, death: null, notes: null, sourceDescription: "家谱快捷编辑 Web 验收" }
  }]);
  const id = receipt.changedEntityIds[0];
  if (!id) throw new Error(`Missing person id for ${displayName}`);
  return id;
}

async function clickFlowNode(page: Page, nodeId: string): Promise<void> {
  await page.locator(`.react-flow__node[data-id="${nodeId}"]`).click();
}

async function clickFlowEdge(page: Page, edgeId: string): Promise<void> {
  await page.getByTestId(`rf__edge-${edgeId}`).locator(".react-flow__edge-path").click({ force: true });
}

test("edits people, marriages and parent-child lines from the family tree", async ({ page, request }) => {
  const workspace = await ensureFamily(request);
  const suffix = Date.now().toString(36);
  const fatherName = `树编辑父亲-${suffix}`;
  const motherName = `树编辑母亲-${suffix}`;
  const replacementName = `树编辑更正配偶-${suffix}`;
  const childName = `树编辑孩子-${suffix}`;
  const fatherId = await createPerson(request, fatherName, "male");
  const motherId = await createPerson(request, motherName, "female");
  const replacementId = await createPerson(request, replacementName, "female");
  const childId = await createPerson(request, childName, "male");
  const marriageReceipt = await stageAndConfirm(request, [{
    type: "marriage.add",
    draft: { spouseAId: fatherId, spouseBId: motherId, status: "active", start: null, end: null, sourceDescription: "家谱快捷编辑婚姻" }
  }]);
  const marriageId = marriageReceipt.changedEntityIds[0]!;
  await stageAndConfirm(request, [{
    type: "parentFamily.add",
    knownParentId: fatherId,
    childId,
    parentRole: "father",
    completionPolicy: "spouse-default",
    sourceDescription: "家谱快捷编辑亲子"
  }]);

  const before = await rpc<TreeProjectionDto>(request, "query", "projectTree", { view: "full", viewpointId: fatherId });
  const marriageUnion = before.topology.nodes.find((node) => node.kind === "union" && node.marriageId === marriageId);
  const childEdge = before.topology.edges.find((edge) => edge.kind === "unionChild" && edge.marriageId === marriageId && edge.childId === childId);
  if (!marriageUnion || !childEdge) throw new Error("Missing marriage union or child edge in tree fixture");

  await openArea(page, workspace.id, "tree");
  const fatal = page.getByRole("heading", { name: "界面暂时无法显示" });
  const fatherNode = page.getByRole("group", { name: `人物：${fatherName}` });
  await expect(fatherNode.or(fatal)).toBeVisible();
  await expect(fatal).toBeHidden();
  await fatherNode.click();
  await expect(page.getByRole("complementary", { name: "人物与关系编辑" })).toBeVisible();
  await expect(page.getByRole("heading", { name: fatherName, exact: true })).toBeVisible();
  await page.getByRole("button", { name: "关闭人物与关系编辑" }).click();

  await clickFlowNode(page, marriageUnion.id);
  const marriageEditor = page.getByRole("region", { name: "婚姻关系", exact: true });
  await expect(marriageEditor).toBeVisible();
  await expect(marriageEditor).toContainText(fatherName);
  await expect(marriageEditor).toContainText(motherName);
  await page.getByRole("button", { name: "关闭人物与关系编辑" }).click();

  await clickFlowEdge(page, childEdge.id);
  await expect(page.getByRole("heading", { name: "亲子关系", exact: true })).toBeVisible();
  await expect(page.getByText(`当前孩子：${childName}`, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: `移除父亲 ${fatherName}`, exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: `移除母亲 ${motherName}`, exact: true })).toBeVisible();
  await page.getByRole("button", { name: "关闭人物与关系编辑" }).click();

  await clickFlowNode(page, marriageUnion.id);
  const spouseOne = page.getByLabel("配偶一", { exact: true });
  const motherSelect = await spouseOne.inputValue() === motherId ? spouseOne : page.getByLabel("配偶二", { exact: true });
  await motherSelect.selectOption(replacementId);
  await page.getByRole("button", { name: "预览婚姻更正", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "确认写入" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "确认写入", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(marriageEditor).toContainText(fatherName);
  await expect(marriageEditor).toContainText(replacementName);

  const corrected = await rpc<PersonDetailReadModel>(request, "people", "get", { personId: fatherId });
  expect(corrected.marriages.find(({ id }) => id === marriageId)?.spouse.id).toBe(replacementId);

  const after = await rpc<TreeProjectionDto>(request, "query", "projectTree", { view: "full", viewpointId: fatherId });
  const coParents = after.topology.nodes.find((node) => node.kind === "union" && node.display.kind === "coParents" && node.childIds.includes(childId));
  if (!coParents) throw new Error("Expected corrected family to retain a non-marriage co-parent union");
  await page.getByRole("button", { name: "关闭人物与关系编辑" }).click();
  await clickFlowNode(page, coParents.id);
  await expect(page.getByRole("heading", { name: "共同父母家庭", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "删除错误婚姻记录", exact: true })).toHaveCount(0);
});

test("switches among the four approved family-tree scopes without changing the kinship viewpoint", async ({ page, request }) => {
  const workspace = await ensureFamily(request);
  const suffix = Date.now().toString(36);
  const centerName = `范围中心-${suffix}`;
  const fatherName = `范围父亲-${suffix}`;
  const motherName = `范围母亲-${suffix}`;
  const halfSiblingName = `范围同父手足-${suffix}`;
  const halfSiblingMotherName = `范围同父手足母亲-${suffix}`;
  const spouseName = `范围配偶-${suffix}`;
  const childName = `范围孩子-${suffix}`;
  const outsiderName = `范围外人物-${suffix}`;
  const noPrimaryName = `未设主支系-${suffix}`;
  const centerId = await createPerson(request, centerName, "male");
  const fatherId = await createPerson(request, fatherName, "male");
  const motherId = await createPerson(request, motherName, "female");
  const halfSiblingId = await createPerson(request, halfSiblingName, "female");
  const halfSiblingMotherId = await createPerson(request, halfSiblingMotherName, "female");
  const spouseId = await createPerson(request, spouseName, "female");
  const childId = await createPerson(request, childName, "male");
  await createPerson(request, outsiderName, "female");
  const noPrimaryId = await createPerson(request, noPrimaryName, "male");

  await stageAndConfirm(request, [
    { type: "marriage.add", draft: { spouseAId: fatherId, spouseBId: motherId, status: "active", start: null, end: null, sourceDescription: "范围验收父母婚姻" } },
    { type: "marriage.add", draft: { spouseAId: centerId, spouseBId: spouseId, status: "active", start: null, end: null, sourceDescription: "范围验收中心婚姻" } },
    { type: "parentChild.add", draft: { parentId: fatherId, childId: centerId, parentRole: "father", sourceDescription: "范围验收亲子" } },
    { type: "parentChild.add", draft: { parentId: motherId, childId: centerId, parentRole: "mother", sourceDescription: "范围验收亲子" } },
    { type: "parentChild.add", draft: { parentId: fatherId, childId: halfSiblingId, parentRole: "father", sourceDescription: "范围验收同父手足" } },
    { type: "parentChild.add", draft: { parentId: halfSiblingMotherId, childId: halfSiblingId, parentRole: "mother", sourceDescription: "范围验收同父手足" } },
    { type: "parentChild.add", draft: { parentId: centerId, childId, parentRole: "father", sourceDescription: "范围验收亲子" } },
    { type: "parentChild.add", draft: { parentId: spouseId, childId, parentRole: "mother", sourceDescription: "范围验收亲子" } }
  ]);

  const mainLineageReceipt = await stageAndConfirm(request, [{
    type: "lineage.create",
    name: `范围本家-${suffix}`,
    founderPersonId: centerId,
    description: "四视图 Web 验收"
  }]);
  const mainLineageId = mainLineageReceipt.changedEntityIds[0]!;
  const noPrimaryLineageReceipt = await stageAndConfirm(request, [{
    type: "lineage.create",
    name: `待设置支系-${suffix}`,
    founderPersonId: noPrimaryId,
    description: null
  }]);
  const noPrimaryLineageId = noPrimaryLineageReceipt.changedEntityIds[0]!;
  let snapshot = await rpc<WorkspaceSnapshotDto>(request, "query", "workspaceSnapshot");
  const mainFounderMembership = snapshot.lineages.find(({ id }) => id === mainLineageId)!.memberships.find(({ personId }) => personId === centerId)!;
  await stageAndConfirm(request, [{
    type: "lineageMembership.update",
    membershipId: mainFounderMembership.id,
    expectedVersion: mainFounderMembership.rowVersion,
    patch: { isPrimary: true, generationMarker: "明" }
  }, {
    type: "lineageMembership.add",
    lineageId: mainLineageId,
    personId: childId,
    lineageRole: "blood",
    isPrimary: true,
    declaredGeneration: null,
    generationMarker: null
  }, {
    type: "lineageMembership.add",
    lineageId: mainLineageId,
    personId: fatherId,
    lineageRole: "associated",
    isPrimary: false,
    declaredGeneration: null,
    generationMarker: null
  }]);
  snapshot = await rpc<WorkspaceSnapshotDto>(request, "query", "workspaceSnapshot");
  expect(snapshot.lineages.find(({ id }) => id === noPrimaryLineageId)?.memberships.find(({ personId }) => personId === noPrimaryId)?.isPrimary).toBe(false);

  await openArea(page, workspace.id, "tree");
  await page.getByLabel("围绕谁查看", { exact: true }).selectOption(centerId);
  await page.getByLabel("当前视角", { exact: true }).selectOption(centerId);
  await expect(page.getByRole("button").filter({ hasText: /全谱|本家支系|核心亲属|子孙后代/u })).toHaveCount(4);

  const assertScopeIsInteractive = async (tabName: "全谱" | "本家支系" | "核心亲属" | "子孙后代"): Promise<void> => {
    await page.getByRole("button", { name: tabName, exact: true }).click();
    await expect(page.getByText(/结果基于当前已确认关系/u)).toBeVisible();
    const centerNode = page.getByRole("group", { name: `人物：${centerName}`, exact: true });
    await expect(centerNode).toBeVisible();
    await centerNode.click();
    await expect(page.getByRole("complementary", { name: "人物与关系编辑" })).toBeVisible();
    await page.getByRole("button", { name: "关闭人物与关系编辑" }).click();
    await expect(page.getByRole("group", { name: /家庭联合/u }).first()).toBeVisible();
  };

  await assertScopeIsInteractive("全谱");
  const lineageRequest = page.waitForRequest((requestEntry) => requestEntry.url().includes("/api/rpc/query/projectTree")
    && requestEntry.postDataJSON()?.input?.view === "lineage");
  await page.getByRole("button", { name: "本家支系", exact: true }).click();
  expect((await lineageRequest).postDataJSON()).toMatchObject({ input: {
    view: "lineage",
    subjectId: centerId,
    lineageId: mainLineageId
  } });
  await assertScopeIsInteractive("本家支系");
  await assertScopeIsInteractive("核心亲属");
  await expect(page.getByRole("group", { name: `人物：${outsiderName}`, exact: true })).toHaveCount(0);
  await assertScopeIsInteractive("子孙后代");

  await page.getByRole("button", { name: "核心亲属", exact: true }).click();
  await page.getByLabel("当前视角", { exact: true }).selectOption(childId);
  await expect(page.getByRole("group", { name: `人物：${centerName}`, exact: true })).toContainText("父亲");
  await expect(page.getByText(new RegExp(`正在显示${centerName}的父母、祖父母、兄弟姐妹、配偶和子女`, "u"))).toBeVisible();
  await expect(page.getByRole("button", { name: "核心亲属", exact: true })).toHaveAttribute("aria-pressed", "true");

  await page.getByLabel("围绕谁查看", { exact: true }).selectOption(noPrimaryId);
  await page.getByRole("button", { name: "本家支系", exact: true }).click();
  await expect(page.getByText(`尚未为 ${noPrimaryName} 设置主要本家支系`, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "前往设置本家支系", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/workspace/${workspace.id}/settings$`, "u"));
});
