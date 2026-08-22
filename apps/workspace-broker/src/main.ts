import Fastify from "fastify";
import { WorkspaceBroker } from "./broker.js";
import { CodexBridge } from "./codex-bridge.js";

const app = Fastify({ logger: true });
const broker = new WorkspaceBroker();
const codex = new CodexBridge();
app.get("/health", async () => ({ status: "ok", service: "workspace-broker" }));
app.get("/v1/codex/health", async () => ({ status: "ok", provider: "codex", command: process.env.CODEX_COMMAND ?? "codex" }));
app.post("/v1/codex/execute", async (request, reply) => { const body = request.body as { prompt?: string; workspacePath?: string; model?: string } | undefined; if (!body?.prompt?.trim() || !body.workspacePath?.trim()) return reply.code(400).send({ error: "prompt_and_workspace_path_required" }); try { return await codex.execute({ prompt: body.prompt, workspacePath: body.workspacePath, ...(body.model ? { model: body.model } : {}) }); } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); } });
app.post("/v1/workspaces/bind", async (request, reply) => { const body = request.body as { workstreamId?: string; hostPath?: string; readOnly?: boolean; agentId?: string } | undefined; if (!body?.workstreamId?.trim() || !body.hostPath?.trim()) return reply.code(400).send({ error: "workstream_id_and_host_path_required" }); try { return reply.code(201).send(await broker.bind({ workstreamId: body.workstreamId.trim(), hostPath: body.hostPath.trim(), readOnly: body.readOnly, agentId: body.agentId })); } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); } });
app.delete("/v1/workspaces/:workstreamId", async (request, reply) => { await broker.stop((request.params as { workstreamId: string }).workstreamId); return reply.code(204).send(); });
app.get("/v1/workspaces/:workstreamId", async (request, reply) => { const binding = broker.get((request.params as { workstreamId: string }).workstreamId); return binding ?? reply.code(404).send({ error: "workspace_binding_not_found" }); });
await app.listen({ host: process.env.BROKER_HOST ?? "127.0.0.1", port: Number(process.env.BROKER_PORT ?? 3010) });
