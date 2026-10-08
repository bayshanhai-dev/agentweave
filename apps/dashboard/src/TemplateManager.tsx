import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Card,
  Divider,
  Group,
  Modal,
  MultiSelect,
  Select,
  SimpleGrid,
  Stack,
  Text,
  Textarea,
  TextInput,
  Title,
} from "@mantine/core";
import { IconAlertCircle, IconPlus, IconTrash } from "@tabler/icons-react";
import { useCallback, useEffect, useState } from "react";

type TemplateRole = {
  id: string;
  label: string;
  authority: "lead" | "executor" | "reviewer";
  description: string;
};

type TemplateLane = {
  status: "ready" | "assigned" | "running" | "review" | "blocked" | "done" | "failed" | "cancelled";
  label: string;
  color: string;
};

export type WorkstreamTemplateInfo = {
  id: string;
  name: string;
  description: string;
  builtin: boolean;
  roles: TemplateRole[];
  taskLanes: TemplateLane[];
};

const AUTHORITIES = [
  { value: "lead", label: "Lead" },
  { value: "executor", label: "Executor" },
  { value: "reviewer", label: "Reviewer" },
];

const DEFAULT_LANES: TemplateLane[] = [
  { status: "ready", label: "Backlog", color: "gray" },
  { status: "assigned", label: "To Do", color: "blue" },
  { status: "running", label: "In Progress", color: "yellow" },
  { status: "review", label: "Review", color: "violet" },
  { status: "done", label: "Done", color: "green" },
];

