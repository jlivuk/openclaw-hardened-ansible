#!/usr/bin/env node
"use strict";

const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { createInterface } = require("node:readline");

const execFileAsync = promisify(execFile);

const SCRIPTS_DIR = process.env.CARLOS_SCRIPTS_DIR || "/opt/openclaw/carlos-scripts";
const LOG_ENTRY = SCRIPTS_DIR + "/log-entry.sh";
const QUERY_LOG = SCRIPTS_DIR + "/query-log.sh";

async function runScript(script, args) {
  try {
    const { stdout, stderr } = await execFileAsync("bash", [script, ...args], {
      env: process.env,
      timeout: 10000,
    });
    return { text: (stdout || stderr || "(no output)").trim(), isError: false };
  } catch (err) {
    const msg = (err.stderr || err.stdout || err.message || "Unknown error").trim();
    return { text: "ERROR: " + msg, isError: true };
  }
}

// ---------- Tool Definitions ----------

const TOOLS = {
  log_meal: {
    description: "Log a meal with macros. Returns daily totals, streak, and calorie budget.",
    inputSchema: {
      type: "object",
      properties: {
        time: { type: "string", description: "Time of meal (e.g., '8:00 AM')" },
        name: { type: "string", description: "Meal name/description" },
        calories: { type: "integer", description: "Calories", minimum: 0 },
        protein_g: { type: "number", description: "Protein in grams", minimum: 0 },
        carbs_g: { type: "number", description: "Carbs in grams", minimum: 0 },
        fat_g: { type: "number", description: "Fat in grams", minimum: 0 },
        notes: { type: "string", description: "Optional notes" },
      },
      required: ["time", "name", "calories", "protein_g", "carbs_g", "fat_g"],
    },
    handler: async (args) => {
      const a = ["meal", args.time, args.name, String(args.calories),
        args.protein_g + "g", args.carbs_g + "g", args.fat_g + "g"];
      if (args.notes) a.push(args.notes);
      return runScript(LOG_ENTRY, a);
    },
  },

  log_hydration: {
    description: "Log a glass of water.",
    inputSchema: {
      type: "object",
      properties: {
        time: { type: "string", description: "Time (e.g., '2:30 PM'). Defaults to now." },
      },
    },
    handler: async (args) => {
      const a = ["hydration"];
      if (args.time) a.push(args.time);
      return runScript(LOG_ENTRY, a);
    },
  },

  log_exercise: {
    description: "Log an exercise session.",
    inputSchema: {
      type: "object",
      properties: {
        time: { type: "string", description: "Time of exercise (e.g., '6:00 PM')" },
        activity: { type: "string", description: "Activity name (e.g., 'Walking', 'Running')" },
        duration: { type: "string", description: "Duration (e.g., '30 min', '1 hour')" },
        calories_burned: { type: "integer", description: "Estimated calories burned", minimum: 0 },
        notes: { type: "string", description: "Optional notes" },
      },
      required: ["time", "activity", "duration", "calories_burned"],
    },
    handler: async (args) => {
      const a = ["exercise", args.time, args.activity, args.duration, String(args.calories_burned)];
      if (args.notes) a.push(args.notes);
      return runScript(LOG_ENTRY, a);
    },
  },

  log_sleep: {
    description: "Log sleep duration. One entry per day (upserts).",
    inputSchema: {
      type: "object",
      properties: {
        duration_minutes: { type: "integer", description: "Sleep duration in minutes (e.g., 420 for 7 hours)", minimum: 1 },
        notes: { type: "string", description: "Optional notes" },
      },
      required: ["duration_minutes"],
    },
    handler: async (args) => {
      const a = ["sleep", String(args.duration_minutes)];
      if (args.notes) a.push(args.notes);
      return runScript(LOG_ENTRY, a);
    },
  },

  log_weight: {
    description: "Log body weight. One entry per day (upserts).",
    inputSchema: {
      type: "object",
      properties: {
        lbs: { type: "number", description: "Weight in pounds", exclusiveMinimum: 0 },
        notes: { type: "string", description: "Optional notes" },
      },
      required: ["lbs"],
    },
    handler: async (args) => {
      const a = ["weight", String(args.lbs)];
      if (args.notes) a.push(args.notes);
      return runScript(LOG_ENTRY, a);
    },
  },

  set_goal: {
    description: "Set or update a fitness goal.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Goal name (e.g., 'Daily Calories', 'Daily Protein', 'Exercise Days')" },
        value: { type: "number", description: "Target value" },
        unit: { type: "string", description: "Unit (e.g., 'cal', 'g', 'days')" },
      },
      required: ["name", "value", "unit"],
    },
    handler: async (args) => runScript(LOG_ENTRY, ["goals", "set", args.name, String(args.value), args.unit]),
  },

  show_goals: {
    description: "Display all current fitness goals.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => runScript(LOG_ENTRY, ["goals", "show"]),
  },

  undo_last: {
    description: "Undo the most recently logged entry across all tables.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => runScript(LOG_ENTRY, ["undo"]),
  },

  delete_entry: {
    description: "Delete entries from a table matching column filters (uses LIKE matching).",
    inputSchema: {
      type: "object",
      properties: {
        table: { type: "string", enum: ["meals", "hydration", "exercise", "weight", "sleep"], description: "Table to delete from" },
        filters: {
          type: "object",
          additionalProperties: { type: "string" },
          description: 'Column-value filter pairs (e.g., {"date": "2026-02-17", "meal": "eggs"})',
        },
      },
      required: ["table", "filters"],
    },
    handler: async (args) => {
      const a = ["delete", args.table];
      for (const [col, val] of Object.entries(args.filters)) {
        a.push(col, val);
      }
      return runScript(LOG_ENTRY, a);
    },
  },

  update_streak: {
    description: "Update a tracking streak.",
    inputSchema: {
      type: "object",
      properties: {
        category: { type: "string", enum: ["meal", "hydration", "exercise"], description: "Streak category" },
      },
      required: ["category"],
    },
    handler: async (args) => runScript(LOG_ENTRY, ["streak", args.category]),
  },

  set_preference: {
    description: "Set or update a user preference.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Preference key (alphanumeric + underscores)" },
        value: { type: "string", description: "Preference value" },
      },
      required: ["key", "value"],
    },
    handler: async (args) => runScript(LOG_ENTRY, ["preference", args.key, args.value]),
  },

  get_preference: {
    description: "Get a user preference value.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Preference key" },
      },
      required: ["key"],
    },
    handler: async (args) => runScript(LOG_ENTRY, ["preference-get", args.key]),
  },

  query_today: {
    description: "Show today's meals, hydration, exercise, and sleep.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => runScript(QUERY_LOG, ["today"]),
  },

  query_date: {
    description: "Show data for a specific date.",
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string", description: "Date in YYYY-MM-DD format" },
      },
      required: ["date"],
    },
    handler: async (args) => runScript(QUERY_LOG, [args.date]),
  },

  query_week: {
    description: "Show last 7 days summary with calories, protein, hydration, exercise, and sleep.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => runScript(QUERY_LOG, ["week"]),
  },

  query_history: {
    description: "Show recent meal history.",
    inputSchema: {
      type: "object",
      properties: {
        days: { type: "integer", description: "Number of days of history", minimum: 1 },
      },
      required: ["days"],
    },
    handler: async (args) => runScript(QUERY_LOG, ["history", String(args.days)]),
  },
};

