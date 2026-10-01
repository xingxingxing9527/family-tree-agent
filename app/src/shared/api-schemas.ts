import { z } from "zod";
import {
  askRequestSchema,
  confirmDraftRequestSchema,
  disclosureRequestSchema,
  reviseDraftRequestSchema,
  stageMutationRequestSchema
} from "./chat.js";
import { parsePartialDate } from "./domain.js";
import { MAX_MUTATION_CHANGES, MAX_MUTATION_INTENTS } from "./mutations.js";

export const rpcRequestSchema = z.object({ input: z.unknown() }).strict();
export const noInputSchema = z.union([z.null(), z.object({}).strict()]);

const id = z.string().trim().min(1).max(200);
const uuid = z.string().uuid();
const expectedVersion = z.number().int().min(1);
const sourceDescription = z.string().trim().min(1).max(500);
const partialDate = z.object({
  calendar: z.enum(["solar", "lunar"]),
  year: z.number().int().min(1),
  month: z.number().int().min(1).max(12),
  day: z.number().int().min(1).max(31).nullable(),
  leapMonth: z.boolean(),
  precision: z.enum(["month", "day"])
}).strict().superRefine((value, context) => {
  try {
    const parsed = parsePartialDate(value);
    if (parsed.precision !== value.precision) context.addIssue({ code: "custom", path: ["precision"], message: "Date precision does not match day" });
    if (parsed.calendar === "lunar" && parsed.day !== null && parsed.day > 30) context.addIssue({ code: "custom", path: ["day"], message: "Lunar day must be at most 30" });
  } catch {
    context.addIssue({ code: "custom", message: "Invalid partial date" });
  }
});
const nullableDate = partialDate.nullable();
const personDraft = z.object({
  displayName: z.string().trim().min(1).max(200),
  aliases: z.array(z.string().trim().min(1).max(200)).max(100),
  gender: z.enum(["male", "female", "unknown"]),
  birth: nullableDate,
  death: nullableDate,
  notes: z.string().max(10_000).nullable(),
  sourceDescription
}).strict();
const personPatch = personDraft.partial().refine((value) => Object.keys(value).length > 0, { message: "Patch cannot be empty" });

const lineageRole = z.enum(["blood", "married_in", "associated"]);
const nullableText = (maximum: number) => z.string().trim().min(1).max(maximum).nullable();
const declaredGeneration = z.number().int().min(1).max(10_000).nullable();
const generationMarker = nullableText(50);
const lineagePatch = z.object({ name: z.string().trim().min(1).max(200).optional(), founderPersonId: id.optional(), description: nullableText(10_000).optional() }).strict()
  .refine((value) => Object.keys(value).length > 0, { message: "Patch cannot be empty" });
const membershipPatch = z.object({ lineageRole: lineageRole.optional(), isPrimary: z.boolean().optional(), declaredGeneration: declaredGeneration.optional(), generationMarker: generationMarker.optional() }).strict()
  .refine((value) => Object.keys(value).length > 0, { message: "Patch cannot be empty" });
const mutationIntent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("person.create"), draft: personDraft }).strict(),
  z.object({ type: z.literal("person.update"), personId: id, expectedVersion, patch: personPatch }).strict(),
  z.object({ type: z.literal("parentChild.add"), draft: z.object({ parentId: id, childId: id, parentRole: z.enum(["father", "mother"]), sourceDescription }).strict() }).strict(),
  z.object({
    type: z.literal("parentFamily.add"),
    knownParentId: id,
    childId: id,
    parentRole: z.enum(["father", "mother"]),
    completionPolicy: z.literal("spouse-default"),
    selectedSpouseId: id.optional(),
    skipCompletion: z.boolean().optional(),
    sourceDescription
  }).strict().refine((value) => value.knownParentId !== value.childId, { message: "People must be different" }),
  z.object({ type: z.literal("marriage.add"), draft: z.object({ spouseAId: id, spouseBId: id, start: nullableDate, sourceDescription }).strict() }).strict(),
  z.object({ type: z.literal("marriage.divorce"), marriageId: id, endDate: nullableDate, expectedVersion }).strict(),
  z.object({ type: z.literal("person.childrenCompleteness.set"), personId: id, complete: z.boolean(), sourceDescription, expectedVersion }).strict(),
  z.object({ type: z.literal("lineage.create"), name: z.string().trim().min(1).max(200), founderPersonId: id, description: nullableText(10_000) }).strict(),
  z.object({ type: z.literal("lineage.update"), lineageId: id, expectedVersion, patch: lineagePatch }).strict(),
  z.object({ type: z.literal("lineage.archive"), lineageId: id, expectedVersion }).strict(),
  z.object({ type: z.literal("lineageMembership.add"), lineageId: id, personId: id, lineageRole, isPrimary: z.boolean(), declaredGeneration, generationMarker }).strict(),
  z.object({ type: z.literal("lineageMembership.update"), membershipId: id, expectedVersion, patch: membershipPatch }).strict(),
  z.object({ type: z.literal("lineageMembership.remove"), membershipId: id, expectedVersion }).strict()
]);

