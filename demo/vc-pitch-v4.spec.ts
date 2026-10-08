import { expect, test } from "@playwright/test";

/**
 * AgentWeave VC pitch v4 — full story.
 *
 * 1. Panel tour: Macro Plan, Agent cards, Message Bus, Summary
 * 2. Real back-and-forth: proposal -> critique -> rebuttals -> synthesis
 * 3. Human steer mid-flow
 * 4. Final product: the production playbook
 *
 * Mock provider serves deterministic real-LLM content (podcast "Ship It").
 */
const GOAL =
  "Design the production workflow for our fictional tech interview podcast Ship It.";

test("AgentWeave VC pitch v4 — full collaboration story", async ({ page }) => {
  test.setTimeout(400_000);
  const pause = (ms: number) => page.waitForTimeout(ms);

  // ---- 1. Establishing + panel tour ------------------------------------
  await page.goto("/");
  await page.waitForLoadState("domcontentloaded");
  await pause(6000);

  // ---- 2. Create workstream ---------------------------------------------
  await page.getByRole("button", { name: "New Workstream" }).first().click();
  await pause(2000);
  await page.getByPlaceholder("What should this Workstream accomplish?").fill(GOAL);
  await pause(2000);
  await page.locator('input[value="/workspaces/academic-paper-buddy"]').fill("/workspaces/agentweave");
  await pause(1500);
  await page.locator('input[value="Codex"]').click({ force: true });
  await pause(1000);
  await page.getByRole("option", { name: "Mock (deterministic)" }).click();
  await pause(1000);
  await page.locator('input[value="gpt-5.6-luna"]').fill("deterministic");
  await pause(1500);
  await page.getByRole("button", { name: "Create Workstream", exact: true }).click();
  await pause(4000);
  await expect(page.getByText("Design the production workflow").first()).toBeVisible();

  // ---- 3. Panel tour (slow) ---------------------------------------------
  // Hover over each panel to highlight
  await pause(3000); // Macro Plan
  await pause(3000); // Agent cards
  await pause(3000); // Message bus

  // ---- 4. Start ----------------------------------------------------------
  await page.getByRole("button", { name: "Start Workstream" }).click();
  await pause(3000);

  // Insights mode (filters are now collapsible, hidden by default)
  await page.getByRole("button", { name: "Filters" }).click();
  await pause(1000);
  await page.locator('input[aria-label="Choose stream mode"]').click({ force: true });
  await pause(1000);
  await page.getByRole("option", { name: "Insights", exact: true }).click();
  await pause(1500);

  // ---- 5. Proposals (slow, let viewer read) ------------------------------
  await page.getByText("45-minute remote interviews").first().waitFor({ timeout: 90000 });
  await pause(8000); // read proposal 1
  await page.getByText("90-minute episode every two weeks").first().waitFor({ timeout: 60000 });
  await pause(8000); // read proposal 2

  // ---- 6. Critique --------------------------------------------------------
  await page.getByText("externalizing the host").first().waitFor({ timeout: 90000 });
  await pause(10000); // read critique

  // ---- 7. Rebuttals (the back-and-forth!) ---------------------------------
  await page.getByText("Three weekly episodes are sustainable").first().waitFor({ timeout: 90000 });
  await pause(8000);
  await page.getByText("not anti-growth").first().waitFor({ timeout: 60000 });
  await pause(8000);

  // ---- 8. Human steer ------------------------------------------------------
  // Send a steering message via the composer
  const composer = page.getByLabel("Send a message");
  await composer.click();
  await pause(1000);
  await composer.fill("@lead Prioritize sustainability — the host will burn out at 3 episodes per week. Cap host time.");
  await pause(2000);
  await page.getByRole("button", { name: "Send message" }).click();
  await pause(5000); // let the steer land

  // ---- 9. Synthesis ---------------------------------------------------------
  await page.getByText("deeply researched intervi").first().waitFor({ timeout: 120000 });
  await pause(12000); // read the final decision slowly

  // ---- 10. Approve ------------------------------------------------------------
  await page.getByRole("button", { name: "Approve" }).click();
  await pause(4000);

  // ---- 11. Final product showcase ----------------------------------------------
  // Scroll to summary / stay on the synthesis
  await pause(5000);
});
