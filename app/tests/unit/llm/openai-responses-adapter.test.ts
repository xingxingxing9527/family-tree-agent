import { describe, expect, it, vi } from "vitest";
import { OpenAIResponsesAdapter } from "../../../src/main/llm/openai-responses-adapter";
import type { ConversationMutationDraft } from "../../../src/shared/chat";

const emptyDraft: ConversationMutationDraft = {
  candidatePeople: [], parentChildFacts: [], marriages: [], sources: [], fieldConfidence: [], unresolvedReferences: []
};

describe("OpenAIResponsesAdapter", () => {
  it("uses stateless Responses structured output with a strict schema and revalidates output_text", async () => {
    const create = vi.fn().mockResolvedValue({ status: "completed", output_text: JSON.stringify(emptyDraft), output: [] });
    const adapter = new OpenAIResponsesAdapter({ apiKey: "sk-private", model: "gpt-test", client: { responses: { create } } as never });

    await expect(adapter.extractDraft({ text: "张国强有两个孩子，附件 C:\\Users\\me\\tree.db、/etc/passwd、https://sensitive.test，密钥 sk-secret-value", candidatePeople: [{
      id: "person", displayName: "张国强", aliases: [], gender: "male", birth: null, parentHints: [], localPath: "C:\\private\\tree.db", mediaBytes: "raw"
    }, {
      id: "unrelated", displayName: "无关人物", aliases: [], gender: "unknown", birth: null, parentHints: []
    }] as never })).resolves.toEqual(emptyDraft);
    const request = create.mock.calls[0]![0];
    expect(request).toMatchObject({ model: "gpt-test", store: false, text: { format: { type: "json_schema", name: "conversation_mutation_draft", strict: true } } });
    expect(request).not.toHaveProperty("response_format");
    expect(request.text.format.schema).toMatchObject({ type: "object", additionalProperties: false });
    expect(request.text.format.schema).not.toHaveProperty("$schema");
    expect(request.text.format.schema.required).toEqual(expect.arrayContaining([
      "candidatePeople", "parentChildFacts", "marriages", "sources", "fieldConfidence", "unresolvedReferences"
    ]));
    const inspectSchema = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      const record = value as Record<string, unknown>;
      expect(Object.keys(record)).not.toEqual(expect.arrayContaining(["allOf", "not", "if", "then", "else", "dependentRequired", "dependentSchemas"]));
      if (record.type === "object" && record.properties && typeof record.properties === "object") {
        expect(record.additionalProperties).toBe(false);
        expect(new Set(record.required as string[])).toEqual(new Set(Object.keys(record.properties as object)));
      }
      Object.values(record).forEach(inspectSchema);
    };
    inspectSchema(request.text.format.schema);
    expect(JSON.stringify(request)).not.toContain("sk-private");
    expect(JSON.stringify(request)).not.toMatch(/localPath|mediaBytes|private|Users\\me|etc\\?\/passwd|sensitive\.test|sk-secret|无关人物/i);
    expect(request).toMatchObject({ max_output_tokens: expect.any(Number) });
  });

  it("rejects output that does not satisfy the shared IPC schema", async () => {
    const create = vi.fn().mockResolvedValue({ status: "completed", output_text: JSON.stringify({ ...emptyDraft, sql: "DELETE FROM person" }), output: [] });
    const adapter = new OpenAIResponsesAdapter({ apiKey: "sk-private", model: "gpt-test", client: { responses: { create } } as never });

    await expect(adapter.extractDraft({ text: "text", candidatePeople: [] })).rejects.toMatchObject({ code: "MODEL_PROTOCOL" });
  });

  it("enforces whole-value secrecy and ambiguity-safe candidates on the final extraction envelope", async () => {
    const create = vi.fn().mockResolvedValue({ status: "completed", output_text: JSON.stringify(emptyDraft), output: [] });
    const adapter = new OpenAIResponsesAdapter({ apiKey: "key", model: "m", client: { responses: { create } } as never });
    await adapter.extractDraft({
      text: "张敏 2026/09/28 1/2 C:\\Family Files\\tree.db OPENAI_API_KEY=env-secret file:///Users/me/a.jpg",
      candidatePeople: [
        { id: "p1", displayName: "张敏", aliases: ["敏"], gender: "female", birth: null, parentHints: [] },
        { id: "p2", displayName: "张敏", aliases: [], gender: "female", birth: null, parentHints: [] },
        { id: "p3", displayName: "王敏", aliases: ["敏"], gender: "female", birth: null, parentHints: [] }
      ]
    });
    const request = create.mock.calls[0]![0];
    const envelope = JSON.parse(request.input);
    expect(envelope.text).toBe("[REDACTED]");
    expect(envelope.candidatePeople.map((entry: { id: string }) => entry.id)).toEqual(["p1", "p2"]);
    expect(JSON.stringify(request)).not.toMatch(/Family Files|tree\.db|OPENAI_API_KEY|env-secret|file:\/\/\/Users/i);
    expect(JSON.stringify(request.text.format.schema)).toMatch(/minLength|maxLength|minimum|maxItems/);
  });

  it("defines only six strict read tools and correlates outputs with the original call_id", async () => {
    const create = vi.fn().mockResolvedValue({ status: "completed", output_text: JSON.stringify({ answer: "完成" }), output: [] });
    const adapter = new OpenAIResponsesAdapter({ apiKey: "sk-private", model: "gpt-test", client: { responses: { create } } as never });

    await adapter.continueWithTools({
      question: "张国强有几个孩子？", viewpointId: "viewpoint", selectedPersonId: "father",
      toolResults: [{ callId: "call-42", name: "list_relatives", arguments: { personId: "father", kinds: ["child"] }, output: [{ kind: "child", person: { id: "child", displayName: "张敏", notes: "see C:\\private\\x and sk-secret-value" }, uri: "file:///private/source.txt", mediaBytes: "raw", error: { message: "failed at C:\\Users\\me\\tree.db" } }] }]
    });

    const request = create.mock.calls[0]![0];
    expect(request.store).toBe(false);
    expect(request.parallel_tool_calls).toBe(false);
    expect(request.include).toEqual(["reasoning.encrypted_content"]);
    expect(request.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "search_people", "get_person", "list_relatives", "calculate_relationship", "summarize_lineage", "search_wiki"
    ]);
    expect(request.tools.every((tool: { strict: boolean; parameters: { additionalProperties: boolean } }) => tool.strict && tool.parameters.additionalProperties === false)).toBe(true);
    expect(request.tools.every((tool: { parameters: Record<string, unknown> }) => !("$schema" in tool.parameters))).toBe(true);
    expect(request.input).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "function_call", call_id: "call-42", name: "list_relatives" }),
      expect.objectContaining({ type: "function_call_output", call_id: "call-42" })
    ]));
    expect(JSON.stringify(request)).not.toMatch(/file:\/\/|mediaBytes|private|sk-secret|error|Users\\me/i);
  });

  it("treats an empty terminal response as a protocol failure", async () => {
    const create = vi.fn().mockResolvedValue({ status: "completed", output_text: "", output: [] });
    const adapter = new OpenAIResponsesAdapter({ apiKey: "key", model: "m", client: { responses: { create } } as never });
    await expect(adapter.continueWithTools({ question: "q", viewpointId: "v", selectedPersonId: null, toolResults: [] }))
      .rejects.toMatchObject({ code: "MODEL_PROTOCOL" });
  });

  it("rejects whitespace answers, failed/incomplete/refusal responses, and incomplete calls", async () => {
    const cases = [
      { status: "completed", output_text: JSON.stringify({ answer: "   " }), output: [] },
      { status: "failed", output_text: "", output: [] },
      { status: "incomplete", output_text: "", output: [] },
      { status: "completed", output_text: "", output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }] },
      { status: "completed", output_text: "", output: [{ type: "function_call", status: "in_progress", call_id: "c", name: "get_person", arguments: "{\"personId\":\"p\"}" }] }
    ];
    for (const response of cases) {
      const create = vi.fn().mockResolvedValue(response);
      await expect(new OpenAIResponsesAdapter({ apiKey: "key", model: "m", client: { responses: { create } } as never })
        .continueWithTools({ question: "q", viewpointId: "v", selectedPersonId: null, toolResults: [] }))
        .rejects.toMatchObject({ code: "MODEL_PROTOCOL" });
    }
  });

  it("preserves bounded encrypted reasoning continuation and replays it exactly", async () => {
    const reasoning = { type: "reasoning", id: "r1", encrypted_content: "opaque-encrypted", summary: [] };
    const call = { type: "function_call", status: "completed", call_id: "call-1", name: "get_person", arguments: "{\"personId\":\"p\"}" };
    const create = vi.fn()
      .mockResolvedValueOnce({ status: "completed", output_text: "", output: [reasoning, call] })
      .mockResolvedValueOnce({ status: "completed", output_text: JSON.stringify({ answer: "有依据" }), output: [] });
    const adapter = new OpenAIResponsesAdapter({ apiKey: "key", model: "m", client: { responses: { create } } as never });
    const first = await adapter.continueWithTools({ question: "q", viewpointId: "v", selectedPersonId: null, toolResults: [] });
    expect(first.continuation).toBeDefined();
    await adapter.continueWithTools({
      question: "q", viewpointId: "v", selectedPersonId: null,
      toolResults: [{ callId: "call-1", name: "get_person", arguments: { personId: "p" }, output: { id: "p", displayName: "甲", gender: "unknown" } }],
      continuation: first.continuation
    });
    expect(create.mock.calls[1]![0].input).toEqual([
      expect.objectContaining({ role: "user" }), reasoning, call,
      expect.objectContaining({ type: "function_call_output", call_id: "call-1" })
    ]);
  });

  it("replays a complete interleaved history across three sequential tool rounds", async () => {
    const reasoning = (id: number) => ({ type: "reasoning", id: `r${id}`, encrypted_content: `opaque-${id}`, summary: [] });
    const call = (id: number) => ({ type: "function_call", status: "completed", call_id: `c${id}`, name: "get_person", arguments: `{"personId":"p${id}"}` });
    const create = vi.fn()
      .mockResolvedValueOnce({ status: "completed", output_text: "", output: [reasoning(1), call(1)] })
      .mockResolvedValueOnce({ status: "completed", output_text: "", output: [reasoning(2), call(2)] })
      .mockResolvedValueOnce({ status: "completed", output_text: "", output: [reasoning(3), call(3)] })
      .mockResolvedValueOnce({ status: "completed", output_text: JSON.stringify({ answer: "完成" }), output: [] });
    const adapter = new OpenAIResponsesAdapter({ apiKey: "key", model: "m", client: { responses: { create } } as never });
    const results = (count: number) => Array.from({ length: count }, (_, index) => ({
      callId: `c${index + 1}`, name: "get_person" as const, arguments: { personId: `p${index + 1}` },
      output: { id: `p${index + 1}`, displayName: `人物${index + 1}`, gender: "unknown" }
    }));
    let turn = await adapter.continueWithTools({ question: "q", viewpointId: "v", selectedPersonId: null, toolResults: [] });
    turn = await adapter.continueWithTools({ question: "q", viewpointId: "v", selectedPersonId: null, toolResults: results(1), continuation: turn.continuation });
    turn = await adapter.continueWithTools({ question: "q", viewpointId: "v", selectedPersonId: null, toolResults: results(2), continuation: turn.continuation });
    await adapter.continueWithTools({ question: "q", viewpointId: "v", selectedPersonId: null, toolResults: results(3), continuation: turn.continuation });
    expect(create.mock.calls[3]![0].input).toEqual([
      expect.objectContaining({ role: "user" }),
      reasoning(1), call(1), expect.objectContaining({ type: "function_call_output", call_id: "c1" }),
      reasoning(2), call(2), expect.objectContaining({ type: "function_call_output", call_id: "c2" }),
      reasoning(3), call(3), expect.objectContaining({ type: "function_call_output", call_id: "c3" })
    ]);
  });

  it("rejects unknown tool names and malformed arguments before returning a turn", async () => {
    const unknown = vi.fn().mockResolvedValue({ status: "completed", output_text: "", output: [{ type: "function_call", status: "completed", call_id: "c1", name: "delete_person", arguments: "{}" }] });
    const malformed = vi.fn().mockResolvedValue({ status: "completed", output_text: "", output: [{ type: "function_call", status: "completed", call_id: "c2", name: "get_person", arguments: "{\"personId\":\"p\",\"sql\":\"x\"}" }] });
    await expect(new OpenAIResponsesAdapter({ apiKey: "key", model: "m", client: { responses: { create: unknown } } as never })
      .continueWithTools({ question: "q", viewpointId: "v", selectedPersonId: null, toolResults: [] }))
      .rejects.toMatchObject({ code: "MODEL_PROTOCOL" });
    await expect(new OpenAIResponsesAdapter({ apiKey: "key", model: "m", client: { responses: { create: malformed } } as never })
      .continueWithTools({ question: "q", viewpointId: "v", selectedPersonId: null, toolResults: [] }))
      .rejects.toMatchObject({ code: "MODEL_PROTOCOL" });
  });
});
