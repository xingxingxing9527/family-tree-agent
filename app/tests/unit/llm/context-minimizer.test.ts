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

  it("redacts an entire sensitive string without corrupting dates or fractions", () => {
    const minimized = minimizeConversationContext({
      question: "日期 2026/09/28，比例 1/2；文件 C:\\Family Files\\tree.db；OPENAI_API_KEY=env-secret",
      viewpointId: "v", selectedPersonId: null, neededCandidateIds: [], candidatePeople: [], toolResults: [{
        callId: "c", name: "search_wiki", arguments: { query: "q", limit: 1 },
        output: [{ wikiEntryId: "w", title: "日期 2026/09/28 比例 1/2", excerpt: "see file:///Users/me/tree.db and trailing words", sourceIds: [] }]
      }]
    });
    expect(minimized.question).toBe("[REDACTED]");
    expect(minimized.toolResults[0]?.output).toEqual([{ wikiEntryId: "w", title: "日期 2026/09/28 比例 1/2", excerpt: "[REDACTED]", sourceIds: [] }]);
    expect(JSON.stringify(minimized)).not.toMatch(/Family Files|tree\.db|OPENAI_API_KEY|env-secret|trailing words/i);
  });

  it.each([
    "/001.jpg",
    "/2026/09/001.jpg",
    "~/family/private.txt",
    "./family/private.txt",
    "../family/private.txt",
    "family/private.txt",
    "family/photos/private.jpg",
    "家谱/照片.jpg",
    "C:private.txt",
    "\\family\\private.txt",
    "KEY=env-secret",
    "TOKEN=env-secret",
    "SECRET=env-secret",
    "PASSWORD=hunter2",
    "PASS=hunter2",
    "PWD=private",
    "OPENAI_KEY=env-secret",
    "DB_PASS=hunter2",
    "SESSION_PWD=private"
  ])("whole-redacts file paths and credential assignments %s", (question) => {
    expect(minimizeConversationContext({ question, viewpointId: "v", selectedPersonId: null, neededCandidateIds: [], candidatePeople: [], toolResults: [] }).question).toBe("[REDACTED]");
  });

  it("preserves ordinary slash dates, fractions, and Chinese prose", () => {
    const question = "生于 1970/01/02，份额是 1/2，这是普通中文。";
    expect(minimizeConversationContext({ question, viewpointId: "v", selectedPersonId: null, neededCandidateIds: [], candidatePeople: [], toolResults: [] }).question).toBe(question);
  });

  it("ignores ambiguous one-character aliases while retaining every duplicate full-name match", () => {
    const candidates = [
      { id: "p1", displayName: "张敏", aliases: ["敏"], gender: "female", birth: null, parentHints: [] },
      { id: "p2", displayName: "张敏", aliases: ["小敏"], gender: "female", birth: null, parentHints: [] },
      { id: "p3", displayName: "王敏", aliases: ["敏"], gender: "female", birth: null, parentHints: [] }
    ] as never;
    expect(selectRelevantCandidates("敏是谁", candidates)).toEqual([]);
    expect(selectRelevantCandidates("张敏是谁", candidates).map((entry) => entry.id)).toEqual(["p1", "p2"]);
  });
});
