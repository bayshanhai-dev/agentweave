import Fastify from "fastify";
import { WorkspaceBroker } from "./broker.js";
import { CodexBridge } from "./codex-bridge.js";
import { CodexAppServer } from "./codex-app-server.js";
import { mapWorkspacePath } from "./workspace-path.js";

const app = Fastify({ logger: true });
const broker = new WorkspaceBroker();
const codex = new CodexBridge();
const appServer = new CodexAppServer();
function authorized(request: { headers: Record<string, string | string[] | undefined> }): boolean { const token = process.env.CODEX_BRIDGE_TOKEN; return !token || request.headers.authorization === `Bearer ${token}`; }
app.get("/health", async () => ({ status: "ok", service: "host-runtime-bridge" }));
app.get("/v1/codex/health", async () => ({ status: "ok", provider: "codex", command: process.env.CODEX_COMMAND ?? "codex", authentication: process.env.CODEX_BRIDGE_TOKEN ? "required" : "disabled" }));
app.post("/v1/codex/app-server/request", async (request, reply) => { if (!authorized(request)) return reply.code(401).send({ error: "unauthorized" }); const body = request.body as { method?: string; params?: Record<string, unknown>; correlationId?: string } | undefined; if (!body?.method) return reply.code(400).send({ error: "method_required" }); try { const params = { ...(body.params ?? {}) }; if (typeof params.cwd === "string") params.cwd = mapWorkspacePath(params.cwd); return await appServer.request(body.method, params, body.correlationId ?? crypto.randomUUID()); } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); } });
app.get("/v1/codex/app-server/events/:threadId", async (request, reply) => { if (!authorized(request)) return reply.code(401).send({ error: "unauthorized" }); const threadId = (request.params as { threadId: string }).threadId; const events: Record<string, unknown>[] = []; for await (const event of appServer.events(threadId)) events.push(event); return reply.send({ events }); });
app.post("/v1/codex/execute", async (request, reply) => { if (!authorized(request)) return reply.code(401).send({ error: "unauthorized" }); const body = request.body as { prompt?: string; workspacePath?: string; model?: string; threadId?: string } | undefined; if (!body?.prompt?.trim() || !body.workspacePath?.trim()) return reply.code(400).send({ error: "prompt_and_workspace_path_required" }); try { return await codex.execute({ prompt: body.prompt, workspacePath: body.workspacePath, ...(body.model ? { model: body.model } : {}), ...(body.threadId ? { threadId: body.threadId } : {}) }); } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); } });
app.post("/v1/workspaces/bind", async (request, reply) => { const body = request.body as { workstreamId?: string; hostPath?: string; readOnly?: boolean; agentId?: string } | undefined; if (!body?.workstreamId?.trim() || !body.hostPath?.trim()) return reply.code(400).send({ error: "workstream_id_and_host_path_required" }); try { return reply.code(201).send(await broker.bind({ workstreamId: body.workstreamId.trim(), hostPath: body.hostPath.trim(), ...(body.readOnly !== undefined ? { readOnly: body.readOnly } : {}), ...(body.agentId ? { agentId: body.agentId } : {}) })); } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); } });
app.delete("/v1/workspaces/:workstreamId", async (request, reply) => { await broker.stop((request.params as { workstreamId: string }).workstreamId); return reply.code(204).send(); });
app.get("/v1/workspaces/:workstreamId", async (request, reply) => { const binding = broker.get((request.params as { workstreamId: string }).workstreamId); return binding ?? reply.code(404).send({ error: "workspace_binding_not_found" }); });
await app.listen({ host: process.env.BROKER_HOST ?? (process.env.CODEX_BRIDGE_TOKEN ? "0.0.0.0" : "127.0.0.1"), port: Number(process.env.BROKER_PORT ?? 3010) });
