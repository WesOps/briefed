import { resolve, join } from "path";
import { existsSync, readFileSync, readdirSync } from "fs";
import { countTokens, formatTokens } from "../utils/tokens.js";
import { checkStaleness, formatStaleness } from "../extract/staleness.js";

interface StatsOptions {
  repo: string;
}

export async function statsCommand(opts: StatsOptions) {
  const root = resolve(opts.repo);

  console.log("briefed stats\n");

  // L1 Skeleton
  const skeletonPath = join(root, ".briefed", "skeleton.md");
  if (existsSync(skeletonPath)) {
    const skeleton = readFileSync(skeletonPath, "utf-8");
    const tokens = countTokens(skeleton);
    console.log(`  L1 Skeleton:     ${formatTokens(tokens)} tokens (${skeleton.length} chars)`);
    console.log(`    Delivery:      CLAUDE.md (always loaded, survives compaction)`);
  } else {
    console.log("  L1 Skeleton:     not generated (run briefed init)");
  }

  // Deep rules (only present when `briefed init --deep` was used)
  const rulesDir = join(root, ".claude", "rules");
  if (existsSync(rulesDir)) {
    const ruleFiles = readdirSync(rulesDir).filter((f) => f.startsWith("briefed-"));
    if (ruleFiles.length > 0) {
      let totalTokens = 0;
      for (const file of ruleFiles) {
        totalTokens += countTokens(readFileSync(join(rulesDir, file), "utf-8"));
      }
      console.log(`  Deep rules:      ${ruleFiles.length} files (~${formatTokens(totalTokens)} tokens)`);
      console.log(`    Delivery:      .claude/rules/ (path-scoped, loaded on demand)`);
    }
  }

  // L2 Contracts
  const contractsDir = join(root, ".briefed", "contracts");
  if (existsSync(contractsDir)) {
    const contractFiles = readdirSync(contractsDir).filter((f) => f.endsWith(".yaml"));
    let totalTokens = 0;
    for (const file of contractFiles) {
      const content = readFileSync(join(contractsDir, file), "utf-8");
      totalTokens += countTokens(content);
    }
    console.log(`  L2 Contracts:    ${contractFiles.length} modules (~${formatTokens(totalTokens)} tokens total)`);
    console.log(`    Delivery:      UserPromptSubmit hook (1-3 modules per prompt)`);
  } else {
    console.log("  L2 Contracts:    not generated");
  }

  // Module index
  const indexPath = join(root, ".briefed", "index.json");
  if (existsSync(indexPath)) {
    const index = JSON.parse(readFileSync(indexPath, "utf-8"));
    console.log(`  Module Index:    ${index.modules?.length || 0} modules indexed`);
    console.log(`    Generated:     ${index.generated || "unknown"}`);
  }

  // Hooks
  const settingsPath = join(root, ".claude", "settings.json");
  if (existsSync(settingsPath)) {
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    const hasBriefedHooks = JSON.stringify(settings.hooks || {}).includes("briefed");
    console.log(`  Hooks:           ${hasBriefedHooks ? "installed" : "not installed"}`);
  } else {
    console.log("  Hooks:           not installed");
  }

  console.log("");

  // Estimated per-prompt cost
  const skeletonTokens = existsSync(skeletonPath)
    ? countTokens(readFileSync(skeletonPath, "utf-8"))
    : 0;
  console.log(`  Estimated tokens per prompt:`);
  console.log(`    L1 (always):     ~${formatTokens(skeletonTokens)}`);
  console.log(`    L2 (per prompt): ~400-1500`);
  console.log(`    Total:           ~${formatTokens(skeletonTokens + 400)}-${formatTokens(skeletonTokens + 1500)}`);
  console.log("");
  console.log(`  Compare to without briefed:`);
  console.log(`    Orientation:     ~5000-10000 tokens (3-6 file reads)`);
  console.log(`    Time:            ~8-12 seconds`);

  // Staleness check
  console.log("");
  const staleness = checkStaleness(root);
  console.log(formatStaleness(staleness));
}
