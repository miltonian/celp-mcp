#!/usr/bin/env node
"use strict";
/**
 * celp‑stdio MCP server —— faithful port of the reference AnalysisClient
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const mcp_js_1 = require("@modelcontextprotocol/sdk/server/mcp.js");
const stdio_js_1 = require("@modelcontextprotocol/sdk/server/stdio.js");
const zod_1 = require("zod");
const socket_io_client_1 = require("socket.io-client");
const pg_1 = require("pg");
const promise_1 = require("mysql2/promise");
const Connector = __importStar(require("./connector"));
require("dotenv").config();
const DEBUG = process.env.DEBUG_LOGS === "true";
const log = (...a) => DEBUG && console.log(...a);
/* ── DB query executor (unchanged from reference) ───────────────────── */
async function runQuery(cfg, sql, params = []) {
    if (cfg.databaseType === "postgres") {
        const client = new pg_1.Client({
            host: cfg.host,
            port: cfg.port || 5432,
            user: cfg.user,
            password: cfg.password,
            database: cfg.database,
            ssl: process.env.PG_DISABLE_SSL === "true" ? undefined : { rejectUnauthorized: false },
        });
        await client.connect();
        try {
            const { rows } = await client.query(sql, params);
            return rows;
        }
        finally {
            await client.end();
        }
    }
    else {
        const conn = await (0, promise_1.createConnection)({
            host: cfg.host,
            port: cfg.port || 3306,
            user: cfg.user,
            password: cfg.password,
            database: cfg.database,
        });
        try {
            const [rows] = await conn.query(sql, params);
            return rows;
        }
        finally {
            await conn.end();
        }
    }
}
/* ── Single orchestration roundtrip ─────────────────────────────────── */
async function orchestrate(prompt, cfg) {
    const serverUrl = process.env.STREAMING_API_URL || "https://celp-mcp-server.onrender.com";
    // const serverUrl = process.env.STREAMING_API_URL || "http://localhost:5006";
    const apiKey = process.env.CELP_API_KEY;
    const socket = (0, socket_io_client_1.io)(serverUrl, {
        auth: apiKey ? { token: apiKey } : undefined,
        extraHeaders: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
    }); // identical to reference
    /* Prepare schema in the background */
    return new Promise((resolve, reject) => {
        let finalMarkdown = "";
        socket.on("connect_error", (e) => {
            socket.disconnect();
            reject(new Error(`Socket error: ${e.message}`));
        });
        /* 1. handle DB query requests */
        socket.on("query_request", async ({ queryId, sql, params }) => {
            log("query_request", queryId);
            try {
                const result = await runQuery(cfg, sql, params);
                socket.emit("query_result", { queryId, result });
            }
            catch (e) {
                socket.emit("query_result", { queryId, error: e.message });
            }
        });
        /* 2. handle streaming orchestration messages */
        socket.on("orchestration_chunk", ({ chunk }) => {
            if (chunk?.type === "summary")
                log("summary", chunk.text);
            if (chunk?.type === "final")
                finalMarkdown = chunk.markdown ?? "";
        });
        socket.on("orchestration_error", ({ error }) => {
            socket.disconnect();
            reject(new Error(error));
        });
        socket.on("orchestration_complete", () => {
            socket.disconnect();
            resolve(finalMarkdown || "No results found");
        });
        /* 3. after socket opens, send schema then orchestrate */
        socket.on("connect", async () => {
            log("connected", socket.id);
            const { schemaMap, indexMap } = await Connector.initMetadata(cfg);
            // console.log(`CLI: Loaded schema with ${Object.keys(schemaMap).length} tables`);
            socket.emit("schema_info", { schemaMap, indexMap });
            const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
            socket.emit("orchestrate", { prompt, databaseType: cfg.databaseType, requestId, apiKey });
        });
    });
}
/* ── MCP stdio server setup ─────────────────────────────────────────── */
const server = new mcp_js_1.McpServer({
    name: "celp-stdio",
    version: "1.3.0",
    description: `
  # Data Analyst Agent: Tool Context for LLM Usage

Based on my analysis of the codebase, I've created a context description that explains how this system works and how an LLM should interact with it:

---

## Tool Description

The **Data Analyst Agent** is a natural language to database analytics system that allows you to answer complex data questions by:

- Translating natural language queries into multi-step SQL analysis plans
- Executing these plans against MySQL or PostgreSQL databases
- Synthesizing the results into coherent markdown reports with insights

---

## How It Works

When a user submits a natural language query:

1. The system evaluates query complexity and generates multiple possible solution plans  
2. It selects the optimal plan through a voting mechanism  
3. It executes the plan step-by-step, with each step building on previous results  
4. It synthesizes a final report addressing the original question  

---

## Capabilities

You can use this tool to:

- Analyze data across multiple tables with complex relationships  
- Perform multi-step analyses where each step builds on previous results  
- Generate parameterized queries that reference data from earlier steps  
- Recover from errors and optimize underperforming queries  
- Produce insightful summaries with visualizations when appropriate  

---

## How to Craft Effective Prompts

When using this tool, prompts should:

- Be specific about the analysis goal (metrics, time periods, entities of interest)  
- Include any relevant business context needed for interpretation  
- Specify the format of the desired output (tables, charts, insights)  
- For complex analyses, break down into logical components  

---

## Behind the Scenes

The system:

- Uses LLMs to generate solution plans and SQL queries  
- Maintains a \`DataContext\` that stores results between steps  
- Automatically optimizes and repairs failing queries  

---

## Limitations

When using this tool, be aware:

- Each step can only access data from the immediately previous step  
- Very large result sets require summarization which may lose detail  
- For optimal performance, limit the scope of analysis to relevant tables and data points  

---

## Example Usage

For a prompt like:

> "Analyze our sales performance by region for Q1, highlighting underperforming product categories"

The system will:

- Determine database tables containing sales, regions, and products  
- Generate a plan to analyze performance metrics  
- Execute SQL queries that join appropriate tables and compute aggregations  
- Present a final report with insights about regional performance and underperforming categories  

---

This tool excels at answering specific analytical questions about data by handling all the complexity of SQL generation, execution, and result interpretation.
`,
    capabilities: { resources: {}, tools: {} },
});
server.tool("query-database", `# Data Analyst Agent: Standard Analysis Mode

This tool translates natural language into multi-step SQL analysis plans and executes them against databases. Use this for complex analytical questions requiring deep reasoning.

## Capabilities
- Performs multi-step analyses with each step building on previous results
- Analyzes data across multiple tables with complex relationships
- Handles complex queries requiring careful reasoning and planning
- Produces comprehensive markdown reports with insights

## When to Use
- For complex analytical questions requiring deep reasoning
- When accuracy and comprehensiveness is more important than speed
- For queries involving multiple tables or complex relationships
- When detailed insights and explanations are needed

## Effective Prompts
- Be specific about metrics, time periods, and entities of interest
- Include relevant business context for interpretation
- Specify desired output format (tables, charts, insights)
- For complex analyses, break down into logical components

## Restrictions:
- Don't sent database credentials in the payload, it's handled by the server.
- Don't sent API keys in the payload, it's handled by the server.
`, {
    prompt: zod_1.z.string(),
    databaseConfig: zod_1.z.object({
        databaseType: zod_1.z.enum(["postgres", "mysql"]),
        host: zod_1.z.string(),
        user: zod_1.z.string(),
        password: zod_1.z.string(),
        database: zod_1.z.string(),
        port: zod_1.z.number().optional(),
        disableSSL: zod_1.z.enum(["true", "false"]).optional(),
    }).optional(),
    celpApiKey: zod_1.z.string().optional(),
}, async ({ prompt, databaseConfig, celpApiKey }) => {
    if (databaseConfig) {
        process.env.PG_DISABLE_SSL = databaseConfig.disableSSL === "true" ? "true" : "false";
        process.env.MYSQL_SSL = databaseConfig.disableSSL === "true" ? "false" : "true";
    }
    if (celpApiKey) {
        process.env.CELP_API_KEY = celpApiKey;
    }
    const cfg = databaseConfig || {
        databaseType: process.env.DATABASE_TYPE || "postgres",
        host: process.env.DATABASE_HOST || "localhost",
        user: process.env.DATABASE_USER || "root",
        password: process.env.DATABASE_PASSWORD || "",
        database: process.env.DATABASE_NAME || "test_db",
        port: process.env.DATABASE_PORT ? parseInt(process.env.DATABASE_PORT, 10) : undefined,
    };
    try {
        const md = await orchestrate(prompt, cfg);
        return { content: [{ type: "text", text: md }] };
    }
    catch (e) {
        console.error("query-database error:", e);
        return { content: [{ type: "text", text: `Error: ${e.message}` }] };
    }
});
server.tool("query-database-fast", `# Data Analyst Agent: Balanced Mode

This tool provides a balanced approach to database analysis, maintaining good accuracy while completing queries faster than the standard mode.

## Capabilities
- Translates natural language to optimized SQL queries
- Balances between depth of analysis and speed of execution
- Can handle moderately complex analytical questions
- Produces concise markdown reports with key insights

## When to Use
- For typical analytical questions that don't require extensive reasoning
- When a good balance between speed and depth is needed
- For most standard database queries
- This should be your default choice unless specifically needing the full reasoning of standard mode

## Effective Prompts
- Clearly state the specific metrics or information needed
- Provide context about what tables or data are relevant
- Be concise but complete in your question formulation
- Mention any time constraints or filters that should be applied

## Restrictions:
- Don't sent database credentials in the payload, it's handled by the server.
- Don't sent API keys in the payload, it's handled by the server.`, {
    prompt: zod_1.z.string(),
    databaseConfig: zod_1.z.object({
        databaseType: zod_1.z.enum(["postgres", "mysql"]),
        host: zod_1.z.string(),
        user: zod_1.z.string(),
        password: zod_1.z.string(),
        database: zod_1.z.string(),
        port: zod_1.z.number().optional(),
        disableSSL: zod_1.z.enum(["true", "false"]).optional(),
    }).optional(),
    celpApiKey: zod_1.z.string().optional(),
}, async ({ prompt, databaseConfig, celpApiKey }) => {
    if (databaseConfig) {
        process.env.PG_DISABLE_SSL = databaseConfig.disableSSL === "true" ? "true" : "false";
        process.env.MYSQL_SSL = databaseConfig.disableSSL === "true" ? "false" : "true";
    }
    if (celpApiKey) {
        process.env.CELP_API_KEY = celpApiKey;
    }
    const cfg = databaseConfig || {
        databaseType: process.env.DATABASE_TYPE || "postgres",
        host: process.env.DATABASE_HOST || "localhost",
        user: process.env.DATABASE_USER || "root",
        password: process.env.DATABASE_PASSWORD || "",
        database: process.env.DATABASE_NAME || "test_db",
        port: process.env.DATABASE_PORT ? parseInt(process.env.DATABASE_PORT, 10) : undefined,
    };
    try {
        const md = await orchestrate(prompt, cfg);
        return { content: [{ type: "text", text: md }] };
    }
    catch (e) {
        console.error("query-database error:", e);
        return { content: [{ type: "text", text: `Error: ${e.message}` }] };
    }
});
server.tool("query-database-turbo", `# Data Analyst Agent: Turbo Mode

This tool maximizes speed for quick database lookups and simple analyses, trading depth for rapid results.

## Capabilities
- Quickly translates simple questions into direct SQL queries
- Executes against databases with minimal planning overhead
- Optimized for speed rather than comprehensive analysis
- Returns results with basic formatting and minimal narrative

## When to Use
- Only when specifically requested by the user
- For simple lookups or queries where speed is the primary concern
- When basic results are sufficient without extensive analysis
- For time-sensitive information needs

## Limitations
- Less suitable for complex multi-step analyses
- May miss nuances that would be captured in standard mode
- Provides less detailed explanations and insights
- May produce simpler visualizations

## Effective Prompts
- Keep questions direct and focused on specific data points
- Clearly specify tables or data sources when possible
- Explicitly mention the need for speed when requesting information

## Restrictions:
- Don't sent database credentials in the payload, it's handled by the server.
- Don't sent API keys in the payload, it's handled by the server.`, {
    prompt: zod_1.z.string(),
    databaseConfig: zod_1.z.object({
        databaseType: zod_1.z.enum(["postgres", "mysql"]),
        host: zod_1.z.string(),
        user: zod_1.z.string(),
        password: zod_1.z.string(),
        database: zod_1.z.string(),
        port: zod_1.z.number().optional(),
        disableSSL: zod_1.z.enum(["true", "false"]).optional(),
    }).optional(),
    celpApiKey: zod_1.z.string().optional(),
}, async ({ prompt, databaseConfig, celpApiKey }) => {
    if (databaseConfig) {
        process.env.PG_DISABLE_SSL = databaseConfig.disableSSL === "true" ? "true" : "false";
        process.env.MYSQL_SSL = databaseConfig.disableSSL === "true" ? "false" : "true";
    }
    if (celpApiKey) {
        process.env.CELP_API_KEY = celpApiKey;
    }
    const cfg = databaseConfig || {
        databaseType: process.env.DATABASE_TYPE || "postgres",
        host: process.env.DATABASE_HOST || "localhost",
        user: process.env.DATABASE_USER || "root",
        password: process.env.DATABASE_PASSWORD || "",
        database: process.env.DATABASE_NAME || "test_db",
        port: process.env.DATABASE_PORT ? parseInt(process.env.DATABASE_PORT, 10) : undefined,
    };
    try {
        const md = await orchestrate(prompt, cfg);
        return { content: [{ type: "text", text: md }] };
    }
    catch (e) {
        console.error("query-database error:", e);
        return { content: [{ type: "text", text: `Error: ${e.message}` }] };
    }
});
(async () => {
    await server.connect(new stdio_js_1.StdioServerTransport());
})().catch((e) => {
    console.error("Fatal:", e);
    process.exit(1);
});
