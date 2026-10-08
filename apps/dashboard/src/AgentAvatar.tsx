import { useId } from "react";
import { shadeHex } from "./roleVisuals";

export type AvatarState = "idle" | "working" | "done";

type Props = {
  color: string;
  icon?: string;
  state: AvatarState;
  size?: number;
};

/**
 * Animated SVG agent character. Pure SVG + CSS animations, no assets:
 * blinking eyes, drifting pupils, gentle bobbing, and a mouth that talks
 * while working, smiles when done, and rests flat when idle.
 */
export function AgentAvatar({ color, icon, state, size = 40 }: Props) {
  const gradientId = useId().replace(/[^a-zA-Z0-9]/g, "");
  const base = /^#[0-9a-fA-F]{6}$/.test(color.trim()) ? color.trim() : "#818cf8";
  const dark = shadeHex(base, -45);
  const badge = size * 0.52;

  return (
    <span
      className="av-wrap"
      style={{
        width: size,
        height: size,
        filter: `drop-shadow(0 0 ${Math.max(6, size * 0.28)}px ${base}66)`,
      }}
      role="img"
      aria-label={`Agent avatar (${state})`}
    >
      <svg width={size} height={size} viewBox="0 0 40 40" className="av-svg">
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor={dark} />
            <stop offset="1" stopColor={base} />
          </linearGradient>
        </defs>
        <circle cx="20" cy="20" r="19" fill={`url(#${gradientId})`} />
        <g className="av-eyes">
          <ellipse cx="13.5" cy="17" rx="3.4" ry="4" fill="#fff" />
          <ellipse cx="26.5" cy="17" rx="3.4" ry="4" fill="#fff" />
          <circle className="av-pupil" cx="13.5" cy="18" r="1.7" fill="#0a0a10" />
          <circle className="av-pupil" cx="26.5" cy="18" r="1.7" fill="#0a0a10" />
        </g>
        {state === "working" ? (
          <ellipse className="av-mouth-talk" cx="20" cy="27" rx="4" ry="5" fill="#0a0a10" />
        ) : state === "done" ? (
          <path
            d="M13 26 Q20 32 27 26"
            stroke="#0a0a10"
            strokeWidth="2.5"
            fill="none"
            strokeLinecap="round"
          />
        ) : (
          <line x1="15" y1="28" x2="25" y2="28" stroke="#0a0a10" strokeWidth="2.5" strokeLinecap="round" />
        )}
      </svg>
      {icon ? (
        <span
          className="av-icon-badge"
          style={{ width: badge, height: badge, fontSize: badge * 0.62 }}
          aria-hidden
        >
          {icon}
        </span>
      ) : null}
    </span>
  );
}
