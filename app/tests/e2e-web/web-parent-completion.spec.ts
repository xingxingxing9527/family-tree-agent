import { createHash } from "node:crypto";
import { expect, test, type APIRequestContext, type Page, type TestInfo } from "@playwright/test";
import { suiteBaselinePersonName } from "./global-setup";
import { ensureFamily, openArea, rpc, stageAndConfirm } from "./helpers";

interface Workspace { id: string; name: string }
interface Result<T> { ok: boolean; value?: T; error?: { message: string } }
interface BackupCounts {
  people: number;
  parentChild: number;
  marriages: number;
  wikiEntries: number;
  auditRows: number;
  mediaAssets: number;
}
interface BackupInspection {
  restoreToken: string;
  targetWorkspaceId: string;
  verified: true;
  manifest: { workspaceId: string; counts: BackupCounts };
}
interface PartialDate {
  calendar: "solar" | "lunar";
  year: number;
  month: number;
  day: number | null;
  leapMonth: boolean;
  precision: "month" | "day";
}
interface RelativeRow {
  relationId: string;
  kind: "parent" | "child" | "spouse";
  person: { id: string; displayName: string };
  parentRole: "father" | "mother" | null;
  originKind?: "explicit" | "spouse_default";
  inferredFromMarriageId?: string | null;
}
interface WorkspaceSnapshot {
  workspaceId: string;
  people: Array<{ id: string; displayName: string }>;
  sources: unknown[];
  lineages: unknown[];
}
interface TreeProjection {
  topology: {
    nodes: Array<
      | { id: string; kind: "person"; personId: string }
      | { id: string; kind: "union"; unionId: string; display: { kind: "marriage" | "coParents" | "singleParent" | "unassigned" } }
    >;
    edges: Array<{ source: string; target: string; kind: "parentUnion" | "unionChild" }>;
  };
}
interface SuiteStateGuard {
  fingerprint: string;
  counts: {
    people: number;
    sources: number;
    lineages: number;
    treeNodes: number;
    treeEdges: number;
    wikiEntries: number;
    auditGroups: number;
  };
}

const solar = (year: number, month: number, day: number | null = null): PartialDate => ({
  calendar: "solar",
  year,
  month,
  day,
  leapMonth: false,
  precision: day === null ? "month" : "day"
});

let baseline: { workspace: Workspace; bytes: Buffer; backupCounts: BackupCounts; state: SuiteStateGuard } | null = null;
let activeWorkspace: Workspace | null = null;
let activeTestTitle: string | null = null;
let activeScenarioName: string | null = null;
const uploadedTokens = new Set<string>();
const restoreTokens = new Set<string>();

function configuredBaseUrl(testInfo: TestInfo): string {
  const baseURL = testInfo.project.use.baseURL;
  if (typeof baseURL !== "string") throw new Error("Parent-completion E2E requires a string baseURL");
  return baseURL;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right), "en"));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right, "en")).map(([key, entry]) => [key, canonicalize(entry)]));
  }
  return value;
}

async function captureSuiteState(request: APIRequestContext): Promise<SuiteStateGuard> {
  const [snapshot, tree, wiki, audit] = await Promise.all([
    rpc<WorkspaceSnapshot>(request, "query", "workspaceSnapshot"),
    rpc<TreeProjection>(request, "query", "projectTree", { view: "full", collapseDepth: 20 }),
    rpc<unknown[]>(request, "wiki", "list", { limit: 100, offset: 0 }),
    rpc<unknown[]>(request, "dataManagement", "listAudit")
  ]);
  const state = canonicalize({ snapshot, tree, wiki, audit });
  return {
    fingerprint: createHash("sha256").update(JSON.stringify(state)).digest("hex"),
    counts: {
      people: snapshot.people.length,
      sources: snapshot.sources.length,
      lineages: snapshot.lineages.length,
      treeNodes: tree.topology.nodes.length,
      treeEdges: tree.topology.edges.length,
      wikiEntries: wiki.length,
      auditGroups: audit.length
    }
  };
}

