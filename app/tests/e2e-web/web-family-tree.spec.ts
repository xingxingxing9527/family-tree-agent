import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import type { PersonDetailReadModel, TreeProjectionDto } from "../../src/shared/contracts";
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
