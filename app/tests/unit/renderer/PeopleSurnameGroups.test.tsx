// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FamilyAgentApi, PersonDetailReadModel, PersonListItem, WorkspaceSummary } from "../../../src/shared/contracts";
import { PeoplePage } from "../../../src/renderer/src/features/people/PeoplePage";

afterEach(cleanup);

const workspace: WorkspaceSummary = {
  id: "workspace-1",
  name: "测试谱册",
  directory: "opaque",
  originPersonId: null,
  lastOpenedAt: null,
  schemaVersion: 7
};

const person = (id: string, displayName: string): PersonListItem => ({
  id,
  personCode: `P-${id}`,
  displayName,
  aliases: [],
  gender: "unknown",
  birth: null,
  death: null,
  notes: null,
  rowVersion: 1
});

const people = [
  person("li-ming", "李明"),
  person("li-qiang", "李强"),
  person("ouyang-na", "欧阳娜"),
  person("placeholder", "大伯"),
  person("question", "？红权"),
  person("described-spouse", "李笛老公")
];

function detail(entry: PersonListItem): PersonDetailReadModel {
  return { person: entry, aliases: [], parents: [], children: [], marriages: [] };
}

function apiFor(entries: PersonListItem[]): FamilyAgentApi {
  return {
    people: {
      list: vi.fn().mockResolvedValue({ ok: true, value: entries }),
      get: vi.fn().mockImplementation(async ({ personId }: { personId: string }) => ({
        ok: true,
        value: detail(entries.find((entry) => entry.id === personId)!)
      })),
      save: vi.fn(),
      update: vi.fn(),
      setChildrenCompleteness: vi.fn(),
      getChildrenCountStatus: vi.fn().mockResolvedValue({ ok: true, value: { count: 0, completeness: "partial" } })
    },
    relations: {
      addParentChild: vi.fn(), addMarriage: vi.fn(), divorce: vi.fn(), planRelativePath: vi.fn(),
      planParentCompletion: vi.fn(), scanParentCompletions: vi.fn()
    },
    mutations: { stage: vi.fn(), confirm: vi.fn(), revise: vi.fn() },
    media: {
      select: vi.fn(), import: vi.fn(), attach: vi.fn(),
      listForPerson: vi.fn().mockResolvedValue({ ok: true, value: [] })
    },
    merges: {
      findDuplicateCandidates: vi.fn(), preview: vi.fn(), merge: vi.fn(),
      history: vi.fn().mockResolvedValue({ ok: true, value: [] }), canUnmerge: vi.fn(), unmerge: vi.fn()
    }
  } as unknown as FamilyAgentApi;
}

describe("PeoplePage surname groups", () => {
  it("groups ordinary, compound, and unreliable names into collapsed surname sections", async () => {
    render(<PeoplePage workspace={workspace} api={apiFor(people)} />);

    expect(await screen.findByRole("button", { name: "李姓（2人）" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: "欧阳姓（1人）" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: "姓氏待确认（3人）" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: "查看李明" })).not.toBeInTheDocument();
  });

  it("expands and collapses one surname without opening other groups", async () => {
    render(<PeoplePage workspace={workspace} api={apiFor(people)} />);
    const liGroup = await screen.findByRole("button", { name: "李姓（2人）" });

    fireEvent.click(liGroup);
    expect(liGroup).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "查看李明" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "查看欧阳娜" })).not.toBeInTheDocument();

    fireEvent.click(liGroup);
    expect(liGroup).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: "查看李明" })).not.toBeInTheDocument();
  });

  it("automatically expands and highlights the group containing an externally selected person", async () => {
    render(<PeoplePage workspace={workspace} api={apiFor(people)} initialSelectedPersonId="ouyang-na" />);

    const group = await screen.findByRole("button", { name: "欧阳姓（1人）" });
    expect(group).toHaveAttribute("aria-expanded", "true");
    expect(await screen.findByRole("button", { name: "查看欧阳娜" })).toHaveClass("selected");
    expect(within(screen.getByRole("complementary", { name: "人物列表" })).queryByRole("button", { name: "查看李明" })).not.toBeInTheDocument();
  });
});
