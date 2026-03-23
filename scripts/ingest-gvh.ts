#!/usr/bin/env tsx
/**
 * GVH Ingestion Crawler
 *
 * Crawls the Gazdasági Versenyhivatal (Hungarian Competition Authority) website
 * at gvh.hu to ingest competition decisions and merger control decisions into
 * the local SQLite database.
 *
 * Two-phase pipeline:
 *   Phase 1 (Discovery):  Fetch year-based listing pages, extract decision and
 *                          merger links from rendered HTML / Solr-backed pages.
 *   Phase 2 (Content):    Fetch each decision page, parse metadata and full text,
 *                          upsert into the decisions / mergers tables.
 *
 * The GVH site is an Aurelia SPA with Solr search backend. Listing pages render
 * decision links client-side but the individual decision HTML pages contain the
 * full text in server-rendered markup once fetched directly.
 *
 * URL patterns (observed):
 *   Year listing (2021+):   /dontesek/versenyhivatali_dontesek/dontesek-{YYYY}
 *   Year listing (pre-2021):/dontesek/versenyhivatali_dontesek/archiv/dontesek_{YYYY}
 *   Decision detail:        /dontesek/versenyhivatali_dontesek/dontesek-{YYYY}/{slug}
 *   PDF (fallback):         /pfile/file?path=/dontesek/.../Vj{NNN}_{YYYY}_m.pdf1&inline=true
 *
 * Case number prefixes:
 *   Vj-   competition supervision (cartels, abuse of dominance, consumer protection)
 *   ÖB-   merger notifications (összefonódás-bejelentés)
 *
 * Usage:
 *   npx tsx scripts/ingest-gvh.ts                          # Full crawl (2000–current)
 *   npx tsx scripts/ingest-gvh.ts --dry-run                # Discover only, no DB writes
 *   npx tsx scripts/ingest-gvh.ts --resume                 # Skip already-ingested case numbers
 *   npx tsx scripts/ingest-gvh.ts --force                  # Drop and recreate DB before crawl
 *   npx tsx scripts/ingest-gvh.ts --year-from 2022         # Start from 2022
 *   npx tsx scripts/ingest-gvh.ts --year-to 2024           # Stop at 2024 (inclusive)
 *   npx tsx scripts/ingest-gvh.ts --limit 50               # Stop after 50 decisions
 *   npx tsx scripts/ingest-gvh.ts --resume --year-from 2023 --year-to 2024
 *
 * Requirements: better-sqlite3, cheerio (install cheerio if missing).
 * Rate limit: 1 500 ms between HTTP requests.
 * Retry: up to 3 attempts per URL with exponential backoff.
 */

import Database from "better-sqlite3";
import * as cheerio from "cheerio";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_SQL } from "../src/db.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DB_PATH = process.env["GVH_DB_PATH"] ?? "data/gvh.db";
const BASE_URL = "https://www.gvh.hu";

/** Minimum delay between HTTP requests (ms). */
const RATE_LIMIT_MS = 1500;

/** Maximum retry attempts per URL. */
const MAX_RETRIES = 3;

/** Base delay for exponential backoff (ms). */
const RETRY_BASE_MS = 2000;

/** HTTP request timeout (ms). */
const REQUEST_TIMEOUT_MS = 30_000;

/** Earliest year to crawl. */
const EARLIEST_YEAR = 2000;

/** User-Agent header sent with all requests. */
const USER_AGENT =
  "Ansvar-GVH-Crawler/1.0 (+https://ansvar.eu; compliance research)";

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

interface CliArgs {
  dryRun: boolean;
  resume: boolean;
  force: boolean;
  yearFrom: number;
  yearTo: number;
  limit: number | null;
}

