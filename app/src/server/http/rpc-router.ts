import type { FastifyInstance } from "fastify";
import type { ZodType } from "zod";
import { RPC_INPUT_SCHEMAS, rpcRequestSchema } from "../../shared/api-schemas.js";
import type { FamilyAgentApi } from "../../shared/contracts.js";
import { invalidRpcRequest, mapUnexpectedRpcError, sanitizeRpcResponse } from "./error-mapper.js";

type RpcInvoker = (input: never) => Promise<unknown>;
interface RpcMethod { schema: ZodType; invoke: RpcInvoker; }
type RpcAllowlist = Readonly<Record<string, Readonly<Record<string, RpcMethod>>>>;

function allowlist(service: FamilyAgentApi): RpcAllowlist {
  const entry = (schema: ZodType, invoke: RpcInvoker): RpcMethod => ({ schema, invoke });
  return {
    people: {
      list: entry(RPC_INPUT_SCHEMAS.people.list, (input) => service.people.list(input)),
      get: entry(RPC_INPUT_SCHEMAS.people.get, (input) => service.people.get(input)),
      save: entry(RPC_INPUT_SCHEMAS.people.save, (input) => service.people.save(input)),
      update: entry(RPC_INPUT_SCHEMAS.people.update, (input) => service.people.update(input)),
      setChildrenCompleteness: entry(RPC_INPUT_SCHEMAS.people.setChildrenCompleteness, (input) => service.people.setChildrenCompleteness(input)),
      getChildrenCountStatus: entry(RPC_INPUT_SCHEMAS.people.getChildrenCountStatus, (input) => service.people.getChildrenCountStatus(input))
    },
    relations: {
      addParentChild: entry(RPC_INPUT_SCHEMAS.relations.addParentChild, (input) => service.relations.addParentChild(input)),
      addMarriage: entry(RPC_INPUT_SCHEMAS.relations.addMarriage, (input) => service.relations.addMarriage(input)),
      divorce: entry(RPC_INPUT_SCHEMAS.relations.divorce, (input) => service.relations.divorce(input))
    },
    lineages: {
      createLineage: entry(RPC_INPUT_SCHEMAS.lineages.createLineage, (input) => service.lineages.createLineage(input)),
      updateLineage: entry(RPC_INPUT_SCHEMAS.lineages.updateLineage, (input) => service.lineages.updateLineage(input)),
      archiveLineage: entry(RPC_INPUT_SCHEMAS.lineages.archiveLineage, (input) => service.lineages.archiveLineage(input)),
      addMembership: entry(RPC_INPUT_SCHEMAS.lineages.addMembership, (input) => service.lineages.addMembership(input)),
      updateMembership: entry(RPC_INPUT_SCHEMAS.lineages.updateMembership, (input) => service.lineages.updateMembership(input)),
      removeMembership: entry(RPC_INPUT_SCHEMAS.lineages.removeMembership, (input) => service.lineages.removeMembership(input))
    },
    imports: {
      parse: entry(RPC_INPUT_SCHEMAS.imports.parse, (input) => service.imports.parse(input)),
      commit: entry(RPC_INPUT_SCHEMAS.imports.commit, (input) => service.imports.commit(input)),
      exportTemplate: entry(RPC_INPUT_SCHEMAS.imports.exportTemplate, () => service.imports.exportTemplate())
    },
    merges: {
      findDuplicateCandidates: entry(RPC_INPUT_SCHEMAS.merges.findDuplicateCandidates, (input) => service.merges.findDuplicateCandidates(input)),
      preview: entry(RPC_INPUT_SCHEMAS.merges.preview, (input) => service.merges.preview(input)),
      merge: entry(RPC_INPUT_SCHEMAS.merges.merge, (input) => service.merges.merge(input)),
      history: entry(RPC_INPUT_SCHEMAS.merges.history, () => service.merges.history()),
      canUnmerge: entry(RPC_INPUT_SCHEMAS.merges.canUnmerge, (input) => service.merges.canUnmerge(input)),
      unmerge: entry(RPC_INPUT_SCHEMAS.merges.unmerge, (input) => service.merges.unmerge(input))
    },
    wiki: {
      list: entry(RPC_INPUT_SCHEMAS.wiki.list, (input) => service.wiki.list(input)),
      create: entry(RPC_INPUT_SCHEMAS.wiki.create, (input) => service.wiki.create(input)),
      update: entry(RPC_INPUT_SCHEMAS.wiki.update, (input) => service.wiki.update(input)),
      remove: entry(RPC_INPUT_SCHEMAS.wiki.remove, (input) => service.wiki.remove(input)),
      get: entry(RPC_INPUT_SCHEMAS.wiki.get, (input) => service.wiki.get(input))
    },
    query: {
      workspaceSnapshot: entry(RPC_INPUT_SCHEMAS.query.workspaceSnapshot, () => service.query.workspaceSnapshot()),
      projectTree: entry(RPC_INPUT_SCHEMAS.query.projectTree, (input) => service.query.projectTree(input)),
      searchPeople: entry(RPC_INPUT_SCHEMAS.query.searchPeople, (input) => service.query.searchPeople(input)),
      getPerson: entry(RPC_INPUT_SCHEMAS.query.getPerson, (input) => service.query.getPerson(input)),
      listRelatives: entry(RPC_INPUT_SCHEMAS.query.listRelatives, (input) => service.query.listRelatives(input)),
      calculateRelationship: entry(RPC_INPUT_SCHEMAS.query.calculateRelationship, (input) => service.query.calculateRelationship(input)),
      summarizeLineage: entry(RPC_INPUT_SCHEMAS.query.summarizeLineage, (input) => service.query.summarizeLineage(input)),
      searchWiki: entry(RPC_INPUT_SCHEMAS.query.searchWiki, (input) => service.query.searchWiki(input))
    },
    chat: {
      authorize: entry(RPC_INPUT_SCHEMAS.chat.authorize, (input) => service.chat.authorize(input)),
      stageMutation: entry(RPC_INPUT_SCHEMAS.chat.stageMutation, (input) => service.chat.stageMutation(input)),
      ask: entry(RPC_INPUT_SCHEMAS.chat.ask, (input) => service.chat.ask(input)),
      confirm: entry(RPC_INPUT_SCHEMAS.chat.confirm, (input) => service.chat.confirm(input)),
      revise: entry(RPC_INPUT_SCHEMAS.chat.revise, (input) => service.chat.revise(input))
    },
    modelSettings: {
      status: entry(RPC_INPUT_SCHEMAS.modelSettings.status, () => service.modelSettings.status())
    },
    media: {
      import: entry(RPC_INPUT_SCHEMAS.media.import, (input) => service.media.import(input)),
      attach: entry(RPC_INPUT_SCHEMAS.media.attach, (input) => service.media.attach(input)),
      listForPerson: entry(RPC_INPUT_SCHEMAS.media.listForPerson, (input) => service.media.listForPerson(input))
    },
    dataManagement: {
      listAudit: entry(RPC_INPUT_SCHEMAS.dataManagement.listAudit, () => service.dataManagement.listAudit()),
      undoOperationGroup: entry(RPC_INPUT_SCHEMAS.dataManagement.undoOperationGroup, (input) => service.dataManagement.undoOperationGroup(input)),
      createBackup: entry(RPC_INPUT_SCHEMAS.dataManagement.createBackup, () => service.dataManagement.createBackup()),
      listRestoreTargets: entry(RPC_INPUT_SCHEMAS.dataManagement.listRestoreTargets, () => service.dataManagement.listRestoreTargets()),
      inspectBackup: entry(RPC_INPUT_SCHEMAS.dataManagement.inspectBackup, (input) => service.dataManagement.inspectBackup(input)),
      restoreBackup: entry(RPC_INPUT_SCHEMAS.dataManagement.restoreBackup, (input) => service.dataManagement.restoreBackup(input))
    }
  };
}

export function registerRpcRoutes(server: FastifyInstance, service: FamilyAgentApi): void {
  const routes = allowlist(service);
  server.post<{ Params: { group: string; method: string } }>("/api/rpc/:group/:method", async (request, reply) => {
    const envelope = rpcRequestSchema.safeParse(request.body);
    const group = Object.prototype.hasOwnProperty.call(routes, request.params.group)
      ? routes[request.params.group]
      : undefined;
    const method = group && Object.prototype.hasOwnProperty.call(group, request.params.method)
      ? group[request.params.method]
      : undefined;
    if (!envelope.success || !method) {
      const error = invalidRpcRequest(!envelope.success ? envelope.error.issues[0]?.path.join(".") || "request" : "method");
      return reply.code(error.statusCode).send(error.body);
    }
    const input = method.schema.safeParse(envelope.data.input);
    if (!input.success) {
      const error = invalidRpcRequest(input.error.issues[0]?.path.join(".") || "input");
      return reply.code(error.statusCode).send(error.body);
    }
    try {
      return reply.code(200).send(sanitizeRpcResponse(await method.invoke(input.data as never)));
    } catch {
      const error = mapUnexpectedRpcError();
      return reply.code(error.statusCode).send(error.body);
    }
  });
}
