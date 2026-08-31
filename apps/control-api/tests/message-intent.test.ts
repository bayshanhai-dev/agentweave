import { describe, expect, it } from "vitest";
import { classifyHumanMessage } from "../src/message-intent.js";

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
});
