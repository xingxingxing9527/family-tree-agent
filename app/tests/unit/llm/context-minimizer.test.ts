import { describe, expect, it } from "vitest";
import { minimizeConversationContext, selectRelevantCandidates } from "../../../src/main/application/chat/context-minimizer";

describe("minimizeConversationContext", () => {
  it("keeps only the current question, identifiers, needed candidates, and bounded tool results", () => {
    const minimized = minimizeConversationContext({
      question: "张国强有几个孩子？",
      viewpointId: "viewpoint-1",
      selectedPersonId: "person-1",
      neededCandidateIds: ["person-1"],
      candidatePeople: [
        {
          id: "person-1", displayName: "张国强", aliases: ["国强"], gender: "male",
          birth: null, parentHints: [], localPath: "C:\\secret\\photo.jpg", mediaBytes: "base64-private"
        },
        {
          id: "unrelated", displayName: "无关人物", aliases: [], gender: "unknown",
          birth: null, parentHints: [], auditHistory: [{ before: "secret" }]
        }
      ] as never,
      toolResults: [{
        callId: "call-1", name: "list_relatives", arguments: { personId: "person-1", kinds: ["child"] },
        output: [{ kind: "child", person: { id: "child-1", displayName: "张敏", citation: "C:\\private\\source.txt" }, filePath: "D:\\private\\tree.db", uri: "file:///private/source.txt", mediaBytes: "raw" }]
      }],
      modelKey: "sk-must-never-leave-main",
      auditHistory: [{ action: "deleted" }]
    } as never);

    expect(minimized).toEqual({
      question: "张国强有几个孩子？",
      viewpointId: "viewpoint-1",
      selectedPersonId: "person-1",
      candidatePeople: [{
        id: "person-1", displayName: "张国强", aliases: ["国强"], gender: "male", birth: null, parentHints: []
      }],
      toolResults: [{
        callId: "call-1", name: "list_relatives", arguments: { personId: "person-1", kinds: ["child"] },
        output: [{ kind: "child", person: { id: "child-1", displayName: "张敏" } }]
      }]
    });
    expect(JSON.stringify(minimized)).not.toMatch(/secret|private|mediaBytes|localPath|audit|modelKey|unrelated/i);
  });

  it("rejects oversized questions and tool output instead of forwarding unbounded context", () => {
    expect(() => minimizeConversationContext({
      question: "x".repeat(4_001), viewpointId: "v", selectedPersonId: null,
      neededCandidateIds: [], candidatePeople: [], toolResults: []
    })).toThrow(/question/i);
    expect(() => minimizeConversationContext({
      question: "q", viewpointId: "v", selectedPersonId: null, neededCandidateIds: [], candidatePeople: [],
      toolResults: [{ callId: "c", name: "search_wiki", arguments: { query: "q", limit: 5 }, output: [{ wikiEntryId: "w", title: "t", excerpt: "x".repeat(32_001), sourceIds: [] }] }]
    })).toThrow(/tool result/i);
  });

  it("selects only candidates named by current text or identifiers", () => {
    const candidates = [
      { id: "p1", displayName: "张国强", aliases: ["国强"], gender: "male", birth: null, parentHints: [] },
      { id: "p2", displayName: "无关人物", aliases: [], gender: "unknown", birth: null, parentHints: [] }
    ] as never;
    expect(selectRelevantCandidates("请更新国强", candidates, ["p1"])).toEqual([candidates[0]]);
    expect(selectRelevantCandidates("请更新张国强", candidates, [])).toEqual([candidates[0]]);
  });
});
