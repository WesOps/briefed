import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { glob } from "glob";

export interface InfraInfo {
  services: InfraService[];
  ports: Array<{ service: string; port: number; protocol: string }>;
  volumes: string[];
  networks: string[];
  providers: string[];     // "aws" | "gcp" | "azure" | "vercel" | "netlify"
  deployment: string | null; // how the app is deployed
}

export interface InfraService {
  name: string;
  image: string | null;
  type: string;            // "app" | "database" | "cache" | "queue" | "proxy"
  source: string;          // file it came from
}

/**
 * Extract infrastructure configuration.
 * Sources: docker-compose, Dockerfile, Terraform, K8s manifests, Vercel/Netlify config.
 */
export function extractInfra(root: string): InfraInfo {
  const info: InfraInfo = {
    services: [],
    ports: [],
    volumes: [],
    networks: [],
    providers: [],
    deployment: null,
  };

  // Docker Compose
  const composeFiles = ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"];
  for (const cf of composeFiles) {
    const path = join(root, cf);
    if (existsSync(path)) {
      parseDockerCompose(readFileSync(path, "utf-8"), cf, info);
    }
  }

  // Dockerfile
  const dockerfiles = glob.sync("{Dockerfile,*.Dockerfile,docker/Dockerfile*}", { cwd: root });
  if (dockerfiles.length > 0) {
    for (const df of dockerfiles) {
      parseDockerfile(readFileSync(join(root, df), "utf-8"), df, info);
    }
  }

  // Deployment platform detection
  if (existsSync(join(root, "vercel.json"))) {
    info.providers.push("vercel");
    info.deployment = "vercel";
  }
  if (existsSync(join(root, "netlify.toml"))) {
    info.providers.push("netlify");
    info.deployment = "netlify";
  }
  if (existsSync(join(root, "fly.toml"))) {
    info.providers.push("fly.io");
    info.deployment = "fly.io";
  }
  if (existsSync(join(root, "railway.json")) || existsSync(join(root, "railway.toml"))) {
    info.providers.push("railway");
    info.deployment = "railway";
  }
  if (existsSync(join(root, "render.yaml"))) {
    info.providers.push("render");
    info.deployment = "render";
  }
  if (existsSync(join(root, "Procfile"))) {
    info.providers.push("heroku");
    info.deployment = "heroku";
  }

  // Terraform
  const tfFiles = glob.sync("**/*.tf", { cwd: root, ignore: [".terraform/**"] });
  if (tfFiles.length > 0) {
    for (const tf of tfFiles.slice(0, 10)) {
      parseTerraform(readFileSync(join(root, tf), "utf-8"), tf, info);
    }
  }

  // Kubernetes
  const k8sFiles = glob.sync("**/{deployment,service,ingress,configmap}*.{yml,yaml}", {
    cwd: root,
    ignore: ["node_modules/**"],
  });
  if (k8sFiles.length > 0) {
    info.providers.push("kubernetes");
    for (const k8s of k8sFiles.slice(0, 10)) {
      parseK8s(readFileSync(join(root, k8s), "utf-8"), k8s, info);
    }
  }

  return info;
}