async function createBaselineBackup(request: APIRequestContext): Promise<{ workspace: Workspace; bytes: Buffer; backupCounts: BackupCounts; state: SuiteStateGuard }> {
  const workspace = await ensureFamily(request);
  const initialSnapshot = await rpc<WorkspaceSnapshot>(request, "query", "workspaceSnapshot");
  const suiteBaselinePeople = initialSnapshot.people.filter((person) => person.displayName === suiteBaselinePersonName);
  if (initialSnapshot.people.length === 0 || suiteBaselinePeople.length !== 1) {
    throw new Error(`Expected one non-empty suite baseline named ${suiteBaselinePersonName}; found ${suiteBaselinePeople.length} in ${initialSnapshot.people.length} people`);
  }
  const state = await captureSuiteState(request);
  const created = await rpc<{
    saved: boolean;
    verified?: true;
    counts?: BackupCounts;
    download?: { downloadUrl: string; fileName: string };
  }>(request, "dataManagement", "createBackup");
  if (!created.saved || created.verified !== true || !created.download || !created.counts) throw new Error("Unable to create verified parent-completion baseline backup");
  const downloaded = await request.get(created.download.downloadUrl);
  if (!downloaded.ok()) throw new Error(`Unable to download parent-completion baseline backup: HTTP ${downloaded.status()}`);
  const bytes = await downloaded.body();
  if (bytes.length === 0 || bytes.subarray(0, 2).toString("ascii") !== "PK") throw new Error("Parent-completion baseline backup is not a non-empty ZIP archive");
  console.info(`[parent-completion fixture] baseline workspace=${workspace.id} bytes=${bytes.length} people=${state.counts.people} fingerprint=${state.fingerprint}`);
  return { workspace, bytes, backupCounts: created.counts, state };
}

async function restoreBaseline(request: APIRequestContext, scenarioName: string): Promise<Workspace> {
  if (!baseline) throw new Error("Parent-completion baseline backup was not initialized");
  const encodedScenario = Buffer.from(scenarioName, "utf8").toString("base64url").slice(0, 48);
  const uploadedResponse = await request.post("/api/files/backup", {
    data: baseline.bytes,
    headers: { "content-type": "application/octet-stream", "x-file-name": `parent-completion-${encodedScenario}.zip` }
  });
  const uploaded = await uploadedResponse.json() as Result<{ fileToken: string }>;
  if (!uploadedResponse.ok() || !uploaded.ok || !uploaded.value?.fileToken) throw new Error(uploaded.error?.message ?? `Unable to upload baseline backup for ${scenarioName}`);
  if (uploadedTokens.has(uploaded.value.fileToken)) throw new Error(`Backup upload token was reused for ${scenarioName}`);
  uploadedTokens.add(uploaded.value.fileToken);

  const inspection = await rpc<BackupInspection>(request, "dataManagement", "inspectBackup", {
    fileToken: uploaded.value.fileToken,
    targetWorkspaceId: baseline.workspace.id
  });
  if (
    inspection.verified !== true ||
    inspection.targetWorkspaceId !== baseline.workspace.id ||
    inspection.manifest.workspaceId !== baseline.workspace.id ||
    JSON.stringify(inspection.manifest.counts) !== JSON.stringify(baseline.backupCounts)
  ) {
    throw new Error(`Baseline backup workspace mismatch for ${scenarioName}`);
  }
  if (restoreTokens.has(inspection.restoreToken)) throw new Error(`Backup restore token was reused for ${scenarioName}`);
  restoreTokens.add(inspection.restoreToken);
  const restored = await rpc<{ restored: true; automaticSnapshotVerified: true }>(request, "dataManagement", "restoreBackup", {
    restoreToken: inspection.restoreToken,
    targetWorkspaceId: baseline.workspace.id,
    confirmReplace: true
  });
  if (restored.restored !== true || restored.automaticSnapshotVerified !== true) throw new Error(`Baseline restore was not verified for ${scenarioName}`);

  const workspace = await ensureFamily(request);
  const snapshot = await rpc<{ workspaceId: string }>(request, "query", "workspaceSnapshot");
  if (workspace.id !== baseline.workspace.id || snapshot.workspaceId !== baseline.workspace.id) throw new Error(`Restored the wrong workspace for ${scenarioName}`);
  const restoredState = await captureSuiteState(request);
  if (restoredState.fingerprint !== baseline.state.fingerprint || JSON.stringify(restoredState.counts) !== JSON.stringify(baseline.state.counts)) {
    throw new Error(`Suite state mismatch after restoring ${scenarioName}: expected ${baseline.state.fingerprint}/${JSON.stringify(baseline.state.counts)}, received ${restoredState.fingerprint}/${JSON.stringify(restoredState.counts)}`);
  }
  console.info(`[parent-completion fixture] restored scenario="${scenarioName}" workspace=${workspace.id} people=${restoredState.counts.people} fingerprint=${restoredState.fingerprint}`);
  return workspace;
}

