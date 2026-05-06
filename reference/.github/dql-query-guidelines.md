# DQL Query Structure Guidelines

All DQL queries in this application should follow a consistent structure with clearly defined sections.

## Query Sections

```dql
// FETCH
fetch logs, ...

// PRE FILTER
| filter ...

// MODIFY
| parse, fieldsAdd, joins...

// POST FILTER
| filter ...

// AGGREGATE
| summarize, makeTimeseries, ...
```

### 1. FETCH
The data source declaration.
- `fetch logs`, `fetch spans`, `fetch metrics`, etc.

### 2. PRE FILTER
**Performance-critical filters** applied before data transformation.
- These filters are pushed down to the storage layer
- Use for filtering on indexed fields (e.g., `dt.system.bucket`, `log.source`, `timestamp`)
- Always place the most selective filters here

### 3. MODIFY
Data transformation operations.
- `parse` - Extract fields from strings
- `fieldsAdd` - Add computed fields
- `fieldsRemove` - Remove unnecessary fields
- `join` - Combine with other data sources
- `lookup` - Enrich with reference data

### 4. POST FILTER
Filters applied **after** data transformation.
- These are **NOT performance-effective** (executed in-memory)
- Use only for filtering on computed/parsed fields that don't exist in raw data
- Minimize usage when possible

### 5. AGGREGATE
Final aggregation and shaping.
- `summarize` - Group and aggregate
- `makeTimeseries` - Create time-based series
- `sort` - Order results
- `limit` - Restrict result count

## Performance Best Practices

1. **Maximize PRE FILTER usage** - Move as many filters as possible before MODIFY
2. **Minimize POST FILTER** - Only filter on derived fields when absolutely necessary
3. **Filter early, transform late** - Reduce data volume before expensive operations
4. **Use indexed fields in PRE FILTER** - `timestamp`, `dt.system.bucket`, entity IDs
5. **Pre-filter with `contains()` for parsed field filters** - See optimization trick below

### Optimization Trick: Pre-filter with `contains()`

When filtering on parsed/computed fields (which must be in POST FILTER), you can often add a redundant `contains()` check in PRE FILTER for significant performance gains.

**Why it works:** The `contains()` on the raw field is pushed to storage and eliminates most non-matching records *before* the expensive parse operation runs.

```dql
// PRE FILTER
| filter contains(content, "E001")  // Fast: eliminates most records early

// MODIFY
| parse content, "JSON:parsed"
| fieldsAdd errorCode = parsed[errorCode]

// POST FILTER
| filter errorCode == "E001"  // Precise: ensures exact match on parsed value
```

**When to use:**
- Filtering on values extracted via `parse`
- Filtering on JSON fields
- Any case where the filter value appears as a substring in the raw data

## Example

```dql
// FETCH
fetch logs

// PRE FILTER
| filter dt.system.bucket == "default_logs"
| filter timestamp >= now() - 1h
| filter log.source == "my-service"
// pre-filter for performance (see optimization trick above)
| filter contains(content, "E001")

// MODIFY
| parse content, "JSON:parsed"
| fieldsAdd errorCode = parsed[errorCode]

// POST FILTER
| filter errorCode == "E001"

// AGGREGATE
| summarize count = count(), by: {errorCode}
| sort count desc
```