function parseArgs(): CliArgs {
  const argv = process.argv.slice(2);
  const args: CliArgs = {
    dryRun: false,
    resume: false,
    force: false,
    yearFrom: EARLIEST_YEAR,
    yearTo: new Date().getFullYear(),
    limit: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    switch (a) {
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--resume":
        args.resume = true;
        break;
      case "--force":
        args.force = true;
        break;
      case "--year-from":
        args.yearFrom = parseInt(argv[++i] ?? "", 10);
        if (Number.isNaN(args.yearFrom)) fatal("--year-from requires a number");
        break;
      case "--year-to":
        args.yearTo = parseInt(argv[++i] ?? "", 10);
        if (Number.isNaN(args.yearTo)) fatal("--year-to requires a number");
        break;
      case "--limit":
        args.limit = parseInt(argv[++i] ?? "", 10);
        if (Number.isNaN(args.limit)) fatal("--limit requires a number");
        break;
      default:
        fatal(`Unknown flag: ${a}`);
    }
  }

  return args;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A discovered link from a year listing page. */
interface DiscoveredEntry {
  /** Full URL to the decision page. */
  url: string;
  /** Raw slug from the URL (e.g. "vj-04202446" or "ob-5420246"). */
  slug: string;
  /** Normalised case number (e.g. "Vj-04/2024/46" or "ÖB-54/2024/6"). */
  caseNumber: string;
  /** Year extracted from the listing URL. */
  year: number;
  /** Whether this is a merger (ÖB) or competition decision (Vj). */
  kind: "decision" | "merger";
  /** Link text from the listing page (often the case number). */
  linkText: string;
}

/** Parsed decision metadata from a detail page. */
interface ParsedDecision {
  caseNumber: string;
  title: string;
  date: string | null;
  type: string | null;
  sector: string | null;
  parties: string | null;
  summary: string | null;
  fullText: string;
  outcome: string | null;
  fineAmount: number | null;
  competitionArticles: string | null;
  status: string;
}

/** Parsed merger metadata from a detail page. */
interface ParsedMerger {
  caseNumber: string;
  title: string;
  date: string | null;
  sector: string | null;
  acquiringParty: string | null;
  target: string | null;
  summary: string | null;
  fullText: string;
  outcome: string | null;
  turnover: number | null;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

let lastRequestTime = 0;

/** Rate-limited fetch with retry and exponential backoff. */
async function fetchWithRetry(url: string): Promise<{ status: number; body: string }> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    // Rate limit
    const now = Date.now();
    const elapsed = now - lastRequestTime;
    if (elapsed < RATE_LIMIT_MS) {
      await sleep(RATE_LIMIT_MS - elapsed);
    }
    lastRequestTime = Date.now();

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      const res = await fetch(url, {
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "hu-HU,hu;q=0.9,en;q=0.5",
        },
        signal: controller.signal,
        redirect: "follow",
      });

      clearTimeout(timeout);
      const body = await res.text();
      return { status: res.status, body };
    } catch (err) {
      const isLast = attempt === MAX_RETRIES;
      const errMsg = err instanceof Error ? err.message : String(err);

      if (isLast) {
        console.error(`    FAILED after ${MAX_RETRIES} attempts: ${url} — ${errMsg}`);
        return { status: 0, body: "" };
      }

      const delay = RETRY_BASE_MS * Math.pow(2, attempt - 1);
      console.warn(`    Retry ${attempt}/${MAX_RETRIES} for ${url} — ${errMsg} (wait ${delay}ms)`);
      await sleep(delay);
    }
  }

  return { status: 0, body: "" };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Phase 1: Discovery — scrape year listing pages for decision links
// ---------------------------------------------------------------------------

/**
 * Build the URL for a year listing page.
 *
 * GVH changed URL structure around 2021:
 *   2021+:     /dontesek/versenyhivatali_dontesek/dontesek-{YYYY}
 *   Pre-2021:  /dontesek/versenyhivatali_dontesek/archiv/dontesek_{YYYY}
 *
 * The listing pages are paginated via `$rppid...` query parameters on the
 * SPA side. We attempt multiple pagination offsets.
 */
function yearListingUrls(year: number): string[] {
  const base =
    year >= 2021
      ? `${BASE_URL}/dontesek/versenyhivatali_dontesek/dontesek-${year}`
      : `${BASE_URL}/dontesek/versenyhivatali_dontesek/archiv/dontesek_${year}`;

  // The SPA paginates with a portlet parameter. We try the base URL and
  // several pagination offsets. The parameter name varies, so we also try
  // the commonly observed patterns.
  const urls = [base];
  for (let page = 2; page <= 10; page++) {
    // Observed pagination pattern on gvh.hu (Liferay-style portlet pagination)
    urls.push(`${base}/$rppid0x1538980x16_pageNumber/${page}`);
  }
  return urls;
}

/**
 * Normalise a slug like "vj-04202446" into a proper case number "Vj-04/2024/46".
 *
 * Observed slug formats:
 *   vj-{NN}{YYYY}{seq}       → Vj-{NN}/{YYYY}/{seq}
 *   ob-{NN}{YYYY}{seq}       → ÖB-{NN}/{YYYY}/{seq}
 *   {digits}_hu_vj-{...}     → strip prefix, then normalise
 *
 * Archiv slugs (pre-2021) may have a numeric prefix like "2955_hu_vj-38199813".
 */
function normaliseCaseNumber(slug: string): { caseNumber: string; kind: "decision" | "merger" } | null {
  // Strip archiv-style numeric prefix: "2955_hu_vj-38199813" → "vj-38199813"
  let cleaned = slug.replace(/^\d+_hu_/, "");

  // Match Vj pattern: vj-{caseNo}{year4}{seq}
  const vjMatch = cleaned.match(/^vj-(\d{1,3})(\d{4})(\d+)$/i);
  if (vjMatch) {
    const [, caseNo, year, seq] = vjMatch;
    return {
      caseNumber: `Vj-${caseNo}/${year}/${seq}`,
      kind: "decision",
    };
  }

  // Match ÖB pattern: ob-{caseNo}{year4}{seq}  (URL-safe: "ob-")
  const obMatch = cleaned.match(/^ob-(\d{1,3})(\d{4})(\d+)$/i);
  if (obMatch) {
    const [, caseNo, year, seq] = obMatch;
    return {
      caseNumber: `ÖB-${caseNo}/${year}/${seq}`,
      kind: "merger",
    };
  }

  // Match archiv Vj_ pattern: "Vj_42_2013_102" or "vj42_2013_m"
  const vjUnderscoreMatch = cleaned.match(/^vj[_-]?(\d{1,3})[_-](\d{4})[_-](\d+)$/i);
  if (vjUnderscoreMatch) {
    const [, caseNo, year, seq] = vjUnderscoreMatch;
    return {
      caseNumber: `Vj-${caseNo}/${year}/${seq}`,
      kind: "decision",
    };
  }

  return null;
}

