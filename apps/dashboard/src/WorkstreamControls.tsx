import {
  Alert,
  Button,
  Group,
  Modal,
  Select,
  Stack,
  Textarea,
  TextInput,
} from "@mantine/core";
import { useForm } from "@mantine/form";
import {
  IconAlertCircle,
  IconCheck,
  IconPlayerPause,
  IconPlayerPlay,
  IconPlayerStop,
  IconPlus,
  IconRefresh,
} from "@tabler/icons-react";
import { useEffect, useState } from "react";

type Props = {
  api: string;
  workstreamId: string;
  status: string;
  onStatus: (status: string) => void;
  onCreated?: (workstreamId: string) => void;
  openCreate?: boolean;
  onCreateOpenChange?: (open: boolean) => void;
  createOnly?: boolean;
};
const commands = [
  { key: "pause", label: "Pause", icon: IconPlayerPause },
  { key: "resume", label: "Resume", icon: IconRefresh },
  { key: "complete", label: "Complete", icon: IconCheck },
  { key: "emergency-stop", label: "Emergency stop", icon: IconPlayerStop },
];
const demoWorkstream = {
  goal: "Build a small, accessible markdown note editor with a clear README and passing tests.",
  workspace: "/workspaces",
  provider: "mock",
  model: "deterministic",
};

