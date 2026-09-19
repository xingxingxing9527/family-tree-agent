import type { WorkspaceDatabase } from "../../database/open-database.js";
import { LineageRepository } from "../../database/repositories/lineage-repository.js";
import { RelationRepository } from "../../database/repositories/relation-repository.js";
import { GenerationService, type GenerationDisplay } from "../../domain/lineage/generation-service.js";

export class LineageService {
  private readonly lineages: LineageRepository;
  private readonly relations: RelationRepository;

  constructor(database: WorkspaceDatabase, workspaceId: string, private readonly generations = new GenerationService()) {
    this.lineages = new LineageRepository(database, workspaceId);
    this.relations = new RelationRepository(database, workspaceId);
  }

  generationDisplays(lineageId: string): Record<string, GenerationDisplay> {
    const lineage = this.lineages.get(lineageId);
    if (!lineage) throw new Error(`Lineage not found: ${lineageId}`);
    const memberships = this.lineages.listMemberships(lineageId).map((membership) => ({
      personId: membership.personId,
      lineageRole: membership.lineageRole,
      declaredGeneration: membership.declaredGeneration
    }));
    const parentChildFacts = this.relations.listParentChild().map((fact) => ({
      parentId: fact.parentId,
      childId: fact.childId,
      relationshipType: fact.relationshipType
    }));
    return this.generations.calculate({ founderPersonId: lineage.founderPersonId, memberships, parentChildFacts });
  }
}