/**
 * Extract decision/merger links from a year listing page HTML.
 *
 * The GVH listing pages are SPA-rendered (Aurelia + Solr), so the static HTML
 * may contain limited content. We look for:
 *   1. <a> tags whose href contains "/vj-" or "/ob-" (decision/merger slugs)
 *   2. Liferay/CMS asset publisher markup with decision entries
 */
function extractLinksFromListing(html: string, year: number): DiscoveredEntry[] {
  const $ = cheerio.load(html);
  const entries: DiscoveredEntry[] = [];
  const seen = new Set<string>();

  // Strategy 1: find all anchor tags with decision/merger slugs in href
  $("a[href]").each((_i, el) => {
    const href = $(el).attr("href") ?? "";
    const text = $(el).text().trim();

    // Match links containing /vj- or /ob- slugs
    const slugMatch = href.match(/\/(vj-[a-z0-9-]+|ob-[a-z0-9-]+)\/?$/i)
      ?? href.match(/\/(\d+_hu_vj-[a-z0-9-]+)\/?$/i);

    if (!slugMatch) return;
    const slug = slugMatch[1]!.toLowerCase();

    // Avoid duplicates
    if (seen.has(slug)) return;
    seen.add(slug);

    const parsed = normaliseCaseNumber(slug);
    if (!parsed) return;

    const fullUrl = href.startsWith("http") ? href : `${BASE_URL}${href}`;

    entries.push({
      url: fullUrl,
      slug,
      caseNumber: parsed.caseNumber,
      year,
      kind: parsed.kind,
      linkText: text || parsed.caseNumber,
    });
  });

  // Strategy 2: look for text content that mentions Vj- or ÖB- case numbers
  // This catches cases where the SPA has rendered some text but without proper <a> tags.
  const bodyText = $("body").text();
  const casePatterns = [
    /Vj-(\d{1,3})\/(\d{4})\/(\d+)/gi,
    /ÖB-(\d{1,3})\/(\d{4})\/(\d+)/gi,
    /VJ\/(\d{1,3})\/(\d{4})/gi,
  ];

  for (const pattern of casePatterns) {
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(bodyText)) !== null) {
      const fullMatch = m[0]!;
      // Normalise to our format
      const normMatch = fullMatch.replace(/^VJ\/(\d+)\/(\d+)$/i, "Vj-$1/$2/0");
      if (seen.has(normMatch)) continue;
      seen.add(normMatch);
      // We don't have a direct URL for these — they came from body text.
      // We'll try to construct a URL from the case number.
    }
  }

  return entries;
}

/**
 * Phase 1: Discover all decision/merger URLs across the requested year range.
 */
async function discoverEntries(args: CliArgs): Promise<DiscoveredEntry[]> {
  console.log("\n  Phase 1: Discovery");
  console.log("  ─────────────────────────────────────────────\n");

  const allEntries: DiscoveredEntry[] = [];
  const seenCaseNumbers = new Set<string>();

  for (let year = args.yearTo; year >= args.yearFrom; year--) {
    const urls = yearListingUrls(year);
    let yearCount = 0;

    for (const listingUrl of urls) {
      const { status, body } = await fetchWithRetry(listingUrl);
      if (status === 0 || status === 404) continue;

      const entries = extractLinksFromListing(body, year);
      for (const entry of entries) {
        if (seenCaseNumbers.has(entry.caseNumber)) continue;
        seenCaseNumbers.add(entry.caseNumber);
        allEntries.push(entry);
        yearCount++;
      }

      // If we got results from the first page, the SPA-rendered pages
      // likely won't give more via static fetch. Stop early.
      if (entries.length > 0) break;
    }

    if (yearCount > 0) {
      console.log(`    ${year}: ${yearCount} entries discovered`);
    } else {
      console.log(`    ${year}: no entries found (SPA-rendered or empty)`);
    }
  }

  console.log(`\n  Total discovered: ${allEntries.length} entries`);
  console.log(
    `    Decisions: ${allEntries.filter((e) => e.kind === "decision").length}`,
  );
  console.log(
    `    Mergers:   ${allEntries.filter((e) => e.kind === "merger").length}`,
  );
  console.log();

  return allEntries;
}

// ---------------------------------------------------------------------------
// Phase 2: Content extraction — parse individual decision/merger pages
// ---------------------------------------------------------------------------

/**
 * Classification of GVH case types based on Hungarian keywords found in text.
 */
