# Coverage

This MCP provides access to GVH (Gazdasági Versenyhivatal — Hungarian Competition Authority) public enforcement data.

## Data Sources

| Source | URL |
|--------|-----|
| GVH decisions | https://www.gvh.hu/ |
| GVH merger register | https://www.gvh.hu/ |

## Coverage

| Category | Types Covered |
|----------|---------------|
| Competition decisions | Abuse of dominance, cartel, unfair commercial practices, sector inquiries |
| Merger control | Cleared, cleared with conditions, blocked, withdrawn |
| Period | 2000 – present |
| Sectors | All sectors with GVH enforcement activity |

## Case Number Formats

| Format | Example | Category |
|--------|---------|----------|
| `Vj/NNN/YYYY` | `Vj/001/2024` | Competition enforcement decisions |
| `Vj/M/NN/YYYY` | `Vj/M/10/2024` | Merger control decisions |
| `ÖB-NNN/YYYY` | `ÖB-001/2024` | Merger notifications |

## Legal Basis

- **Competition enforcement**: Tpvt (1996. évi LVII. törvény a tisztességtelen piaci magatartás és a versenykorlátozás tilalmáról)
- **Merger control**: Tpvt Chapter VI (merger notification thresholds and review)

## Update Schedule

Data is ingested via `scripts/ingest-gvh.ts` on a weekly schedule (Sundays at 02:00 UTC).
The `GVH_DATA_AGE` environment variable reflects the last successful ingestion date.

## Machine-Readable Coverage

See [`data/coverage.json`](data/coverage.json) for the machine-readable version of this coverage document.
