import { describe, expect, it } from "vitest";
import {
  classifyHumanMessage,
  ownerAgentForHumanRequest,
  shouldCreateHumanMessageTask,
} from "../src/message-intent.js";

describe("human message intent classification", () => {
  it.each([
    ["为什么 PM 还在运行？", "question"],
    ["帮我重启项目", "request"],
    ["Please fix the send button", "request"],
    ["不要修改数据库", "directive"],
    ["确认采用这个方案", "decision"],
    ["/question 帮我解释这个状态", "question"],
  ])("classifies %s as %s", (content, expected) => {
    expect(classifyHumanMessage(content).messageType).toBe(expected);
  });

  it("removes an explicit slash override before delivery", () => {
    expect(classifyHumanMessage("/decision ship it")).toEqual({ content: "ship it", messageType: "decision" });
  });

  it("creates durable work for an implicit non-request sent to the lead", () => {
    const classified = classifyHumanMessage(
      "Review the production backlog and address anything stranded",
    );

    expect(classified.messageType).toBe("directive");
    expect(
      shouldCreateHumanMessageTask(classified.messageType, true),
    ).toBe(true);
  });

  it("preserves explicit request task behavior", () => {
    const classified = classifyHumanMessage("Ship the fix", "request");

    expect(classified.messageType).toBe("request");
    expect(
      shouldCreateHumanMessageTask(classified.messageType, true),
    ).toBe(true);
    expect(
      shouldCreateHumanMessageTask(classified.messageType, false),
    ).toBe(true);
    expect(
      shouldCreateHumanMessageTask(classified.messageType, true, "task-1"),
    ).toBe(false);
  });

  it("assigns a request sent to one non-lead agent to that agent", () => {
    expect(ownerAgentForHumanRequest(
      [{ id: "pm-1", role: "pm" }, { id: "backend-1", role: "backend" }],
      ["backend-1"],
      "pm",
      false,
    )).toBe("backend-1");
  });
});
