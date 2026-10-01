// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatPage } from "../../../src/renderer/src/features/chat/ChatPage";
import { ViewpointProvider } from "../../../src/renderer/src/app/ViewpointContext";

afterEach(cleanup);

const people = [
  { id: "wang-ming", personCode: "P000001", displayName: "王明", aliases: [], gender: "male" as const, birth: null, death: null, notes: null, rowVersion: 1 },
  { id: "wang-qiang", personCode: "P000002", displayName: "王强", aliases: [], gender: "male" as const, birth: null, death: null, notes: null, rowVersion: 1 }
];

describe("ChatPage", () => {
  it("shows and updates the shared answer viewpoint and selected person context", () => {
    const onSelectedPersonChange = vi.fn();
    window.localStorage.setItem("family-agent:viewpoint:workspace", "wang-ming");
    render(<ViewpointProvider workspaceId="workspace" visiblePersonIds={[]} validPersonIds={people.map((person) => person.id)} fallbackViewpointId="wang-ming" query={{ calculateRelationship: vi.fn() }}>
      <ChatPage people={people} selectedPersonId="wang-qiang" onSelectedPersonChange={onSelectedPersonChange} onSend={vi.fn()} />
    </ViewpointProvider>);

    expect(screen.getByLabelText("回答视角")).toHaveValue("wang-ming");
    expect(screen.getByLabelText("问题人物")).toHaveValue("wang-qiang");
    fireEvent.change(screen.getByLabelText("问题人物"), { target: { value: "wang-ming" } });
    expect(onSelectedPersonChange).toHaveBeenCalledWith("wang-ming");
  });
});