async function freshFamily(request: APIRequestContext, scenarioName: string): Promise<Workspace> {
  if (!activeWorkspace || !activeTestTitle) throw new Error(`Scenario ${scenarioName} started before its baseline restore`);
  if (!scenarioName.trim()) throw new Error("Parent-completion scenario name is required");
  if (activeScenarioName !== null) throw new Error(`Scenario already named ${activeScenarioName}`);
  const opened = await ensureFamily(request);
  if (opened.id !== activeWorkspace.id) throw new Error(`Scenario ${scenarioName} opened workspace ${opened.id}, expected ${activeWorkspace.id}`);
  activeScenarioName = scenarioName;
  console.info(`[parent-completion fixture] test="${activeTestTitle}" scenario="${scenarioName}"`);
  return opened;
}

async function createPerson(
  request: APIRequestContext,
  displayName: string,
  gender: "male" | "female" | "unknown" = "unknown",
  birth: PartialDate | null = null
): Promise<string> {
  const receipt = await stageAndConfirm(request, [{
    type: "person.create",
    draft: {
      displayName,
      aliases: [],
      gender,
      birth,
      death: null,
      notes: null,
      sourceDescription: "父母补全 Web 验收"
    }
  }]);
  const id = receipt.changedEntityIds[0];
  if (!id) throw new Error(`Missing created person id for ${displayName}`);
  return id;
}

async function createMarriage(
  request: APIRequestContext,
  spouseAId: string,
  spouseBId: string,
  options: { status?: "active" | "divorced"; start?: PartialDate | null; end?: PartialDate | null } = {}
): Promise<string> {
  const receipt = await stageAndConfirm(request, [{
    type: "marriage.add",
    draft: {
      spouseAId,
      spouseBId,
      status: options.status ?? "active",
      start: options.start ?? null,
      end: options.end ?? null,
      sourceDescription: "父母补全 Web 验收婚姻"
    }
  }]);
  const id = receipt.changedEntityIds[0];
  if (!id) throw new Error("Missing created marriage id");
  return id;
}

async function createExplicitParent(
  request: APIRequestContext,
  parentId: string,
  childId: string,
  parentRole: "father" | "mother"
): Promise<void> {
  await stageAndConfirm(request, [{
    type: "parentChild.add",
    draft: { parentId, childId, parentRole, sourceDescription: "父母补全 Web 验收明确关系" }
  }]);
}

async function createCompletedFamily(
  request: APIRequestContext,
  knownParentId: string,
  childId: string,
  parentRole: "father" | "mother"
): Promise<void> {
  await stageAndConfirm(request, [{
    type: "parentFamily.add",
    knownParentId,
    childId,
    parentRole,
    completionPolicy: "spouse-default",
    sourceDescription: "父母补全 Web 验收家庭关系"
  }]);
}

async function openPerson(page: Page, workspaceId: string, displayName: string): Promise<void> {
  await openArea(page, workspaceId, "people");
  await page.getByRole("button", { name: `查看${displayName}`, exact: true }).click();
  await expect(page.getByRole("heading", { name: displayName, exact: true })).toBeVisible();
  await expect(page.getByText(`当前人物固定为：${displayName}`, { exact: true })).toBeVisible();
}