function classifyCaseType(text: string): string | null {
  const lower = text.toLowerCase();

  if (lower.includes("kartell") || lower.includes("versenykorlátozó megállapodás")
      || lower.includes("összehangolt magatartás") || lower.includes("11. §")) {
    return "cartel";
  }
  if (lower.includes("erőfölény") || lower.includes("gazdasági erőfölény")
      || lower.includes("21. §") || lower.includes("102. cikk")) {
    return "abuse_of_dominance";
  }
  if (lower.includes("összefonódás") || lower.includes("koncentráció")
      || lower.includes("fúzió") || lower.includes("24. §")) {
    return "merger";
  }
  if (lower.includes("szektorelemzés") || lower.includes("ágazati vizsgálat")
      || lower.includes("43/H. §")) {
    return "sector_inquiry";
  }
  if (lower.includes("tisztességtelen kereskedelmi gyakorlat")
      || lower.includes("fogyasztóvédel") || lower.includes("fogyasztók")) {
    return "unfair_commercial_practice";
  }
  if (lower.includes("kötelezettségvállalás")) {
    return "commitment_decision";
  }
  return null;
}

/**
 * Classify outcome based on Hungarian keywords.
 */
function classifyOutcome(text: string): string | null {
  const lower = text.toLowerCase();

  if (lower.includes("bírság") || lower.includes("pénzbírság")) {
    return "fine";
  }
  if (lower.includes("kötelezettségvállalás") && !lower.includes("bírság")) {
    return "remedies";
  }
  if (lower.includes("megtilt") || lower.includes("tilalom")) {
    return "prohibited";
  }
  if (lower.includes("engedélyez") && lower.includes("feltétel")) {
    return "approved_with_conditions";
  }
  if (lower.includes("engedélyez") || lower.includes("tudomásul vesz")
      || lower.includes("nem csökkenti")) {
    return "approved";
  }
  if (lower.includes("megszüntet") || lower.includes("nem állapít meg jogsértés")) {
    return "dismissed";
  }
  if (lower.includes("folyamatban") || lower.includes("vizsgálat")) {
    return "ongoing";
  }
  return null;
}

/**
 * Extract fine amount from Hungarian text.
 * Looks for patterns like: "850.000.000 Ft", "1,2 milliárd Ft", "320 millió forint".
 */
function extractFineAmount(text: string): number | null {
  // Pattern: digit groups separated by dots or spaces, followed by Ft/forint
  // e.g. "850.000.000 Ft" or "1 200 000 000 Ft"
  const patterns = [
    // "850.000.000 Ft" — dot-separated thousands
    /(\d{1,3}(?:\.\d{3})+)\s*(?:Ft|forint|HUF)/gi,
    // "850 000 000 Ft" — space-separated thousands
    /(\d{1,3}(?:\s\d{3})+)\s*(?:Ft|forint|HUF)/gi,
    // "1,2 milliárd Ft"
    /(\d+(?:[,.]\d+)?)\s*milliárd\s*(?:Ft|forint|HUF)/gi,
    // "320 millió Ft"
    /(\d+(?:[,.]\d+)?)\s*millió\s*(?:Ft|forint|HUF)/gi,
  ];

  let maxFine = 0;

  for (const pattern of patterns) {
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(text)) !== null) {
      const raw = m[1]!;
      const fullMatch = m[0]!.toLowerCase();
      let value: number;

      if (fullMatch.includes("milliárd")) {
        value = parseFloat(raw.replace(",", ".")) * 1_000_000_000;
      } else if (fullMatch.includes("millió")) {
        value = parseFloat(raw.replace(",", ".")) * 1_000_000;
      } else {
        // Remove dot/space thousand separators
        value = parseInt(raw.replace(/[.\s]/g, ""), 10);
      }

      if (!Number.isNaN(value) && value > maxFine) {
        maxFine = value;
      }
    }
  }

  return maxFine > 0 ? maxFine : null;
}

/**
 * Extract legal article references from the text.
 * Looks for Tpvt. (competition act) and EUMSZ (TFEU) references.
 */
function extractArticles(text: string): string | null {
  const articles = new Set<string>();

  // Tpvt. paragraphs: "Tpvt. 11. §", "Tpvt. 21. §", "Tpvt. 24. §"
  const tpvtPattern = /Tpvt\.\s*(\d+(?:\/[A-Z])?)\.\s*§/gi;
  let m: RegExpExecArray | null;
  while ((m = tpvtPattern.exec(text)) !== null) {
    articles.add(`Tpvt. ${m[1]}. §`);
  }

  // EUMSZ / EUMSz articles: "EUMSZ 101. cikk", "EUMSz 102. cikk"
  const eumszPattern = /EUMSz?\s*(\d+)\.\s*cikk/gi;
  while ((m = eumszPattern.exec(text)) !== null) {
    articles.add(`EUMSZ ${m[1]}. cikk`);
  }

  // Fttv. (unfair commercial practices act)
  const fttvPattern = /Fttv\.\s*(\d+)\.\s*§/gi;
  while ((m = fttvPattern.exec(text)) !== null) {
    articles.add(`Fttv. ${m[1]}. §`);
  }

  if (articles.size === 0) return null;
  return Array.from(articles).join(", ");
}

