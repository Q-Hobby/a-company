import { describe, expect, it } from "vitest";
import { botColors, tokens } from "./theme.js";

describe("mobile theme tokens", () => {
  it("exposes the shared product palette used by custom surfaces", () => {
    expect(tokens.background).toBe("#161820");
    expect(tokens.foreground).toBe("#f1f3f7");
    expect(tokens.primary).toBe("#f1f3f7");
  });

  it("re-exports botColors for identity accents", () => {
    expect(botColors.length).toBeGreaterThan(0);
    expect(botColors[0]).toBe("#3EC5A8");
  });
});
