import { readFileSync } from "fs";
import { glob } from "glob";
import { join } from "path";

export interface Integration {
  name: string;         // "stripe" | "sendgrid" | "twilio" | etc
  sdk: string;          // npm package or import name
  usedIn: string[];     // files where it's used
  category: string;     // "payments" | "email" | "sms" | "analytics" | "storage" | "search" | "auth" | "monitoring"
}

const KNOWN_INTEGRATIONS: Array<{ pattern: string | string[]; name: string; category: string }> = [
  // Payments
  { pattern: ["stripe", "@stripe/stripe-js"], name: "Stripe", category: "payments" },
  { pattern: "braintree", name: "Braintree", category: "payments" },
  { pattern: ["@paddle/paddle-js", "paddle"], name: "Paddle", category: "payments" },
  { pattern: "lemonsqueezy", name: "LemonSqueezy", category: "payments" },
  // Email
  { pattern: ["@sendgrid/mail", "@sendgrid/client"], name: "SendGrid", category: "email" },
  { pattern: "resend", name: "Resend", category: "email" },
  { pattern: "postmark", name: "Postmark", category: "email" },
  { pattern: "nodemailer", name: "Nodemailer", category: "email" },
  { pattern: ["@aws-sdk/client-ses", "aws-sdk"], name: "AWS SES", category: "email" },
  { pattern: "mailgun", name: "Mailgun", category: "email" },
  // SMS / Communication
  { pattern: "twilio", name: "Twilio", category: "sms" },
  { pattern: "vonage", name: "Vonage", category: "sms" },
  // Analytics / Monitoring
  { pattern: ["@sentry/node", "@sentry/nextjs", "@sentry/react", "@sentry/browser"], name: "Sentry", category: "monitoring" },
  { pattern: ["@datadog/browser-rum", "dd-trace"], name: "Datadog", category: "monitoring" },
  { pattern: "posthog", name: "PostHog", category: "analytics" },
  { pattern: ["mixpanel", "mixpanel-browser"], name: "Mixpanel", category: "analytics" },
  { pattern: "segment", name: "Segment", category: "analytics" },
  { pattern: ["@amplitude/analytics-browser", "amplitude-js"], name: "Amplitude", category: "analytics" },
  { pattern: "logrocket", name: "LogRocket", category: "monitoring" },
  // Storage / CDN
  { pattern: ["@aws-sdk/client-s3", "aws-sdk"], name: "AWS S3", category: "storage" },
  { pattern: "cloudinary", name: "Cloudinary", category: "storage" },
  { pattern: "@uploadthing/react", name: "UploadThing", category: "storage" },
  { pattern: "@supabase/supabase-js", name: "Supabase", category: "storage" },
  { pattern: "firebase", name: "Firebase", category: "storage" },
  // Search
  { pattern: ["algolia", "algoliasearch"], name: "Algolia", category: "search" },
  { pattern: ["@elastic/elasticsearch", "elasticsearch"], name: "Elasticsearch", category: "search" },
  { pattern: "meilisearch", name: "Meilisearch", category: "search" },
  { pattern: "typesense", name: "Typesense", category: "search" },
  // Auth (external providers)
  { pattern: "auth0", name: "Auth0", category: "auth" },
  { pattern: "@clerk/nextjs", name: "Clerk", category: "auth" },
  { pattern: "next-auth", name: "NextAuth", category: "auth" },
  { pattern: "@lucia-auth/core", name: "Lucia", category: "auth" },
  { pattern: "passport", name: "Passport.js", category: "auth" },
  // AI
  { pattern: ["openai", "@openai/api"], name: "OpenAI", category: "ai" },
  { pattern: "@anthropic-ai/sdk", name: "Anthropic", category: "ai" },
  { pattern: ["@google/generative-ai", "google-ai"], name: "Google AI", category: "ai" },
  { pattern: "replicate", name: "Replicate", category: "ai" },
  // Queues (cross-reference with jobs extractor)
  { pattern: "bullmq", name: "BullMQ", category: "queue" },
  { pattern: "amqplib", name: "RabbitMQ", category: "queue" },
  { pattern: "kafkajs", name: "Kafka", category: "queue" },
  { pattern: "inngest", name: "Inngest", category: "queue" },
  { pattern: "@trigger.dev/sdk", name: "Trigger.dev", category: "queue" },
  // CMS
  { pattern: "contentful", name: "Contentful", category: "cms" },
  { pattern: "sanity", name: "Sanity", category: "cms" },
  { pattern: "@notionhq/client", name: "Notion", category: "cms" },
];

export function extractIntegrations(root: string): Integration[] {
  const found = new Map<string, Integration>();

  // Check package.json deps
  const pkgPath = join(root, "package.json");
  let allDeps: Record<string, string> = {};
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
  } catch { /* not a JS project */ }

  // Check pyproject.toml / requirements.txt
  let pyDeps = "";
  try { pyDeps += readFileSync(join(root, "pyproject.toml"), "utf-8"); } catch {}
  try { pyDeps += readFileSync(join(root, "requirements.txt"), "utf-8"); } catch {}

  for (const known of KNOWN_INTEGRATIONS) {
    const patterns = Array.isArray(known.pattern) ? known.pattern : [known.pattern];
    const matchedPkg = patterns.find(p => allDeps[p] || pyDeps.includes(p));
    if (matchedPkg) {
      found.set(known.name, {
        name: known.name,
        sdk: matchedPkg,
        usedIn: [],
        category: known.category,
      });
    }
  }

  // Scan source files to find which files use each integration
  if (found.size > 0) {
    const sourceFiles = glob.sync("**/*.{ts,tsx,js,jsx,py}", {
      cwd: root,
      ignore: ["node_modules/**", "dist/**", "venv/**", ".venv/**"],
    });

    for (const f of sourceFiles.slice(0, 200)) {
      let content: string;
      try { content = readFileSync(join(root, f), "utf-8"); } catch { continue; }

      for (const [name, integration] of found) {
        const patterns = KNOWN_INTEGRATIONS.find(k => k.name === name);
        if (!patterns) continue;
        const pkgs = Array.isArray(patterns.pattern) ? patterns.pattern : [patterns.pattern];
        if (pkgs.some(p => content.includes(p))) {
          integration.usedIn.push(f);
        }
      }
    }
  }

  return [...found.values()];
}

export function formatIntegrations(integrations: Integration[]): string {
  if (integrations.length === 0) return "";

  const byCategory = new Map<string, Integration[]>();
  for (const i of integrations) {
    if (!byCategory.has(i.category)) byCategory.set(i.category, []);
    byCategory.get(i.category)!.push(i);
  }

  const lines: string[] = ["Integrations:"];
  for (const [cat, items] of byCategory) {
    const names = items.map(i => {
      const fileCount = i.usedIn.length;
      return fileCount > 0 ? `${i.name}(${fileCount} files)` : i.name;
    });
    lines.push(`  ${cat}: ${names.join(", ")}`);
  }
  return lines.join("\n");
}
