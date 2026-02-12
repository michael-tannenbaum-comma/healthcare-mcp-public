#!/usr/bin/env node

import http from "http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from 'crypto';
import { URL } from 'url';

// Import services and tools
import { CacheService } from './cache-service.js';
import { FDATool } from './fda-tool.js';
import { PubMedTool } from './pubmed-tool.js';
import { HealthTopicsTool } from './health-topics-tool.js';
import { ClinicalTrialsTool } from './clinical-trials-tool.js';
import { MedicalTerminologyTool } from './medical-terminology-tool.js';
import { MedRxivTool } from './medrxiv-tool.js';
import { MedicalCalculatorTool } from './medical-calculator-tool.js';
import { NcbiBookshelfTool } from './ncbi-bookshelf-tool.js';
import { DicomTool } from './dicom-tool.js';
import { UsageService } from './usage-service.js';

// --- SERVICE SETUP ---
const cacheService = new CacheService(parseInt(process.env.CACHE_TTL) || 86400);
const usageService = new UsageService();

// Tools initialisieren (wie gehabt)
const tools = [
  new FDATool(cacheService),
  new PubMedTool(cacheService),
  new HealthTopicsTool(cacheService),
  new ClinicalTrialsTool(cacheService),
  new MedicalTerminologyTool(cacheService),
  new MedRxivTool(cacheService),
  new MedicalCalculatorTool(cacheService),
  new NcbiBookshelfTool(cacheService),
  new DicomTool(cacheService)
];

// --- MCP SERVER INIT ---
const mcpServer = new Server(
  { name: "healthcare-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// Tools registrieren
mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "fda_drug_lookup",
        description: "Look up drug information from the FDA database",
        inputSchema: {
          type: "object",
          properties: {
            drug_name: { type: "string" },
            search_type: { type: "string", enum: ["general", "label", "adverse_events"], default: "general" },
          },
          required: ["drug_name"],
        },
      },
      {
        name: "pubmed_search",
        description: "Search for medical literature in PubMed",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            max_results: { type: "number", default: 5 },
          },
          required: ["query"],
        },
      },
      {
        name: "calculate_bmi",
        description: "Calculate Body Mass Index (BMI)",
        inputSchema: {
          type: "object",
          properties: {
            height_meters: { type: "number" },
            weight_kg: { type: "number" },
          },
          required: ["height_meters", "weight_kg"],
        },
      },
       {
        name: "clinical_trials_search",
        description: "Search for clinical trials",
        inputSchema: {
          type: "object",
          properties: {
            condition: { type: "string" },
            status: { type: "string", default: "recruiting" },
            max_results: { type: "number", default: 10 },
          },
          required: ["condition"],
        },
      }
    ],
  };
});

mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const sessionId = "streamable-session";
  
  try {
    usageService.recordUsage(sessionId, name);
    let result;

    switch (name) {
      case "fda_drug_lookup": result = await tools[0].lookupDrug(args.drug_name, args.search_type); break;
      case "pubmed_search": result = await tools[1].searchLiterature(args.query, args.max_results, args.date_range, args.open_access); break;
      case "calculate_bmi": result = tools[6].calculateBmi(args.height_meters, args.weight_kg); break;
      case "clinical_trials_search": result = await tools[3].searchTrials(args.condition, args.status, args.max_results); break;
      default: throw new Error(`Unknown tool: ${name}`);
    }

    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (error) {
    return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
  }
});

// --- HTTP SERVER (Refactored to use StreamableHTTPServerTransport) ---

const PORT = process.env.PORT || 8000;

// Initialize the Streamable HTTP Transport
// Explicitly providing sessionIdGenerator enables "stateful" mode, ensuring session IDs are managed automatically.
const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID()
});

// Connect the transport to the MCP server
// This must be done BEFORE handling requests
await mcpServer.connect(transport);

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // GLOBAL LOGGER
  console.log(`[HTTP] ${req.method} ${req.url}`);
  try {
      console.log(`[HTTP] Headers: ${JSON.stringify(req.headers)}`);
  } catch (e) {
      console.error(`[HTTP] Error stringifying headers`, e);
  }

  // Handle /mcp endpoint
  if (url.pathname === "/mcp") {
      // Delegate request handling to the transport
      // This automatically handles GET (SSE), POST (Messages), OPTIONS, and Headers
      await transport.handleRequest(req, res);
      return;
  }

  // Fallback 404
  res.writeHead(404);
  res.end("Not Found");
});

httpServer.listen(PORT, () => {
  console.log(`Streamable HTTP Server running on port ${PORT}`);
  console.log(`Endpoint for Inspector: https://<DEIN-RENDER-URL>/mcp`);
});
