// /mcp：MCP（Streamable HTTP・状態なし）。ツール定義と本体は GAS と共通。削除はAI下書き限定でここに追加
import { ApiError, isPlainObject } from "./util.mjs";

const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const DELETE_TOOL = { name: "delete_draft", title: "AI下書きを削除", description: "AIが作った下書き（本人がまだ保存していないもの）を削除します。本人の書類、入金・失注の記録やPDFがある下書きは削除できません。",
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  inputSchema: { type: "object", required: ["id"], properties: { id: { type: "string" } } } };

const err = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

export async function mcpMessage(m, { gas, principal, meta, onWrite }) {
  const id = isPlainObject(m) && m.id !== undefined ? m.id : null;
  if (!isPlainObject(m) || m.jsonrpc !== "2.0" || typeof m.method !== "string") return err(id, -32600, "Invalid Request");
  if (m.id === undefined) return null; // 通知
  const p = isPlainObject(m.params) ? m.params : {};
  const canWrite = principal.scopes.includes("documents:write");
  const tools = async () => {
    const info = await meta();
    return { info, list: [...info.tools, DELETE_TOOL].filter(t => canWrite || t.annotations?.readOnlyHint === true) };
  };
  let writing = false;
  try {
    let result;
    if (m.method === "initialize") {
      const { info } = await tools();
      result = { protocolVersion: PROTOCOLS.includes(p.protocolVersion) ? p.protocolVersion : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } }, serverInfo: { name: "redseal", title: "REDSEAL 見積・請求・領収", version: info.version },
        instructions: info.instructions.replace("削除はできません。", "削除できるのはAI下書きだけです。") };
    } else if (m.method === "ping") result = {};
    else if (m.method === "tools/list") result = { tools: (await tools()).list };
    else if (m.method === "tools/call") {
      const { list } = await tools();
      if (!list.some(t => t.name === p.name)) result = { content: [{ type: "text", text: "そのツールはないか、このキーの権限では使えません" }], isError: true };
      else {
        const args = isPlainObject(p.arguments) ? p.arguments : {};
        const writes = list.find(t => t.name === p.name).annotations?.readOnlyHint !== true;
        writing = writes;
        if (p.name === "delete_draft") {
          const r = await gas("delete", { id: args.id });
          const data = { id: r.id, deleted: true, updated_at: new Date(r.updatedAt).toISOString() };
          result = { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data };
        } else result = await gas("call", { name: p.name, arguments: args });
        if (writes && !result.isError) onWrite();
      }
    } else return err(id, -32601, "Method not found: " + m.method.slice(0, 60));
    return { jsonrpc: "2.0", id, result };
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    if (m.method === "tools/call") {
      let text = e.message;
      if (writing && e.unknown) { onWrite(); text += "。保存済みの可能性があります。一覧で確認するまで同じ操作をやり直さないでください"; }
      return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], isError: true } };
    }
    return err(id, -32603, e.message);
  }
}
