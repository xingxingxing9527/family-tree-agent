import { randomUUID } from "node:crypto";
import type { WorkspaceDatabase } from "./open-database.js";
import { AuditRepository } from "./repositories/audit-repository.js";
import { LineageRepository } from "./repositories/lineage-repository.js";
import { ImportIdentityRepository } from "./repositories/import-identity-repository.js";
import { PersonRepository } from "./repositories/person-repository.js";
import { RelationRepository } from "./repositories/relation-repository.js";
import { SourceRepository } from "./repositories/source-repository.js";
import { FactSourceLinkRepository } from "./repositories/fact-source-link-repository.js";

export interface UnitOfWork {
  run<T>(kind: string, work: (ctx: TransactionContext) => T): T;
}

export interface TransactionContext {
  operationGroupId: string;
  people: PersonRepository;
  relations: RelationRepository;
  lineages: LineageRepository;
  importIdentities: ImportIdentityRepository;
  sources: SourceRepository;
  factSources: FactSourceLinkRepository;
  audit: AuditRepository;
}

export class SqliteUnitOfWork implements UnitOfWork {
  constructor(private readonly database: WorkspaceDatabase, private readonly workspaceId: string) {}

  run<T>(kind: string, work: (ctx: TransactionContext) => T): T {
    const operationGroupId = randomUUID();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const now = new Date().toISOString();
      this.database.prepare("INSERT INTO operation_group (id, workspace_id, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(operationGroupId, this.workspaceId, kind, now, now);
      const ctx: TransactionContext = {
        operationGroupId,
        people: new PersonRepository(this.database, this.workspaceId),
        relations: new RelationRepository(this.database, this.workspaceId),
        lineages: new LineageRepository(this.database, this.workspaceId),
        importIdentities: new ImportIdentityRepository(this.database, this.workspaceId),
        sources: new SourceRepository(this.database, this.workspaceId),
        factSources: new FactSourceLinkRepository(this.database, this.workspaceId),
        audit: new AuditRepository(this.database, this.workspaceId, operationGroupId)
      };
      const result = work(ctx);
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      if (this.database.inTransaction) this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

export const createUnitOfWork = (database: WorkspaceDatabase, workspaceId: string): UnitOfWork => new SqliteUnitOfWork(database, workspaceId);
