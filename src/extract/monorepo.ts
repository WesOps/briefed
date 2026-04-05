import { existsSync, readFileSync } from "fs";
import { join, relative, resolve } from "path";
import { glob } from "glob";

export interface WorkspaceInfo {
  isMonorepo: boolean;
  root: string;
  packages: WorkspacePackage[];
  currentPackage: WorkspacePackage | null;
}

export interface WorkspacePackage {
  name: string;
  path: string;       // relative to monorepo root
  absolutePath: string;
}

/**
 * Detect if we're in a monorepo and identify packages.
 * Supports: npm workspaces, pnpm workspaces, yarn workspaces, turborepo, nx, lerna.
 */
export function detectMonorepo(cwd: string): WorkspaceInfo {
  const info: WorkspaceInfo = {
    isMonorepo: false,
    root: cwd,
    packages: [],
    currentPackage: null,
  };

  // Walk up to find monorepo root
  let searchDir = resolve(cwd);
  const visited = new Set<string>();

  while (searchDir && !visited.has(searchDir)) {
    visited.add(searchDir);

    const pkgPath = join(searchDir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));

        // npm/yarn workspaces
        if (pkg.workspaces) {
          info.isMonorepo = true;
          info.root = searchDir;
          const patterns = Array.isArray(pkg.workspaces)
            ? pkg.workspaces
            : pkg.workspaces.packages || [];
          info.packages = resolveWorkspacePackages(searchDir, patterns);
          break;
        }
      } catch { /* skip */ }
    }

    // pnpm workspaces
    const pnpmPath = join(searchDir, "pnpm-workspace.yaml");
    if (existsSync(pnpmPath)) {
      info.isMonorepo = true;
      info.root = searchDir;
      const content = readFileSync(pnpmPath, "utf-8");
      const match = content.match(/packages:\s*\n([\s\S]*?)(?:\n\S|$)/);
      if (match) {
        const patterns = match[1]
          .split("\n")
          .map((l) => l.trim().replace(/^-\s*['"]?/, "").replace(/['"]?\s*$/, ""))
          .filter(Boolean);
        info.packages = resolveWorkspacePackages(searchDir, patterns);
      }
      break;
    }

    // Turborepo
    if (existsSync(join(searchDir, "turbo.json"))) {
      info.isMonorepo = true;
      info.root = searchDir;
      // turbo uses package.json workspaces, already handled above
      break;
    }

    // Go modules workspace
    if (existsSync(join(searchDir, "go.work"))) {
      info.isMonorepo = true;
      info.root = searchDir;
      const content = readFileSync(join(searchDir, "go.work"), "utf-8");
      const useMatch = content.match(/use\s*\(([\s\S]*?)\)/);
      if (useMatch) {
        const dirs = useMatch[1].split("\n").map((l) => l.trim()).filter(Boolean);
        info.packages = dirs.map((d) => ({
          name: d.split("/").pop()!,
          path: d,
          absolutePath: join(searchDir, d),
        }));
      }
      break;
    }

    // Cargo workspace
    if (existsSync(join(searchDir, "Cargo.toml"))) {
      try {
        const content = readFileSync(join(searchDir, "Cargo.toml"), "utf-8");
        if (content.includes("[workspace]")) {
          info.isMonorepo = true;
          info.root = searchDir;
          const membersMatch = content.match(/members\s*=\s*\[([\s\S]*?)\]/);
          if (membersMatch) {
            const patterns = membersMatch[1]
              .split(",")
              .map((s) => s.trim().replace(/['"]/g, ""))
              .filter(Boolean);
            info.packages = resolveWorkspacePackages(searchDir, patterns);
          }
          break;
        }
      } catch { /* skip */ }
    }

    // Move up one directory
    const parent = join(searchDir, "..");
    if (resolve(parent) === resolve(searchDir)) break;
    searchDir = resolve(parent);
  }

  // Determine current package
  if (info.isMonorepo && info.packages.length > 0) {
    const cwdRel = relative(info.root, cwd).replace(/\\/g, "/");
    info.currentPackage = info.packages.find((p) =>
      cwdRel.startsWith(p.path) || cwdRel === p.path
    ) || null;
  }

  return info;
}

function resolveWorkspacePackages(
  root: string,
  patterns: string[]
): WorkspacePackage[] {
  const packages: WorkspacePackage[] = [];

  for (const pattern of patterns) {
    try {
      const dirs = glob.sync(pattern, { cwd: root });
      for (const dir of dirs) {
        const pkgJsonPath = join(root, dir, "package.json");
        let name = dir.split("/").pop()!;
        if (existsSync(pkgJsonPath)) {
          try {
            const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
            name = pkg.name || name;
          } catch { /* use dir name */ }
        }
        packages.push({
          name,
          path: dir.replace(/\\/g, "/"),
          absolutePath: join(root, dir),
        });
      }
    } catch { /* skip */ }
  }

  return packages;
}
