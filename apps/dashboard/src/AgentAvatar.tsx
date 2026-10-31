import { IconRobot } from "@tabler/icons-react";

export type AvatarState = "idle" | "working" | "done";

type Props = {
  color: string;
  icon?: string;
  state: AvatarState;
  size?: number;
};

/** A fixed-size line-icon box; presence and last signal carry the live state. */
export function AgentAvatar({ color, state, size = 40 }: Props) {
  const accent = /^#[0-9a-fA-F]{6}$/.test(color.trim()) ? color.trim() : "#b8c99c";
  return (
    <span
      className="av-wrap"
      style={{
        width: size,
        height: size,
        color: accent,
        background: `color-mix(in srgb, ${accent} 18%, var(--aw-raised))`,
      }}
      role="img"
      aria-label={`Agent avatar (${state})`}
    >
      <IconRobot size={Math.round(size * 0.48)} stroke={1.5} aria-hidden />
    </span>
  );
}
