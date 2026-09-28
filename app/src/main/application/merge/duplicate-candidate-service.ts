import type { WorkspaceDatabase } from "../../database/open-database.js";
import { PersonRepository } from "../../database/repositories/person-repository.js";
import type { DuplicateCandidate } from "./merge-types.js";

const normalize = (value: string): string => value.toLocaleLowerCase().replace(/[\s·.，,]/g, "");
export class DuplicateCandidateService {
  constructor(private readonly database: WorkspaceDatabase, private readonly workspaceId: string) {}
  findDuplicateCandidates(personId: string): DuplicateCandidate[] {
    const people = new PersonRepository(this.database, this.workspaceId);
    const subject = people.get(personId); if (!subject) throw new Error("Person not found");
    const aliases = (id: string): string[] => [people.get(id, { includeArchived: true })?.displayName ?? "", ...people.listAliases(id).map((entry) => entry.name)].map(normalize).filter(Boolean);
    const subjectNames = aliases(personId);
    const parentSet = (id: string): Set<string> => new Set((this.database.prepare("SELECT parent_id FROM parent_child WHERE workspace_id = ? AND child_id = ? AND deleted_at IS NULL").pluck().all(this.workspaceId, id) as string[]));
    const spouseSet = (id: string): Set<string> => new Set((this.database.prepare("SELECT CASE WHEN spouse_a_id = ? THEN spouse_b_id ELSE spouse_a_id END FROM marriage WHERE workspace_id = ? AND (spouse_a_id = ? OR spouse_b_id = ?) AND deleted_at IS NULL").pluck().all(id, this.workspaceId, id, id) as string[]));
    const childSet = (id: string): Set<string> => new Set((this.database.prepare("SELECT child_id FROM parent_child WHERE workspace_id = ? AND parent_id = ? AND deleted_at IS NULL").pluck().all(this.workspaceId, id) as string[]));
    const intersect = (left: Set<string>, right: Set<string>): boolean => [...left].some((value) => right.has(value));
    return people.list().filter((person) => person.id !== personId).map((person) => {
      const reasons: DuplicateCandidate["reasons"] = [];
      if (aliases(person.id).some((name) => subjectNames.includes(name))) reasons.push({ code: "NAME_OVERLAP", detail: "姓名或别名相同" });
      if (subject.birth && person.birth && subject.birth.year === person.birth.year && subject.birth.month === person.birth.month) reasons.push({ code: "BIRTH_COMPATIBLE", detail: "出生日期相容" });
      if (intersect(parentSet(personId), parentSet(person.id))) reasons.push({ code: "SHARED_PARENT", detail: "共享父母" });
      if (intersect(spouseSet(personId), spouseSet(person.id))) reasons.push({ code: "SHARED_SPOUSE", detail: "共享配偶" });
      if (intersect(childSet(personId), childSet(person.id))) reasons.push({ code: "SHARED_CHILD", detail: "共享子女" });
      const score = reasons.reduce((sum, reason) => sum + ({ NAME_OVERLAP: 35, BIRTH_COMPATIBLE: 20, SHARED_PARENT: 35, SHARED_SPOUSE: 20, SHARED_CHILD: 20 }[reason.code]), 0);
      return { person, score, reasons };
    }).filter((candidate) => candidate.score >= 60).sort((a, b) => b.score - a.score || a.person.id.localeCompare(b.person.id));
  }
}
