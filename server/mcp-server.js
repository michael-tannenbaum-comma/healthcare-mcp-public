#!/usr/bin/env node

import http from "http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
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

// --- SERVICE SETUP (shared across requests) ---
const cacheService = new CacheService(parseInt(process.env.CACHE_TTL) || 86400);
const usageService = new UsageService();

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

// --- MCP SERVER FACTORY ---
// Creates a fresh MCP Server instance per request (stateless pattern from SDK examples).
// Services and tools are shared, but the MCP Server + Transport are per-request.
function createMcpServer() {
  const mcpServer = new Server(
    { name: "healthcare-mcp", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

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
        },
        {
          name: "health_topics_search",
          description: "Get evidence-based health information from Health.gov on various topics",
          inputSchema: {
            type: "object",
            properties: {
              topic: { type: "string", description: "The health topic to search for" },
              language: { type: "string", enum: ["en", "es"], default: "en", description: "Language for results (en or es)" },
            },
            required: ["topic"],
          },
        },
        {
          name: "icd_code_lookup",
          description: "Look up ICD-10 codes by code or description for medical terminology",
          inputSchema: {
            type: "object",
            properties: {
              code: { type: "string", description: "ICD-10 code to look up" },
              description: { type: "string", description: "Description to search for" },
              max_results: { type: "number", default: 10, description: "Maximum number of results (1-50)" },
            },
          },
        },
        {
          name: "medrxiv_search",
          description: "Search for pre-print medical research articles on medRxiv",
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string", description: "Search query for medRxiv" },
              max_results: { type: "number", default: 10, description: "Maximum number of results (1-100)" },
            },
            required: ["query"],
          },
        },
        {
          name: "ncbi_bookshelf_search",
          description: "Search the NCBI Bookshelf for medical books and documents",
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string", description: "Search query for NCBI Bookshelf" },
              max_results: { type: "number", default: 10, description: "Maximum number of results (1-100)" },
            },
            required: ["query"],
          },
        },
        {
          name: "dicom_extract_metadata",
          description: "Extract metadata (patient name, ID, study/series descriptions) from a DICOM file",
          inputSchema: {
            type: "object",
            properties: {
              file_path: { type: "string", description: "Path to the DICOM file" },
            },
            required: ["file_path"],
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
        case "health_topics_search": result = await tools[2].getHealthTopics(args.topic, args.language); break;
        case "icd_code_lookup": result = await tools[4].lookupICDCode(args.code, args.description, args.max_results); break;
        case "medrxiv_search": result = await tools[5].search(args.query, args.max_results); break;
        case "ncbi_bookshelf_search": result = await tools[7].search(args.query, args.max_results); break;
        case "dicom_extract_metadata": result = tools[8].extractMetadata(args.file_path); break;
        default: throw new Error(`Unknown tool: ${name}`);
      }

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
    }
  });

  return mcpServer;
}

// --- HTTP SERVER (Stateless Streamable HTTP) ---

const PORT = process.env.PORT || 8000;

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  console.log(`[HTTP] ${req.method} ${req.url}`);

  if (url.pathname === "/mcp") {

    // POST: Handle JSON-RPC messages (stateless: fresh server+transport per request)
    if (req.method === "POST") {
      const server = createMcpServer();
      try {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,  // stateless mode
        });

        await server.connect(transport);
        await transport.handleRequest(req, res);

        res.on("close", () => {
          console.log("[HTTP] Request closed, cleaning up.");
          transport.close();
          server.close();
        });
      } catch (error) {
        console.error("[HTTP] Error handling MCP request:", error);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal server error" },
            id: null,
          }));
        }
      }
      return;
    }

    // GET/DELETE: Not supported in stateless mode
    if (req.method === "GET" || req.method === "DELETE") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Method not allowed." },
        id: null,
      }));
      return;
    }

    // OPTIONS: CORS preflight
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, mcp-session-id");
      res.writeHead(204);
      res.end();
      return;
    }
  }

  res.writeHead(404);
  res.end("Not Found");
});

httpServer.listen(PORT, () => {
  console.log(`Stateless Streamable HTTP Server running on port ${PORT}`);
  console.log(`Endpoint: /mcp (POST only)`);
});
