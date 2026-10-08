import { ActionIcon, Badge, Button, Group, Paper, Stack, Text, Textarea } from "@mantine/core";
import { IconSend, IconX } from "@tabler/icons-react";
import { useMemo, useRef, useState } from "react";

export type SteerRole = { id: string; label: string };

type Props = {
  roles: SteerRole[];
  onSubmit: (text: string) => void;
  error: string | null;
};

const MENTION_PATTERN = /@([a-z0-9_-]*)$/i;

/**
 * Human steer composer: type @ to tag agents (or @all), write the directive,
 * hit Steer. Tagged roles are sent as @mentions through the normal
 * human-message channel so agents must honor the steer.
 */
export function SteerComposer({ roles, onSubmit, error }: Props) {
  const [text, setText] = useState("");
  const [chips, setChips] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const mentionQuery = useMemo(() => {
    const match = text.match(MENTION_PATTERN);
    return match ? match[1].toLowerCase() : null;
  }, [text]);

  const options = useMemo<Array<SteerRole & { all?: boolean }>>(() => {
    if (mentionQuery === null) return [];
    const q = mentionQuery;
    const matches = roles.filter(
      (role) => !chips.includes(role.id) && (role.id.toLowerCase().includes(q) || role.label.toLowerCase().includes(q)),
    );
    const all: Array<SteerRole & { all?: boolean }> = q === "" || "all".includes(q)
      ? [{ id: "__all", label: "Everyone", all: true }]
      : [];
    return [...all, ...matches];
  }, [mentionQuery, roles, chips]);

  const addChip = (id: string) => {
    if (id === "__all") {
      setChips(roles.map((role) => role.id));
    } else if (!chips.includes(id)) {
      setChips((current) => [...current, id]);
    }
    setText((current) => current.replace(MENTION_PATTERN, ""));
    setOpen(false);
    setHighlight(0);
    inputRef.current?.focus();
  };

  const removeChip = (id: string) => setChips((current) => current.filter((chip) => chip !== id));

  const submit = () => {
    const mentions = chips.map((chip) => `@${chip}`).join(" ");
    const body = text.replace(MENTION_PATTERN, "").trim();
    const final = [mentions, body].filter(Boolean).join(" ").trim();
    if (!final) return;
    onSubmit(final);
    setText("");
    setChips([]);
    setOpen(false);
  };

  return (
    <Stack gap="xs" className="cc-composer">
      {chips.length > 0 && (
        <Group gap="xs">
          {chips.map((chip) => {
            const role = roles.find((candidate) => candidate.id === chip);
            return (
              <Badge
                key={chip}
                size="sm"
                variant="filled"
                color="cyan"
                rightSection={
                  <ActionIcon size="xs" variant="transparent" color="white" onClick={() => removeChip(chip)} aria-label={`Remove @${chip}`}>
                    <IconX size={10} />
                  </ActionIcon>
                }
              >
                @{role?.label ?? chip}
              </Badge>
            );
          })}
        </Group>
      )}
      <div className="cc-composer-field">
        <Textarea
          ref={inputRef}
          placeholder="Type @ to tag agents, then write your steer…"
          value={text}
          minRows={2}
          autosize
          onChange={(event) => {
            const next = event.currentTarget.value;
            setText(next);
            const hasMention = MENTION_PATTERN.test(next);
            setOpen(hasMention);
            setHighlight(0);
          }}
          onKeyDown={(event) => {
            if (open && options.length > 0) {
              if (event.key === "ArrowDown") { event.preventDefault(); setHighlight((h) => (h + 1) % options.length); return; }
              if (event.key === "ArrowUp") { event.preventDefault(); setHighlight((h) => (h - 1 + options.length) % options.length); return; }
              if (event.key === "Enter" || event.key === "Tab") { event.preventDefault(); addChip(options[highlight].id); return; }
              if (event.key === "Escape") { setOpen(false); return; }
            }
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              submit();
            }
          }}
          aria-label="Steer message"
        />
        {open && options.length > 0 && (
          <Paper withBorder shadow="md" className="cc-mention-dropdown" radius="md" p={4}>
            {options.map((option, index) => (
              <div
                key={option.id}
                role="option"
                aria-selected={index === highlight}
                className={`cc-mention-option${index === highlight ? " cc-mention-option-active" : ""}`}
                onMouseDown={(event) => { event.preventDefault(); addChip(option.id); }}
                onMouseEnter={() => setHighlight(index)}
              >
                <Text size="sm" fw={700}>@{option.all ? "all" : option.id}</Text>
                <Text size="xs" c="dimmed">{option.all ? "Tag every agent" : `Direct ${option.label}`}</Text>
              </div>
            ))}
          </Paper>
        )}
      </div>
      {error && <Text size="xs" c="red">{error}</Text>}
      <Group justify="space-between" align="center">
        <Group gap={4}>
          <Text size="xs" c="dimmed">Tag:</Text>
          {roles.slice(0, 5).map((role) => (
            <Button key={role.id} size="compact-xs" variant="subtle" onClick={() => addChip(role.id)}>
              @{role.id}
            </Button>
          ))}
          {roles.length > 5 && (
            <Button size="compact-xs" variant="subtle" onClick={() => addChip("__all")}>@all</Button>
          )}
        </Group>
        <Button
          leftSection={<IconSend size={14} />}
          onClick={submit}
          disabled={!text.trim() && chips.length === 0}
          className="cc-steer-button"
        >
          Steer
        </Button>
      </Group>
    </Stack>
  );
}
