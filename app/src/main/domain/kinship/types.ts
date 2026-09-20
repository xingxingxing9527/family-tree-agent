import type { PartialDate } from "../../../shared/domain.js";

export type KinshipGender = "male" | "female" | "unknown";

export type KinshipStep =
  | "father" | "mother" | "parent"
  | "son" | "daughter" | "child"
  | "olderBrother" | "youngerBrother" | "brother"
  | "olderSister" | "youngerSister" | "sister"
  | "husband" | "wife" | "spouse"
  | "formerHusband" | "formerWife" | "formerSpouse";

export interface KinshipSignature {
  steps: KinshipStep[];
  generationDelta: number;
  lineageSide: "paternal" | "maternal" | "self" | "affinity" | "unknown";
  bloodAffinity: "blood" | "currentAffinity" | "directFormerSpouse";
  viewpointGender: KinshipGender;
  targetGender: KinshipGender;
  relativeAgeOrder: "older" | "younger" | "same" | "unknown";
  pathPersonIds: string[];
  pathRelationIds: string[];
}

export interface RelationshipAlternative {
  primaryTerm: string | null;
  reverseTerm: string | null;
  description: string;
  signature: KinshipSignature;
}

export interface RelationshipResult {
  primaryTerm: string | null;
  reverseTerm: string | null;
  description: string;
  ruleVersion: string;
  signature: KinshipSignature;
  alternatives: RelationshipAlternative[];
  uncertainty: string[];
}

export interface KinshipPerson {
  id: string;
  gender: KinshipGender;
  birth: PartialDate | null;
  conflictIds?: string[];
}

export interface ParentChildFact {
  id: string;
  parentId: string;
  childId: string;
  parentRole: "father" | "mother";
  conflictIds?: string[];
}

export interface MarriageFact {
  id: string;
  spouseAId: string;
  spouseBId: string;
  status: "active" | "divorced";
  conflictIds?: string[];
}

export interface KinshipFactGraph {
  people: KinshipPerson[];
  parentChild: ParentChildFact[];
  marriages: MarriageFact[];
}

export type RelationEdgeKind = "parentChild" | "marriage" | "formerMarriage";

export interface RelationEdge {
  relationId: string;
  fromPersonId: string;
  toPersonId: string;
  step: KinshipStep;
  inverseStep: KinshipStep;
  kind: RelationEdgeKind;
  conflictIds: string[];
}

export interface RelationGraph {
  people: ReadonlyMap<string, KinshipPerson>;
  adjacency: ReadonlyMap<string, readonly RelationEdge[]>;
}

export interface KinshipPath {
  edges: RelationEdge[];
  personIds: string[];
  relationIds: string[];
  rank: 0 | 1 | 2;
}

export interface KinshipSignaturePair {
  forward: KinshipSignature;
  reverse: KinshipSignature;
  uncertainty: string[];
}
