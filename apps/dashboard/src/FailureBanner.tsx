import { Group, Text, ThemeIcon } from "@mantine/core";
import { IconAlertOctagon } from "@tabler/icons-react";

type Props = {
  reason?: string;
  failedTasks: string[];
};

/**
 * The failure banner: when a workstream fails, say so at the top of the page
 * with the recorded reason — not just a red badge and silence. Failure detail
 * previously lived only in worker logs, which the user never sees.
 */
export function FailureBanner({ reason, failedTasks }: Props) {
  const shown = failedTasks.slice(0, 3);
  return (
    <div className="cc-failure-banner" role="alert">
      <Group gap="xs">
        <ThemeIcon size="sm" radius="xl" color="red" variant="light">
          <IconAlertOctagon size={13} />
        </ThemeIcon>
        <Text fw={500} size="sm">
          This workstream failed
        </Text>
      </Group>
      {reason && (
        <Text size="sm" mt={6}>
          {reason}
        </Text>
      )}
      {shown.length > 0 && (
        <Text size="sm" c="dimmed" mt={2}>
          Failed tasks: {shown.join(" · ")}
          {failedTasks.length > shown.length ? ` · +${failedTasks.length - shown.length} more` : ""}
        </Text>
      )}
      <Text size="xs" c="dimmed" mt={6}>
        Fix the cause, then use Resume in the controls above to continue, or Emergency stop to abandon the run.
      </Text>
    </div>
  );
}
