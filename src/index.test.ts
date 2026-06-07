import { describe, expect, it } from "vitest";
import { getBank, listBanks, security } from "./index.js";

describe("bank registry", () => {
  it("registers Banco Security with the canonical security id", () => {
    expect(getBank("security")).toBe(security);
    expect(getBank("security")?.id).toBe("security");
    expect(listBanks().some((bank) => bank.id === "security")).toBe(true);
  });

  it("does not expose the old bancosecurity id", () => {
    expect(getBank("bancosecurity")).toBeUndefined();
    expect(listBanks().some((bank) => bank.id === "bancosecurity")).toBe(false);
  });
});