/**
 * Detect sector from text content using Hungarian keywords.
 */
function detectSector(text: string): string | null {
  const lower = text.toLowerCase();
  const sectorMap: [string, string[]][] = [
    ["energy", ["energia", "villamos", "földgáz", "gáz", "áram", "megújuló"]],
    ["telecommunications", ["telekommunikáci", "távközl", "mobil", "internet", "szélessáv"]],
    ["banking", ["bank", "pénzintézet", "hitel", "jelzálog", "pénzügyi"]],
    ["insurance", ["biztosít", "biztosítás"]],
    ["pharmaceuticals", ["gyógyszer", "patika", "orvos", "egészségügy"]],
    ["retail", ["kiskereskedel", "élelmiszer", "üzletlánc", "szupermarket", "bolt"]],
    ["construction", ["építőanyag", "építési", "ingatlan", "lakás"]],
    ["agriculture", ["mezőgazdaság", "agrár", "termőföld", "élelmiszer-termel"]],
    ["media", ["média", "televízió", "rádió", "sajtó", "kiadó"]],
    ["transport", ["közlekedés", "fuvarozás", "logisztika", "szállítás", "vasút", "légi"]],
    ["digital", ["digitális", "platform", "online", "e-kereskedel", "piactér"]],
    ["automotive", ["autó", "gépjármű", "járműgyárt"]],
    ["waste", ["hulladék", "szemét", "újrahasznosít"]],
    ["water", ["víz", "vízszolgáltat", "csatorna", "szennyvíz"]],
  ];

  for (const [sector, keywords] of sectorMap) {
    for (const kw of keywords) {
      if (lower.includes(kw)) return sector;
    }
  }
  return null;
}

/**
 * Parse a GVH decision detail page into structured data.
 *
 * The HTML structure varies, but typically contains:
 *   - A heading with the case number and/or title
 *   - Metadata block (date, parties, case number)
 *   - Decision body text
 */
function parseDecisionPage(html: string, entry: DiscoveredEntry): ParsedDecision | null {
  const $ = cheerio.load(html);

  // Remove script/style/nav/footer elements
  $("script, style, nav, footer, header, .cookie-notice, .navigation, #hamburger-nav").remove();

  // Extract the main content area
  const mainContent = $("#main-section, .journal-content-article, .asset-content, article, main, .portlet-body")
    .first();
  const contentHtml = mainContent.length > 0 ? mainContent : $("body");
  const fullText = contentHtml.text().replace(/\s+/g, " ").trim();

  if (fullText.length < 100) {
    // Too little content — page likely didn't render server-side
    return null;
  }

  // Try to extract title from headings
  let title = "";
  const h1 = $("h1").first().text().trim();
  const h2 = $("h2").first().text().trim();
  const h3 = $("h3").first().text().trim();
  title = h1 || h2 || h3 || entry.linkText || entry.caseNumber;

  // Extract date: look for patterns like "2024. március 15." or "2024.03.15" or "Budapest, 2024..."
  let date: string | null = null;
  const datePatterns = [
    // "2024. március 15." — Hungarian long date
    /(\d{4})\.\s*(január|február|március|április|május|június|július|augusztus|szeptember|október|november|december)\s*(\d{1,2})\./i,
    // "2024.03.15" or "2024-03-15"
    /(\d{4})[.\-/](\d{2})[.\-/](\d{2})/,
    // "Budapest, 2024. ..." at start of decision
    /Budapest,\s*(\d{4})\.\s*(január|február|március|április|május|június|július|augusztus|szeptember|október|november|december)\s*(\d{1,2})/i,
  ];

  const monthMap: Record<string, string> = {
    január: "01", február: "02", március: "03", április: "04",
    május: "05", június: "06", július: "07", augusztus: "08",
    szeptember: "09", október: "10", november: "11", december: "12",
  };

  for (const pattern of datePatterns) {
    const dm = fullText.match(pattern);
    if (dm) {
      if (dm[2] && monthMap[dm[2]!.toLowerCase()]) {
        // Hungarian long date
        const month = monthMap[dm[2]!.toLowerCase()]!;
        const day = dm[3]!.padStart(2, "0");
        date = `${dm[1]}-${month}-${day}`;
      } else if (dm[1] && dm[2] && dm[3]) {
        date = `${dm[1]}-${dm[2]}-${dm[3]}`;
      }
      break;
    }
  }

  // Extract parties: look for "eljárás alá vont" (respondent) patterns
  let parties: string | null = null;
  const partyPatterns = [
    /eljárás alá vont(?:ak?)?\s*:\s*([^.]+)/i,
    /eljárás alá vont(?:ak?)?\s+([A-ZÁÉÍÓÖŐÚÜŰ][\wÁÉÍÓÖŐÚÜŰáéíóöőúüű\s.,;-]+(?:Kft\.|Zrt\.|Bt\.|Nyrt\.|Kkt\.|e\.v\.))/i,
    /(?:kérelmező|bejelentő)\s*:\s*([^.]+)/i,
  ];
  for (const pattern of partyPatterns) {
    const pm = fullText.match(pattern);
    if (pm) {
      parties = pm[1]!.trim().replace(/\s+/g, " ").substring(0, 500);
      break;
    }
  }

  // Build summary: first 500 characters of substantive content
  let summary: string | null = null;
  // Try to find a "rendelkező rész" (operative part) or start of reasoning
  const opPartMatch = fullText.match(/(?:rendelkező\s+rész|HATÁROZAT|határozat)/i);
  if (opPartMatch && opPartMatch.index !== undefined) {
    const afterOp = fullText.substring(opPartMatch.index, opPartMatch.index + 600);
    summary = afterOp.substring(0, 500).trim();
  }
  if (!summary || summary.length < 50) {
    summary = fullText.substring(0, 500).trim();
  }

  const type = classifyCaseType(fullText);
  const outcome = classifyOutcome(fullText);
  const fineAmount = extractFineAmount(fullText);
  const competitionArticles = extractArticles(fullText);
  const sector = detectSector(fullText);

  // Determine status
  let status = "final";
  if (fullText.toLowerCase().includes("folyamatban") || fullText.toLowerCase().includes("vizsgálat alatt")) {
    status = "ongoing";
  }

  return {
    caseNumber: entry.caseNumber,
    title: title.substring(0, 500),
    date,
    type,
    sector,
    parties,
    summary,
    fullText,
    outcome,
    fineAmount,
    competitionArticles,
    status,
  };
}