export function WorkstreamControls({
  api,
  workstreamId,
  status,
  onStatus,
  onCreated,
  openCreate = false,
  onCreateOpenChange,
  createOnly = false,
}: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opened, setOpened] = useState(openCreate);
  const form = useForm({
    initialValues: {
      goal: "",
      flavor: "software-development",
      workspace: "/workspaces/academic-paper-buddy",
      provider: "codex",
      model: "gpt-5.6-luna",
    },
    validate: {
      goal: (value) =>
        value.trim().length < 3
          ? "Describe what this Workstream should accomplish"
          : null,
      workspace: (value) =>
        value.trim() ? null : "Workspace path is required",
    },
  });
  useEffect(() => setOpened(openCreate), [openCreate]);
  useEffect(() => {
    if (!workstreamId) return;
    let disposed = false;
    const refreshStatus = async () => {
      try {
        const response = await fetch(`${api}/api/workstreams/${workstreamId}`);
        if (!response.ok || disposed) return;
        const current = (await response.json()) as { status?: string };
        if (current.status) onStatus(current.status);
      } catch {
        // The live event stream remains the primary update path while the API is restarting.
      }
    };
    void refreshStatus();
    const timer = window.setInterval(() => void refreshStatus(), 5000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [api, workstreamId]);
  const setCreateModal = (value: boolean) => {
    setOpened(value);
    onCreateOpenChange?.(value);
  };
  async function create(values: typeof form.values) {
    setBusy("create");
    try {
      const response = await fetch(`${api}/api/workstreams`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          goal: values.goal.trim(),
          flavor: values.flavor,
          workspaceRoot: values.workspace.trim(),
          tool: values.provider,
          model: values.model,
        }),
      });
      const created = (await response.json()) as {
        id?: string;
        error?: string;
      };
      if (!response.ok || !created.id)
        throw new Error(created.error ?? "Unable to create Workstream");
      setCreateModal(false);
      form.reset();
      onCreated?.(created.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }
  function createDemo() {
    form.setValues(demoWorkstream);
    void create({ ...form.values, ...demoWorkstream });
  }
  async function start() {
    setBusy("start");
    try {
      const response = await fetch(
        `${api}/api/workstreams/${workstreamId}/start`,
        { method: "POST" },
      );
      const result = (await response.json()) as {
        status?: string;
        error?: string;
      };
      if (!response.ok) {
        if (result.status) onStatus(result.status);
        if (result.error === "workstream_not_draft" && result.status) {
          setError(`Workstream is already ${result.status.replaceAll("_", " ")}. Status refreshed.`);
          return;
        }
        throw new Error(result.error ?? "Start failed");
      }
      if (result.status) onStatus(result.status);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }
  async function command(key: string) {
    setBusy(key);
    try {
      const response = await fetch(
        `${api}/api/workstreams/${workstreamId}/${key}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ commandId: `${key}-${Date.now()}` }),
        },
      );
      const result = (await response.json()) as {
        status?: string;
        error?: string;
        message?: string;
      };
      if (!response.ok)
        throw new Error(
          result.message ?? result.error ?? `Command ${key} failed`,
        );
      if (result.status) onStatus(result.status);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }
  async function approval(decision: "complete" | "reject") {
    setBusy(`approval-${decision}`);
    try {
      const response = await fetch(
        `${api}/api/workstreams/${workstreamId}/approval`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            commandId: `approval-${decision}-${Date.now()}`,
            decision,
          }),
        },
      );
      const result = (await response.json()) as {
        status?: string;
        error?: string;
      };
      if (!response.ok) throw new Error(result.error ?? "Approval failed");
      if (result.status) onStatus(result.status);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }
  const terminal = ["completed", "archived", "emergency_stopped"].includes(
    status,
  );
  const waiting = status === "waiting_for_human" || status === "completing";
  return (
    <>
      <Group gap="xs" style={createOnly ? { display: "none" } : undefined}>
        <Button
          variant="light"
          leftSection={<IconPlus size={16} />}
          onClick={() => setCreateModal(true)}
        >
          New Workstream
        </Button>
        {status === "draft" && (
          <Button
            leftSection={<IconPlayerPlay size={16} />}
            loading={busy === "start"}
            onClick={() => void start()}
          >
            Start Workstream
          </Button>
        )}
        {commands.map(({ key, label, icon: Icon }) => (
          <Button
            key={key}
            variant={key === "emergency-stop" ? "outline" : "default"}
            color={key === "emergency-stop" ? "red" : undefined}
            leftSection={<Icon size={16} />}
            disabled={
              status === "draft" ||
              terminal ||
              busy !== null ||
              (key === "pause" && status === "paused") ||
              (key === "resume" && status !== "paused")
            }
            loading={busy === key}
            onClick={() => void command(key)}
          >
            {label}
          </Button>
        ))}
        {waiting && (
          <>
            <Button
              color="green"
              loading={busy === "approval-complete"}
              onClick={() => void approval("complete")}
            >
              Approve & complete
            </Button>
            <Button
              variant="subtle"
              color="red"
              loading={busy === "approval-reject"}
              onClick={() => void approval("reject")}
            >
              Reject
            </Button>
          </>
        )}
      </Group>
      {error && (
        <Alert
          mt="sm"
          icon={<IconAlertCircle size={16} />}
          color="red"
          withCloseButton
          onClose={() => setError(null)}
        >
          {error}
        </Alert>
      )}
      <Modal
        opened={opened}
        onClose={() => setCreateModal(false)}
        title="Create a Workstream"
        centered
      >
        <form onSubmit={form.onSubmit((values) => void create(values))}>
          <Stack>
            <Textarea
              label="Goal"
              placeholder="What should this Workstream accomplish?"
              autosize
              minRows={3}
              {...form.getInputProps("goal")}
            />
            <TextInput
              label="Workspace path"
              {...form.getInputProps("workspace")}
            />
            <Select
              label="Flavor"
              data={[
                {
                  value: "software-development",
                  label: "Software development",
                },
              ]}
              {...form.getInputProps("flavor")}
            />
            <Select
              label="Provider"
              data={[
                { value: "codex", label: "Codex" },
                { value: "mock", label: "Mock (deterministic)" },
              ]}
              {...form.getInputProps("provider")}
            />
            <TextInput label="Model" {...form.getInputProps("model")} />
            <Button type="submit" loading={busy === "create"}>
              Create Workstream
            </Button>
            <Button type="button" variant="light" loading={busy === "create"} onClick={createDemo}>
              Create demo workstream
            </Button>
          </Stack>
        </form>
      </Modal>
    </>
  );
}
