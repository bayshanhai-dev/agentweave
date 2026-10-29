import {
  Badge,
  Button,
  Group,
  Modal,
  Paper,
  ScrollArea,
  Select,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
  Textarea,
  Title,
} from "@mantine/core";
import { useForm } from "@mantine/form";
import { useCallback, useEffect, useState } from "react";

type TriggerSummary = {
  id: string;
  name: string;
  kind: "schedule" | "api";
  cronExpr?: string;
  timezone: string;
  targetMode: "workstream" | "create";
  targetWorkstreamId?: string;
  templateId?: string;
  goalTemplate?: string;
  dutyTitle: string;
  dutyPrompt: string;
  targetRole?: string;
  completionEvidence?: "attestation" | "deliverable";
  enabled: boolean;
  lastFiredAt?: string;
  nextFireAt?: string | null;
};

type TriggerFormValues = {
  name: string;
  kind: "schedule" | "api";
  cronExpr: string;
  timezone: string;
  targetMode: "workstream" | "create";
  targetWorkstreamId: string;
  templateId: string;
  goalTemplate: string;
  dutyTitle: string;
  dutyPrompt: string;
  targetRole: string;
  completionEvidence: "attestation" | "deliverable";
};

const emptyValues: TriggerFormValues = {
  name: "",
  kind: "schedule",
  cronExpr: "0 9 * * *",
  timezone: "UTC",
  targetMode: "workstream",
  targetWorkstreamId: "",
  templateId: "software-development",
  goalTemplate: "",
  dutyTitle: "",
  dutyPrompt: "",
  targetRole: "",
  completionEvidence: "attestation",
};

const timestamp = (value?: string | null): string =>
  value ? new Date(value).toLocaleString() : "—";