const mergeDecision = z.object({
  primaryPersonId: id,
  secondaryPersonId: id,
  scalarChoices: z.record(z.string().max(100), z.enum(["primary", "secondary"])),
  expectedVersions: z.record(z.string().max(200), expectedVersion)
}).strict().refine((value) => value.primaryPersonId !== value.secondaryPersonId, { message: "People must be different" });

const wikiDraft = z.object({
  title: z.string().trim().min(1).max(500),
  body: z.string().max(200_000),
  personIds: z.array(uuid).max(500),
  sourceIds: z.array(uuid).max(500)
}).strict();

const projectTree = z.object({
  view: z.enum(["full", "branch", "ancestors", "descendants"]),
  subjectId: id.optional(),
  viewpointId: id.optional(),
  collapseDepth: z.number().int().min(0).max(20).optional()
}).strict().superRefine((value, context) => {
  if (value.view !== "full" && !value.subjectId) context.addIssue({ code: "custom", path: ["subjectId"], message: "A subject is required" });
});
const searchQuery = z.string().trim().min(1).max(200);

export const RPC_INPUT_SCHEMAS = {
  people: {
    list: z.object({ query: z.string().trim().max(200).optional(), limit: z.number().int().min(1).max(1_000), offset: z.number().int().min(0).max(100_000) }).strict(),
    get: z.object({ personId: id }).strict(),
    save: z.object({ draft: personDraft, confirmWarnings: z.boolean() }).strict(),
    update: z.object({ personId: id, patch: personPatch, expectedVersion, confirmWarnings: z.boolean() }).strict(),
    setChildrenCompleteness: z.object({ personId: id, complete: z.boolean(), sourceDescription, expectedVersion }).strict(),
    getChildrenCountStatus: z.object({ personId: id }).strict()
  },
  relations: {
    addParentChild: z.object({ draft: z.object({ parentId: id, childId: id, parentRole: z.enum(["father", "mother"]), sourceDescription }).strict()
      .refine((value) => value.parentId !== value.childId, { message: "People must be different" }), confirmWarnings: z.boolean() }).strict(),
    addMarriage: z.object({ draft: z.object({ spouseAId: id, spouseBId: id, start: nullableDate, sourceDescription }).strict()
      .refine((value) => value.spouseAId !== value.spouseBId, { message: "People must be different" }), confirmWarnings: z.boolean() }).strict(),
    divorce: z.object({ marriageId: id, endDate: nullableDate, expectedVersion }).strict(),
    planParentCompletion: z.object({
      knownParentId: id,
      childId: id,
      parentRole: z.enum(["father", "mother"]),
      selectedSpouseId: id.optional()
    }).strict().refine((value) => value.knownParentId !== value.childId, { message: "People must be different" }),
    scanParentCompletions: noInputSchema,
    planRelativePath: z.object({
      anchorId: id,
      targetId: id,
      templateId: z.enum(["sibling", "grandparent", "uncle", "aunt", "nibling", "cousin"]),
      selectedIntermediaryIds: z.object({
        parent: id.optional(),
        grandparent: id.optional(),
        sibling: id.optional(),
        collateralParent: id.optional()
      }).strict()
    }).strict()
  },
  lineages: {
    createLineage: z.object({ name: z.string().trim().min(1).max(200), founderPersonId: id, description: nullableText(10_000) }).strict(),
    updateLineage: z.object({ lineageId: id, expectedVersion, patch: lineagePatch }).strict(),
    archiveLineage: z.object({ lineageId: id, expectedVersion }).strict(),
    addMembership: z.object({ lineageId: id, personId: id, lineageRole, isPrimary: z.boolean(), declaredGeneration, generationMarker }).strict(),
    updateMembership: z.object({ membershipId: id, expectedVersion, patch: membershipPatch }).strict(),
    removeMembership: z.object({ membershipId: id, expectedVersion }).strict()
  },
  imports: {
    parse: z.object({
      fileToken: uuid,
      sourceKey: z.string().max(500).refine((value) => value.trim().length > 0),
      csvEntityType: z.enum(["People", "ParentChild", "Marriages"]).optional(),
      fieldMapping: z.record(z.string().min(1).max(100), z.string().min(1).max(200)).optional()
    }).strict(),
    commit: z.object({ planId: id, selectedActionIds: z.array(id).max(10_000) }).strict()
      .refine((value) => new Set(value.selectedActionIds).size === value.selectedActionIds.length),
    exportTemplate: noInputSchema,
    exportCurrentWorkbook: noInputSchema,
    exportBlankWorkbook: noInputSchema
  },
  merges: {
    findDuplicateCandidates: z.object({ personId: id }).strict(),
    preview: z.object({ primaryPersonId: id, secondaryPersonId: id }).strict(),
    merge: mergeDecision,
    history: noInputSchema,
    canUnmerge: z.object({ mergeId: id }).strict(),
    unmerge: z.object({ mergeId: id }).strict()
  },
  wiki: {
    list: z.object({ limit: z.number().int().min(1).max(100), offset: z.number().int().min(0).max(100_000) }).strict(),
    create: wikiDraft,
    update: wikiDraft.extend({ wikiEntryId: uuid, expectedVersion }).strict(),
    remove: z.object({ wikiEntryId: uuid, expectedVersion }).strict(),
    get: z.object({ wikiEntryId: uuid }).strict()
  },
  query: {
    workspaceSnapshot: noInputSchema,
    projectTree,
    searchPeople: z.object({ query: searchQuery, limit: z.number().int().min(1).max(100) }).strict(),
    getPerson: z.object({ personId: id }).strict(),
    listRelatives: z.object({ personId: id, kinds: z.array(z.enum(["parent", "spouse", "child"])).min(1).max(3) }).strict(),
    calculateRelationship: z.object({ viewpointId: id, targetId: id }).strict(),
    summarizeLineage: z.object({ lineageId: id, generation: z.number().int().min(1).optional() }).strict(),
    searchWiki: z.object({ query: searchQuery, limit: z.number().int().min(1).max(10_000) }).strict()
  },
  chat: {
    authorize: disclosureRequestSchema,
    stageMutation: stageMutationRequestSchema,
    ask: askRequestSchema,
    confirm: confirmDraftRequestSchema,
    revise: reviseDraftRequestSchema
  },
  mutations: {
    stage: z.object({ intents: z.array(mutationIntent).min(1).max(MAX_MUTATION_INTENTS) }).strict(),
    confirm: z.object({ draftId: uuid, draftVersion: z.number().int().min(1), selectedChangeIds: z.array(uuid).min(1).max(MAX_MUTATION_CHANGES), acknowledgedWarningCodes: z.array(z.string().trim().min(1).max(200)).max(MAX_MUTATION_CHANGES) }).strict(),
    revise: z.object({ draftId: uuid, intents: z.array(mutationIntent).min(1).max(MAX_MUTATION_INTENTS) }).strict()
  },
  modelSettings: {
    status: noInputSchema,
    saveKey: z.object({ key: z.string().trim().min(1).max(512) }).strict(),
    clearKey: noInputSchema
  },
  media: {
    import: z.object({ fileToken: uuid }).strict(),
    attach: z.object({ mediaAssetId: uuid, personId: id, caption: z.string().trim().max(500).optional() }).strict(),
    listForPerson: z.object({ personId: id }).strict()
  },
  dataManagement: {
    listAudit: noInputSchema,
    undoOperationGroup: z.object({ operationGroupId: uuid }).strict(),
    createBackup: noInputSchema,
    listRestoreTargets: noInputSchema,
    inspectBackup: z.object({ fileToken: uuid, targetWorkspaceId: uuid }).strict(),
    restoreBackup: z.object({ restoreToken: uuid, targetWorkspaceId: uuid, confirmReplace: z.literal(true) }).strict()
  }
} as const;

export type RpcGroup = keyof typeof RPC_INPUT_SCHEMAS;
