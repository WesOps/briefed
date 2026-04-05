#!/usr/bin/env node
// briefed: PostToolUse hook — tracks which files Claude reads for the learning loop
// Security: only appends to .briefed/session-reads.log, never reads prompt content
const { appendFileSync, mkdirSync, existsSync } = require("fs");
const { join } = require("path");

let input = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  try {
    const data = JSON.parse(input);
    if (data.tool_name !== "Read") { process.exit(0); return; }
    const filePath = data.tool_input && data.tool_input.file_path;
    if (!filePath) { process.exit(0); return; }
    const briefedDir = join(process.cwd(), ".briefed");
    if (!existsSync(briefedDir)) mkdirSync(briefedDir, { recursive: true });
    appendFileSync(join(briefedDir, "session-reads.log"), filePath + "\n");
  } catch {}
  process.exit(0);
});
