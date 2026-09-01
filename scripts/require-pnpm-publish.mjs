const userAgent = process.env.npm_config_user_agent ?? "";

if (!userAgent.startsWith("pnpm/")) {
  console.error("Paneform packages must be published with pnpm so publishConfig exports are applied.");
  process.exit(1);
}
