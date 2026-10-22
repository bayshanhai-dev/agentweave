import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { allowedRuntimeEventTypes } from "@agentweave/protocol";
import { describe, expect, it } from "vitest";

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith(".ts") ? [path] : [];
  });
}

function emittedLiteralTypes(path: string): string[] {
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
  const types: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const directEmit = ts.isIdentifier(node.expression) && node.expression.text === "emit";
      const memberEmit = ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "emit";
      if (directEmit || memberEmit) {
        const argument = node.arguments[directEmit && node.arguments.length >= 3 ? 1 : 0];
        const collect = (candidate: ts.Node): void => {
          if (
            (ts.isStringLiteral(candidate) || ts.isNoSubstitutionTemplateLiteral(candidate)) &&
            candidate.text.includes(".")
          ) types.push(candidate.text);
          else candidate.forEachChild(collect);
        };
        if (argument) collect(argument);
      }
    }
    node.forEachChild(visit);
  };
  visit(source);
  return types;
}

describe("control-api runtime event types", () => {
  it("only emits event types registered by the protocol", () => {
    const sourceRoot = fileURLToPath(new URL("../src", import.meta.url));
    const emittedTypes = new Set(sourceFiles(sourceRoot).flatMap(emittedLiteralTypes));
    // These finite values are produced by template expressions in the lifecycle handler.
    for (const type of [
      "approval.resume",
      "workstream.complete",
      "workstream.pause",
      "workstream.resume",
      "workstream.waiting_for_human",
    ]) emittedTypes.add(type);

    expect([...emittedTypes].filter((type) => !allowedRuntimeEventTypes.has(type))).toEqual([]);
  });
});
