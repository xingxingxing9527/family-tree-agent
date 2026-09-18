import type { WorkspaceDatabase } from "../../database/open-database.js";
import { PersonRepository, type PersonAliasRecord, type PersonRecord } from "../../database/repositories/person-repository.js";
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

  getPerson(personId: string): PersonRecord | null {
    return this.people.get(personId);
  }

  listAliases(personId: string): PersonAliasRecord[] {
    return this.people.listAliases(personId);
  }

  listParentChild(): ParentChildRecord[] {
    return this.relations.listParentChild();
  }

  listMarriages(): MarriageRecord[] {
    return this.relations.listMarriages();
  }
}
