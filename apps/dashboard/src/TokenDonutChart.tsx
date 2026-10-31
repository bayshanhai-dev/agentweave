import { Group, Stack, Text, Tooltip } from "@mantine/core";

export type TokenDonutDatum = {
  role: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Kept for data compatibility; chart color is intentionally system-owned. */
  color?: string;
};

const SERIES_COLORS = ["#b8c99c", "#a9afb0", "#92999a", "#c0b9a7", "#7d8587", "#a1a7a0"];

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
  const segments = entries.map((entry, index) => {
    const length = (entry.totalTokens / total) * CIRCUMFERENCE;
    const dashOffset = -consumed;
    consumed += length;
    return { ...entry, length, dashOffset, color: SERIES_COLORS[index % SERIES_COLORS.length] };
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
                  <Text size="xs" fw={500}>{segment.role}</Text>
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
          <Text size="xs" c="dimmed" fw={500}>Total tokens</Text>
          <Text size="xl" fw={500} ff="monospace">{total.toLocaleString()}</Text>
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
            <Text size="sm" fw={500}>{segment.role}</Text>
            <Text size="sm" c="dimmed" ff="monospace">{segment.totalTokens.toLocaleString()}</Text>
          </Group>
        ))}
      </Stack>
    </Group>
  );
}
