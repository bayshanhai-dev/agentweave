import { Group, Stack, Text, Tooltip } from "@mantine/core";

export type TokenDonutDatum = {
  role: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Optional explicit color; falls back to the hash-based palette. */
  color?: string;
};

const PALETTE = [
  "#4dabf7", // blue
  "#63e6be", // teal
  "#9775fa", // violet
  "#ffa94d", // orange
  "#f783ac", // pink
  "#66d9e8", // cyan
  "#a9e34b", // lime
  "#ffd43b", // yellow
  "#ff8787", // red
  "#748ffc", // indigo
];

function colorForRole(role: string): string {
  let hash = 0;
  for (let i = 0; i < role.length; i += 1) {
    hash = (hash * 31 + role.charCodeAt(i)) >>> 0;
  }
  return PALETTE[hash % PALETTE.length];
}

const SIZE = 220;
const STROKE = 36;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export function TokenDonutChart({ data }: { data: TokenDonutDatum[] }) {
  const entries = data.filter((datum) => datum.totalTokens > 0);
  const total = entries.reduce((sum, datum) => sum + datum.totalTokens, 0);

  if (entries.length === 0 || total <= 0) {
    return (
      <Text size="sm" c="dimmed" ta="center" py="md">
        No token usage reported yet
      </Text>
    );
  }

  let consumed = 0;
  const segments = entries.map((entry) => {
    const length = (entry.totalTokens / total) * CIRCUMFERENCE;
    const dashOffset = -consumed;
    consumed += length;
    return { ...entry, length, dashOffset, color: entry.color ?? colorForRole(entry.role) };
  });

  return (
    <Group align="center" gap="xl" wrap="wrap">
      <div style={{ position: "relative", width: SIZE, height: SIZE, flexShrink: 0 }}>
        <svg width={SIZE} height={SIZE} role="img" aria-label="Token usage by agent">
          <circle
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={RADIUS}
            fill="none"
            stroke="var(--mantine-color-gray-2)"
            strokeWidth={STROKE}
          />
          {segments.map((segment) => (
            <Tooltip
              key={segment.role}
              withArrow
              label={
                <Stack gap={2}>
                  <Text size="xs" fw={700}>{segment.role.toUpperCase()}</Text>
                  <Text size="xs">Input: {segment.inputTokens.toLocaleString()}</Text>
                  <Text size="xs">Output: {segment.outputTokens.toLocaleString()}</Text>
                  <Text size="xs">Total: {segment.totalTokens.toLocaleString()}</Text>
                </Stack>
              }
            >
              <circle
                cx={SIZE / 2}
                cy={SIZE / 2}
                r={RADIUS}
                fill="none"
                stroke={segment.color}
                strokeWidth={STROKE}
                strokeDasharray={`${segment.length} ${CIRCUMFERENCE - segment.length}`}
                strokeDashoffset={segment.dashOffset}
                transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
                style={{ cursor: "pointer" }}
              />
            </Tooltip>
          ))}
        </svg>
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            pointerEvents: "none",
          }}
        >
          <Text size="xs" c="dimmed" tt="uppercase" fw={700}>Total tokens</Text>
          <Text size="xl" fw={800}>{total.toLocaleString()}</Text>
        </div>
      </div>
      <Stack gap="xs">
        {segments.map((segment) => (
          <Group key={segment.role} gap="xs">
            <span
              style={{
                width: 12,
                height: 12,
                borderRadius: 3,
                backgroundColor: segment.color,
                flexShrink: 0,
              }}
            />
            <Text size="sm" fw={700}>{segment.role.toUpperCase()}</Text>
            <Text size="sm" c="dimmed">{segment.totalTokens.toLocaleString()}</Text>
          </Group>
        ))}
      </Stack>
    </Group>
  );
}
