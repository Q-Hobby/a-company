import { describe, expect, it } from "vitest";
import { getStarterTeam, listStarterTeams } from "./starter-teams.js";
import {
  parseTeamBlueprint,
  redactBlueprintSecrets,
  serializeTeamBlueprint,
  type TeamBlueprint,
} from "./team-blueprint.js";

describe("team-blueprint", () => {
  it("roundtrips a portable markdown blueprint", () => {
    const input: TeamBlueprint = {
      version: 1,
      name: "Launch Team",
      description: "Ships product updates safely.",
      playbook: "# Launch Team\n\nCoordinate releases with @Ops.",
      bots: [
        {
          name: "Ops",
          title: "Release Manager",
          description: "Runs checklists and smoke tests.",
          instructions: "Verify CI green before tagging.",
          computerMode: "team",
          connectors: ["github", "slack"],
          routines: ["Daily release status"],
        },
      ],
    };

    const markdown = serializeTeamBlueprint(input);
    const parsed = parseTeamBlueprint(markdown);
    expect(parsed).toEqual(input);
  });

  it("redacts secret-like tokens during serialization and parsing", () => {
    const leaked =
      "Use apiKey=sk-proj-1234567890abcdef123456 and Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig";
    const clean = redactBlueprintSecrets(leaked);
    expect(clean).not.toContain("sk-proj-1234567890abcdef123456");
    expect(clean).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(clean).toContain("[REDACTED]");
  });

  it("rejects blueprints without frontmatter or bots", () => {
    expect(() => parseTeamBlueprint("# Just markdown")).toThrow(/frontmatter/i);
    expect(() =>
      parseTeamBlueprint("---\nversion: 1\nname: Empty\ndescription: None\nbots:\n---\n"),
    ).toThrow(/at least one bot/i);
  });

  it("provides valid starter teams", () => {
    const teams = listStarterTeams();
    expect(teams.length).toBeGreaterThanOrEqual(3);
    for (const entry of teams) {
      const roundtrip = parseTeamBlueprint(serializeTeamBlueprint(entry.blueprint));
      expect(roundtrip.name).toBe(entry.blueprint.name);
      expect(roundtrip.bots.length).toBeGreaterThan(0);
    }
    expect(getStarterTeam("engineering-squad")?.bots).toHaveLength(3);
    expect(getStarterTeam("nonexistent")).toBeUndefined();
  });
});
