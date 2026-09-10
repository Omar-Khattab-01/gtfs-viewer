export type IssueSeverity = "error" | "warning";

export type GtfsIssue = {
  id: string;
  severity: IssueSeverity;
  scope: "feed" | "file";
  file?: string;
  row?: number;
  column?: string;
  emptyValue?: boolean;
  wholeColumn?: boolean;
  title: string;
  detail: string;
};

export type TableAccessor = {
  columns: string[];
  rowCount: number;
  getRow: (index: number) => string[];
};

const FILE_RULES: Record<string, { required: string[]; key?: string[] }> = {
  "agency.txt": { required: ["agency_name", "agency_url", "agency_timezone"] },
  "stops.txt": { required: ["stop_id"], key: ["stop_id"] },
  "routes.txt": { required: ["route_id", "route_type"], key: ["route_id"] },
  "trips.txt": { required: ["route_id", "service_id", "trip_id"], key: ["trip_id"] },
  "stop_times.txt": { required: ["trip_id", "stop_sequence"], key: ["trip_id", "stop_sequence"] },
  "calendar.txt": { required: ["service_id", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "start_date", "end_date"], key: ["service_id"] },
  "calendar_dates.txt": { required: ["service_id", "date", "exception_type"], key: ["service_id", "date"] },
  "shapes.txt": { required: ["shape_id", "shape_pt_lat", "shape_pt_lon", "shape_pt_sequence"], key: ["shape_id", "shape_pt_sequence"] },
  "frequencies.txt": { required: ["trip_id", "start_time", "end_time", "headway_secs"], key: ["trip_id", "start_time"] },
  "feed_info.txt": { required: ["feed_publisher_name", "feed_publisher_url", "feed_lang"] },
};

const VALID_ROUTE_TYPES = new Set(["0", "1", "2", "3", "4", "5", "6", "7", "11", "12"]);
const TIME_PATTERN = /^\d{2,3}:[0-5]\d:[0-5]\d$/;
const DATE_PATTERN = /^\d{8}$/;
const HEX_PATTERN = /^[0-9A-Fa-f]{6}$/;
const NON_NEGATIVE_INTEGER = /^\d+$/;

function makeIssue(overrides: Omit<GtfsIssue, "id">): GtfsIssue {
  return { id: `${overrides.scope}-${overrides.file || "feed"}-${overrides.title}-${overrides.row || 0}`, ...overrides };
}

