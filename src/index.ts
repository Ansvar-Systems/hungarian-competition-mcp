#!/usr/bin/env node

/**
 * Hungarian Competition MCP — stdio entry point.
 *
 * Provides MCP tools for querying GVH (Gazdasági Versenyhivatal — Hungarian
 * Competition Authority) decisions, merger control cases, and sector enforcement
 * activity under Hungarian competition law (Tpvt).
 *
 * Tool prefix: hu_comp_
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  searchDecisions,
  getDecision,
  searchMergers,
  getMerger,
  listSectors,
} from "./db.js";
import { buildCitation } from "./utils/citation.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let pkgVersion = "0.1.0";
try {
  const pkg = JSON.parse(
    readFileSync(join(__dirname, "..", "package.json"), "utf8"),
  ) as { version: string };
  pkgVersion = pkg.version;
} catch {
  // fallback to default
}

const SERVER_NAME = "hungarian-competition-mcp";
const GVH_DATA_AGE = process.env["GVH_DATA_AGE"] ?? "2024-12-31";

function getMeta(sourceUrl?: string) {
  return {
    disclaimer:
      "This data is sourced from GVH (Gazdasági Versenyhivatal) public records. Always verify with official sources before relying on this information for legal or compliance purposes.",
    data_age: GVH_DATA_AGE,
    copyright:
      "© GVH (Gazdasági Versenyhivatal) — Hungarian Competition Authority. Data used for informational purposes.",
    ...(sourceUrl ? { source_url: sourceUrl } : {}),
  };
}

// --- Tool definitions ---------------------------------------------------------

const TOOLS = [
  {
    name: "hu_comp_search_decisions",
    description:
      "Full-text search across GVH competition enforcement decisions. Covers abuse of dominance, cartel enforcement, unfair commercial practices, and sector inquiries under Hungarian competition law (Tpvt — 1996. évi LVII. törvény). Returns matching decisions with case number, parties, sector, outcome, and summary.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Search query (e.g., 'erőfölénnyel való visszaélés', 'kartell', 'tisztességtelen verseny')",
        },
        type: {
          type: "string",
          enum: ["abuse_of_dominance", "cartel", "sector_inquiry", "unfair_commercial_practice"],
          description: "Filter by case type. Optional.",
        },
        sector: {
          type: "string",
          description: "Filter by industry sector (e.g., 'energy', 'telecommunications', 'retail'). Optional.",
        },
        outcome: {
          type: "string",
          enum: ["infringement", "commitment", "no_infringement", "fine"],
          description: "Filter by decision outcome. Optional.",
        },
        limit: {
          type: "number",
          description: "Maximum number of results to return. Defaults to 20.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "hu_comp_get_decision",
    description:
      "Get a specific GVH competition decision by case number (e.g., 'Vj/001/2024', 'Vj/050/2023').",
    inputSchema: {
      type: "object" as const,
      properties: {
        case_number: {
          type: "string",
          description: "GVH case number",
        },
      },
      required: ["case_number"],
    },
  },
  {
    name: "hu_comp_search_mergers",
    description:
      "Search GVH merger control decisions. Returns merger cases with acquiring party, target, sector, and clearance outcome under Hungarian merger control rules (Tpvt).",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Search query (e.g., 'összefonódás', 'felvásárlás', 'energia')",
        },
        sector: {
          type: "string",
          description: "Filter by industry sector. Optional.",
        },
        outcome: {
          type: "string",
          enum: ["cleared", "cleared_with_conditions", "blocked", "withdrawn"],
          description: "Filter by merger outcome. Optional.",
        },
        limit: {
          type: "number",
          description: "Maximum number of results to return. Defaults to 20.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "hu_comp_get_merger",
    description:
      "Get a specific GVH merger control decision by case number (e.g., 'Vj/M/10/2024').",
    inputSchema: {
      type: "object" as const,
      properties: {
        case_number: {
          type: "string",
          description: "GVH merger case number",
        },
      },
      required: ["case_number"],
    },
  },
  {
    name: "hu_comp_list_sectors",
    description:
      "List all industry sectors with GVH enforcement activity covered in this MCP, with decision and merger counts.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "hu_comp_list_sources",
    description:
      "List the data sources used by this MCP server, including GVH website URLs, data coverage, and update schedule.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "hu_comp_check_data_freshness",
    description:
      "Check the freshness of the data in this MCP server. Returns the last known data ingestion date and coverage period.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "hu_comp_about",
    description: "Return metadata about this MCP server: version, data source, coverage, and tool list.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
];

// --- Zod schemas for argument validation --------------------------------------

const SearchDecisionsArgs = z.object({
  query: z.string().min(1),
  type: z.enum(["abuse_of_dominance", "cartel", "sector_inquiry", "unfair_commercial_practice"]).optional(),
  sector: z.string().optional(),
  outcome: z.enum(["infringement", "commitment", "no_infringement", "fine"]).optional(),
  limit: z.number().int().positive().max(100).optional(),
});

const GetDecisionArgs = z.object({
  case_number: z.string().min(1),
});

const SearchMergersArgs = z.object({
  query: z.string().min(1),
  sector: z.string().optional(),
  outcome: z.enum(["cleared", "cleared_with_conditions", "blocked", "withdrawn"]).optional(),
  limit: z.number().int().positive().max(100).optional(),
});

const GetMergerArgs = z.object({
  case_number: z.string().min(1),
});

// --- Helper ------------------------------------------------------------------

function textContent(data: unknown, sourceUrl?: string) {
  const meta = getMeta(sourceUrl);
  const payload =
    typeof data === "object" && data !== null
      ? { ...(data as object), _meta: meta }
      : { data, _meta: meta };
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(payload, null, 2) },
    ],
  };
}

function errorContent(message: string, errorType = "tool_error") {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          { error: message, _meta: getMeta(), _error_type: errorType },
          null,
          2,
        ),
      },
    ],
    isError: true as const,
  };
}

// --- Server setup ------------------------------------------------------------

const server = new Server(
  { name: SERVER_NAME, version: pkgVersion },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  try {
    switch (name) {
      case "hu_comp_search_decisions": {
        const parsed = SearchDecisionsArgs.parse(args);
        const results = searchDecisions({
          query: parsed.query,
          type: parsed.type,
          sector: parsed.sector,
          outcome: parsed.outcome,
          limit: parsed.limit,
        });
        return textContent({ results, count: results.length });
      }

      case "hu_comp_get_decision": {
        const parsed = GetDecisionArgs.parse(args);
        const decision = getDecision(parsed.case_number);
        if (!decision) {
          return errorContent(`Decision not found: ${parsed.case_number}`, "not_found");
        }
        const d = decision as Record<string, unknown>;
        return textContent(
          {
            ...decision,
            _citation: buildCitation(
              String(d.case_number ?? parsed.case_number),
              String(d.title ?? d.case_number ?? parsed.case_number),
              "hu_comp_get_decision",
              { case_number: parsed.case_number },
              d.url as string | undefined,
            ),
          },
          d.url as string | undefined,
        );
      }

      case "hu_comp_search_mergers": {
        const parsed = SearchMergersArgs.parse(args);
        const results = searchMergers({
          query: parsed.query,
          sector: parsed.sector,
          outcome: parsed.outcome,
          limit: parsed.limit,
        });
        return textContent({ results, count: results.length });
      }

      case "hu_comp_get_merger": {
        const parsed = GetMergerArgs.parse(args);
        const merger = getMerger(parsed.case_number);
        if (!merger) {
          return errorContent(`Merger decision not found: ${parsed.case_number}`, "not_found");
        }
        const m = merger as Record<string, unknown>;
        return textContent(
          {
            ...merger,
            _citation: buildCitation(
              String(m.case_number ?? parsed.case_number),
              String(m.title ?? m.case_number ?? parsed.case_number),
              "hu_comp_get_merger",
              { case_number: parsed.case_number },
              m.url as string | undefined,
            ),
          },
          m.url as string | undefined,
        );
      }

      case "hu_comp_list_sectors": {
        const sectors = listSectors();
        return textContent({ sectors, count: sectors.length });
      }

      case "hu_comp_list_sources": {
        return textContent({
          sources: [
            {
              name: "GVH",
              full_name: "Gazdasági Versenyhivatal — Hungarian Competition Authority",
              url: "https://www.gvh.hu/",
              coverage: {
                decisions: ["abuse_of_dominance", "cartel", "unfair_commercial_practice", "sector_inquiry"],
                mergers: ["cleared", "cleared_with_conditions", "blocked", "withdrawn"],
                period_from: "2000",
                period_to: "present",
              },
            },
          ],
          ingest_script: "scripts/ingest-gvh.ts",
          update_schedule: "Weekly (Sundays at 02:00 UTC)",
        });
      }

      case "hu_comp_check_data_freshness": {
        return textContent({
          data_age: GVH_DATA_AGE,
          status: "ok",
          source: "GVH (https://www.gvh.hu/)",
          note: "Set GVH_DATA_AGE environment variable to reflect the actual ingestion date.",
        });
      }

      case "hu_comp_about": {
        return textContent({
          name: SERVER_NAME,
          version: pkgVersion,
          description:
            "GVH (Gazdasági Versenyhivatal — Hungarian Competition Authority) MCP server. Provides access to competition enforcement decisions, merger control cases, and sector inquiries under Hungarian competition law (Tpvt — 1996. évi LVII. törvény).",
          data_source: "GVH (https://www.gvh.hu/)",
          coverage: {
            decisions: "GVH abuse of dominance, cartel, unfair commercial practices, and sector inquiry decisions",
            mergers: "GVH merger control decisions under Tpvt",
            sectors: "Sectors with GVH enforcement activity",
          },
          tools: TOOLS.map((t) => ({ name: t.name, description: t.description })),
        });
      }

      default:
        return errorContent(`Unknown tool: ${name}`, "unknown_tool");
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorContent(`Error executing ${name}: ${message}`, "tool_error");
  }
});

// --- Main --------------------------------------------------------------------

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`${SERVER_NAME} v${pkgVersion} running on stdio\n`);
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
