export type HumanMessageType = "question" | "request" | "directive" | "decision";

const messageTypes = new Set<HumanMessageType>(["question", "request", "directive", "decision"]);

export function classifyHumanMessage(rawContent: string, requestedIntent?: string): { content: string; messageType: HumanMessageType } {
  const trimmed = rawContent.trim();
  const slash = trimmed.match(/^\/(question|request|directive|decision)\b\s*/i);
  const content = slash ? trimmed.slice(slash[0].length).trim() : trimmed;
  const explicit = (slash?.[1]?.toLowerCase() ?? requestedIntent?.toLowerCase()) as HumanMessageType | undefined;
  if (explicit && messageTypes.has(explicit)) return { content, messageType: explicit };

  const value = content.toLowerCase();
  if (/\b(decision|decided|we will|we'll|approved|confirmed)\b|(^|[，。；;\s])(决定|确定|确认|批准|就这么做)/i.test(value)) return { content, messageType: "decision" };
  if (/^(please\b|can you\b|could you\b|would you\b|i need you to\b|help me\b|build\b|fix\b|create\b|delete\b|remove\b|restart\b|test\b|update\b|implement\b|run\b|check\b|send\b|continue\b)|^(请|麻烦|帮我|帮忙|给我|替我|请你|需要你|修改|实现|修复|创建|删除|清空|重启|测试|检查|继续)/i.test(value)) return { content, messageType: "request" };
  if (/[?？]\s*$/.test(value) || /^(what|why|how|when|where|who|which|is|are|do|does|did|should|would|could)\b|^(为什么|怎么|如何|什么时候|哪里|谁|哪个|是否|是不是|能不能|可不可以|啥|什么)/i.test(value) || /[吗呢]\s*$/.test(value)) return { content, messageType: "question" };
  if (/^(do not|don't|never|must|always|make sure|不要|别|必须|务必|应该|不能)/i.test(value)) return { content, messageType: "directive" };
  return { content, messageType: "directive" };
}
