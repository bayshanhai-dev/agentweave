import { expect, test, type APIRequestContext } from "@playwright/test";

const demoGoal =
  "Build a small, accessible markdown note editor with a clear README and passing tests.";
const controlApi = process.env.E2E_CONTROL_API_URL ?? "http://localhost:13000";

type Snapshot = {
  schemaVersion: number;
  cursor: number;
  workstream: {
    id: string;
    goal: string;
    status: string;
    tasks: Array<{ status: string; evidence: string[] }>;
    messages: unknown[];
    events: Array<{ type?: string }>;
  };
};

async function snapshot(request: APIRequestContext, workstreamId: string) {
  const response = await request.get(
    `${controlApi}/api/workstreams/${workstreamId}/snapshot`,
  );
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as Snapshot;
}

test("completes and persists the deterministic Mock workstream", async ({
  page,
  request,
}) => {
  const frames: Array<{ type?: string; workstreamId?: string }> = [];
  page.on("websocket", (socket) => {
    if (!socket.url().includes("/events")) return;
    socket.on("framereceived", ({ payload }) => {
      try {
        frames.push(JSON.parse(payload.toString()) as (typeof frames)[number]);
      } catch {
        // Ignore non-JSON transport frames; the application protocol is JSON.
      }
    });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "New Workstream" }).first().click();
  const createResponsePromise = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/workstreams" &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create demo workstream" }).click();
  const createResponse = await createResponsePromise;
  expect(createResponse.status()).toBe(201);
  const created = (await createResponse.json()) as { id: string };

  await expect(page.locator(".cc-goal-text", { hasText: demoGoal })).toBeVisible();
  await expect(
    page.getByText("Agents now", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Task board", { exact: true }).or(page.getByText("No tasks yet"))).toBeVisible();
  await expect(
    page.getByText("Session totals", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Live events", { exact: true }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Start Workstream" }).click();
  await expect(
    page.getByRole("button", { name: "Approve & complete" }),
  ).toBeVisible({ timeout: 45_000 });

  await expect
    .poll(
      () =>
        frames.some(
          (frame) =>
            frame.workstreamId === created.id && frame.type === "run.started",
        ),
      { timeout: 15_000 },
    )
    .toBe(true);
  await expect
    .poll(() => page.locator(".cc-kanban-card").count())
    .toBeGreaterThanOrEqual(3);
  await expect(page.locator(".cc-event")).not.toHaveCount(0);

  const awaitingApproval = await snapshot(request, created.id);
  expect(awaitingApproval.schemaVersion).toBe(1);
  expect(awaitingApproval.cursor).toBeGreaterThan(0);
  expect(awaitingApproval.workstream.status).toBe("waiting_for_human");
  expect(
    awaitingApproval.workstream.events.some(
      (event) => event.type === "run.started",
    ),
  ).toBe(true);
  expect(
    awaitingApproval.workstream.events.some(
      (event) => event.type === "task.completed",
    ),
  ).toBe(true);
  expect(awaitingApproval.workstream.messages.length).toBeGreaterThanOrEqual(5);
  const insightResponse = await request.get(
    `${controlApi}/api/workstreams/${created.id}/insights`,
  );
  expect(insightResponse.ok()).toBeTruthy();
  const { insights, rounds } = await insightResponse.json();
  expect(insights.filter((item: { kind: string }) => item.kind === "proposal")).toHaveLength(2);
  expect(insights).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: "critique", lifecycle: "accepted", workstreamId: created.id }),
    expect.objectContaining({ kind: "synthesis", lifecycle: "accepted", workstreamId: created.id, evidenceIds: expect.arrayContaining([expect.any(String)]) }),
  ]));
  expect(insights.every((item: { lifecycle: string }) => item.lifecycle === "accepted")).toBe(true);
  expect(rounds).toEqual([expect.objectContaining({ status: "completed", insightIds: expect.arrayContaining(insights.map((item: { id: string }) => item.id)) })]);
  const proposalId = insights.find((item: { kind: string }) => item.kind === "proposal").id;
  expect(
    awaitingApproval.workstream.tasks.filter((task) => task.status === "done")
      .length,
  ).toBeGreaterThanOrEqual(4);

  await page.getByRole("button", { name: "Approve & complete" }).click();
  await expect(
    page.getByText("completed", { exact: true }),
  ).toBeVisible();

  await page.reload();
  await expect(page.locator(".cc-goal-text", { hasText: demoGoal })).toBeVisible();
  await expect(
    page.getByText("completed", { exact: true }),
  ).toBeVisible();

  const persisted = await snapshot(request, created.id);
  const reloadedInsights = await (
    await request.get(`${controlApi}/api/workstreams/${created.id}/insights`)
  ).json();
  expect(
    reloadedInsights.insights.filter(
      (item: { id: string }) => item.id === proposalId,
    ),
  ).toHaveLength(1);
  expect(persisted.workstream.status).toBe("completed");
  expect(persisted.workstream.goal).toBe(demoGoal);
  expect(
    persisted.workstream.tasks.filter((task) => task.status === "done").length,
  ).toBeGreaterThanOrEqual(4);
});
