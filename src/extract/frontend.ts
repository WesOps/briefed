import { readFileSync } from "fs";
import { glob } from "glob";
import { join, basename, dirname, extname } from "path";

export interface PageRoute {
  path: string;
  file: string;
  layout: string | null;
  isProtected: boolean;   // has auth middleware/guard
}

export interface ComponentInfo {
  name: string;
  file: string;
  props: string[];          // prop names
  children: boolean;        // accepts children
  hooks: string[];          // React hooks used
  stateManagement: string[];// zustand/redux/context used
}

export interface FrontendInfo {
  framework: string | null;       // "react" | "next" | "vue" | "svelte" | "angular"
  pages: PageRoute[];
  components: ComponentInfo[];
  stateStores: string[];          // zustand stores, redux slices, etc.
  styling: string | null;         // "tailwind" | "css-modules" | "styled-components" | "scss"
  uiLibrary: string | null;       // "shadcn" | "mui" | "chakra" | "radix" | "ant"
}

/**
 * Extract frontend-specific context: pages, components, state, styling.
 */
export function extractFrontend(root: string): FrontendInfo {
  const info: FrontendInfo = {
    framework: null,
    pages: [],
    components: [],
    stateStores: [],
    styling: null,
    uiLibrary: null,
  };

  // Detect framework + styling + UI library from package.json
  const pkgPath = join(root, "package.json");
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };

    if (deps["next"]) info.framework = "next";
    else if (deps["nuxt"]) info.framework = "nuxt";
    else if (deps["@sveltejs/kit"]) info.framework = "sveltekit";
    else if (deps["svelte"]) info.framework = "svelte";
    else if (deps["vue"]) info.framework = "vue";
    else if (deps["react"]) info.framework = "react";
    else if (deps["@angular/core"]) info.framework = "angular";

    if (deps["tailwindcss"]) info.styling = "tailwind";
    else if (deps["styled-components"]) info.styling = "styled-components";
    else if (deps["sass"] || deps["node-sass"]) info.styling = "scss";
    else if (deps["@emotion/react"]) info.styling = "emotion";

    if (deps["@shadcn/ui"] || deps["class-variance-authority"]) info.uiLibrary = "shadcn";
    else if (deps["@mui/material"]) info.uiLibrary = "mui";
    else if (deps["@chakra-ui/react"]) info.uiLibrary = "chakra";
    else if (deps["@radix-ui/react-dialog"]) info.uiLibrary = "radix";
    else if (deps["antd"]) info.uiLibrary = "antd";
  } catch { /* not a JS project */ }

  // Extract pages
  info.pages = extractPages(root, info.framework);

  // Extract components
  info.components = extractComponents(root);

  // Extract state stores
  info.stateStores = extractStateStores(root);

  return info;
}

