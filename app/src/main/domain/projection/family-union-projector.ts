import type { PartialDate } from "../../../shared/domain.js";

export interface FamilyUnion {
  id: string;
  kind: "marriage" | "coParents" | "singleParent" | "unassigned";
  parentIds: string[];
  marriageId: string | null;
  marriageStatus: "active" | "divorced" | null;
  marriageStart: PartialDate | null;
  marriageEnd: PartialDate | null;
  childIds: string[];
  warnings: string[];
}

export interface FamilyUnionPerson {
  id: string;
  birth: PartialDate | null;
}

export interface FamilyUnionMarriage {
  id: string;
  spouseAId: string;
  spouseBId: string;
  status: "active" | "divorced";
  start: PartialDate | null;
  end: PartialDate | null;
}

export interface FamilyUnionParentChild {
  parentId: string;
  childId: string;
  relationshipType: "biological";
}

export interface FamilyUnionProjectionInput {
  people: FamilyUnionPerson[];
  marriages: FamilyUnionMarriage[];
  parentChildFacts: FamilyUnionParentChild[];
}

type IntervalRelation = "inside" | "outside" | "unknown";

interface DateRange {
  calendar: PartialDate["calendar"];
  minimum: CalendarPoint;
  maximum: CalendarPoint;
}

interface CalendarPoint {
  year: number;
  monthOrder: number;
  day: number;
}

const ordered = (ids: Iterable<string>): string[] => [...new Set(ids)].sort((left, right) => left.localeCompare(right));
const pairKey = (ids: Iterable<string>): string => ordered(ids).join(":");

function solarMonthLength(year: number, month: number): number {
  if (month === 2) {
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leapYear ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function dateRange(date: PartialDate): DateRange {
  const monthOrder = date.calendar === "lunar"
    ? date.month * 2 + (date.leapMonth ? 1 : 0)
    : date.month;
  const maximumDay = date.calendar === "lunar" ? 30 : solarMonthLength(date.year, date.month);
  return {
    calendar: date.calendar,
    minimum: { year: date.year, monthOrder, day: date.day ?? 1 },
    maximum: { year: date.year, monthOrder, day: date.day ?? maximumDay }
  };
}

function comparePoint(left: CalendarPoint, right: CalendarPoint): number {
  if (left.year !== right.year) return left.year < right.year ? -1 : 1;
  if (left.monthOrder !== right.monthOrder) return left.monthOrder < right.monthOrder ? -1 : 1;
  if (left.day !== right.day) return left.day < right.day ? -1 : 1;
  return 0;
}

function relationToInterval(birth: PartialDate | null, marriage: FamilyUnionMarriage): IntervalRelation {
  if (!birth || (!marriage.start && !marriage.end)) return "unknown";
  const child = dateRange(birth);
  const start = marriage.start ? dateRange(marriage.start) : null;
  const end = marriage.end ? dateRange(marriage.end) : null;
  if ((start && start.calendar !== child.calendar) || (end && end.calendar !== child.calendar)) return "unknown";
  if ((start && comparePoint(child.maximum, start.minimum) < 0) || (end && comparePoint(child.minimum, end.maximum) > 0)) return "outside";

  const afterStart = !start || comparePoint(child.minimum, start.maximum) >= 0;
  const beforeEnd = !end || comparePoint(child.maximum, end.minimum) <= 0;
  return afterStart && beforeEnd ? "inside" : "unknown";
}

function emptyUnion(id: string, kind: FamilyUnion["kind"], parentIds: string[], marriage?: FamilyUnionMarriage): FamilyUnion {
  return {
    id,
    kind,
    parentIds,
    marriageId: marriage?.id ?? null,
    marriageStatus: marriage?.status ?? null,
    marriageStart: marriage?.start ?? null,
    marriageEnd: marriage?.end ?? null,
    childIds: [],
    warnings: []
  };
}

export class FamilyUnionProjector {
  project(input: FamilyUnionProjectionInput): FamilyUnion[] {
    const people = new Map(input.people.map((person) => [person.id, person]));
    const unions = new Map<string, FamilyUnion>();
    const marriagesByPair = new Map<string, FamilyUnionMarriage[]>();

    for (const marriage of [...input.marriages].sort((left, right) => left.id.localeCompare(right.id))) {
      const parentIds = ordered([marriage.spouseAId, marriage.spouseBId]);
      unions.set(`marriage:${marriage.id}`, emptyUnion(`marriage:${marriage.id}`, "marriage", parentIds, marriage));
      const key = pairKey(parentIds);
      const marriages = marriagesByPair.get(key) ?? [];
      marriages.push(marriage);
      marriagesByPair.set(key, marriages);
    }

    const parentsByChild = new Map<string, Set<string>>();
    for (const fact of input.parentChildFacts) {
      const parents = parentsByChild.get(fact.childId) ?? new Set<string>();
      parents.add(fact.parentId);
      parentsByChild.set(fact.childId, parents);
    }

    for (const [childId, parents] of [...parentsByChild].sort(([left], [right]) => left.localeCompare(right))) {
      const parentIds = ordered(parents);
      if (parentIds.length === 1) {
        this.addChild(unions, emptyUnion(`single:${parentIds[0]}`, "singleParent", parentIds), childId);
        continue;
      }

      const pair = parentIds.slice(0, 2);
      const key = pairKey(pair);
      const marriages = marriagesByPair.get(key) ?? [];
      if (marriages.length === 0) {
        this.addChild(unions, emptyUnion(`parents:${key}`, "coParents", pair), childId);
        continue;
      }
      if (marriages.length === 1) {
        unions.get(`marriage:${marriages[0].id}`)!.childIds.push(childId);
        continue;
      }

      const birth = people.get(childId)?.birth ?? null;
      const relations = marriages.map((marriage) => ({ marriage, relation: relationToInterval(birth, marriage) }));
      const inside = relations.filter((candidate) => candidate.relation === "inside");
      const selected = inside.length === 1 && relations.every((candidate) => candidate === inside[0] || candidate.relation === "outside")
        ? inside[0].marriage
        : null;
      if (selected) {
        unions.get(`marriage:${selected.id}`)!.childIds.push(childId);
        continue;
      }

      const union = emptyUnion(`unassigned:${key}`, "unassigned", pair);
      this.addChild(unions, union, childId, `Child ${childId} cannot be assigned unambiguously across marriages ${marriages.map((marriage) => marriage.id).sort().join(", ")}.`);
    }

    return [...unions.values()]
      .map((union) => ({
        ...union,
        parentIds: ordered(union.parentIds),
        childIds: ordered(union.childIds),
        warnings: [...union.warnings].sort((left, right) => left.localeCompare(right))
      }))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  private addChild(unions: Map<string, FamilyUnion>, proposed: FamilyUnion, childId: string, warning?: string): void {
    const union = unions.get(proposed.id) ?? proposed;
    union.childIds.push(childId);
    if (warning) union.warnings.push(warning);
    unions.set(union.id, union);
  }
}
