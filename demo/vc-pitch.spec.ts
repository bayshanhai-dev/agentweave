import { expect, test } from "@playwright/test";

/**
 * AgentWeave VC pitch — recorded demo.
 *
 * Narrative (matches voiceover script in demo/VOICEOVER.md):
 *  1. Establishing shot: the AgentWeave dashboard, a live multi-agent runtime.
 *  2. A human sets a goal: choose the realtime sync architecture.
 *  3. Two agents independently propose (CRDT vs OT) — a genuine disagreement.
 *  4. A reviewer challenges both on the offline requirement.
 *  5. The lead synthesizes a stronger, gated decision.
 *  6. The human approves. Reload proves the state is durable.
 *
 * The mock provider serves deterministic narrative content so the recording
 * is flake-free; the dashboard, control API, Postgres and NATS are all real.
 */
const GOAL =
  "Decide the launch strategy for our AI note-taking app.";

test("AgentWeave VC pitch — agent team debates and decides", async ({ page }) => {
  test.setTimeout(300_000);
  const pause = (ms: number) => page.waitForTimeout(ms);

  // ---- 1. Establishing shot -------------------------------------------
  await page.goto("/");
  await page.waitForLoadState("domcontentloaded");
  await pause(5000); // let the viewer absorb the dashboard

  // ---- 2. Create the workstream ----------------------------------------
  await page.getByRole("button", { name: "New Workstream" }).first().click();
  await pause(1800);
  await page.getByPlaceholder("What should this Workstream accomplish?").fill(GOAL);
  await pause(1500);
  // Workspace path must exist or the worker fails with ENOENT.
  await page.locator('input[value="/workspaces/academic-paper-buddy"]').fill("/workspaces/agentweave");
  await pause(1200);

  // Provider -> Mock, Model -> deterministic (deterministic narrative, zero flake)
  await page.locator('input[value="Codex"]').click({ force: true });
  await pause(900);
  await page.getByRole("option", { name: "Mock (deterministic)" }).click();
  await pause(900);
  await page.locator('input[value="gpt-5.6-luna"]').fill("deterministic");
  await pause(1200);

  await page.getByRole("button", { name: "Create Workstream", exact: true }).click();
  await pause(3500); // land on the workstream page, show the goal
  await expect(page.getByText("Decide the launch strategy").first()).toBeVisible();

  // ---- 3. Start the agent team ------------------------------------------
  await page.getByRole("button", { name: "Start Workstream" }).click();
  await pause(2500);

  // ---- 4. Watch the debate unfold ---------------------------------------
  // Switch the stream to Insights mode so the narrative cards (not raw prompts)
  // are what the viewer reads.
  await page.locator('input[aria-label="Choose stream mode"]').click({ force: true });
  await pause(800);
  await page.getByRole("option", { name: "Insights", exact: true }).click();
  await pause(1200);
  // Scroll to the live message bus so proposals are visible as they arrive.
  await page.getByText("Live message bus").scrollIntoViewIfNeeded();
  await page.getByText("Build anticipation, then concentrate").first().waitFor({ timeout: 60000 });
  await pause(6000); // let the viewer read both proposals

  // Scroll back up to the summary as the reviewer + synthesis complete.
  await page.getByText("Summary report").scrollIntoViewIfNeeded();
  await pause(10000);

  // ---- 5. Human approval gate --------------------------------------------
  await page.getByText("WAITING FOR HUMAN").first().waitFor({ timeout: 90_000 });
  await pause(3000); // beat: the decision is waiting on a human
  await page.getByText("Summary report").scrollIntoViewIfNeeded();
  await pause(4000); // show the synthesized decision in the attention line

  await page.getByRole("button", { name: "Approve & complete" }).click();
  await pause(5000); // completion lands

  // ---- 6. Reload: prove durable state --------------------------------------
  await page.reload();
  await page.waitForLoadState("domcontentloaded");
  await pause(4000);
  await page.getByText("Summary report").scrollIntoViewIfNeeded();
  await pause(4000); // everything persisted — tasks, insights, evidence
});
