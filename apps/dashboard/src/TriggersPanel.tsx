import {
  Badge,
  Button,
  Group,
  Paper,
  ScrollArea,
  Stack,
  Switch,
  Table,
  Text,
  Title,
} from "@mantine/core";
import { useCallback, useEffect, useState } from "react";

type TriggerSummary = {
  id: string;
  name: string;
  kind: "schedule" | "api";
  cronExpr?: string;
  timezone: string;
  enabled: boolean;
  lastFiredAt?: string;
  nextFireAt?: string | null;
};

const timestamp = (value?: string | null): string =>
  value ? new Date(value).toLocaleString() : "—";

export function TriggersPanel({ api }: { api: string }) {
  const [triggers, setTriggers] = useState<TriggerSummary[]>([]);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const load = useCallback(async () => {
    try {
      const response = await fetch(`${api}/api/triggers`);
      if (!response.ok)
        throw new Error(`Unable to load triggers (${response.status})`);
      setTriggers((await response.json()) as TriggerSummary[]);
      setError(undefined);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Unable to load triggers",
      );
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggle(trigger: TriggerSummary) {
    setBusy(trigger.id);
    try {
      const response = await fetch(`${api}/api/triggers/${trigger.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: !trigger.enabled }),
      });
      if (!response.ok) throw new Error(`Update failed (${response.status})`);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Update failed");
    } finally {
      setBusy(undefined);
    }
  }

  async function run(trigger: TriggerSummary) {
    setBusy(trigger.id);
    try {
      const response = await fetch(`${api}/api/triggers/${trigger.id}/fire`, {
        method: "POST",
      });
      if (!response.ok) throw new Error(`Run failed (${response.status})`);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Run failed");
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <Paper withBorder radius="lg" p="lg">
      <Stack gap="md">
        <Group justify="space-between">
          <div>
            <Title order={3}>Triggers</Title>
            <Text size="sm" c="dimmed">
              Create and edit triggers through the API; operational controls are
              available here.
            </Text>
          </div>
          <Badge variant="light">{triggers.length}</Badge>
        </Group>
        {error && (
          <Text c="red" size="sm">
            {error}
          </Text>
        )}
        <ScrollArea type="auto">
          <Table striped highlightOnHover miw={760}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Name</Table.Th>
                <Table.Th>Kind</Table.Th>
                <Table.Th>Schedule</Table.Th>
                <Table.Th>Enabled</Table.Th>
                <Table.Th>Last fire</Table.Th>
                <Table.Th>Next fire</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {triggers.map((trigger) => (
                <Table.Tr key={trigger.id}>
                  <Table.Td>
                    <Text fw={700} size="sm">
                      {trigger.name}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Badge size="sm" variant="light">
                      {trigger.kind}
                    </Badge>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm" ff="monospace">
                      {trigger.kind === "schedule"
                        ? `${trigger.cronExpr} · ${trigger.timezone}`
                        : "api"}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Switch
                      aria-label={`Toggle ${trigger.name}`}
                      checked={trigger.enabled}
                      disabled={busy === trigger.id}
                      onChange={() => void toggle(trigger)}
                    />
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm">{timestamp(trigger.lastFiredAt)}</Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm">{timestamp(trigger.nextFireAt)}</Text>
                  </Table.Td>
                  <Table.Td>
                    <Button
                      size="xs"
                      variant="light"
                      loading={busy === trigger.id}
                      onClick={() => void run(trigger)}
                    >
                      Run now
                    </Button>
                  </Table.Td>
                </Table.Tr>
              ))}
              {!triggers.length && !error && (
                <Table.Tr>
                  <Table.Td colSpan={7}>
                    <Text ta="center" c="dimmed" size="sm">
                      No triggers configured.
                    </Text>
                  </Table.Td>
                </Table.Tr>
              )}
            </Table.Tbody>
          </Table>
        </ScrollArea>
      </Stack>
    </Paper>
  );
}
