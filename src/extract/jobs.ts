import { readFileSync } from "fs";
import { glob } from "glob";
import { join } from "path";

export interface BackgroundJob {
  name: string;
  type: string;     // "queue" | "cron" | "worker" | "scheduled"
  framework: string; // "bullmq" | "inngest" | "cron" | "node-cron" | "agenda" | "trigger.dev"
  file: string;
  schedule?: string; // cron expression if applicable
}

export function extractJobs(root: string): BackgroundJob[] {
  const jobs: BackgroundJob[] = [];

  const sourceFiles = glob.sync("**/*.{ts,tsx,js,jsx}", {
    cwd: root,
    ignore: ["node_modules/**", "dist/**", "test/**", "**/*.test.*", "**/*.spec.*"],
  });

  for (const f of sourceFiles) {
    let content: string;
    try { content = readFileSync(join(root, f), "utf-8"); } catch { continue; }

    // BullMQ queues and workers
    if (content.includes("bullmq") || content.includes("bull")) {
      // Queue definitions: new Queue('name')
      for (const m of content.matchAll(/new\s+Queue\s*\(\s*['"](\w[\w-]*)['"]|new\s+Worker\s*\(\s*['"](\w[\w-]*)['"]/g)) {
        const name = m[1] || m[2];
        const type = m[0].includes("Worker") ? "worker" : "queue";
        if (!jobs.some(j => j.name === name && j.type === type)) {
          jobs.push({ name, type, framework: "bullmq", file: f });
        }
      }
    }

    // Inngest functions
    if (content.includes("inngest")) {
      for (const m of content.matchAll(/createFunction\s*\(\s*\{[^}]*id:\s*['"]([^'"]+)['"]/g)) {
        jobs.push({ name: m[1], type: "scheduled", framework: "inngest", file: f });
      }
    }

    // Trigger.dev jobs
    if (content.includes("@trigger.dev") || content.includes("trigger.dev")) {
      for (const m of content.matchAll(/(?:defineJob|client\.defineJob)\s*\(\s*\{[^}]*id:\s*['"]([^'"]+)['"]/g)) {
        jobs.push({ name: m[1], type: "scheduled", framework: "trigger.dev", file: f });
      }
    }

    // node-cron / cron
    if (content.includes("node-cron") || content.includes("cron")) {
      for (const m of content.matchAll(/cron\.schedule\s*\(\s*['"]([^'"]+)['"]/g)) {
        const schedule = m[1];
        // Try to find a name from context
        const nameMatch = content.slice(Math.max(0, (m.index || 0) - 200), m.index).match(/(?:\/\/|\/\*)\s*(.+?)(?:\n|\*\/)/);
        jobs.push({
          name: nameMatch?.[1]?.trim() || f.replace(/\.\w+$/, ""),
          type: "cron",
          framework: "node-cron",
          file: f,
          schedule,
        });
      }
    }

    // Agenda
    if (content.includes("agenda")) {
      for (const m of content.matchAll(/agenda\.define\s*\(\s*['"]([^'"]+)['"]/g)) {
        jobs.push({ name: m[1], type: "scheduled", framework: "agenda", file: f });
      }
      for (const m of content.matchAll(/agenda\.every\s*\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]/g)) {
        jobs.push({ name: m[2], type: "cron", framework: "agenda", file: f, schedule: m[1] });
      }
    }

    // setInterval-based background tasks (only in server-side files)
    if (content.includes("setInterval") && (f.includes("server") || f.includes("worker") || f.includes("job") || f.includes("cron"))) {
      for (const m of content.matchAll(/setInterval\s*\(\s*(\w+)/g)) {
        jobs.push({ name: m[1], type: "worker", framework: "setInterval", file: f });
      }
    }
  }

  // Python: Celery tasks
  const pyFiles = glob.sync("**/*.py", { cwd: root, ignore: ["venv/**", ".venv/**", "__pycache__/**"] });
  for (const f of pyFiles) {
    let content: string;
    try { content = readFileSync(join(root, f), "utf-8"); } catch { continue; }

    // @celery_app.task or @shared_task
    for (const m of content.matchAll(/@(?:celery_app\.task|shared_task|app\.task)[\s\S]*?def\s+(\w+)/g)) {
      jobs.push({ name: m[1], type: "queue", framework: "celery", file: f });
    }

    // APScheduler
    for (const m of content.matchAll(/scheduler\.add_job\s*\([^)]*['"]([^'"]+)['"]/g)) {
      jobs.push({ name: m[1], type: "cron", framework: "apscheduler", file: f });
    }
  }

  return jobs;
}

export function formatJobs(jobs: BackgroundJob[]): string {
  if (jobs.length === 0) return "";

  const lines: string[] = ["Background jobs:"];
  for (const j of jobs) {
    let line = `  ${j.name} (${j.type}, ${j.framework})`;
    if (j.schedule) line += ` [${j.schedule}]`;
    line += ` — ${j.file}`;
    lines.push(line);
  }
  return lines.join("\n");
}
