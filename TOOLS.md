# Tool Reference

All tools use the `hu_comp_` prefix.

## Search & Retrieval Tools

| Tool | Description |
|------|-------------|
| `hu_comp_search_decisions` | Full-text search across GVH competition enforcement decisions |
| `hu_comp_get_decision` | Get a specific GVH decision by case number |
| `hu_comp_search_mergers` | Search GVH merger control decisions |
| `hu_comp_get_merger` | Get a specific merger decision by case number |
| `hu_comp_list_sectors` | List all sectors with GVH enforcement activity |

## Meta Tools

| Tool | Description |
|------|-------------|
| `hu_comp_list_sources` | List data sources, coverage, and update schedule |
| `hu_comp_check_data_freshness` | Check when data was last ingested |
| `hu_comp_about` | Return server version, description, and tool list |

---

## hu_comp_search_decisions

Full-text search across GVH competition enforcement decisions.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | yes | Search query (e.g., `'kartell'`, `'erőfölény'`) |
| `type` | enum | no | `abuse_of_dominance` \| `cartel` \| `sector_inquiry` \| `unfair_commercial_practice` |
| `sector` | string | no | Industry sector filter (e.g., `'energy'`, `'telecommunications'`) |
| `outcome` | enum | no | `infringement` \| `commitment` \| `no_infringement` \| `fine` |
| `limit` | number | no | Maximum results (default 20, max 100) |

---

## hu_comp_get_decision

Get a specific GVH competition decision by case number.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `case_number` | string | yes | GVH case number (e.g., `'Vj/001/2024'`) |

**Response includes `_citation`** for deterministic entity linking.

---

## hu_comp_search_mergers

Search GVH merger control decisions.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | yes | Search query (e.g., `'összefonódás'`, `'felvásárlás'`) |
| `sector` | string | no | Industry sector filter |
| `outcome` | enum | no | `cleared` \| `cleared_with_conditions` \| `blocked` \| `withdrawn` |
| `limit` | number | no | Maximum results (default 20, max 100) |

---

## hu_comp_get_merger

Get a specific GVH merger decision by case number.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `case_number` | string | yes | GVH merger case number (e.g., `'Vj/M/10/2024'`) |

**Response includes `_citation`** for deterministic entity linking.

---

## hu_comp_list_sectors

List all industry sectors with GVH enforcement activity. No parameters required.

---

## hu_comp_list_sources

List data sources used by this MCP. No parameters required.

---

## hu_comp_check_data_freshness

Check when data was last ingested. No parameters required.

---

## hu_comp_about

Return server metadata. No parameters required.

---

## Common Response Fields

All responses include a `_meta` block:

```json
{
  "_meta": {
    "disclaimer": "...",
    "data_age": "2024-12-31",
    "copyright": "© GVH..."
  }
}
```

Error responses include `_error_type`:

```json
{
  "error": "Decision not found: Vj/999/2024",
  "_meta": { ... },
  "_error_type": "not_found"
}
```

`_error_type` values: `not_found`, `tool_error`, `unknown_tool`
