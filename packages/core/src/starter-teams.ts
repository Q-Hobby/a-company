import type { TeamBlueprint } from "./team-blueprint.js";

export interface StarterTeamEntry {
  slug: string;
  blueprint: TeamBlueprint;
}

export const STARTER_TEAM_BLUEPRINTS: StarterTeamEntry[] = [
  {
    slug: "engineering-squad",
    blueprint: {
      version: 1,
      name: "Engineering Squad",
      description: "Architect, Implementer, and Reviewer working together on a shared repo.",
      playbook: [
        "# Engineering Squad",
        "",
        "Use this team to plan features, write code in a shared computer, and review diffs before merging.",
        "",
        "- Mention **@Architect** for design tradeoffs and specs.",
        "- Mention **@Builder** to implement changes and run tests.",
        "- Mention **@Reviewer** to audit diffs, edge cases, and security.",
      ].join("\n"),
      bots: [
        {
          name: "Architect",
          title: "Systems Architect",
          description: "Breaks down requirements into clear, minimal technical plans.",
          instructions:
            "Design simple, modular architectures. Identify edge cases, contracts, and verification steps before coding starts.",
          computerMode: "team",
          connectors: ["github"],
        },
        {
          name: "Builder",
          title: "Full-Stack Engineer",
          description: "Implements features, writes tests, and verifies builds.",
          instructions:
            "Write clean TypeScript/tests, run checks before reporting completion, and keep diffs focused.",
          computerMode: "team",
          connectors: ["github"],
        },
        {
          name: "Reviewer",
          title: "Code & Security Reviewer",
          description: "Reviews changes for bugs, regressions, and secret leaks.",
          instructions:
            "Inspect diffs critically, flag missing tests or security risks, and suggest concrete fixes.",
          computerMode: "team",
          connectors: ["github"],
        },
      ],
    },
  },
  {
    slug: "research-content",
    blueprint: {
      version: 1,
      name: "Research & Content",
      description: "Web researcher and technical writer for cited briefs and documentation.",
      playbook: [
        "# Research & Content",
        "",
        "Ideal for market recon, competitor teardowns, and technical blog/doc drafts.",
      ].join("\n"),
      bots: [
        {
          name: "Scout",
          title: "Research Analyst",
          description: "Gathers primary sources, benchmarks, and verifiable citations.",
          instructions: "Always cite primary URLs and separate verified facts from estimates.",
          computerMode: "dedicated",
        },
        {
          name: "Editor",
          title: "Technical Writer",
          description: "Turns raw research into concise, structured briefs and docs.",
          instructions:
            "Write clear, direct copy without fluff. Preserve every source link from Scout.",
          computerMode: "team",
        },
      ],
    },
  },
  {
    slug: "personal-ops",
    blueprint: {
      version: 1,
      name: "Personal Ops",
      description: "Daily inbox triage, calendar prep, and routine automation.",
      playbook: [
        "# Personal Ops",
        "",
        "Connect Gmail or Calendar in Integrations, then unpause the daily brief routine.",
      ].join("\n"),
      bots: [
        {
          name: "Chief",
          title: "Chief of Staff",
          description: "Summarizes priorities, drafts replies, and tracks follow-ups.",
          instructions:
            "Keep daily summaries scannable with action items, owners, and deadlines. Never send external emails without approval.",
          computerMode: "team",
          connectors: ["gmail", "google-calendar"],
          routines: ["Weekday 09:00 inbox & calendar digest"],
        },
      ],
    },
  },
];

export function listStarterTeams(): StarterTeamEntry[] {
  return STARTER_TEAM_BLUEPRINTS;
}

export function getStarterTeam(slug: string): TeamBlueprint | undefined {
  return STARTER_TEAM_BLUEPRINTS.find((entry) => entry.slug === slug)?.blueprint;
}