function parseDockerCompose(content: string, source: string, info: InfraInfo) {
  let currentService = "";
  for (const line of content.split("\n")) {
    const svcMatch = line.match(/^  (\w[\w-]*):\s*$/);
    if (svcMatch) {
      currentService = svcMatch[1];
      const type = classifyService(currentService);
      info.services.push({
        name: currentService,
        image: null,
        type,
        source,
      });
    }

    if (currentService) {
      const imgMatch = line.match(/image:\s*['"]?([^\s'"]+)/);
      if (imgMatch) {
        const svc = info.services.find((s) => s.name === currentService);
        if (svc) svc.image = imgMatch[1];
      }

      const portMatch = line.match(/['"]?(\d+):(\d+)['"]?/);
      if (portMatch) {
        info.ports.push({
          service: currentService,
          port: parseInt(portMatch[2]),
          protocol: "tcp",
        });
      }
    }
  }
}

function parseDockerfile(content: string, source: string, info: InfraInfo) {
  const exposeMatch = content.matchAll(/EXPOSE\s+(\d+)/g);
  for (const m of exposeMatch) {
    info.ports.push({
      service: source,
      port: parseInt(m[1]),
      protocol: "tcp",
    });
  }
}

function parseTerraform(content: string, source: string, info: InfraInfo) {
  // Detect providers
  const providerMatch = content.matchAll(/provider\s+"(\w+)"/g);
  for (const m of providerMatch) {
    if (!info.providers.includes(m[1])) info.providers.push(m[1]);
  }

  // Detect resources
  const resourceMatch = content.matchAll(/resource\s+"(\w+)"\s+"(\w+)"/g);
  for (const m of resourceMatch) {
    const resourceType = m[1];
    const resourceName = m[2];
    if (resourceType.includes("instance") || resourceType.includes("service") ||
        resourceType.includes("function") || resourceType.includes("container")) {
      info.services.push({
        name: resourceName,
        image: null,
        type: classifyTerraformResource(resourceType),
        source,
      });
    }
  }
}

function parseK8s(content: string, source: string, info: InfraInfo) {
  const nameMatch = content.match(/name:\s*['"]?(\w[\w-]*)/);
  const kindMatch = content.match(/kind:\s*(\w+)/);
  if (nameMatch && kindMatch) {
    if (kindMatch[1] === "Deployment" || kindMatch[1] === "StatefulSet") {
      info.services.push({
        name: nameMatch[1],
        image: null,
        type: "app",
        source,
      });
    }
  }

  const portMatches = content.matchAll(/port:\s*(\d+)/g);
  for (const m of portMatches) {
    info.ports.push({
      service: nameMatch?.[1] || source,
      port: parseInt(m[1]),
      protocol: "tcp",
    });
  }
}

function classifyService(name: string): string {
  const n = name.toLowerCase();
  if (n.includes("postgres") || n.includes("mysql") || n.includes("mongo") || n.includes("db") || n.includes("database")) return "database";
  if (n.includes("redis") || n.includes("memcache") || n.includes("cache")) return "cache";
  if (n.includes("rabbit") || n.includes("kafka") || n.includes("queue") || n.includes("nats")) return "queue";
  if (n.includes("nginx") || n.includes("traefik") || n.includes("proxy") || n.includes("caddy")) return "proxy";
  if (n.includes("minio") || n.includes("s3") || n.includes("storage")) return "storage";
  return "app";
}

function classifyTerraformResource(type: string): string {
  if (type.includes("rds") || type.includes("database")) return "database";
  if (type.includes("cache") || type.includes("redis")) return "cache";
  if (type.includes("sqs") || type.includes("queue")) return "queue";
  if (type.includes("s3") || type.includes("bucket")) return "storage";
  if (type.includes("lambda") || type.includes("function")) return "function";
  if (type.includes("lb") || type.includes("load_balancer")) return "proxy";
  return "app";
}

/**
 * Format infra info for skeleton inclusion.
 */
export function formatInfra(info: InfraInfo): string {
  const lines: string[] = [];

  if (info.deployment) {
    lines.push(`Deployment: ${info.deployment}`);
  }

  if (info.services.length > 0) {
    lines.push("Infrastructure:");
    for (const s of info.services) {
      let line = `  ${s.name} (${s.type})`;
      if (s.image) line += ` — ${s.image}`;
      lines.push(line);
    }
  }

  if (info.ports.length > 0) {
    const portList = info.ports.map((p) => `${p.service}:${p.port}`).join(", ");
    lines.push(`Ports: ${portList}`);
  }

  if (info.providers.length > 0 && !info.deployment) {
    lines.push(`Providers: ${info.providers.join(", ")}`);
  }

  if (lines.length === 0) return "";
  return lines.join("\n");
}