// ---------- JSON-RPC / MCP Protocol ----------

function jsonRpcResponse(id, result) {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

function jsonRpcError(id, code, message) {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handleMessage(msg) {
  const { id, method, params } = msg;

  switch (method) {
    case "initialize":
      return jsonRpcResponse(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "carlos-tools", version: "1.0.0" },
      });

    case "notifications/initialized":
      return null; // notification — no response

    case "tools/list":
      return jsonRpcResponse(id, {
        tools: Object.entries(TOOLS).map(([name, def]) => ({
          name,
          description: def.description,
          inputSchema: def.inputSchema,
        })),
      });

    case "tools/call": {
      const toolName = params.name;
      const tool = TOOLS[toolName];
      if (!tool) {
        return jsonRpcResponse(id, {
          content: [{ type: "text", text: "Unknown tool: " + toolName }],
          isError: true,
        });
      }
      const result = await tool.handler(params.arguments || {});
      return jsonRpcResponse(id, {
        content: [{ type: "text", text: result.text }],
        isError: result.isError,
      });
    }

    case "ping":
      return jsonRpcResponse(id, {});

    default:
      if (id != null) {
        return jsonRpcError(id, -32601, "Method not found: " + method);
      }
      return null; // unknown notification — ignore
  }
}

// ---------- Main ----------

const rl = createInterface({ input: process.stdin });

rl.on("line", async (line) => {
  if (!line.trim()) return;
  try {
    const msg = JSON.parse(line);
    const response = await handleMessage(msg);
    if (response) {
      process.stdout.write(response + "\n");
    }
  } catch (err) {
    process.stderr.write("Parse error: " + err.message + "\n");
    process.stdout.write(jsonRpcError(null, -32700, "Parse error") + "\n");
  }
});

rl.on("close", () => process.exit(0));