export function checkFeedStructure(entryNames: string[]): GtfsIssue[] {
  const normalized = entryNames.map((name) => name.replace(/^\.\//, ""));
  const rootNames = new Set(normalized.filter((name) => !name.includes("/")).map((name) => name.toLowerCase()));
  const issues: GtfsIssue[] = [];

  for (const requiredFile of ["agency.txt", "routes.txt", "trips.txt", "stop_times.txt"]) {
    if (!rootNames.has(requiredFile)) {
      issues.push(makeIssue({ severity: "error", scope: "feed", title: `Missing ${requiredFile}`, detail: "This file is required in a GTFS Schedule feed." }));
    }
  }

  if (!rootNames.has("stops.txt") && !rootNames.has("locations.geojson")) {
    issues.push(makeIssue({ severity: "error", scope: "feed", title: "Missing stops.txt", detail: "A feed needs stops.txt unless demand-responsive locations are defined in locations.geojson." }));
  }

  if (!rootNames.has("calendar.txt") && !rootNames.has("calendar_dates.txt")) {
    issues.push(makeIssue({ severity: "error", scope: "feed", title: "No service calendar", detail: "Include calendar.txt, calendar_dates.txt, or both to define service dates." }));
  }

  const nestedFiles = normalized.filter((name) => name.includes("/") && /\.(txt|csv|geojson)$/i.test(name));
  if (nestedFiles.length) {
    issues.push(makeIssue({ severity: "warning", scope: "feed", title: "Files are inside a folder", detail: `${nestedFiles.length} feed ${nestedFiles.length === 1 ? "file is" : "files are"} not at the ZIP root.` }));
  }

  return issues;
}

function validDate(value: string) {
  if (!DATE_PATTERN.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export async function checkTable(
  fileName: string,
  table: TableAccessor,
  maxRows = 50_000,
  onProgress?: (completedRows: number, totalRows: number) => void,
): Promise<GtfsIssue[]> {
  const normalizedName = fileName.toLowerCase();
  const rules = FILE_RULES[normalizedName];
  if (!rules) return [];

  const issues: GtfsIssue[] = [];
  const columnIndex = new Map(table.columns.map((column, index) => [column, index]));
  const requiredColumns = new Set(rules.required);
  const optionalColumns = table.columns.filter((column) => !requiredColumns.has(column));
  const missingColumns = rules.required.filter((column) => !columnIndex.has(column));
  for (const column of missingColumns) {
    issues.push(makeIssue({ severity: "error", scope: "file", file: fileName, column, title: `Missing ${column}`, detail: `${fileName} requires a ${column} column.` }));
  }
  if (missingColumns.length) return issues;

  const checkedRows = Math.min(table.rowCount, maxRows);
  const counts = new Map<string, { count: number; row: number; column?: string; emptyColumn?: string; severity: IssueSeverity; title: string; detail: string }>();
  const keys = new Set<string>();
  let previousGroup = "";
  let previousSequence = -1;
  let previousDistance: number | null = null;

  const record = (key: string, row: number, severity: IssueSeverity, title: string, detail: string, column?: string, emptyColumn?: string) => {
    const current = counts.get(key);
    if (current) current.count++;
    else counts.set(key, { count: 1, row, column, emptyColumn, severity, title, detail });
  };

  for (let rowIndex = 0; rowIndex < checkedRows; rowIndex++) {
    const row = table.getRow(rowIndex);
    const value = (column: string) => row[columnIndex.get(column) ?? -1]?.trim() || "";
    const displayRow = rowIndex + 2;

    for (const required of rules.required) {
      if (!value(required)) record(`blank-${required}`, displayRow, "error", `Blank ${required}`, `Required values are empty in {count} ${checkedRows < table.rowCount ? "checked " : ""}rows.`, required, required);
    }
    for (const optional of optionalColumns) {
      if (!value(optional)) record(`blank-optional-${optional}`, displayRow, "warning", `Empty optional field: ${optional}`, `The ${optional} field is empty in {count} of ${checkedRows.toLocaleString()} ${checkedRows < table.rowCount ? "checked " : ""}rows.`, optional, optional);
    }

    // The two largest GTFS tables are ordered by their composite sequence keys;
    // their duplicate sequences are caught below without retaining millions of strings.
    if (rules.key && normalizedName !== "stop_times.txt" && normalizedName !== "shapes.txt") {
      const keyValue = rules.key.map(value).join("\u0000");
      if (keyValue && !keyValue.includes("\u0000\u0000")) {
        if (keys.has(keyValue)) record("duplicate-key", displayRow, "error", "Duplicate primary key", `The file contains {count} repeated ${rules.key.join(" + ")} values.`);
        else keys.add(keyValue);
      }
    }

    for (const column of ["stop_lat", "shape_pt_lat"]) {
      const raw = value(column);
      if (raw && (!Number.isFinite(Number(raw)) || Number(raw) < -90 || Number(raw) > 90)) record(`invalid-${column}`, displayRow, "error", `Invalid ${column}`, `{count} values fall outside the latitude range of -90 to 90.`, column);
    }
    for (const column of ["stop_lon", "shape_pt_lon"]) {
      const raw = value(column);
      if (raw && (!Number.isFinite(Number(raw)) || Number(raw) < -180 || Number(raw) > 180)) record(`invalid-${column}`, displayRow, "error", `Invalid ${column}`, `{count} values fall outside the longitude range of -180 to 180.`, column);
    }

    if (normalizedName === "routes.txt") {
      if (value("route_type") && !VALID_ROUTE_TYPES.has(value("route_type"))) record("route-type", displayRow, "error", "Unknown route_type", "{count} routes use a route_type outside the GTFS core values.", "route_type");
      if (!value("route_short_name") && !value("route_long_name")) record("route-name", displayRow, "error", "Route has no name", "{count} routes have neither route_short_name nor route_long_name.");
      for (const colorColumn of ["route_color", "route_text_color"]) {
        if (value(colorColumn) && !HEX_PATTERN.test(value(colorColumn))) record(`color-${colorColumn}`, displayRow, "warning", `Invalid ${colorColumn}`, `{count} values are not six-character hexadecimal colours.`, colorColumn);
      }
    }

    for (const timeColumn of ["arrival_time", "departure_time", "start_time", "end_time"]) {
      if (value(timeColumn) && !TIME_PATTERN.test(value(timeColumn))) record(`time-${timeColumn}`, displayRow, "error", `Invalid ${timeColumn}`, `{count} values do not use HH:MM:SS format.`, timeColumn);
    }
    for (const dateColumn of ["date", "start_date", "end_date"]) {
      if (value(dateColumn) && !validDate(value(dateColumn))) record(`date-${dateColumn}`, displayRow, "error", `Invalid ${dateColumn}`, `{count} values are not valid YYYYMMDD dates.`, dateColumn);
    }
    for (const sequenceColumn of ["stop_sequence", "shape_pt_sequence"]) {
      if (value(sequenceColumn) && !NON_NEGATIVE_INTEGER.test(value(sequenceColumn))) record(`sequence-${sequenceColumn}`, displayRow, "error", `Invalid ${sequenceColumn}`, `{count} values are not non-negative integers.`, sequenceColumn);
    }

    const groupColumn = normalizedName === "stop_times.txt" ? "trip_id" : normalizedName === "shapes.txt" ? "shape_id" : "";
    const sequenceColumn = normalizedName === "stop_times.txt" ? "stop_sequence" : normalizedName === "shapes.txt" ? "shape_pt_sequence" : "";
    if (groupColumn && sequenceColumn && NON_NEGATIVE_INTEGER.test(value(sequenceColumn))) {
      const group = value(groupColumn);
      const sequence = Number(value(sequenceColumn));
      if (group !== previousGroup) previousDistance = null;
      if (group === previousGroup && sequence <= previousSequence) record("sequence-order", displayRow, "error", "Sequence does not increase", `{count} rows do not increase within their ${groupColumn}.`, sequenceColumn);
      const rawDistance = value("shape_dist_traveled");
      if (rawDistance) {
        const distance = Number(rawDistance);
        if (!Number.isFinite(distance) || distance < 0) {
          record("invalid-shape-distance", displayRow, "error", "Invalid shape_dist_traveled", "{count} values are not non-negative numbers.", "shape_dist_traveled");
        } else {
          if (group === previousGroup && previousDistance !== null && distance <= previousDistance) record("shape-distance-order", displayRow, "error", "shape_dist_traveled does not increase", `{count} rows have a distance equal to or below the previous distance within their ${groupColumn}.`, "shape_dist_traveled");
          previousDistance = distance;
        }
      }
      previousGroup = group;
      previousSequence = sequence;
    }

    if ((rowIndex + 1) % 2_000 === 0) {
      onProgress?.(rowIndex + 1, checkedRows);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  onProgress?.(checkedRows, checkedRows);

  for (const item of counts.values()) {
    issues.push(makeIssue({ severity: item.severity, scope: "file", file: fileName, row: item.row, column: item.column, emptyValue: Boolean(item.emptyColumn), wholeColumn: Boolean(item.emptyColumn) && item.count === checkedRows, title: item.title, detail: item.detail.replace("{count}", item.count.toLocaleString()) }));
  }

  if (checkedRows < table.rowCount) {
    issues.push(makeIssue({ severity: "warning", scope: "file", file: fileName, title: "Large file sampled", detail: `Checks covered the first ${checkedRows.toLocaleString()} of ${table.rowCount.toLocaleString()} rows to keep the browser responsive.` }));
  }

  return issues;
}
