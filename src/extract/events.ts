import { readFileSync } from "fs";
import { glob } from "glob";
import { join } from "path";

export interface EventContract {
  name: string;
  type: "webhook" | "event" | "message";
  emitters: string[];    // files that emit/trigger this event
  handlers: string[];    // files that handle/subscribe to this event
}

/**
 * Extract event/webhook/message contracts.
 * Finds: webhook trigger events, EventEmitter patterns, pub/sub topics.
 */
export function extractEvents(root: string): EventContract[] {
  const events = new Map<string, EventContract>();

  const sourceFiles = glob.sync("**/*.{ts,tsx,js,jsx,py}", {
    cwd: root,
    ignore: ["node_modules/**", "dist/**", "venv/**", ".venv/**", "*.test.*", "*.spec.*", "test/**", "**/*test*/**", "**/*spec*/**"],
  });

  for (const f of sourceFiles) {
    let content: string;
    try { content = readFileSync(join(root, f), "utf-8"); } catch { continue; }

    // Webhook event enums/constants: WebhookTriggerEvents.EVENT_NAME
    for (const m of content.matchAll(/WebhookTriggerEvents\.(\w+)/g)) {
      const name = m[1];
      addEvent(events, name, "webhook", f, content, m[0]);
    }

    // Generic event emit patterns: emit('event.name'), dispatch('EVENT_NAME')
    for (const m of content.matchAll(/(?:emit|dispatch|publish|trigger|fire)\s*\(\s*['"]([a-zA-Z][a-zA-Z0-9._:-]+)['"]/g)) {
      addEvent(events, m[1], "event", f, content, m[0]);
    }

    // EventEmitter .on('event') / .addEventListener
    for (const m of content.matchAll(/\.on\s*\(\s*['"]([a-zA-Z][a-zA-Z0-9._:-]+)['"]|\.addEventListener\s*\(\s*['"]([a-zA-Z][a-zA-Z0-9._:-]+)['"]/g)) {
      const name = m[1] || m[2];
      const existing = events.get(name);
      if (existing) {
        if (!existing.handlers.includes(f)) existing.handlers.push(f);
      }
    }

    // Python signals: signal.send(), signal.connect()
    for (const m of content.matchAll(/(\w+_signal)\.send\(/g)) {
      addEvent(events, m[1], "event", f, content, m[0]);
    }

    // Kafka/RabbitMQ topics
    for (const m of content.matchAll(/(?:topic|queue|channel)\s*[:=]\s*['"]([a-zA-Z][a-zA-Z0-9._:-]+)['"]/g)) {
      addEvent(events, m[1], "message", f, content, m[0]);
    }
  }

  // Filter out DOM events and common noise
  const noise = new Set(["click", "change", "submit", "load", "error", "close", "open", "message", "data", "end", "finish", "drain"]);
  return [...events.values()].filter(e => !noise.has(e.name.toLowerCase()));
}

function addEvent(events: Map<string, EventContract>, name: string, type: "webhook" | "event" | "message", file: string, content: string, match: string) {
  if (!events.has(name)) {
    events.set(name, { name, type, emitters: [], handlers: [] });
  }
  const event = events.get(name)!;
  // Determine if this file emits or handles
  const isEmitter = match.includes("emit") || match.includes("dispatch") || match.includes("trigger") || match.includes("publish") || match.includes("fire") || match.includes("send");
  if (isEmitter) {
    if (!event.emitters.includes(file)) event.emitters.push(file);
  } else {
    if (!event.handlers.includes(file)) event.handlers.push(file);
  }
}

export function formatEvents(events: EventContract[]): string {
  if (events.length === 0) return "";

  const byType = new Map<string, EventContract[]>();
  for (const e of events) {
    if (!byType.has(e.type)) byType.set(e.type, []);
    byType.get(e.type)!.push(e);
  }

  const lines: string[] = ["Events:"];
  for (const [type, typeEvents] of byType) {
    const names = typeEvents.map(e => e.name).slice(0, 15);
    lines.push(`  ${type}: ${names.join(", ")}`);
    if (typeEvents.length > 15) lines.push(`    ... +${typeEvents.length - 15} more`);
  }
  return lines.join("\n");
}
