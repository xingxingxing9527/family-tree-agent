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
    expect(JSON.stringify(request)).not.toContain("sk-private");
    expect(JSON.stringify(request)).not.toMatch(/localPath|mediaBytes|private|Users\\me|etc\\?\/passwd|sensitive\.test|sk-secret|无关人物/i);
    expect(request).toMatchObject({ max_output_tokens: expect.any(Number) });
  });

  it("rejects output that does not satisfy the shared IPC schema", async () => {
    const create = vi.fn().mockResolvedValue({ status: "completed", output_text: JSON.stringify({ ...emptyDraft, sql: "DELETE FROM person" }), output: [] });
    const adapter = new OpenAIResponsesAdapter({ apiKey: "sk-private", model: "gpt-test", client: { responses: { create } } as never });

    await expect(adapter.extractDraft({ text: "text", candidatePeople: [] })).rejects.toMatchObject({ code: "MODEL_PROTOCOL" });
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
