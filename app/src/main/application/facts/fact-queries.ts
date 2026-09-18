import type { WorkspaceDatabase } from "../../database/open-database.js";
import { PersonRepository, type PersonRecord } from "../../database/repositories/person-repository.js";
import { RelationRepository, type MarriageRecord, type ParentChildRecord } from "../../database/repositories/relation-repository.js";

export class FactQueries {
  private readonly people: PersonRepository;
  private readonly relations: RelationRepository;

  constructor(database: WorkspaceDatabase, workspaceId: string) {
    this.people = new PersonRepository(database, workspaceId);
    this.relations = new RelationRepository(database, workspaceId);
  }

  listPeople(): PersonRecord[] {
    return this.people.list();
  }

  listParentChild(): ParentChildRecord[] {
    return this.relations.listParentChild();
  }

  listMarriages(): MarriageRecord[] {
    return this.relations.listMarriages();
  }
}
