/** Shared role visuals use a restrained instrument-panel ramp. */
const ROLE_TONES = [
  "#b8c99c", // leading accent
  "#a9afb0",
  "#92999a",
  "#c0b9a7",
  "#7d8587",
  "#a1a7a0",
];

export function fallbackRoleColor(roleId: string): string {
  let hash = 0;
  for (let i = 0; i < roleId.length; i += 1) {
    hash = (hash * 31 + roleId.charCodeAt(i)) >>> 0;
  }
  return ROLE_TONES[hash % ROLE_TONES.length];
}

export type TemplateRoleVisual = {
  id: string;
  label: string;
  color?: string;
  icon?: string;
};

export function roleColor(roleId: string, templateRoles?: readonly TemplateRoleVisual[]): string {
  // Template colors are data, but the dashboard chrome stays in one visual
  // system so a user can read status rather than a rainbow of role colors.
  const roleIndex = templateRoles?.findIndex((role) => role.id === roleId) ?? -1;
  return ROLE_TONES[(roleIndex >= 0 ? roleIndex : Math.abs(roleId.length)) % ROLE_TONES.length];
}

export function roleIcon(roleId: string, templateRoles?: readonly TemplateRoleVisual[]): string | undefined {
  return templateRoles?.find((role) => role.id === roleId)?.icon;
}

export function roleLabel(roleId: string, templateRoles?: readonly TemplateRoleVisual[]): string {
  return templateRoles?.find((role) => role.id === roleId)?.label ?? roleId.replaceAll("_", " ");
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
