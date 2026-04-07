/**
 * Quality bench task set. Each task pairs a strategy-neutral prompt with a
 * rubric listing facts a correct answer MUST contain. Rubrics are hand-authored
 * by reading the pinned commit of the bench corpus.
 *
 * Current corpus: epic-stack @ 19eeb4ba358781ea447762e70403f7b78994db10
 *
 * If you change the pinned ref or swap corpora, you MUST re-author every rubric.
 */

/**
 * SHA this rubric set was authored against. Must equal `DEFAULT_CORPUS.ref`
 * in `corpus.ts`. Bumping the corpus without re-authoring rubrics is a
 * silent-failure-mode bug, so we lock these in code with a sibling test.
 */
export const QUALITY_TASKS_PINNED_SHA = "19eeb4ba358781ea447762e70403f7b78994db10";

export interface QualityRubric {
  mustContain: string[];
  mustNotHallucinate: string[];
}

export interface QualityTask {
  name: string;
  prompt: string;
  rubric: QualityRubric;
}

export const QUALITY_TASKS: QualityTask[] = [
  {
    name: "explain-architecture",
    prompt:
      "Explain the overall architecture of this project in one paragraph per top-level module. Cover what each module does, how they connect, and which file is the server entry point.",
    rubric: {
      mustContain: [
        // Verified by inspecting the pinned commit top-level directories and server/index.ts
        "app/",
        "server/",
        "prisma/",
        "server/index.ts",
        "Express",
        "React Router",
      ],
      mustNotHallucinate: [
        "Next.js",
        "pages/ directory",
        "getServerSideProps",
      ],
    },
  },
  {
    name: "list-routes",
    prompt:
      "List every route this app exposes with its HTTP method (or React Router equivalent) and a one-line purpose. Produce a markdown table.",
    rubric: {
      mustContain: [
        // Verified by inspecting app/routes/ directory tree at pinned commit
        "_auth",
        "login",
        "users/$username",
        "settings/profile",
        "resources/healthcheck",
        "admin",
        "_marketing",
      ],
      mustNotHallucinate: [
        "/api/v1/",
        "pages/api/",
      ],
    },
  },
  {
    name: "env-var-audit",
    prompt:
      "What environment variables does this project read? For each one, name the variable, say whether it is required or optional, and name the file(s) where it is consumed.",
    rubric: {
      mustContain: [
        // Verified by reading app/utils/env.server.ts at pinned commit
        "DATABASE_URL",
        "SESSION_SECRET",
        "INTERNAL_COMMAND_TOKEN",
        "HONEYPOT_SECRET",
        "SENTRY_DSN",
        "RESEND_API_KEY",
        "GITHUB_CLIENT_ID",
      ],
      mustNotHallucinate: [
        "NEXT_PUBLIC_",
        "VITE_",
      ],
    },
  },
  {
    name: "trace-auth-flow",
    prompt:
      "Trace what happens when a user logs in to this app — which route handles the POST, which server modules run, which database tables get touched, in order. Name the specific functions involved at each step.",
    rubric: {
      mustContain: [
        // Verified by reading app/routes/_auth/login.tsx and login.server.ts at pinned commit
        "app/routes/_auth/login.tsx",
        "verifyUserPassword",
        "handleNewSession",
        "authSessionStorage",
        "Session",
        "Password",
      ],
      mustNotHallucinate: [
        "JWT",
        "localStorage",
      ],
    },
  },
];
