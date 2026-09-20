import { describe, expect, it } from "vitest";
import { createRelationGraph } from "../../../../src/main/domain/kinship/relation-graph";
import { findKinshipPaths } from "../../../../src/main/domain/kinship/path-search";
import type { KinshipFactGraph, KinshipPerson } from "../../../../src/main/domain/kinship/types";

const person = (id: string, gender: KinshipPerson["gender"] = "unknown"): KinshipPerson => ({
  id,
  gender,
  birth: null
});

const graph = (input: Partial<KinshipFactGraph>) => createRelationGraph({
  people: input.people ?? [],
  parentChild: input.parentChild ?? [],
  marriages: input.marriages ?? []
});

describe("findKinshipPaths", () => {
  it("prefers the shortest path over a longer derived route", () => {
    const relationGraph = graph({
      people: [person("source"), person("middle"), person("target")],
      parentChild: [
        { id: "direct", parentId: "source", childId: "target", parentRole: "father" },
        { id: "source-middle", parentId: "source", childId: "middle", parentRole: "father" },
        { id: "middle-target", parentId: "middle", childId: "target", parentRole: "father" }
      ]
    });

    const paths = findKinshipPaths(relationGraph, "source", "target");

    expect(paths.map((path) => path.relationIds)).toEqual([["direct"]]);
    expect(paths[0]?.rank).toBe(0);
  });

  it("retains every equal-length equal-rank path in stable relation-id order", () => {
    const relationGraph = graph({
      people: [person("source"), person("father"), person("mother"), person("target")],
      parentChild: [
        { id: "f-source", parentId: "father", childId: "source", parentRole: "father" },
        { id: "f-target", parentId: "father", childId: "target", parentRole: "father" },
        { id: "m-source", parentId: "mother", childId: "source", parentRole: "mother" },
        { id: "m-target", parentId: "mother", childId: "target", parentRole: "mother" }
      ]
    });

    const paths = findKinshipPaths(relationGraph, "source", "target");

    expect(paths.map((path) => path.personIds)).toEqual([
      ["source", "father", "target"],
      ["source", "mother", "target"]
    ]);
    expect(paths.map((path) => path.relationIds)).toEqual([
      ["f-source", "f-target"],
      ["m-source", "m-target"]
    ]);
  });

  it("ranks a pure blood path before an equal-length current-affinity path", () => {
    const relationGraph = graph({
      people: [person("source"), person("blood-parent"), person("spouse"), person("target")],
      parentChild: [
        { id: "blood-up", parentId: "blood-parent", childId: "source", parentRole: "father" },
        { id: "blood-down", parentId: "blood-parent", childId: "target", parentRole: "father" },
        { id: "affinity-down", parentId: "spouse", childId: "target", parentRole: "mother" }
      ],
      marriages: [
        { id: "current-marriage", spouseAId: "source", spouseBId: "spouse", status: "active" }
      ]
    });

    const paths = findKinshipPaths(relationGraph, "source", "target");

    expect(paths).toHaveLength(1);
    expect(paths[0]?.relationIds).toEqual(["blood-up", "blood-down"]);
    expect(paths[0]?.rank).toBe(1);
  });

  it("traverses an active marriage and ranks a direct current spouse fact first", () => {
    const relationGraph = graph({
      people: [person("source", "female"), person("spouse", "male"), person("parent", "male")],
      parentChild: [
        { id: "spouse-parent", parentId: "parent", childId: "spouse", parentRole: "father" }
      ],
      marriages: [
        { id: "current-marriage", spouseAId: "source", spouseBId: "spouse", status: "active" }
      ]
    });

    expect(findKinshipPaths(relationGraph, "source", "spouse").map((path) => ({
      relationIds: path.relationIds,
      rank: path.rank
    }))).toEqual([{ relationIds: ["current-marriage"], rank: 0 }]);
    expect(findKinshipPaths(relationGraph, "source", "parent")[0]?.relationIds).toEqual([
      "current-marriage",
      "spouse-parent"
    ]);
  });

  it("returns a divorced edge only for its two direct endpoints", () => {
    const relationGraph = graph({
      people: [person("source"), person("former"), person("former-child")],
      parentChild: [
        { id: "former-child-fact", parentId: "former", childId: "former-child", parentRole: "father" }
      ],
      marriages: [
        { id: "former-marriage", spouseAId: "source", spouseBId: "former", status: "divorced" }
      ]
    });

    const direct = findKinshipPaths(relationGraph, "source", "former");

    expect(direct.map((path) => path.relationIds)).toEqual([["former-marriage"]]);
    expect(direct[0]?.edges[0]?.kind).toBe("formerMarriage");
    expect(findKinshipPaths(relationGraph, "source", "former-child")).toEqual([]);
  });

  it("uses per-path visited people so cycles cannot create duplicate longer candidates", () => {
    const relationGraph = graph({
      people: [person("source"), person("parent"), person("target")],
      parentChild: [
        { id: "up", parentId: "parent", childId: "source", parentRole: "father" },
        { id: "down", parentId: "parent", childId: "target", parentRole: "father" }
      ]
    });

    const paths = findKinshipPaths(relationGraph, "source", "target");

    expect(paths).toHaveLength(1);
    expect(paths[0]?.personIds).toEqual(["source", "parent", "target"]);
  });

  it("orders tied evidence by codepoint rather than the host locale", () => {
    const relationGraph = graph({
      people: [person("source"), person("z-parent"), person("umlaut-parent"), person("target")],
      parentChild: [
        { id: "z-source", parentId: "z-parent", childId: "source", parentRole: "father" },
        { id: "z-target", parentId: "z-parent", childId: "target", parentRole: "father" },
        { id: "ä-source", parentId: "umlaut-parent", childId: "source", parentRole: "mother" },
        { id: "ä-target", parentId: "umlaut-parent", childId: "target", parentRole: "mother" }
      ]
    });

    expect(findKinshipPaths(relationGraph, "source", "target").map((path) => path.relationIds)).toEqual([
      ["z-source", "z-target"],
      ["ä-source", "ä-target"]
    ]);
  });
});