async function selectChildrenAndPreview(
  page: Page,
  childNames: string[],
  role: "father" | "mother"
): Promise<void> {
  for (const childName of childNames) await page.getByRole("checkbox", { name: `选择子女 ${childName}`, exact: true }).check();
  await page.getByRole("radio", { name: role === "father" ? "当前人物作为父亲" : "当前人物作为母亲", exact: true }).check();
  await page.getByRole("button", { name: "生成子女关系预览", exact: true }).click();
}

async function confirmDialog(page: Page): Promise<{ operationGroupId: string }> {
  const dialog = page.getByRole("dialog", { name: "确认写入" });
  await expect(dialog).toBeVisible();
  for (const warning of await dialog.getByLabel(/^我已阅读 /u).all()) await warning.check();
  const responsePromise = page.waitForResponse((response) => response.request().method() === "POST" && response.url().includes("/api/rpc/mutations/confirm"));
  await dialog.getByRole("button", { name: "确认写入", exact: true }).click();
  const body = await (await responsePromise).json() as Result<{ operationGroupId: string }>;
  if (!body.ok || !body.value) throw new Error(body.error?.message ?? "Unable to confirm staged mutation");
  await expect(dialog).toBeHidden();
  return body.value;
}

async function relatives(request: APIRequestContext, personId: string, kinds: Array<"parent" | "child" | "spouse">): Promise<RelativeRow[]> {
  return rpc<RelativeRow[]>(request, "query", "listRelatives", { personId, kinds });
}

async function undoOperationFromSettings(page: Page, workspaceId: string, operationGroupId: string): Promise<void> {
  await openArea(page, workspaceId, "settings");
  await page.getByRole("button", { name: `撤销 ${operationGroupId}`, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "确认撤销操作" });
  await dialog.getByLabel(/我确认撤销以上/u).check();
  await dialog.getByRole("button", { name: "确认撤销", exact: true }).click();
  await expect(dialog).toBeHidden();
}

async function selectVisibleOption(page: Page, label: string, optionText: string): Promise<void> {
  await page.getByLabel(label, { exact: true }).selectOption({ label: optionText });
}

async function personOptionLabel(request: APIRequestContext, personId: string): Promise<string> {
  const person = await rpc<{ personCode: string; displayName: string }>(request, "query", "getPerson", { personId });
  return `${person.personCode}｜${person.displayName}`;
}