const emptyRole = (): TemplateRole => ({ id: "", label: "", authority: "executor", description: "" });

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function TemplateManager({ api }: { api: string }) {
  const [templates, setTemplates] = useState<WorkstreamTemplateInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [roles, setRoles] = useState<TemplateRole[]>([emptyRole(), emptyRole()]);
  const [leadRole, setLeadRole] = useState<string | null>(null);
  const [planningRole, setPlanningRole] = useState<string | null>(null);
  const [reviewRole, setReviewRole] = useState<string | null>(null);
  const [executionRoles, setExecutionRoles] = useState<string[]>([]);
  const [lanes, setLanes] = useState<TemplateLane[]>(DEFAULT_LANES.map((lane) => ({ ...lane })));

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(`${api}/api/workstream-templates`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = (await response.json()) as WorkstreamTemplateInfo[];
      setTemplates(data);
    } catch {
      setTemplates([]);
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const resetForm = () => {
    setId("");
    setName("");
    setDescription("");
    setRoles([emptyRole(), emptyRole()]);
    setLeadRole(null);
    setPlanningRole(null);
    setReviewRole(null);
    setExecutionRoles([]);
    setLanes(DEFAULT_LANES.map((lane) => ({ ...lane })));
    setError(null);
  };

  const roleOptions = roles
    .map((role) => role.id.trim())
    .filter(Boolean)
    .map((roleId) => ({ value: roleId, label: roleId }));

  const updateRole = (index: number, patch: Partial<TemplateRole>) => {
    setRoles((current) => current.map((role, i) => (i === index ? { ...role, ...patch } : role)));
  };

  const removeRole = (index: number) => {
    setRoles((current) => {
      if (current.length <= 2) return current;
      return current.filter((_, i) => i !== index);
    });
  };

  const submit = async () => {
    setError(null);
    setSubmitting(true);
    try {
      const payload = {
        id: id.trim() || slugify(name),
        name: name.trim(),
        description: description.trim(),
        roles: roles.map((role) => ({
          id: role.id.trim(),
          label: role.label.trim(),
          authority: role.authority,
          description: role.description.trim(),
        })),
        taskLanes: lanes,
        orchestration: { leadRole, planningRole, executionRoles, reviewRole },
      };
      const response = await fetch(`${api}/api/workstream-templates`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string; message?: string; details?: string[] };
      if (!response.ok) {
        const details = Array.isArray(body.details) ? `: ${body.details.join("; ")}` : "";
        throw new Error(`${body.message ?? body.error ?? `HTTP ${response.status}`}${details}`);
      }
      setModalOpen(false);
      resetForm();
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to create template");
    } finally {
      setSubmitting(false);
    }
  };

  const remove = async (templateId: string) => {
    if (!window.confirm(`Delete custom template "${templateId}"? Workstreams already created from it keep working.`)) return;
    setDeleting(templateId);
    try {
      const response = await fetch(`${api}/api/workstream-templates/${encodeURIComponent(templateId)}`, { method: "DELETE" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await refresh();
    } catch {
      setError("Failed to delete template");
    } finally {
      setDeleting(null);
    }
  };

  return (
    <Stack gap="md">
      <Group justify="space-between">
        <div>
          <Title order={3}>Workstream templates</Title>
          <Text size="sm" c="dimmed">
            Templates define the agent roles, task lanes, and workflow policy for a workstream.
          </Text>
        </div>
        <Button leftSection={<IconPlus size={16} />} onClick={() => { resetForm(); setModalOpen(true); }}>
          New template
        </Button>
      </Group>

      {loading ? (
        <Text size="sm" c="dimmed">Loading templates…</Text>
      ) : (
        <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="md">
          {templates.map((template) => (
            <Card key={template.id} withBorder radius="md" padding="md">
              <Group justify="space-between" align="flex-start">
                <div>
                  <Text fw={700}>{template.name}</Text>
                  <Text size="xs" c="dimmed">{template.id}</Text>
                </div>
                {template.builtin ? (
                  <Badge color="gray" variant="light">Built-in</Badge>
                ) : (
                  <Group gap="xs">
                    <Badge color="teal" variant="light">Custom</Badge>
                    <ActionIcon
                      size="sm"
                      color="red"
                      variant="subtle"
                      aria-label={`Delete template ${template.id}`}
                      loading={deleting === template.id}
                      onClick={() => void remove(template.id)}
                    >
                      <IconTrash size={14} />
                    </ActionIcon>
                  </Group>
                )}
              </Group>
              {template.description && (
                <Text size="sm" c="dimmed" mt="xs" lineClamp={2}>{template.description}</Text>
              )}
              <Text size="xs" c="dimmed" mt="sm">
                {template.roles.length} roles · {template.roles.map((role) => role.label).join(", ")}
              </Text>
            </Card>
          ))}
        </SimpleGrid>
      )}

      <Modal opened={modalOpen} onClose={() => setModalOpen(false)} title="New workstream template" size="lg" centered>
        <Stack gap="md">
          <SimpleGrid cols={2} spacing="sm">
            <TextInput label="Template ID" placeholder="podcast-production" value={id} onChange={(e) => setId(e.currentTarget.value)} required />
            <TextInput label="Name" placeholder="Podcast production" value={name} onChange={(e) => setName(e.currentTarget.value)} required />
          </SimpleGrid>
          <Textarea label="Description" placeholder="What is this template for?" autosize minRows={2} value={description} onChange={(e) => setDescription(e.currentTarget.value)} />

          <Divider label="Roles" labelPosition="left" />
          <Stack gap="xs">
            {roles.map((role, index) => (
              <Group key={index} gap="xs" align="flex-end" wrap="nowrap">
                <TextInput label={index === 0 ? "ID" : undefined} placeholder="producer" value={role.id} onChange={(e) => updateRole(index, { id: e.currentTarget.value })} style={{ flex: 1 }} />
                <TextInput label={index === 0 ? "Label" : undefined} placeholder="Producer" value={role.label} onChange={(e) => updateRole(index, { label: e.currentTarget.value })} style={{ flex: 1 }} />
                <Select label={index === 0 ? "Authority" : undefined} data={AUTHORITIES} value={role.authority} onChange={(value) => updateRole(index, { authority: (value ?? "executor") as TemplateRole["authority"] })} style={{ width: 130 }} />
                <ActionIcon color="red" variant="subtle" aria-label="Remove role" disabled={roles.length <= 2} onClick={() => removeRole(index)}>
                  <IconTrash size={16} />
                </ActionIcon>
              </Group>
            ))}
            <Button variant="light" size="xs" leftSection={<IconPlus size={14} />} onClick={() => setRoles((current) => [...current, emptyRole()])} style={{ alignSelf: "flex-start" }}>
              Add role
            </Button>
          </Stack>
          <Textarea label="Role descriptions (optional, one per line as id: description)" placeholder={"producer: Owns the episode plan.\nhost: Records the episode."} autosize minRows={2} value={roles.map((r) => (r.description ? `${r.id}: ${r.description}` : "")).filter(Boolean).join("\n")} onChange={(e) => {
            const parsed = new Map(e.currentTarget.value.split("\n").map((line) => {
              const colon = line.indexOf(":");
              return colon >= 0 ? [line.slice(0, colon).trim(), line.slice(colon + 1).trim()] as const : [line.trim(), ""] as const;
            }));
            setRoles((current) => current.map((role) => ({ ...role, description: parsed.get(role.id.trim()) ?? role.description })));
          }} />

          <Divider label="Orchestration" labelPosition="left" />
          <SimpleGrid cols={2} spacing="sm">
            <Select label="Lead role" placeholder="Pick a role" data={roleOptions} value={leadRole} onChange={setLeadRole} />
            <Select label="Planning role" placeholder="Pick a role" data={roleOptions} value={planningRole} onChange={setPlanningRole} />
            <Select label="Review role" placeholder="Pick a role" data={roleOptions} value={reviewRole} onChange={setReviewRole} />
            <MultiSelect label="Execution roles" placeholder="Pick roles" data={roleOptions} value={executionRoles} onChange={setExecutionRoles} />
          </SimpleGrid>

          <Divider label="Task lanes" labelPosition="left" />
          <Stack gap="xs">
            {lanes.map((lane, index) => (
              <Group key={lane.status} gap="xs" align="center" wrap="nowrap">
                <Badge variant="light" style={{ minWidth: 90 }}>{lane.status}</Badge>
                <TextInput aria-label={`${lane.status} lane label`} value={lane.label} onChange={(e) => setLanes((current) => current.map((l, i) => (i === index ? { ...l, label: e.currentTarget.value } : l)))} style={{ flex: 1 }} />
              </Group>
            ))}
          </Stack>

          {error && (
            <Alert icon={<IconAlertCircle size={16} />} color="red" withCloseButton onClose={() => setError(null)}>
              {error}
            </Alert>
          )}
          <Button onClick={() => void submit()} loading={submitting}>
            Create template
          </Button>
        </Stack>
      </Modal>
    </Stack>
  );
}
