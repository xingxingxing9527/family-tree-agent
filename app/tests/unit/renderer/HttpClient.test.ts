import { afterEach, describe, expect, it, vi } from "vitest";
import { createHttpApiClient } from "../../../src/renderer/src/api/http-client";

afterEach(() => vi.unstubAllGlobals());

describe("HTTP family API client", () => {
  it("uses the dedicated single-family lifecycle route", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: vi.fn().mockResolvedValue({ ok: true, value: [] })
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await createHttpApiClient("http://127.0.0.1:8787").workspaces.list();

    expect(result).toEqual({ ok: true, value: [] });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8787/api/family",
      expect.objectContaining({ headers: expect.objectContaining({ "content-type": "application/json" }) })
    );
  });
});
