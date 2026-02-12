#!/usr/bin/env node

import http from "http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
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

// --- SERVICE SETUP (Wie im Original) ---
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

// --- MCP SERVER INIT ---
const mcpServer = new Server(
  { name: "healthcare-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// Tools registrieren
mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
  // Wir bauen die Tool-Liste dynamisch aus den vorhandenen Klassen (oder Hardcoded wie im Original)
  // Hier der Einfachheit halber eine gekürzte Liste der wichtigsten Tools, 
  // die auch im originalen index.js definiert waren:
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
      // Füge hier bei Bedarf weitere Tools aus der index.js hinzu
    ],
  };
});

mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const sessionId = "streamable-session"; // In echter Prod-Umgebung aus dem Request extrahieren
  
  try {
    usageService.recordUsage(sessionId, name);
    let result;

    // Mapping der Tool-Aufrufe
    switch (name) {
      case "fda_drug_lookup": 
        result = await tools[0].lookupDrug(args.drug_name, args.search_type); 
        break;
      case "pubmed_search": 
        result = await tools[1].searchLiterature(args.query, args.max_results, args.date_range, args.open_access); 
        break;
      case "calculate_bmi": 
        result = tools[6].calculateBmi(args.height_meters, args.weight_kg); 
        break;
      case "clinical_trials_search": 
        result = await tools[3].searchTrials(args.condition, args.status, args.max_results); 
        break;
      default: 
        throw new Error(`Unknown tool: ${name}`);
    }

    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (error) {
    return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
  }
});

// --- MODERN STREAMABLE HTTP SERVER ---

const PORT = process.env.PORT || 8000;
const sessions = new Map();

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // CORS ist PFLICHT für Streamable HTTP
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Mcp-Session-Id");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // EINZIGER ENDPUNKT: /mcp
  if (url.pathname === "/mcp") {
    
    // 1. Initialisierung (GET) -> Startet SSE Stream
    if (req.method === "GET") {
      const transport = new SSEServerTransport("/mcp", res);
      const sessionId = randomUUID();
      
      // Session speichern
      sessions.set(sessionId, transport);
      
      // Session ID im Header zurückgeben (Wichtig für Streamable HTTP!)
      res.setHeader("X-Mcp-Session-Id", sessionId);
      
      console.log(`New Streamable HTTP session: ${sessionId}`);

      // Transport verbinden
      await mcpServer.connect(transport);

      // Cleanup bei Verbindungsabbruch
      req.on("close", () => {
        console.log(`Session closed: ${sessionId}`);
        sessions.delete(sessionId);
      });
      return;
    }

    // 2. Nachrichten (POST) -> Verarbeitet JSON-RPC
    if (req.method === "POST") {
      // Session ID aus Header oder Query lesen
      const sessionId = req.headers["x-mcp-session-id"] || url.searchParams.get("sessionId");
      
      if (!sessionId || !sessions.has(sessionId)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Session ID required or invalid. Connect via GET /mcp first." }));
        return;
      }

      const transport = sessions.get(sessionId);
      
      // Nachricht an den existierenden Transport weiterleiten
      await transport.handlePostMessage(req, res);
      return;
    }
  }

  res.writeHead(404);
  res.end("Not Found - Use /mcp endpoint");
});

httpServer.listen(PORT, () => {
  console.log(`Streamable HTTP Server running on port ${PORT}`);
  console.log(`Endpoint: http://localhost:${PORT}/mcp`);
});