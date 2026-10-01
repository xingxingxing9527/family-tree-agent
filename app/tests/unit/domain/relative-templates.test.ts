import { describe, expect, it } from "vitest";
import { RELATIVE_TEMPLATES } from "../../../src/shared/relative-templates";

describe("relative templates", () => {
  it("covers the six approved close-relative paths", () => {
    expect(RELATIVE_TEMPLATES.map((template) => [template.id, template.label])).toEqual([
      ["sibling", "兄弟姐妹"],
      ["grandparent", "祖父母"],
      ["uncle", "叔伯/舅舅"],
      ["aunt", "姑姑/姨妈"],
      ["nibling", "侄子女/外甥子女"],
      ["cousin", "堂表亲"]
    ]);
  });

  it("describes only parent-child edges rather than stored kinship labels", () => {
    expect(RELATIVE_TEMPLATES.every((template) => template.edges.every((edge) => edge.type === "parentChild"))).toBe(true);
    expect(JSON.stringify(RELATIVE_TEMPLATES)).not.toContain("kinshipLabel");
  });
});
