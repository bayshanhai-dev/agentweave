import { defineConfig } from "vite";

const configuredHosts = process.env.VITE_ALLOWED_HOSTS?.split(",")
  .map((host) => host.trim())
  .filter(Boolean);

export default defineConfig({
  server: configuredHosts?.length
    ? {
        allowedHosts: configuredHosts,
      }
    : undefined,
});