export function TriggersPanel({ api }: { api: string }) {
  const [triggers, setTriggers] = useState<TriggerSummary[]>([]);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<TriggerSummary>();
  const form = useForm<TriggerFormValues>({
    initialValues: emptyValues,
    validate: {
      name: (value) => (value.trim() ? null : "Name is required"),
      timezone: (value) => (value.trim() ? null : "Timezone is required"),
      dutyTitle: (value) => (value.trim() ? null : "Duty title is required"),
      dutyPrompt: (value) => (value.trim() ? null : "Duty prompt is required"),
      cronExpr: (value, values) =>
        values.kind === "schedule" && !value.trim()
          ? "Cron expression is required"
          : null,
      targetWorkstreamId: (value, values) =>
        values.targetMode === "workstream" && !value.trim()
          ? "Workstream ID is required"
          : null,
      templateId: (value, values) =>
        values.targetMode === "create" && !value.trim()
          ? "Template ID is required"
          : null,
      goalTemplate: (value, values) =>
        values.targetMode === "create" && !value.trim()
          ? "Goal template is required"
          : null,
    },
  });

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

  function openCreate() {
    setEditing(undefined);
    form.setValues(emptyValues);
    form.resetDirty(emptyValues);
    setEditorOpen(true);
  }

  function openEdit(trigger: TriggerSummary) {
    setEditing(trigger);
    form.setValues({
      ...emptyValues,
      name: trigger.name,
      kind: trigger.kind,
      cronExpr: trigger.cronExpr ?? "",
      timezone: trigger.timezone,
      targetMode: trigger.targetMode,
      targetWorkstreamId: trigger.targetWorkstreamId ?? "",
      templateId: trigger.templateId ?? "",
      goalTemplate: trigger.goalTemplate ?? "",
      dutyTitle: trigger.dutyTitle,
      dutyPrompt: trigger.dutyPrompt,
      targetRole: trigger.targetRole ?? "",
      completionEvidence: trigger.completionEvidence ?? "attestation",
    });
    form.resetDirty();
    setEditorOpen(true);
  }

  async function save(values: TriggerFormValues) {
    setBusy(editing?.id ?? "create");
    try {
      const body: Record<string, unknown> = {
        name: values.name.trim(),
        kind: values.kind,
        timezone: values.timezone.trim(),
        targetMode: values.targetMode,
        dutyTitle: values.dutyTitle.trim(),
        dutyPrompt: values.dutyPrompt.trim(),
        completionEvidence: values.completionEvidence,
        targetRole: values.targetRole.trim() || null,
      };
      if (values.kind === "schedule") body.cronExpr = values.cronExpr.trim();
      if (values.targetMode === "workstream") {
        body.targetWorkstreamId = values.targetWorkstreamId.trim();
      } else {
        body.templateId = values.templateId.trim();
        body.goalTemplate = values.goalTemplate.trim();
      }
      const response = await fetch(
        `${api}/api/triggers${editing ? `/${editing.id}` : ""}`,
        {
          method: editing ? "PATCH" : "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      if (!response.ok) throw new Error(`Save failed (${response.status})`);
      setEditorOpen(false);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Save failed");
    } finally {
      setBusy(undefined);
    }
  }

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
          <Group>
            <Badge variant="light">{triggers.length}</Badge>
            <Button size="xs" onClick={openCreate}>
              New trigger
            </Button>
          </Group>
        </Group>
        {error && (
          <Text c="red" size="sm">
            {error}
          </Text>
        )}
        <ScrollArea type="auto">
          <Table striped highlightOnHover miw={980}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Name</Table.Th>
                <Table.Th>Kind</Table.Th>
                <Table.Th>Schedule</Table.Th>
                <Table.Th>Target</Table.Th>
                <Table.Th>Evidence</Table.Th>
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
                    <Text size="sm">
                      {trigger.targetRole ?? trigger.targetMode}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm">
                      {trigger.completionEvidence ?? "attestation"}
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
                    <Group gap="xs" wrap="nowrap">
                      <Button
                        size="xs"
                        variant="subtle"
                        onClick={() => openEdit(trigger)}
                      >
                        Edit
                      </Button>
                      <Button
                        size="xs"
                        variant="light"
                        loading={busy === trigger.id}
                        onClick={() => void run(trigger)}
                      >
                        Run now
                      </Button>
                    </Group>
                  </Table.Td>
                </Table.Tr>
              ))}
              {!triggers.length && !error && (
                <Table.Tr>
                  <Table.Td colSpan={9}>
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
      <Modal
        opened={editorOpen}
        onClose={() => setEditorOpen(false)}
        title={editing ? "Edit trigger" : "Create trigger"}
        centered
      >
        <form onSubmit={form.onSubmit((values) => void save(values))}>
          <Stack>
            <TextInput label="Name" required {...form.getInputProps("name")} />
            <Group grow>
              <Select
                label="Kind"
                data={["schedule", "api"]}
                {...form.getInputProps("kind")}
              />
              <TextInput
                label="Timezone"
                required
                {...form.getInputProps("timezone")}
              />
            </Group>
            {form.values.kind === "schedule" && (
              <TextInput
                label="Cron expression"
                placeholder="0 9 * * *"
                required
                {...form.getInputProps("cronExpr")}
              />
            )}
            <Select
              label="Target mode"
              data={[
                { value: "workstream", label: "Existing workstream" },
                { value: "create", label: "Create workstream" },
              ]}
              {...form.getInputProps("targetMode")}
            />
            {form.values.targetMode === "workstream" ? (
              <TextInput
                label="Workstream ID"
                required
                {...form.getInputProps("targetWorkstreamId")}
              />
            ) : (
              <>
                <TextInput
                  label="Template ID"
                  required
                  {...form.getInputProps("templateId")}
                />
                <Textarea
                  label="Goal template"
                  required
                  {...form.getInputProps("goalTemplate")}
                />
              </>
            )}
            <TextInput
              label="Target role"
              description="Leave empty to assign the lead role."
              placeholder="qa"
              {...form.getInputProps("targetRole")}
            />
            <Select
              label="Completion evidence"
              data={[
                { value: "attestation", label: "Attestation" },
                { value: "deliverable", label: "Deliverable" },
              ]}
              {...form.getInputProps("completionEvidence")}
            />
            <TextInput
              label="Duty title"
              required
              {...form.getInputProps("dutyTitle")}
            />
            <Textarea
              label="Duty prompt"
              required
              autosize
              minRows={3}
              {...form.getInputProps("dutyPrompt")}
            />
            <Button type="submit" loading={busy === (editing?.id ?? "create")}>
              {editing ? "Save trigger" : "Create trigger"}
            </Button>
          </Stack>
        </form>
      </Modal>
    </Paper>
  );
}
