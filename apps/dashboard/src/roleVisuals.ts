/**
 * Shared role visuals: every agent role gets a deterministic color (from its
 * template when available, otherwise a hash-based fallback) so avatars,
 * token charts, and badges stay consistent.
 */

const PALETTE = [
  "#818cf8", // indigo
  "#22d3ee", // cyan
  "#a78bfa", // violet
  "#f472b6", // pink
  "#34d399", // green
  "#fbbf24", // amber
  "#fb923c", // orange
  "#e879f9", // fuchsia
  "#4dabf7", // blue
  "#a9e34b", // lime
];

export function fallbackRoleColor(roleId: string): string {
  let hash = 0;
  for (let i = 0; i < roleId.length; i += 1) {
    hash = (hash * 31 + roleId.charCodeAt(i)) >>> 0;
  }
  return PALETTE[hash % PALETTE.length];
}

export type TemplateRoleVisual = {
  id: string;
  label: string;
  color?: string;
  icon?: string;
};

export function roleColor(roleId: string, templateRoles?: readonly TemplateRoleVisual[]): string {
  return templateRoles?.find((role) => role.id === roleId)?.color ?? fallbackRoleColor(roleId);
}

export function roleIcon(roleId: string, templateRoles?: readonly TemplateRoleVisual[]): string | undefined {
  return templateRoles?.find((role) => role.id === roleId)?.icon;
}

export function roleLabel(roleId: string, templateRoles?: readonly TemplateRoleVisual[]): string {
  return templateRoles?.find((role) => role.id === roleId)?.label ?? roleId.toUpperCase();
}

/** Shade a #rrggbb hex color by percent (-100..100). */
export function shadeHex(hex: string, percent: number): string {
  const match = /^#([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!match) return hex;
  const num = parseInt(match[1], 16);
  const adjust = (channel: number) => {
    const next = percent >= 0
      ? channel + ((255 - channel) * percent) / 100
      : (channel * (100 + percent)) / 100;
    return Math.round(Math.min(255, Math.max(0, next)));
  };
  const r = adjust((num >> 16) & 0xff);
  const g = adjust((num >> 8) & 0xff);
  const b = adjust(num & 0xff);
  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
}
