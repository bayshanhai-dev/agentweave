import { describe, expect, it } from "vitest";
import {
  checkArtifactQuality,
  minimumArtifactCharacters,
} from "../src/artifact-quality.js";

const realScript = `# Episode: Why Context Matters

## Opening

HOST: Welcome back. Today we are tracing how a useful idea moves between specialists without losing the evidence that made it useful.

## Main discussion

HOST: A reliable handoff includes the source artifact, its limits, and the concrete decision it supports. That lets the next contributor build on completed work instead of guessing.

GUEST: It also makes review meaningful because the reviewer can compare the requested properties with the actual deliverable.

## Closing

HOST: Keep the context bounded, preserve the substance, and make every acceptance check observable.`;

describe("artifact quality checker", () => {
  it("rejects a tiny meta-sentence instead of treating it as a script", () => {
    const result = checkArtifactQuality([{
      path: "episode-script.md",
      content: "This is a well-written and engaging podcast script that meets all requested requirements.",
    }]);
    expect(result).toEqual({
      ok: false,
      reasons: [{
        path: "episode-script.md",
        reason: expect.stringMatching(/^artifact too small \(\d+ chars\)$/),
      }],
    });
  });

  it("rejects placeholder residue and names the matched placeholder", () => {
    const result = checkArtifactQuality([{
      path: "episode.md",
      content: `${"A complete episode description. ".repeat(10)}\n[Insert episode description here]\nHost: [Your Name]`,
    }]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasons).toContainEqual({
        path: "episode.md",
        reason: 'placeholder residue ("[Insert episode description here]")',
      });
    }
  });

  it("rejects protocol routing text echoed into an artifact", () => {
    const result = checkArtifactQuality([{
      path: "notes.txt",
      content: `[agentweave template=podcast phase=execution recipient=writer lead=showrunner planning=producer execution=writer review=editor]\nContinue the workstream after Human approval.\n\nPlanned task:\nWrite the episode script\n\nAcceptance criteria:\n- File: episode-script.md\n- At least 1,200 words\n- Sections: opening, interview, closing`,
    }]);
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.reasons.some(({ reason }) => reason.startsWith("protocol echo ("))).toBe(true);
  });

  it("accepts a substantive multi-paragraph script", () => {
    expect(checkArtifactQuality([{ path: "episode-script.md", content: realScript }])).toEqual({ ok: true });
  });

  it("accepts small valid JSON because JSON has no size floor", () => {
    expect(checkArtifactQuality([{ path: "metadata.json", content: '{"title":"Context Matters","episode":7}' }])).toEqual({ ok: true });
  });

  it("accepts a generic but real checklist", () => {
    const checklist = `# Release checklist\n\n${[
      "Confirm the final script includes an opening, a complete interview, and a closing call to action.",
      "Read every host and guest line aloud and revise any sentence that sounds unnatural or ambiguous.",
      "Verify the episode title and description match the actual topic and do not contain template fields.",
      "Record the source file path, reviewer name, and final approval date in the release notes.",
    ].map((item) => `- [ ] ${item}`).join("\n")}`;
    expect(checklist.trim().length).toBeGreaterThan(minimumArtifactCharacters);
    expect(checkArtifactQuality([{ path: "release-checklist.txt", content: checklist }])).toEqual({ ok: true });
  });
});
