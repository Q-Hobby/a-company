import { describe, expect, it } from "vitest";
import { handleMcpRequest, MCP_TOOLS, type RpcInvoker } from "./mcp-server-protocol.js";

describe("a-company mcp-server-protocol", () => {
  const fakeRpc: RpcInvoker = async (procedure, input) => {
    if (procedure === "bots/list") {
      return [{ id: "bot_1", name: "Architect", title: "Systems" }];
    }
    if (procedure === "threads/send") {
      return { taskId: "task_1", runId: "run_1", seq: 1, input };
    }
    return { procedure, input };
  };

  it("responds to initialize and tools/list", async () => {
    const init = await handleMcpRequest({ id: 1, method: "initialize" }, fakeRpc);
    expect(init?.result).toMatchObject({
      protocolVersion: "2024-11-05",
      serverInfo: { name: "a-company-mcp" },
    });

    const list = await handleMcpRequest({ id: 2, method: "tools/list" }, fakeRpc);
    expect(list?.result).toEqual({ tools: MCP_TOOLS });
  });

  it("dispatches list_bots, send_message, and list_starter_teams", async () => {
    const botsRes = await handleMcpRequest(
      { id: 3, method: "tools/call", params: { name: "list_bots", arguments: {} } },
      fakeRpc,
    );
    const botsText = (botsRes?.result as { content?: Array<{ text?: string }> } | undefined)
      ?.content?.[0]?.text;
    expect(botsText).toContain("Architect");

    const sendRes = await handleMcpRequest(
      {
        id: 4,
        method: "tools/call",
        params: { name: "send_message", arguments: { botId: "bot_1", text: "Hello" } },
      },
      fakeRpc,
    );
    const sendText = (sendRes?.result as { content?: Array<{ text?: string }> } | undefined)
      ?.content?.[0]?.text;
    expect(sendText).toContain("task_1");

    const startersRes = await handleMcpRequest(
      { id: 5, method: "tools/call", params: { name: "list_starter_teams", arguments: {} } },
      fakeRpc,
    );
    const startersText = (startersRes?.result as { content?: Array<{ text?: string }> } | undefined)
      ?.content?.[0]?.text;
    expect(startersText).toContain("engineering-squad");
  });
});