function extractPages(root: string, framework: string | null): PageRoute[] {
  const pages: PageRoute[] = [];

  if (framework === "next") {
    // Next.js App Router pages
    const appPages = glob.sync("{src/app,app}/**/page.{tsx,jsx,ts,js}", { cwd: root });
    for (const f of appPages) {
      const path = "/" + dirname(f).replace(/^(?:src\/)?app\/?/, "").replace(/\(.*?\)\/?/g, "");
      const content = tryRead(join(root, f));
      const layoutFile = findLayout(root, f);
      const isProtected = content?.includes("auth") || content?.includes("session") ||
        content?.includes("getServerSession") || content?.includes("redirect") || false;

      pages.push({
        path: path || "/",
        file: f,
        layout: layoutFile,
        isProtected,
      });
    }

    // Next.js Pages Router
    const pagesDir = glob.sync("pages/**/*.{tsx,jsx,ts,js}", {
      cwd: root,
      ignore: ["pages/api/**", "pages/_*"],
    });
    for (const f of pagesDir) {
      const normalized = f.replace(/\\/g, "/");
      const path = "/" + normalized.replace(/^pages\//, "").replace(/\.\w+$/, "").replace(/\/index$/, "");
      pages.push({ path: path || "/", file: f, layout: null, isProtected: false });
    }
  }

  if (framework === "vue" || framework === "nuxt") {
    const vuePages = glob.sync("{pages,src/pages,src/views}/**/*.vue", { cwd: root });
    for (const f of vuePages) {
      const path = "/" + f.replace(/^(?:src\/)?(?:pages|views)\//, "").replace(/\.vue$/, "").replace(/\/index$/, "");
      pages.push({ path, file: f, layout: null, isProtected: false });
    }
  }

  if (framework === "sveltekit" || framework === "svelte") {
    const sveltePages = glob.sync("src/routes/**/+page.svelte", { cwd: root });
    for (const f of sveltePages) {
      const path = "/" + dirname(f).replace(/^src\/routes\/?/, "").replace(/\(.*?\)\/?/g, "");
      pages.push({ path: path || "/", file: f, layout: null, isProtected: false });
    }
  }

  return pages;
}

function extractComponents(root: string): ComponentInfo[] {
  const components: ComponentInfo[] = [];

  const componentFiles = glob.sync("{src/components,components,src/ui,app/components}/**/*.{tsx,jsx,vue,svelte}", {
    cwd: root,
    ignore: ["node_modules/**", "*.test.*", "*.spec.*", "*.stories.*"],
  });

  for (const f of componentFiles.slice(0, 50)) { // limit to 50
    const content = tryRead(join(root, f));
    if (!content) continue;

    const name = basename(f, extname(f));
    const ext = extname(f);

    const props: string[] = [];
    const hooks: string[] = [];
    let children = false;

    if ([".tsx", ".jsx"].includes(ext)) {
      // React props
      const propsMatch = content.match(/(?:interface|type)\s+\w*Props\w*\s*(?:=\s*)?{([^}]*)}/);
      if (propsMatch) {
        const propLines = propsMatch[1].matchAll(/(\w+)\s*[?:]?\s*:/g);
        for (const p of propLines) props.push(p[1]);
        if (propsMatch[1].includes("children")) children = true;
      }

      // React hooks
      const hookMatches = content.matchAll(/\buse(\w+)\s*\(/g);
      for (const h of hookMatches) {
        const hookName = `use${h[1]}`;
        if (!hooks.includes(hookName)) hooks.push(hookName);
      }
    }

    if (ext === ".vue") {
      // Vue props
      const vueProps = content.matchAll(/(\w+)\s*:\s*{\s*type:\s*(\w+)/g);
      for (const p of vueProps) props.push(p[1]);
    }

    components.push({
      name,
      file: f,
      props: props.slice(0, 10),
      children,
      hooks: hooks.slice(0, 8),
      stateManagement: [],
    });
  }

  return components;
}

function extractStateStores(root: string): string[] {
  const stores: string[] = [];

  // Zustand stores
  const zustandFiles = glob.sync("**/*.{ts,tsx,js,jsx}", {
    cwd: root,
    ignore: ["node_modules/**", "dist/**"],
  });

  for (const f of zustandFiles) {
    const content = tryRead(join(root, f));
    if (!content) continue;

    if (content.includes("create(") && (content.includes("zustand") || content.includes("from 'zustand'"))) {
      const nameMatch = content.match(/export\s+(?:const|let)\s+use(\w+)/);
      if (nameMatch) stores.push(`zustand:use${nameMatch[1]}`);
    }

    // Redux slices
    if (content.includes("createSlice(")) {
      const nameMatch = content.match(/name:\s*['"](\w+)['"]/);
      if (nameMatch) stores.push(`redux:${nameMatch[1]}`);
    }

    // React Context
    if (content.includes("createContext(")) {
      const nameMatch = content.match(/(?:export\s+)?const\s+(\w+Context)\s*=/);
      if (nameMatch) stores.push(`context:${nameMatch[1]}`);
    }
  }

  return stores;
}

function findLayout(root: string, pageFile: string): string | null {
  let dir = dirname(join(root, pageFile));
  while (dir.includes("app")) {
    const layoutFile = glob.sync("layout.{tsx,jsx,ts,js}", { cwd: dir });
    if (layoutFile.length > 0) return join(dir, layoutFile[0]).replace(root + "/", "").replace(root + "\\", "");
    dir = dirname(dir);
  }
  return null;
}

function tryRead(path: string): string | null {
  try { return readFileSync(path, "utf-8"); } catch { return null; }
}

/**
 * Format frontend info for skeleton inclusion.
 */
export function formatFrontend(info: FrontendInfo): string {
  const parts: string[] = [];

  // Route map — compact, one line. Saves a glob + directory traversal.
  if (info.pages.length > 0) {
    const routes = info.pages.map(p => {
      const path = p.path.replace(/\\/g, "/");
      return p.isProtected ? `${path}(auth)` : path;
    });
    parts.push(`Routes: ${routes.join(", ")}`);
  }

  // State stores — hard to discover, scattered across files
  if (info.stateStores.length > 0) {
    parts.push(`State: ${info.stateStores.join(", ")}`);
  }

  return parts.join("\n");
}
