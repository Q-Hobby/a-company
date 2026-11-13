#!/usr/bin/env node
import { createInterface } from "node:readline";
import {
  handleMcpRequest,
  type JsonRpcRequest,
  type RpcInvoker,
} from "../packages/core/src/index.js";

export function createHttpRpcInvoker(
  baseUrl = (process.env.ACOMPANY_URL ?? "http://127.0.0.1:5173").replace(/\/+$/, ""),
  fetchImpl: typeof fetch = fetch,
): RpcInvoker {
  return async (procedure: string, input: Record<string, unknown> = {}) => {
    const response = await fetchImpl(`${baseUrl}/rpc/${procedure}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ json: input }),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`RPC ${procedure} failed (${response.status}): ${text}`);
    }
    const parsed = JSON.parse(text) as { json?: unknown };
    return parsed.json ?? parsed;
  };
}

const invokeRpc = createHttpRpcInvoker();
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", async (line: string) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    const req = JSON.parse(trimmed) as JsonRpcRequest;
    const res = await handleMcpRequest(req, invokeRpc);
    if (res) {
      process.stdout.write(`${JSON.stringify(res)}\n`);
    }
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32700,
          message: error instanceof Error ? error.message : "Parse error",
        },
      })}\n`,
    );
  }
});
