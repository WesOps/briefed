import { readFileSync } from "fs";
import { glob } from "glob";
import { join } from "path";

export interface FeatureFlag {
  name: string;
  file: string;
  provider: string;  // "launchdarkly" | "unleash" | "custom" | "env" | "flagsmith" | "growthbook"
}

export function extractFeatureFlags(root: string): FeatureFlag[] {
  const flags = new Map<string, FeatureFlag>();

  // Check package.json for flag providers
  let provider: string | null = null;
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (deps["launchdarkly-js-client-sdk"] || deps["@launchdarkly/node-server-sdk"]) provider = "launchdarkly";
    else if (deps["unleash-client"]) provider = "unleash";
    else if (deps["flagsmith"]) provider = "flagsmith";
    else if (deps["@growthbook/growthbook"]) provider = "growthbook";
    else if (deps["@vercel/flags"]) provider = "vercel-flags";
  } catch { /* not a JS project */ }

  const sourceFiles = glob.sync("**/*.{ts,tsx,js,jsx}", {
    cwd: root,
    ignore: ["node_modules/**", "dist/**", "test/**", "tests/**", "**/*test*/**", "**/*spec*/**", "*.test.*", "*.spec.*", "e2e/**", "**/*.spec.ts", "**/*.test.ts"],
  });

  for (const f of sourceFiles) {
    let content: string;
    try { content = readFileSync(join(root, f), "utf-8"); } catch { continue; }

    // LaunchDarkly: client.variation('flag-name', ...)
    for (const m of content.matchAll(/\.variation\s*\(\s*['"]([^'"]+)['"]/g)) {
      flags.set(m[1], { name: m[1], file: f, provider: "launchdarkly" });
    }

    // Unleash: client.isEnabled('flag-name')
    for (const m of content.matchAll(/\.isEnabled\s*\(\s*['"]([^'"]+)['"]/g)) {
      flags.set(m[1], { name: m[1], file: f, provider: provider || "unleash" });
    }

    // GrowthBook: useFeatureValue('flag-name') or gb.isOn('flag-name')
    for (const m of content.matchAll(/(?:useFeatureValue|useFeatureIsOn|isOn|getFeatureValue)\s*\(\s*['"]([^'"]+)['"]/g)) {
      flags.set(m[1], { name: m[1], file: f, provider: "growthbook" });
    }

    // Custom flag patterns: FEATURE_*, ENABLE_*, FF_* (only from env references)
    for (const m of content.matchAll(/process\.env\.((?:FEATURE|ENABLE|FF|FLAG)_\w+)/g)) {
      if (!flags.has(m[1])) {
        flags.set(m[1], { name: m[1], file: f, provider: "env" });
      }
    }

    // Custom: featureFlags.isEnabled('name')
    for (const m of content.matchAll(/featureFlags?\s*\.\s*(?:isEnabled|isOn|get|check)\s*\(\s*['"]([^'"]+)['"]/g)) {
      if (!flags.has(m[1])) {
        flags.set(m[1], { name: m[1], file: f, provider: provider || "custom" });
      }
    }
  }

  return [...flags.values()];
}

export function formatFeatureFlags(flags: FeatureFlag[]): string {
  if (flags.length === 0) return "";

  const providers = [...new Set(flags.map(f => f.provider))];
  const providerStr = providers.length === 1 ? providers[0] : providers.join(", ");
  const flagNames = flags.map(f => f.name);

  return `Feature flags (${providerStr}): ${flagNames.join(", ")}`;
}
