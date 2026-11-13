import { listStarterTeams } from "./starter-teams.js";

export interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

export type RpcInvoker = (procedure: string, input?: Record<string, unknown>) => Promise<unknown>;

export const MCP_TOOLS = [
  {
    name: "list_bots",
    description: "List all active AI teammates (bots) in the A-Company workspace.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "create_bot",
    description: "Create a new AI teammate in A-Company.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        title: { type: "string" },
        description: { type: "string" },
        instructions: { type: "string" },
        computerMode: { type: "string", enum: ["team", "dedicated"] },
      },
      required: ["name"],
    },
  },
  {
    name: "send_message",
    description: "Send a prompt/message to a bot in A-Company.",
    inputSchema: {
      type: "object",
      properties: {
        botId: { type: "string" },
        text: { type: "string" },
      },
      required: ["botId", "text"],
    },
  },
  {
    name: "get_messages",
    description: "Read recent messages from a bot thread.",
    inputSchema: {
      type: "object",
      properties: {
        botId: { type: "string" },
      },
      required: ["botId"],
    },
  },
  {
    name: "list_starter_teams",
    description: "List built-in portable starter team blueprints.",
    inputSchema: { type: "object", properties: {} },
  },
];

export async function handleMcpRequest(
  req: JsonRpcRequest,
  invokeRpc: RpcInvoker,
): Promise<JsonRpcResponse | null> {
  const id = req.id ?? null;

  if (req.method === "notifications/initialized") {
    return null;
  }

  if (req.method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        serverInfo: { name: "a-company-mcp", version: "0.1.0" },
        capabilities: { tools: {} },
      },
    };
  }

  if (req.method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id,
      result: { tools: MCP_TOOLS },
    };
  }

  if (req.method === "tools/call") {
    const name = String(req.params?.name ?? "");
    const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
    try {
      let data: unknown;
      if (name === "list_bots") {
        data = await invokeRpc("bots/list", {});
      } else if (name === "create_bot") {
        data = await invokeRpc("bots/create", {
          name: String(args.name ?? ""),
          title: String(args.title ?? ""),
          description: String(args.description ?? ""),
          instructions: String(args.instructions ?? args.description ?? ""),
          computerMode: args.computerMode === "dedicated" ? "dedicated" : "team",
        });
      } else if (name === "send_message") {
        data = await invokeRpc("threads/send", {
          botId: String(args.botId ?? ""),
          text: String(args.text ?? ""),
        });
      } else if (name === "get_messages") {
        data = await invokeRpc("threads/messages", {
          botId: String(args.botId ?? ""),
        });
      } else if (name === "list_starter_teams") {
        data = listStarterTeams().map((entry) => ({
          slug: entry.slug,
          name: entry.blueprint.name,
          description: entry.blueprint.description,
          bots: entry.blueprint.bots.map((b) => b.name),
        }));
      } else {
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Unknown tool: ${name}` },
        };
      }

      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        },
      };
    } catch (error) {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          isError: true,
          content: [
            {
              type: "text",
              text: error instanceof Error ? error.message : String(error),
            },
          ],
        },
      };
    }
  }

  return {
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: `Method not found: ${req.method}` },
  };
}
