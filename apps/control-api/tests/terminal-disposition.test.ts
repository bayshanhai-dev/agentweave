import { describe, expect, it } from "vitest";
import { validateDismissal } from "../src/terminal-disposition.js";

describe("terminal human-message disposition", () => {
  it("requires a reason and only applies to human messages", () => {
    expect(validateDismissal({ senderId: "human" }, "Historical request superseded")).toEqual({ ok: true, reason: "Historical request superseded" });
    expect(validateDismissal({ senderId: "agent-1" }, "not applicable")).toEqual({ ok: false, error: "only_human_messages_can_be_dismissed" });
    expect(validateDismissal({ senderId: "human" }, " ")).toEqual({ ok: false, error: "terminal_reason_required" });
  });
});