/**
 * Parse a merger detail page.
 */
function parseMergerPage(html: string, entry: DiscoveredEntry): ParsedMerger | null {
  const $ = cheerio.load(html);

  $("script, style, nav, footer, header, .cookie-notice, .navigation, #hamburger-nav").remove();

  const mainContent = $("#main-section, .journal-content-article, .asset-content, article, main, .portlet-body")
    .first();
  const contentHtml = mainContent.length > 0 ? mainContent : $("body");
  const fullText = contentHtml.text().replace(/\s+/g, " ").trim();

  if (fullText.length < 100) return null;

  let title = "";
  const h1 = $("h1").first().text().trim();
  const h2 = $("h2").first().text().trim();
  title = h1 || h2 || entry.linkText || entry.caseNumber;

  // Date extraction (same as decisions)
  let date: string | null = null;
  const monthMap: Record<string, string> = {
    január: "01", február: "02", március: "03", április: "04",
    május: "05", június: "06", július: "07", augusztus: "08",
    szeptember: "09", október: "10", november: "11", december: "12",
  };
  const dateMatch = fullText.match(
    /(\d{4})\.\s*(január|február|március|április|május|június|július|augusztus|szeptember|október|november|december)\s*(\d{1,2})\./i,
  ) ?? fullText.match(/(\d{4})[.\-/](\d{2})[.\-/](\d{2})/);
  if (dateMatch) {
    if (dateMatch[2] && monthMap[dateMatch[2]!.toLowerCase()]) {
      const month = monthMap[dateMatch[2]!.toLowerCase()]!;
      const day = dateMatch[3]!.padStart(2, "0");
      date = `${dateMatch[1]}-${month}-${day}`;
    } else if (dateMatch[1] && dateMatch[2] && dateMatch[3]) {
      date = `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`;
    }
  }

  // Extract acquiring party and target
  let acquiringParty: string | null = null;
  let target: string | null = null;

  // Patterns: "X megszerzi Y feletti irányítást"
  const mergerPartyMatch = fullText.match(
    /([A-ZÁÉÍÓÖŐÚÜŰ][\wÁÉÍÓÖŐÚÜŰáéíóöőúüű\s.,'-]+(?:Kft\.|Zrt\.|Bt\.|Nyrt\.|Kkt\.|Ltd\.|GmbH|s\.r\.o\.))\s+(?:megszerz|irányítás|felvásárol)/i,
  );
  if (mergerPartyMatch) {
    acquiringParty = mergerPartyMatch[1]!.trim().substring(0, 300);
  }

  const targetMatch = fullText.match(
    /(?:irányítást|kontrollt)\s+(?:a|az)\s+([A-ZÁÉÍÓÖŐÚÜŰ][\wÁÉÍÓÖŐÚÜŰáéíóöőúüű\s.,'-]+(?:Kft\.|Zrt\.|Bt\.|Nyrt\.|Kkt\.|Ltd\.|GmbH|s\.r\.o\.))/i,
  );
  if (targetMatch) {
    target = targetMatch[1]!.trim().substring(0, 300);
  }

  // If no specific parties found, try generic extraction
  if (!acquiringParty) {
    const genericPartyMatch = fullText.match(
      /(?:kérelmező|bejelentő)\s*:\s*([^\n.]+)/i,
    );
    if (genericPartyMatch) {
      acquiringParty = genericPartyMatch[1]!.trim().substring(0, 300);
    }
  }

  const sector = detectSector(fullText);
  const outcome = classifyOutcome(fullText);

  // Summary
  let summary: string | null = fullText.substring(0, 500).trim();
  if (summary.length < 50) summary = null;

  // Turnover: look for "árbevétel" or "nettó árbevétel" figures
  let turnover: number | null = null;
  const turnoverMatch = fullText.match(
    /(?:nettó\s+)?árbevétel[^.]*?(\d{1,3}(?:[.\s]\d{3})*)\s*(?:millió|milliárd)?\s*(?:Ft|forint|HUF)/i,
  );
  if (turnoverMatch) {
    const raw = turnoverMatch[1]!.replace(/[.\s]/g, "");
    const val = parseInt(raw, 10);
    const fullMatchLower = turnoverMatch[0]!.toLowerCase();
    if (fullMatchLower.includes("milliárd")) {
      turnover = val * 1_000_000_000;
    } else if (fullMatchLower.includes("millió")) {
      turnover = val * 1_000_000;
    } else {
      turnover = val;
    }
  }

  return {
    caseNumber: entry.caseNumber,
    title: title.substring(0, 500),
    date,
    sector,
    acquiringParty,
    target,
    summary,
    fullText,
    outcome,
    turnover,
  };
}

// ---------------------------------------------------------------------------
// Phase 2 orchestration
// ---------------------------------------------------------------------------

async function ingestEntries(
  entries: DiscoveredEntry[],
  db: Database.Database,
  args: CliArgs,
): Promise<void> {
  console.log("\n  Phase 2: Content ingestion");
  console.log("  ─────────────────────────────────────────────\n");

  const insertDecision = db.prepare(`
    INSERT OR REPLACE INTO decisions
      (case_number, title, date, type, sector, parties, summary, full_text,
       outcome, fine_amount, competition_articles, status)
    VALUES
      (@caseNumber, @title, @date, @type, @sector, @parties, @summary, @fullText,
       @outcome, @fineAmount, @competitionArticles, @status)
  `);

  const insertMerger = db.prepare(`
    INSERT OR REPLACE INTO mergers
      (case_number, title, date, sector, acquiring_party, target, summary,
       full_text, outcome, turnover)
    VALUES
      (@caseNumber, @title, @date, @sector, @acquiringParty, @target, @summary,
       @fullText, @outcome, @turnover)
  `);

  // Build set of existing case numbers for --resume
  const existingDecisions = new Set<string>();
  const existingMergers = new Set<string>();
  if (args.resume) {
    const dRows = db.prepare("SELECT case_number FROM decisions").all() as { case_number: string }[];
    for (const r of dRows) existingDecisions.add(r.case_number);

    const mRows = db.prepare("SELECT case_number FROM mergers").all() as { case_number: string }[];
    for (const r of mRows) existingMergers.add(r.case_number);

    console.log(`    Resume mode: ${existingDecisions.size} decisions, ${existingMergers.size} mergers already in DB`);
  }

  let decisionsIngested = 0;
  let mergersIngested = 0;
  let skipped = 0;
  let failed = 0;
  let processed = 0;

  const toProcess = args.limit ? entries.slice(0, args.limit) : entries;

  for (const entry of toProcess) {
    processed++;

    // Resume: skip if already in DB
    if (args.resume) {
      const existing = entry.kind === "decision" ? existingDecisions : existingMergers;
      if (existing.has(entry.caseNumber)) {
        skipped++;
        continue;
      }
    }

    const { status, body } = await fetchWithRetry(entry.url);
    if (status === 0 || status === 404) {
      failed++;
      continue;
    }

    if (args.dryRun) {
      console.log(`    [DRY-RUN] Would ingest: ${entry.caseNumber} (${entry.kind})`);
      continue;
    }

    if (entry.kind === "decision") {
      const parsed = parseDecisionPage(body, entry);
      if (parsed) {
        insertDecision.run(parsed);
        decisionsIngested++;
      } else {
        failed++;
      }
    } else {
      const parsed = parseMergerPage(body, entry);
      if (parsed) {
        insertMerger.run(parsed);
        mergersIngested++;
      } else {
        failed++;
      }
    }

    if (processed % 25 === 0) {
      console.log(
        `    Progress: ${processed}/${toProcess.length} ` +
          `(${decisionsIngested} decisions, ${mergersIngested} mergers, ` +
          `${skipped} skipped, ${failed} failed)`,
      );
    }
  }

  console.log("\n  ─────────────────────────────────────────────");
  console.log(`    Decisions ingested: ${decisionsIngested}`);
  console.log(`    Mergers ingested:   ${mergersIngested}`);
  console.log(`    Skipped (resume):   ${skipped}`);
  console.log(`    Failed / empty:     ${failed}`);
  console.log(`    Total processed:    ${processed}`);
  console.log("  ─────────────────────────────────────────────\n");
}

// ---------------------------------------------------------------------------
// Sector table maintenance
// ---------------------------------------------------------------------------

function updateSectorCounts(db: Database.Database): void {
  // Collect sectors from decisions and mergers
  const decisionSectors = db
    .prepare("SELECT sector, COUNT(*) as cnt FROM decisions WHERE sector IS NOT NULL GROUP BY sector")
    .all() as { sector: string; cnt: number }[];
  const mergerSectors = db
    .prepare("SELECT sector, COUNT(*) as cnt FROM mergers WHERE sector IS NOT NULL GROUP BY sector")
    .all() as { sector: string; cnt: number }[];

  const sectorData = new Map<string, { decisions: number; mergers: number }>();
  for (const row of decisionSectors) {
    const existing = sectorData.get(row.sector) ?? { decisions: 0, mergers: 0 };
    existing.decisions = row.cnt;
    sectorData.set(row.sector, existing);
  }
  for (const row of mergerSectors) {
    const existing = sectorData.get(row.sector) ?? { decisions: 0, mergers: 0 };
    existing.mergers = row.cnt;
    sectorData.set(row.sector, existing);
  }

  // English names for sectors
  const sectorNames: Record<string, { hu: string; en: string }> = {
    energy: { hu: "Energiaipar", en: "Energy" },
    telecommunications: { hu: "Távközlés", en: "Telecommunications" },
    banking: { hu: "Bankszolgáltatások", en: "Banking" },
    insurance: { hu: "Biztosítás", en: "Insurance" },
    pharmaceuticals: { hu: "Gyógyszeripar", en: "Pharmaceuticals" },
    retail: { hu: "Kiskereskedelem", en: "Retail" },
    construction: { hu: "Építőipar", en: "Construction" },
    agriculture: { hu: "Mezőgazdaság", en: "Agriculture" },
    media: { hu: "Média", en: "Media" },
    transport: { hu: "Közlekedés", en: "Transport" },
    digital: { hu: "Digitális piacok", en: "Digital markets" },
    automotive: { hu: "Autóipar", en: "Automotive" },
    waste: { hu: "Hulladékgazdálkodás", en: "Waste management" },
    water: { hu: "Vízszolgáltatás", en: "Water services" },
  };

  const upsert = db.prepare(`
    INSERT INTO sectors (id, name, name_en, description, decision_count, merger_count)
    VALUES (@id, @name, @nameEn, @description, @decisionCount, @mergerCount)
    ON CONFLICT(id) DO UPDATE SET
      decision_count = @decisionCount,
      merger_count = @mergerCount
  `);

  for (const [id, counts] of sectorData) {
    const names = sectorNames[id] ?? { hu: id, en: id };
    upsert.run({
      id,
      name: names.hu,
      nameEn: names.en,
      description: null,
      decisionCount: counts.decisions,
      mergerCount: counts.mergers,
    });
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function fatal(msg: string): never {
  console.error(`Error: ${msg}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const args = parseArgs();

  console.log("╔═══════════════════════════════════════════════════════╗");
  console.log("║  GVH Ingestion Crawler                               ║");
  console.log("║  Gazdasági Versenyhivatal — gvh.hu                    ║");
  console.log("╚═══════════════════════════════════════════════════════╝");
  console.log();

  if (args.dryRun) console.log("  Mode: DRY RUN (no DB writes)");
  if (args.resume) console.log("  Mode: RESUME (skip existing)");
  if (args.force) console.log("  Mode: FORCE (recreate DB)");
  console.log(`  Years: ${args.yearFrom}–${args.yearTo}`);
  if (args.limit) console.log(`  Limit: ${args.limit} entries`);
  console.log(`  Rate limit: ${RATE_LIMIT_MS}ms between requests`);
  console.log(`  DB path: ${DB_PATH}`);

  // Initialise database
  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  if (args.force && existsSync(DB_PATH)) {
    unlinkSync(DB_PATH);
    console.log(`  Deleted existing DB: ${DB_PATH}`);
  }

  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);

  // Phase 1: Discovery
  const entries = await discoverEntries(args);

  if (entries.length === 0) {
    console.log("  No entries discovered. The GVH site may be blocking requests");
    console.log("  or the SPA content is not server-rendered.");
    console.log("  Try running with --year-from and --year-to for specific years.\n");
    db.close();
    return;
  }

  // Phase 2: Content ingestion
  if (!args.dryRun) {
    const ingestTx = db.transaction(() => {
      // We do not wrap the full loop in a transaction because it includes
      // network I/O. Instead we rely on WAL mode for concurrent writes.
    });
    ingestTx();
  }

  await ingestEntries(entries, db, args);

  // Update sector counts
  if (!args.dryRun) {
    updateSectorCounts(db);
    const dCount = (db.prepare("SELECT COUNT(*) as c FROM decisions").get() as { c: number }).c;
    const mCount = (db.prepare("SELECT COUNT(*) as c FROM mergers").get() as { c: number }).c;
    const sCount = (db.prepare("SELECT COUNT(*) as c FROM sectors").get() as { c: number }).c;

    console.log("  Final DB state:");
    console.log(`    Decisions: ${dCount}`);
    console.log(`    Mergers:   ${mCount}`);
    console.log(`    Sectors:   ${sCount}`);
  }

  db.close();
  console.log("\n  Done.\n");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