async function openTreeDescendants(page: Page, workspaceId: string, centerName: string): Promise<void> {
  await openArea(page, workspaceId, "tree");
  await selectVisibleOption(page, "围绕谁查看", centerName);
  await page.getByRole("button", { name: "子孙后代", exact: true }).click();
  await expect(page.getByRole("button", { name: "子孙后代", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("group", { name: `人物：${centerName}`, exact: true })).toBeVisible();
}

test.beforeAll(async ({ playwright }, testInfo) => {
  const request = await playwright.request.newContext({ baseURL: configuredBaseUrl(testInfo) });
  try {
    baseline = await createBaselineBackup(request);
  } finally {
    await request.dispose();
  }
});

test.beforeEach(async ({ request }, testInfo) => {
  activeTestTitle = testInfo.title;
  activeScenarioName = null;
  activeWorkspace = await restoreBaseline(request, testInfo.title);
});

test.afterEach(async () => {
  if (!activeScenarioName) throw new Error(`Test ${activeTestTitle ?? "unknown"} did not identify its parent-completion scenario`);
  activeWorkspace = null;
  activeTestTitle = null;
  activeScenarioName = null;
});

test.afterAll(async ({ playwright }, testInfo) => {
  if (!baseline) return;
  const request = await playwright.request.newContext({ baseURL: configuredBaseUrl(testInfo) });
  try {
    await restoreBaseline(request, "spec-after-all-baseline");
    console.info(`[parent-completion fixture] final suite state restored people=${baseline.state.counts.people} fingerprint=${baseline.state.fingerprint}`);
  } finally {
    await request.dispose();
  }
});

test("普通夫妻新增一个孩子时预览人工与自动两行", async ({ page, request }) => {
  const workspace = await freshFamily(request, "验收-普通夫妻");
  const father = await createPerson(request, "验收普通父亲", "male");
  const mother = await createPerson(request, "验收普通母亲", "female");
  await createMarriage(request, father, mother);
  await openPerson(page, workspace.id, "验收普通父亲");

  await page.getByRole("button", { name: "新建人物并设为子女", exact: true }).click();
  await page.getByLabel("姓名", { exact: true }).fill("验收普通孩子");
  await page.getByLabel("性别", { exact: true }).selectOption("female");
  await page.getByRole("button", { name: "保存人物", exact: true }).click();
  await confirmDialog(page);
  await expect(page.getByRole("checkbox", { name: "选择子女 验收普通孩子", exact: true })).toBeChecked();

  const dialog = page.getByRole("dialog", { name: "确认写入" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel(/选择 验收普通父亲 → 验收普通孩子：父亲/u)).toBeChecked();
  await expect(dialog.getByLabel(/选择 验收普通母亲 → 验收普通孩子：母亲/u)).toBeChecked();
  await expect(dialog.getByText("人工录入", { exact: true })).toBeVisible();
  await expect(dialog.getByText("系统自动补全", { exact: true })).toBeVisible();
  await confirmDialog(page);

  const childSearch = await rpc<Array<{ id: string }>>(request, "query", "searchPeople", { query: "验收普通孩子", limit: 10 });
  const childParents = await relatives(request, childSearch[0]!.id, ["parent"]);
  expect(childParents.map(({ originKind }) => originKind).sort()).toEqual(["explicit", "spouse_default"]);
  await createPerson(request, "验收场景隔离标记");
});

test("管理员取消自动项后只保存明确亲子关系", async ({ page, request }) => {
  const workspace = await freshFamily(request, "验收-取消自动项");
  expect(await rpc<Array<{ id: string }>>(request, "query", "searchPeople", { query: "验收场景隔离标记", limit: 10 })).toHaveLength(0);
  const father = await createPerson(request, "验收取消父亲", "male");
  const mother = await createPerson(request, "验收取消母亲", "female");
  const child = await createPerson(request, "验收取消孩子", "unknown");
  await createMarriage(request, father, mother);
  await openPerson(page, workspace.id, "验收取消父亲");

  await selectChildrenAndPreview(page, ["验收取消孩子"], "father");
  const dialog = page.getByRole("dialog", { name: "确认写入" });
  await dialog.getByLabel(/选择 验收取消母亲 → 验收取消孩子：母亲/u).uncheck();
  await confirmDialog(page);

  expect(await relatives(request, child, ["parent"])).toEqual([
    expect.objectContaining({ person: expect.objectContaining({ displayName: "验收取消父亲" }), originKind: "explicit" })
  ]);
  await createExplicitParent(request, mother, child, "mother");
});

test("无配偶时说明另一位父母未确认且明确关系仍可保存", async ({ page, request }) => {
  const workspace = await freshFamily(request, "验收-无配偶");
  const parent = await createPerson(request, "验收单身父亲", "male");
  const child = await createPerson(request, "验收无配偶孩子", "unknown");
  await openPerson(page, workspace.id, "验收单身父亲");

  await selectChildrenAndPreview(page, ["验收无配偶孩子"], "father");
  await expect(page.getByText("验收无配偶孩子：另一位父母尚未确认", { exact: true })).toBeVisible();
  const dialog = page.getByRole("dialog", { name: "确认写入" });
  await expect(dialog.getByRole("checkbox")).toHaveCount(1);
  await confirmDialog(page);

  expect(await relatives(request, child, ["parent"])).toEqual([
    expect.objectContaining({ person: expect.objectContaining({ id: parent }), parentRole: "father" })
  ]);
  const manuallyRecordedMother = await createPerson(request, "验收无配偶管理员补录母亲", "female");
  await createExplicitParent(request, manuallyRecordedMother, child, "mother");
});

test("离婚再婚按唯一出生区间选择前配偶", async ({ page, request }) => {
  const workspace = await freshFamily(request, "验收-出生区间");
  const father = await createPerson(request, "验收区间父亲", "male");
  const former = await createPerson(request, "验收区间前配偶", "female");
  const current = await createPerson(request, "验收区间现配偶", "female");
  const child = await createPerson(request, "验收区间孩子", "unknown", solar(1995, 6, 15));
  const formerMarriage = await createMarriage(request, father, former, { status: "divorced", start: solar(1990, 1), end: solar(2000, 12) });
  await createMarriage(request, father, current, { status: "active", start: solar(2010, 1) });
  await openPerson(page, workspace.id, "验收区间父亲");

  await selectChildrenAndPreview(page, ["验收区间孩子"], "father");
  const dialog = page.getByRole("dialog", { name: "确认写入" });
  await expect(dialog.getByLabel(/选择 验收区间前配偶 → 验收区间孩子：母亲（依据：孩子出生时间与婚姻区间唯一匹配）/u)).toBeChecked();
  await expect(dialog.getByText(/验收区间现配偶/u)).toHaveCount(0);
  await confirmDialog(page);

  expect(await relatives(request, child, ["parent"])).toEqual(expect.arrayContaining([
    expect.objectContaining({ person: expect.objectContaining({ displayName: "验收区间前配偶" }), inferredFromMarriageId: formerMarriage })
  ]));
});

test("缺少出生日期的歧义允许一项选择候选另一项暂时跳过", async ({ page, request }) => {
  const workspace = await freshFamily(request, "验收-歧义选择跳过");
  const father = await createPerson(request, "验收歧义父亲", "male");
  const former = await createPerson(request, "验收歧义前配偶", "female");
  const current = await createPerson(request, "验收歧义现配偶", "female");
  const chosenChild = await createPerson(request, "验收歧义选择孩子");
  const skippedChild = await createPerson(request, "验收歧义跳过孩子");
  await createMarriage(request, father, former, { status: "divorced", start: solar(1990, 1), end: solar(2000, 12) });
  await createMarriage(request, father, current, { status: "active", start: solar(2010, 1) });
  await openPerson(page, workspace.id, "验收歧义父亲");

  await selectChildrenAndPreview(page, ["验收歧义选择孩子", "验收歧义跳过孩子"], "father");
  await expect(page.getByRole("heading", { name: "请选择另一位父母，或暂时跳过", exact: true })).toBeVisible();
  await page.getByRole("radio", { name: "为验收歧义选择孩子选择验收歧义前配偶", exact: true }).check();
  await page.getByRole("radio", { name: "暂时跳过验收歧义跳过孩子的另一位父母", exact: true }).check();
  await page.getByRole("button", { name: "生成关系预览", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "确认写入" });
  await expect(dialog.getByText("系统自动补全", { exact: true })).toHaveCount(1);
  await confirmDialog(page);

  expect(await relatives(request, chosenChild, ["parent"])).toHaveLength(2);
  expect(await relatives(request, skippedChild, ["parent"])).toEqual([
    expect.objectContaining({ person: expect.objectContaining({ id: father }), originKind: "explicit" })
  ]);
  await createExplicitParent(request, current, skippedChild, "mother");
});

test("互补父母角色已占用时阻断自动项但保留明确关系", async ({ page, request }) => {
  const workspace = await freshFamily(request, "验收-角色占用");
  const father = await createPerson(request, "验收冲突父亲", "male");
  const suggested = await createPerson(request, "验收冲突婚姻母亲", "female");
  const recorded = await createPerson(request, "验收冲突现有母亲", "female");
  const child = await createPerson(request, "验收冲突孩子");
  await createMarriage(request, father, suggested);
  await createExplicitParent(request, recorded, child, "mother");
  await openPerson(page, workspace.id, "验收冲突父亲");

  await selectChildrenAndPreview(page, ["验收冲突孩子"], "father");
  const dialog = page.getByRole("dialog", { name: "确认写入" });
  await expect(dialog.getByText(/孩子验收冲突孩子的母亲已是验收冲突现有母亲，不能用建议候选验收冲突婚姻母亲覆盖/u)).toBeVisible();
  await expect(dialog.getByText("系统自动补全", { exact: true })).toBeVisible();
  await confirmDialog(page);

  const parents = await relatives(request, child, ["parent"]);
  expect(parents.map(({ person }) => person.displayName).sort()).toEqual(["验收冲突父亲", "验收冲突现有母亲"]);
});

test("一次选择多个子女会为每人生成明确与自动两条预览", async ({ page, request }) => {
  const workspace = await freshFamily(request, "验收-多个子女");
  const father = await createPerson(request, "验收多子女父亲", "male");
  const mother = await createPerson(request, "验收多子女母亲", "female");
  const childA = await createPerson(request, "验收多子女甲");
  const childB = await createPerson(request, "验收多子女乙");
  await createMarriage(request, father, mother);
  await openPerson(page, workspace.id, "验收多子女父亲");

  await selectChildrenAndPreview(page, ["验收多子女甲", "验收多子女乙"], "father");
  const dialog = page.getByRole("dialog", { name: "确认写入" });
  await expect(dialog.getByRole("checkbox")).toHaveCount(4);
  await expect(dialog.getByText("人工录入", { exact: true })).toHaveCount(2);
  await expect(dialog.getByText("系统自动补全", { exact: true })).toHaveCount(2);
  await confirmDialog(page);

  expect(await relatives(request, childA, ["parent"])).toHaveLength(2);
  expect(await relatives(request, childB, ["parent"])).toHaveLength(2);
});

test("自动关系可移除、更正并通过操作历史整体撤销", async ({ page, request }) => {
  const workspace = await freshFamily(request, "验收-移除更正撤销");
  const father = await createPerson(request, "验收维护父亲", "male");
  const originalMother = await createPerson(request, "验收维护原母亲", "female");
  const replacementMother = await createPerson(request, "验收维护新母亲", "female");
  const child = await createPerson(request, "验收维护孩子");
  await createMarriage(request, father, originalMother);
  await createCompletedFamily(request, father, child, "father");
  await openPerson(page, workspace.id, "验收维护孩子");

  await page.getByRole("button", { name: "移除母亲 验收维护原母亲", exact: true }).click();
  const removeReceipt = await confirmDialog(page);
  expect((await relatives(request, child, ["parent"])).map(({ person }) => person.displayName)).toEqual(["验收维护父亲"]);
  expect(await relatives(request, father, ["spouse"])).toEqual([
    expect.objectContaining({ person: expect.objectContaining({ displayName: "验收维护原母亲" }) })
  ]);

  await undoOperationFromSettings(page, workspace.id, removeReceipt.operationGroupId);
  expect((await relatives(request, child, ["parent"])).map(({ person }) => person.displayName).sort()).toEqual(["验收维护原母亲", "验收维护父亲"]);

  await openPerson(page, workspace.id, "验收维护孩子");
  await page.getByRole("button", { name: "更正母亲 验收维护原母亲", exact: true }).click();
  await selectVisibleOption(page, "母亲更正为", await personOptionLabel(request, replacementMother));
  await page.getByRole("button", { name: "预览母亲更正", exact: true }).click();
  const correctionReceipt = await confirmDialog(page);
  expect((await relatives(request, child, ["parent"])).map(({ person }) => person.displayName).sort()).toEqual(["验收维护新母亲", "验收维护父亲"]);

  await undoOperationFromSettings(page, workspace.id, correctionReceipt.operationGroupId);
  expect((await relatives(request, child, ["parent"])).map(({ person }) => person.displayName).sort()).toEqual(["验收维护原母亲", "验收维护父亲"]);
});

test("历史未完整父母关系只有确认批修复后才写入", async ({ page, request }) => {
  const workspace = await freshFamily(request, "验收-历史批修复");
  const father = await createPerson(request, "验收修复父亲", "male");
  const mother = await createPerson(request, "验收修复母亲", "female");
  const child = await createPerson(request, "验收修复孩子");
  await createMarriage(request, father, mother);
  await createExplicitParent(request, father, child, "father");
  await openArea(page, workspace.id, "people");

  await page.getByRole("button", { name: "检查未完整父母关系", exact: true }).click();
  const panel = page.getByRole("region", { name: "检查未完整父母关系" });
  await expect(panel.getByText("可安全补全 1", { exact: true })).toBeVisible();
  await expect(panel.getByRole("checkbox", { name: "选择修复 验收修复孩子", exact: true })).toBeChecked();
  expect(await relatives(request, child, ["parent"])).toHaveLength(1);
  await panel.getByRole("button", { name: "生成修复预览", exact: true }).click();
  await confirmDialog(page);

  expect(await relatives(request, child, ["parent"])).toHaveLength(2);
});

test("批修复后家谱树不再把该家庭标为单亲", async ({ page, request }) => {
  const workspace = await freshFamily(request, "验收-树完整度");
  const father = await createPerson(request, "验收树父亲", "male");
  const mother = await createPerson(request, "验收树母亲", "female");
  const child = await createPerson(request, "验收树孩子");
  const marriage = await createMarriage(request, father, mother);
  await createExplicitParent(request, father, child, "father");

  await openTreeDescendants(page, workspace.id, "验收树父亲");
  await expect(page.getByRole("group", { name: "家庭联合：仅录入一位父母" })).toHaveCount(1);
  await openArea(page, workspace.id, "people");
  await page.getByRole("button", { name: "检查未完整父母关系", exact: true }).click();
  const panel = page.getByRole("region", { name: "检查未完整父母关系" });
  await panel.getByRole("button", { name: "生成修复预览", exact: true }).click();
  await confirmDialog(page);

  await openTreeDescendants(page, workspace.id, "验收树父亲");
  await expect(page.getByRole("group", { name: "家庭联合：仅录入一位父母" })).toHaveCount(0);
  await expect(page.getByRole("group", { name: "家庭联合：婚姻", exact: true })).toBeVisible();
  await expect(page.getByRole("group", { name: "人物：验收树父亲", exact: true })).toBeVisible();
  await expect(page.getByRole("group", { name: "人物：验收树母亲", exact: true })).toBeVisible();
  await expect(page.getByRole("group", { name: "人物：验收树孩子", exact: true })).toBeVisible();
  const projection = await rpc<TreeProjection>(request, "query", "projectTree", { view: "descendants", subjectId: father });
  const fatherNodes = projection.topology.nodes.filter((node) => node.kind === "person" && node.personId === father);
  const motherNodes = projection.topology.nodes.filter((node) => node.kind === "person" && node.personId === mother);
  const childNodes = projection.topology.nodes.filter((node) => node.kind === "person" && node.personId === child);
  const marriageUnions = projection.topology.nodes.filter((node) => node.kind === "union" && node.unionId === `marriage:${marriage}` && node.display.kind === "marriage");
  expect(fatherNodes).toHaveLength(1);
  expect(motherNodes).toHaveLength(1);
  expect(childNodes).toHaveLength(1);
  expect(marriageUnions).toHaveLength(1);
  const targetUnionId = marriageUnions[0]!.id;
  expect(projection.topology.edges.filter((edge) => edge.kind === "parentUnion" && edge.target === targetUnionId).map((edge) => edge.source).sort()).toEqual([
    fatherNodes[0]!.id,
    motherNodes[0]!.id
  ].sort());
  expect(projection.topology.edges.filter((edge) => edge.kind === "unionChild" && edge.source === targetUnionId).map((edge) => edge.target)).toContain(childNodes[0]!.id);
  const repairedParents = await relatives(request, child, ["parent"]);
  expect(repairedParents.map((row) => ({ personId: row.person.id, role: row.parentRole })).sort((left, right) => left.role!.localeCompare(right.role!))).toEqual([
    { personId: father, role: "father" },
    { personId: mother, role: "mother" }
  ]);
});
