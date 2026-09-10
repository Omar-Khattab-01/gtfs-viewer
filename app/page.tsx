"use client";

import { ChangeEvent, DragEvent, UIEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import JSZip from "jszip";
import Papa from "papaparse";
import { checkFeedStructure, checkTable, GtfsIssue } from "./gtfs-checks";

type FeedFile = {
  name: string;
  entryName?: string;
  size: number;
  rowCount: number | null;
  sampleColumns?: string[];
  sampleRows?: string[][];
};

type ActiveTable = {
  columns: string[];
  rowCount: number;
  getRow: (index: number) => string[];
};

type FeedSession = {
  id: string;
  name: string;
  status: string;
  files: FeedFile[];
  activeName: string;
  zip: JSZip;
  entryNames: string[];
  issues: GtfsIssue[];
  checkedFiles: string[];
  checkCompleted: boolean;
  showIssues: boolean;
};

const COLORS = ["#f2e6ff", "#dff5e8", "#fff0d8", "#dceeff", "#ffe3e3", "#e5f3f4", "#f3efd8", "#e8e6ff"];
const ACCENTS = ["#8e4ec6", "#2d8a59", "#c87619", "#3978b7", "#ca4a4a", "#27828a", "#907820", "#6656b8"];
const ROW_HEIGHT = 35;
const SEARCH_LIMIT = 25_000;
const MAX_SCROLL_HEIGHT = 8_000_000;

const sampleStopRows = Array.from({ length: 46 }, (_, index) => {
  const route = ["10", "20", "30", "40", "50"][index % 5];
  return [`STOP_${String(1001 + index).padStart(4, "0")}`, `${1001 + index}`, ["Central Station", "Main Street", "Riverside", "University", "North Terminal"][index % 5], (43.6501 + index * 0.0007).toFixed(6), (-79.3470 + index * 0.0009).toFixed(6), `Route ${route}`];
});

const SAMPLE: FeedFile[] = [
  { name: "agency.txt", size: 148, rowCount: 1, sampleColumns: ["agency_id", "agency_name", "agency_url", "agency_timezone"], sampleRows: [["CITY", "Example Transit", "https://example.com", "America/Toronto"]] },
  { name: "stops.txt", size: 48291, rowCount: sampleStopRows.length, sampleColumns: ["stop_id", "stop_code", "stop_name", "stop_lat", "stop_lon", "stop_desc"], sampleRows: sampleStopRows },
  { name: "routes.txt", size: 3812, rowCount: 4, sampleColumns: ["route_id", "agency_id", "route_short_name", "route_long_name", "route_type", "route_color"], sampleRows: [["10", "CITY", "10", "Central–Riverside", "3", "15603B"], ["20", "CITY", "20", "North Terminal–University", "3", "3978B7"], ["30", "CITY", "30", "Main Street–Central", "3", "C87619"], ["40", "CITY", "40", "Riverside–North Terminal", "3", "8E4EC6"]] },
  { name: "trips.txt", size: 892104, rowCount: 24, sampleColumns: ["route_id", "service_id", "trip_id", "trip_headsign", "direction_id", "shape_id"], sampleRows: Array.from({ length: 24 }, (_, index) => ["20", "WEEKDAY", `TRIP_20_${3100 + index}`, index % 2 ? "University" : "North Terminal", String(index % 2), `SHAPE_20_${index % 2}`]) },
  { name: "stop_times.txt", size: 6240, rowCount: 48, sampleColumns: ["trip_id", "arrival_time", "departure_time", "stop_id", "stop_sequence"], sampleRows: Array.from({ length: 48 }, (_, index) => [`TRIP_20_${3100 + Math.floor(index / 2)}`, `${String(7 + Math.floor(index / 12)).padStart(2, "0")}:${index % 2 ? "18" : "05"}:00`, `${String(7 + Math.floor(index / 12)).padStart(2, "0")}:${index % 2 ? "18" : "05"}:30`, `STOP_${String(1001 + (index % 46)).padStart(4, "0")}`, String((index % 2) + 1)]) },
  { name: "calendar.txt", size: 744, rowCount: 3, sampleColumns: ["service_id", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "start_date", "end_date"], sampleRows: [["WEEKDAY", "1", "1", "1", "1", "1", "0", "0", "20260801", "20261220"], ["SATURDAY", "0", "0", "0", "0", "0", "1", "0", "20260801", "20261220"], ["SUNDAY", "0", "0", "0", "0", "0", "0", "1", "20260801", "20261220"]] },
];

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function parseLine(line: string): string[] {
  return (Papa.parse<string[]>(line).data[0] || []).map((value) => String(value ?? ""));
}

function indexBytes(bytes: Uint8Array): Promise<{ bytes: Uint8Array; offsets: Uint32Array }> {
  const workerSource = `
    self.onmessage = function(event) {
      var buffer = event.data;
      var bytes = new Uint8Array(buffer);
      var lineCount = bytes.length ? 1 : 0;
      for (var i = 0; i < bytes.length; i++) if (bytes[i] === 10 && i + 1 < bytes.length) lineCount++;
      var offsets = new Uint32Array(lineCount + 1);
      var cursor = lineCount ? 1 : 0;
      for (var j = 0; j < bytes.length; j++) if (bytes[j] === 10 && j + 1 < bytes.length) offsets[cursor++] = j + 1;
      offsets[lineCount] = bytes.length;
      self.postMessage({ buffer: buffer, offsets: offsets.buffer }, [buffer, offsets.buffer]);
    };
  `;
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" }));
    const worker = new Worker(url);
    worker.onmessage = (event) => {
      worker.terminate();
      URL.revokeObjectURL(url);
      resolve({ bytes: new Uint8Array(event.data.buffer), offsets: new Uint32Array(event.data.offsets) });
    };
    worker.onerror = () => {
      worker.terminate();
      URL.revokeObjectURL(url);
      reject(new Error("Could not index file"));
    };
    worker.postMessage(bytes.buffer, [bytes.buffer]);
  });
}

function makeByteTable(bytes: Uint8Array, offsets: Uint32Array): ActiveTable {
  const decoder = new TextDecoder("utf-8");
  const readLine = (lineIndex: number) => {
    const start = offsets[lineIndex];
    let end = offsets[lineIndex + 1];
    if (end > start && bytes[end - 1] === 10) end--;
    if (end > start && bytes[end - 1] === 13) end--;
    return decoder.decode(bytes.subarray(start, end));
  };
  const columns = parseLine(readLine(0)).map((cell, index) => cell.replace(/^\uFEFF/, "").trim() || `column_${index + 1}`);
  const rowCount = Math.max(0, offsets.length - 2);
  return { columns, rowCount, getRow: (index) => {
    const values = parseLine(readLine(index + 1));
    return columns.map((_, cellIndex) => values[cellIndex] ?? "");
  } };
}

function tableFromSample(file: FeedFile): ActiveTable {
  const rows = file.sampleRows || [];
  return { columns: file.sampleColumns || [], rowCount: rows.length, getRow: (index) => rows[index] || [] };
}

export default function Home() {
  const [files, setFiles] = useState<FeedFile[]>(SAMPLE);
  const [feedName, setFeedName] = useState("Example transit feed");
  const [activeName, setActiveName] = useState("stops.txt");
  const [activeTable, setActiveTable] = useState<ActiveTable>(() => tableFromSample(SAMPLE.find((file) => file.name === "stops.txt") || SAMPLE[0]));
  const [query, setQuery] = useState("");
  const [wrap, setWrap] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [status, setStatus] = useState("Example feed · choose a zip to inspect your own data");
  const [loadingFile, setLoadingFile] = useState<string | null>(null);
  const [fileError, setFileError] = useState("");
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(500);
  const [view, setView] = useState<"data" | "checks">("data");
  const [issues, setIssues] = useState<GtfsIssue[]>([]);
  const [checkedFiles, setCheckedFiles] = useState<Set<string>>(new Set());
  const [checkCompleted, setCheckCompleted] = useState(false);
  const [checkProgress, setCheckProgress] = useState({ running: false, fileIndex: 0, totalFiles: SAMPLE.length, fileName: "", completedRows: 0, totalRows: 0, overallPercent: 0 });
  const [showNextStep, setShowNextStep] = useState(false);
  const [focusIssue, setFocusIssue] = useState<GtfsIssue | null>(null);
  const [focusRow, setFocusRow] = useState<number | null>(null);
  const [feedTabs, setFeedTabs] = useState<Array<{ id: string; name: string }>>([]);
  const [activeFeedId, setActiveFeedId] = useState<string | null>(null);
  const [feedLimitMessage, setFeedLimitMessage] = useState("");
  const [showIssues, setShowIssues] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const tableFrameRef = useRef<HTMLDivElement>(null);
  const zipRef = useRef<JSZip | null>(null);
  const entryNamesRef = useRef<string[]>(SAMPLE.map((file) => file.name));
  const loadIdRef = useRef(0);
  const checkRunIdRef = useRef(0);
  const scrollFrameRef = useRef<number | null>(null);
  const feedSessionsRef = useRef<Map<string, FeedSession>>(new Map());

  const activeFile = files.find((file) => file.name === activeName) || files[0];
  const searchDisabled = activeTable.rowCount > SEARCH_LIMIT;
  const errorCount = issues.filter((issue) => issue.severity === "error").length;
  const warningCount = issues.filter((issue) => issue.severity === "warning").length;
  const issueCountByFile = useMemo(() => {
    const counts = new Map<string, number>();
    for (const issue of issues) if (issue.file) counts.set(issue.file, (counts.get(issue.file) || 0) + 1);
    return counts;
  }, [issues]);
  const activeFileIssues = useMemo(() => issues.filter((issue) => issue.file === activeName), [activeName, issues]);
  const selectedViewerIssue = useMemo(() => {
    if (!showIssues || activeFileIssues.length === 0) return null;
    return activeFileIssues.find((issue) => issue.id === focusIssue?.id) || activeFileIssues[0];
  }, [activeFileIssues, focusIssue, showIssues]);
  const selectedViewerIssueIndex = selectedViewerIssue
    ? activeFileIssues.findIndex((issue) => issue.id === selectedViewerIssue.id)
    : -1;
  const highlightedColumns = useMemo(() => {
    const columns = new Map<string, "error" | "warning">();
    if (selectedViewerIssue?.wholeColumn && selectedViewerIssue.column) {
      columns.set(selectedViewerIssue.column, selectedViewerIssue.severity);
    }
    return columns;
  }, [selectedViewerIssue]);

  useEffect(() => {
    const frame = tableFrameRef.current;
    if (!frame) return;
    const observer = new ResizeObserver(() => setViewportHeight(frame.clientHeight));
    observer.observe(frame);
    setViewportHeight(frame.clientHeight);
    return () => observer.disconnect();
  }, []);

  const filteredIndices = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized || searchDisabled) return null;
    const matches: number[] = [];
    for (let index = 0; index < activeTable.rowCount; index++) {
      if (activeTable.getRow(index).some((cell) => cell.toLowerCase().includes(normalized))) matches.push(index);
    }
    return matches;
  }, [activeTable, query, searchDisabled]);

  const displayedRowCount = filteredIndices?.length ?? activeTable.rowCount;
  const scrollStep = Math.min(ROW_HEIGHT, MAX_SCROLL_HEIGHT / Math.max(1, displayedRowCount));
  const startIndex = Math.max(0, Math.floor(scrollTop / scrollStep) - 18);
  const endIndex = Math.min(displayedRowCount, startIndex + Math.ceil(viewportHeight / ROW_HEIGHT) + 38);
  const visibleRows = useMemo(() => Array.from({ length: Math.max(0, endIndex - startIndex) }, (_, offset) => {
    const displayIndex = startIndex + offset;
    const sourceIndex = filteredIndices?.[displayIndex] ?? displayIndex;
    return { displayIndex, sourceIndex, cells: activeTable.getRow(sourceIndex) };
  }), [activeTable, endIndex, filteredIndices, startIndex]);
  const visibleRowsWithIssues = useMemo(() => visibleRows.map((visibleRow) => {
    if (!selectedViewerIssue) return { ...visibleRow, issueSeverity: null as "error" | "warning" | null, emptyCellIndex: -1 };
    const fileRow = visibleRow.sourceIndex + 2;
    let issueSeverity: "error" | "warning" | null = null;
    let emptyCellIndex = -1;
    if (selectedViewerIssue.emptyValue && !selectedViewerIssue.wholeColumn && selectedViewerIssue.column) {
      const columnIndex = activeTable.columns.indexOf(selectedViewerIssue.column);
      if (columnIndex >= 0 && !visibleRow.cells[columnIndex]?.trim()) emptyCellIndex = columnIndex;
    } else if (!selectedViewerIssue.wholeColumn && selectedViewerIssue.row === fileRow) {
      issueSeverity = selectedViewerIssue.severity;
    }
    return { ...visibleRow, issueSeverity, emptyCellIndex };
  }), [activeTable.columns, selectedViewerIssue, visibleRows]);

  const saveCurrentFeed = useCallback(() => {
    if (!activeFeedId) return;
    const session = feedSessionsRef.current.get(activeFeedId);
    if (!session) return;
    feedSessionsRef.current.set(activeFeedId, { ...session, name: feedName, status, files, activeName, issues, checkedFiles: [...checkedFiles], checkCompleted, showIssues });
  }, [activeFeedId, activeName, checkCompleted, checkedFiles, feedName, files, issues, showIssues, status]);

  const scrollToTableRow = useCallback((fileRow: number, table: ActiveTable) => {
    const rowIndex = Math.max(0, fileRow - 2);
    const step = Math.min(ROW_HEIGHT, MAX_SCROLL_HEIGHT / Math.max(1, table.rowCount));
    requestAnimationFrame(() => {
      const top = rowIndex * step;
      if (tableFrameRef.current) tableFrameRef.current.scrollTop = top;
      setScrollTop(top);
    });
  }, []);

  const focusTableIssue = useCallback((issue: GtfsIssue | undefined, table: ActiveTable) => {
    setFocusIssue(issue || null);
    setFocusRow(issue?.row || null);
    if (issue?.row) scrollToTableRow(issue.row, table);
  }, [scrollToTableRow]);

  const selectViewerIssue = useCallback((issue: GtfsIssue) => {
    setFocusIssue(issue);
    setFocusRow(issue.row || null);
    if (issue.row) scrollToTableRow(issue.row, activeTable);
  }, [activeTable, scrollToTableRow]);

  const moveViewerIssue = useCallback((direction: number) => {
    if (activeFileIssues.length < 2 || selectedViewerIssueIndex < 0) return;
    const nextIndex = (selectedViewerIssueIndex + direction + activeFileIssues.length) % activeFileIssues.length;
    selectViewerIssue(activeFileIssues[nextIndex]);
  }, [activeFileIssues, selectViewerIssue, selectedViewerIssueIndex]);

  const goToNextEmptyRow = useCallback(() => {
    if (!selectedViewerIssue?.emptyValue || selectedViewerIssue.wholeColumn || !selectedViewerIssue.column || activeTable.rowCount === 0) return;
    const columnIndex = activeTable.columns.indexOf(selectedViewerIssue.column);
    if (columnIndex < 0) return;
    const currentIndex = Math.max(0, (focusRow || selectedViewerIssue.row || 2) - 2);
    for (let offset = 1; offset <= activeTable.rowCount; offset++) {
      const candidateIndex = (currentIndex + offset) % activeTable.rowCount;
      if (!activeTable.getRow(candidateIndex)[columnIndex]?.trim()) {
        const nextFileRow = candidateIndex + 2;
        setFocusRow(nextFileRow);
        scrollToTableRow(nextFileRow, activeTable);
        return;
      }
    }
  }, [activeTable, focusRow, scrollToTableRow, selectedViewerIssue]);

  const loadFeedFile = useCallback(async (file: FeedFile, issue?: GtfsIssue) => {
    const loadId = ++loadIdRef.current;
    setActiveName(file.name);
    setQuery("");
    setFileError("");
    setScrollTop(0);
    if (tableFrameRef.current) tableFrameRef.current.scrollTop = 0;
    if (file.sampleRows) {
      const table = tableFromSample(file);
      setActiveTable(table);
      setLoadingFile(null);
      focusTableIssue(issue, table);
      return;
    }
    const entry = file.entryName ? zipRef.current?.file(file.entryName) : null;
    if (!entry) return;
    try {
      setLoadingFile(file.name);
      const rawBytes = await entry.async("uint8array");
      const indexed = await indexBytes(rawBytes);
      if (loadId !== loadIdRef.current) return;
      const table = makeByteTable(indexed.bytes, indexed.offsets);
      setActiveTable(table);
      setFiles((current) => current.map((item) => item.name === file.name ? { ...item, rowCount: table.rowCount } : item));
      focusTableIssue(issue, table);
    } catch {
      if (loadId === loadIdRef.current) setFileError("We couldn’t open this file. Try opening the feed again.");
    } finally {
      if (loadId === loadIdRef.current) setLoadingFile(null);
    }
  }, [focusTableIssue]);

  const activateFeed = useCallback((session: FeedSession) => {
    checkRunIdRef.current++;
    loadIdRef.current++;
    setActiveFeedId(session.id);
    zipRef.current = session.zip;
    entryNamesRef.current = session.entryNames;
    setFeedName(session.name);
    setStatus(session.status);
    setFiles(session.files);
    setIssues(session.issues);
    setCheckedFiles(new Set(session.checkedFiles));
    setCheckCompleted(session.checkCompleted);
    setShowIssues(session.showIssues);
    setCheckProgress({ running: false, fileIndex: 0, totalFiles: session.files.length, fileName: "", completedRows: 0, totalRows: 0, overallPercent: session.checkCompleted ? 100 : 0 });
    setFocusIssue(null);
    setFocusRow(null);
    setShowNextStep(false);
    setFeedLimitMessage("");
    const selectedFile = session.files.find((file) => file.name === session.activeName) || session.files[0];
    if (selectedFile) void loadFeedFile(selectedFile);
  }, [loadFeedFile]);

  const switchFeed = useCallback((id: string) => {
    if (id === activeFeedId) return;
    saveCurrentFeed();
    const session = feedSessionsRef.current.get(id);
    if (session) activateFeed(session);
  }, [activateFeed, activeFeedId, saveCurrentFeed]);

  const deleteFeed = useCallback((id: string) => {
    const remainingTabs = feedTabs.filter((tab) => tab.id !== id);
    feedSessionsRef.current.delete(id);
    setFeedTabs(remainingTabs);
    setFeedLimitMessage("");
    if (id !== activeFeedId) return;
    const nextSession = remainingTabs[0] ? feedSessionsRef.current.get(remainingTabs[0].id) : undefined;
    if (nextSession) {
      activateFeed(nextSession);
      return;
    }
    checkRunIdRef.current++;
    loadIdRef.current++;
    setActiveFeedId(null);
    zipRef.current = null;
    entryNamesRef.current = SAMPLE.map((file) => file.name);
    setFiles(SAMPLE);
    setFeedName("Example transit feed");
    setStatus("Example feed · choose a zip to inspect your own data");
    setIssues([]);
    setCheckedFiles(new Set());
    setCheckCompleted(false);
    setShowIssues(false);
    setCheckProgress({ running: false, fileIndex: 0, totalFiles: SAMPLE.length, fileName: "", completedRows: 0, totalRows: 0, overallPercent: 0 });
    setFocusIssue(null);
    setFocusRow(null);
    setShowNextStep(false);
    setActiveName("stops.txt");
    setActiveTable(tableFromSample(SAMPLE.find((file) => file.name === "stops.txt") || SAMPLE[0]));
  }, [activateFeed, activeFeedId, feedTabs]);

  const runFullCheck = useCallback(async () => {
    const runId = ++checkRunIdRef.current;
    setView("checks");
    setShowNextStep(false);
    setCheckCompleted(false);
    setShowIssues(false);
    setFocusIssue(null);
    setFocusRow(null);
    setCheckedFiles(new Set());
    setIssues(checkFeedStructure(entryNamesRef.current));
    setCheckProgress({ running: true, fileIndex: 0, totalFiles: files.length, fileName: files[0]?.name || "", completedRows: 0, totalRows: 0, overallPercent: 0 });

    for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
      if (runId !== checkRunIdRef.current) return;
      const file = files[fileIndex];
      try {
        let table: ActiveTable;
        if (file.sampleRows) table = tableFromSample(file);
        else {
          const entry = file.entryName ? zipRef.current?.file(file.entryName) : null;
          if (!entry) throw new Error("File is unavailable");
          const indexed = await indexBytes(await entry.async("uint8array"));
          table = makeByteTable(indexed.bytes, indexed.offsets);
          setFiles((current) => current.map((item) => item.name === file.name ? { ...item, rowCount: table.rowCount } : item));
        }
        setCheckProgress({ running: true, fileIndex: fileIndex + 1, totalFiles: files.length, fileName: file.name, completedRows: 0, totalRows: table.rowCount, overallPercent: Math.round((fileIndex / files.length) * 100) });
        const fileIssues = await checkTable(file.name, table, Number.POSITIVE_INFINITY, (completedRows, totalRows) => {
          const withinFile = totalRows ? completedRows / totalRows : 1;
          setCheckProgress({ running: true, fileIndex: fileIndex + 1, totalFiles: files.length, fileName: file.name, completedRows, totalRows, overallPercent: Math.round(((fileIndex + withinFile) / files.length) * 100) });
        });
        if (runId !== checkRunIdRef.current) return;
        setIssues((current) => [...current.filter((item) => item.scope !== "file" || item.file !== file.name), ...fileIssues]);
      } catch {
        setIssues((current) => [...current, { id: `file-${file.name}-unreadable`, severity: "error", scope: "file", file: file.name, title: "Could not check file", detail: "The file could not be opened during the feed check." }]);
      }
      setCheckedFiles((current) => new Set(current).add(file.name));
    }
    if (runId === checkRunIdRef.current) {
      setCheckProgress((current) => ({ ...current, running: false, overallPercent: 100 }));
      setCheckCompleted(true);
    }
  }, [files]);

  const loadZip = useCallback(async (file: File) => {
    if (feedTabs.length >= 3) {
      setFeedLimitMessage("Three feeds are already open. Delete one before opening another.");
      return;
    }
    if (!file.name.toLowerCase().endsWith(".zip")) {
      setFeedLimitMessage("That doesn’t look like a .zip file. Try a zipped GTFS feed.");
      return;
    }
    try {
      checkRunIdRef.current++;
      setCheckProgress((current) => ({ ...current, running: false }));
      setFeedLimitMessage("Opening feed…");
      const zip = await JSZip.loadAsync(file);
      const entryNames = Object.values(zip.files).filter((entry) => !entry.dir && !entry.name.startsWith("__MACOSX/")).map((entry) => entry.name);
      const order = ["agency.txt", "stops.txt", "routes.txt", "trips.txt", "stop_times.txt", "calendar.txt", "calendar_dates.txt", "fare_attributes.txt", "fare_rules.txt", "shapes.txt", "frequencies.txt", "transfers.txt", "feed_info.txt"];
      const feedFiles = Object.values(zip.files)
        .filter((entry) => !entry.dir && !entry.name.startsWith("__MACOSX/") && /\.(txt|csv)$/i.test(entry.name))
        .map((entry) => ({ name: entry.name.split("/").pop() || entry.name, entryName: entry.name, size: Number((entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize || 0), rowCount: null }))
        .sort((a, b) => {
          const aIndex = order.indexOf(a.name.toLowerCase());
          const bIndex = order.indexOf(b.name.toLowerCase());
          return (aIndex < 0 ? 999 : aIndex) - (bIndex < 0 ? 999 : bIndex) || a.name.localeCompare(b.name);
        });
      if (!feedFiles.length) throw new Error("No GTFS files found");
      saveCurrentFeed();
      const id = crypto.randomUUID();
      const name = file.name.replace(/\.zip$/i, "");
      const feedStatus = `${feedFiles.length} files · ${formatBytes(file.size)} compressed · processed locally`;
      const structureIssues = checkFeedStructure(entryNames);
      feedSessionsRef.current.set(id, { id, name, status: feedStatus, files: feedFiles, activeName: feedFiles[0].name, zip, entryNames, issues: structureIssues, checkedFiles: [], checkCompleted: false, showIssues: false });
      setFeedTabs((current) => [...current, { id, name }]);
      setActiveFeedId(id);
      zipRef.current = zip;
      entryNamesRef.current = entryNames;
      setFiles(feedFiles);
      setIssues(structureIssues);
      setCheckedFiles(new Set());
      setView("data");
      setCheckCompleted(false);
      setShowIssues(false);
      setFocusIssue(null);
      setFocusRow(null);
      setShowNextStep(true);
      setFeedName(name);
      setStatus(feedStatus);
      setFeedLimitMessage("");
      void loadFeedFile(feedFiles[0]);
    } catch {
      setFeedLimitMessage("We couldn’t read that feed. Check that it’s a valid GTFS zip and try again.");
    }
  }, [feedTabs.length, loadFeedFile, saveCurrentFeed]);

  const onInput = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) void loadZip(file);
    event.target.value = "";
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files?.[0];
    if (file) void loadZip(file);
  };

  const onTableScroll = (event: UIEvent<HTMLDivElement>) => {
    const nextTop = event.currentTarget.scrollTop;
    if (scrollFrameRef.current !== null) cancelAnimationFrame(scrollFrameRef.current);
    scrollFrameRef.current = requestAnimationFrame(() => setScrollTop(nextTop));
  };

  const openIssue = (issue: GtfsIssue) => {
    if (!issue.file) return;
    const file = files.find((candidate) => candidate.name === issue.file);
    if (!file) return;
    setShowIssues(true);
    setView("data");
    void loadFeedFile(file, issue);
  };

  const checkReport = <>
    {checkProgress.running && <div className="progress-panel"><div className="progress-label"><span><strong>Checking {checkProgress.fileName}</strong><small>File {checkProgress.fileIndex} of {checkProgress.totalFiles}{checkProgress.totalRows ? ` · ${checkProgress.completedRows.toLocaleString()} of ${checkProgress.totalRows.toLocaleString()} rows` : ""}</small></span><b>{checkProgress.overallPercent}%</b></div><div className="progress-track"><span style={{ width: `${checkProgress.overallPercent}%` }} /></div></div>}
    <div className="check-summary">
      <div className="summary-card error"><span>Errors</span><strong>{errorCount}</strong><small>Likely to break or misread the feed</small></div>
      <div className="summary-card warning"><span>Warnings</span><strong>{warningCount}</strong><small>Worth reviewing before publishing</small></div>
      <div className="summary-card checked"><span>Files checked</span><strong>{checkedFiles.size}<em>/{files.length}</em></strong><small>{checkCompleted ? "Full feed check complete" : "Every supported row will be checked"}</small></div>
    </div>
    <div className="check-note"><strong>What is checked?</strong><span>Required files and values, empty optional fields, duplicate keys, coordinates, dates, times, route types, colours, sequence order, and shape distance progression.</span></div>
    <div className="issue-list">
      {issues.length === 0 ? <div className="checks-clear"><span>✓</span><strong>{checkCompleted ? "No issues found" : "Ready to check the feed"}</strong><p>{checkCompleted ? "The full scan did not find a problem covered by these checks." : "Run the full check to scan every supported file and row in this feed."}</p></div> : [...issues].sort((a, b) => a.severity.localeCompare(b.severity)).map((issue) => (
        <button key={issue.id} className={`issue-row ${issue.severity}`} onClick={() => openIssue(issue)} disabled={!issue.file}>
          <span className="issue-mark">{issue.severity === "error" ? "!" : "△"}</span>
          <span className="issue-copy"><strong>{issue.title}</strong><small>{issue.detail}</small></span>
          <span className="issue-location">{issue.file || "Feed"}{issue.column ? ` · ${issue.column}` : ""}{issue.row ? ` · row ${issue.row}` : ""}{issue.file && <b>View ›</b>}</span>
        </button>
      ))}
    </div>
  </>;

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="GTFS Viewer home"><span className="brand-mark">G</span><span>GTFS Viewer</span></a>
        <nav className="mode-switch" aria-label="Tool mode"><button className={view === "data" ? "active" : ""} onClick={() => setView("data")}>Viewer</button><button className={view === "checks" ? "active" : ""} onClick={() => setView("checks")}>Feed check{issues.length > 0 && <span>{issues.length}</span>}</button></nav>
        <div className="privacy-note"><span className="privacy-dot" /> Your data stays in this browser</div>
        <button className="upload-button" onClick={() => inputRef.current?.click()} disabled={feedTabs.length >= 3} title={feedTabs.length >= 3 ? "Delete an open feed before adding another." : undefined}><span aria-hidden="true">↑</span> {feedTabs.length >= 3 ? "3 feeds open" : "Open GTFS zip"}</button>
        <input ref={inputRef} className="sr-only" type="file" accept=".zip,application/zip" onChange={onInput} />
      </header>

      <section id="top" className="intro">
        <div><p className="eyebrow">GTFS files are simple—until they get big</p><h1>Stop losing track<br />of the header row.</h1></div>
        <div className="intro-copy"><p>A regular text editor turns a long GTFS file into a wall of commas. Scroll a few hundred rows and it is easy to forget which value belongs to which field.</p><p>Open the ZIP here to keep headers pinned, separate columns by colour, and check the whole feed when you need to.</p></div>
      </section>

      {feedTabs.length > 0 && <section className="feed-tabs-bar" aria-label="Open GTFS feeds"><div className="feed-tabs-heading"><strong>Open feeds</strong><span>{feedTabs.length}/3</span></div><div className="feed-tabs-list">{feedTabs.map((tab) => <div key={tab.id} className={tab.id === activeFeedId ? "feed-tab active" : "feed-tab"}><button className="feed-tab-name" onClick={() => switchFeed(tab.id)} title={tab.name}><span className="feed-tab-dot" />{tab.name}</button><button className="feed-tab-delete" onClick={() => deleteFeed(tab.id)} aria-label={`Delete ${tab.name}`}>×</button></div>)}{feedTabs.length < 3 && <button className="add-feed-tab" onClick={() => inputRef.current?.click()}>＋ Add feed</button>}</div>{feedLimitMessage && <p>{feedLimitMessage}</p>}</section>}

      <section className={`workspace ${view === "checks" ? "check-mode" : ""} ${dragging ? "is-dragging" : ""}`} onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={onDrop}>
        {dragging && <div className="drop-overlay"><strong>Drop your GTFS zip here</strong><span>We’ll open it right in your browser</span></div>}
        {showNextStep && <div className="feed-choice"><div className="feed-choice-card"><span className="choice-check">✓</span><p className="file-kicker">Feed opened</p><h2>{feedName}</h2><p>{files.length} GTFS files are ready. What would you like to do first?</p><div><button onClick={() => { setShowNextStep(false); setView("data"); }}>Browse the files</button><button className="primary" onClick={() => void runFullCheck()}>Run a feed check</button></div><small>The full check reads every supported file and reports progress as it works.</small></div></div>}

        {view === "data" && <aside className="sidebar">
          <div className="feed-card"><div className="feed-icon">ZIP</div><div className="feed-copy"><strong>{feedName}</strong><span>{status}</span></div></div>
          <div className="file-heading"><span>Files</span><span>{files.length}</span></div>
          <nav className="file-list" aria-label="GTFS files">{files.map((file) => <button key={file.name} className={file.name === activeFile?.name ? "file-item active" : "file-item"} onClick={() => void loadFeedFile(file)}><span className="file-glyph">≡</span><span className="file-meta"><strong>{file.name}</strong><small>{file.rowCount === null ? "Open to count rows" : `${file.rowCount.toLocaleString()} rows`} · {formatBytes(file.size)}</small></span>{issueCountByFile.get(file.name) ? <span className="issue-badge">{issueCountByFile.get(file.name)}</span> : <span className="chevron">›</span>}</button>)}</nav>
          <button className="new-feed" onClick={() => inputRef.current?.click()} disabled={feedTabs.length >= 3}>{feedTabs.length >= 3 ? "Delete a feed to open another" : "＋ Open another feed"}</button>
        </aside>}

        {view === "data" && <section className={`viewer ${showIssues ? "with-issue-panel" : ""}`}>
          <div className="viewer-head">
            <div><p className="file-kicker">Viewing file</p><h2>{activeFile?.name || "No file selected"}</h2><p>{loadingFile ? `Preparing ${formatBytes(activeFile?.size || 0)} file…` : `${activeTable.rowCount.toLocaleString()} rows · ${activeTable.columns.length} columns`}</p></div>
            <div className="viewer-tools">{checkCompleted && <button className={`issue-toggle ${showIssues ? "active" : ""}`} aria-pressed={showIssues} onClick={() => { const next = !showIssues; setShowIssues(next); if (next) { const firstIssue = activeFileIssues[0]; setFocusIssue(firstIssue || null); setFocusRow(firstIssue?.row || null); } else { setFocusIssue(null); setFocusRow(null); } }}><span className="issue-toggle-mark">!</span><span>{showIssues ? "Issues on" : "Show issues"}</span>{activeFileIssues.length > 0 && <b>{activeFileIssues.length}</b>}</button>}<label className={`search-box ${searchDisabled ? "disabled" : ""}`} title={searchDisabled ? "Search is disabled for very large files to keep the viewer responsive." : undefined}><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={searchDisabled ? "Search off for large files" : "Search this file"} aria-label="Search this file" disabled={searchDisabled} />{query && <button onClick={() => setQuery("")} aria-label="Clear search">×</button>}</label><button className={`wrap-button ${wrap ? "active" : ""}`} onClick={() => setWrap((value) => !value)} title="Toggle cell text wrapping">↵ <span>Wrap</span></button></div>
          </div>
          {showIssues && <div className={`viewer-issue-panel ${selectedViewerIssue?.severity || "clear"}`}>
            {selectedViewerIssue ? <>
              <span className="viewer-issue-mark">{selectedViewerIssue.severity === "error" ? "!" : "△"}</span>
              <div className="viewer-issue-copy"><strong>{selectedViewerIssue.title}</strong><p>{selectedViewerIssue.detail}</p><small>{selectedViewerIssue.column && `${selectedViewerIssue.column}`}{selectedViewerIssue.column && focusRow && " · "}{focusRow && `row ${focusRow}`}</small></div>
              <div className="viewer-issue-controls">
                {activeFileIssues.length > 1 && <><button onClick={() => moveViewerIssue(-1)} aria-label="Previous issue">←</button><label><span>Issue</span><select value={selectedViewerIssue.id} onChange={(event) => { const issue = activeFileIssues.find((item) => item.id === event.target.value); if (issue) selectViewerIssue(issue); }}>{activeFileIssues.map((issue, index) => <option key={issue.id} value={issue.id}>{index + 1}. {issue.title}</option>)}</select></label><span className="issue-position">{selectedViewerIssueIndex + 1} of {activeFileIssues.length}</span><button onClick={() => moveViewerIssue(1)} aria-label="Next issue">→</button></>}
                {selectedViewerIssue.emptyValue && !selectedViewerIssue.wholeColumn && (selectedViewerIssue.occurrences || 0) > 1 && <button className="next-problem" onClick={goToNextEmptyRow}>Next highlighted row ↓</button>}
                <button onClick={() => setView("checks")}>Full report</button>
              </div>
            </> : <><span className="viewer-issue-mark">✓</span><div className="viewer-issue-copy"><strong>No issues in this file</strong><p>The feed check did not report anything for {activeFile?.name}.</p></div><div className="viewer-issue-controls"><button onClick={() => setView("checks")}>Full report</button></div></>}
          </div>}
          <div ref={tableFrameRef} className="table-frame" onScroll={onTableScroll}>
            {!loadingFile && !fileError && <table className={wrap ? "data-table wraps" : "data-table"}><thead><tr><th className="row-number">Line</th>{activeTable.columns.map((column, index) => { const severity = highlightedColumns.get(column); return <th key={`${column}-${index}`} className={severity ? `problem-column ${severity}-problem-column` : ""} style={{ "--column-color": COLORS[index % COLORS.length], "--column-accent": ACCENTS[index % ACCENTS.length] } as React.CSSProperties}><span>{column}</span></th>; })}</tr></thead><tbody>{startIndex > 0 && <tr className="virtual-spacer" aria-hidden="true"><td colSpan={activeTable.columns.length + 1} style={{ height: startIndex * scrollStep }} /></tr>}{visibleRowsWithIssues.map(({ sourceIndex, cells, issueSeverity, emptyCellIndex }) => <tr key={sourceIndex} className={`${issueSeverity ? `problem-row ${issueSeverity}-problem-row` : ""}${emptyCellIndex >= 0 ? ` empty-value-row ${selectedViewerIssue?.severity || "warning"}-empty-value-row` : ""}${showIssues && !selectedViewerIssue?.wholeColumn && focusRow === sourceIndex + 2 ? " active-problem-row" : ""}`.trim()} style={{ height: ROW_HEIGHT }}><td className="row-number">{sourceIndex + 2}</td>{activeTable.columns.map((column, cellIndex) => { const severity = highlightedColumns.get(column); const emptySeverity = cellIndex === emptyCellIndex ? selectedViewerIssue?.severity : null; return <td key={cellIndex} className={`${severity ? `problem-column ${severity}-problem-column` : ""}${emptySeverity ? ` issue-cell ${emptySeverity}-issue-cell` : ""}`.trim()} style={{ "--column-color": COLORS[cellIndex % COLORS.length] } as React.CSSProperties} title={cells[cellIndex]}>{cells[cellIndex] || <span className="empty">—</span>}</td>; })}</tr>)}{endIndex < displayedRowCount && <tr className="virtual-spacer" aria-hidden="true"><td colSpan={activeTable.columns.length + 1} style={{ height: (displayedRowCount - endIndex) * scrollStep }} /></tr>}</tbody></table>}
            {loadingFile && <div className="loading-state"><span className="loading-ring" /><strong>Preparing {loadingFile}</strong><span>Large files are indexed in the background so scrolling stays smooth.</span></div>}
            {fileError && <div className="empty-state"><strong>Couldn’t open file</strong><span>{fileError}</span></div>}
            {!loadingFile && !fileError && displayedRowCount === 0 && <div className="empty-state"><strong>No matching rows</strong><span>Try a different search term.</span></div>}
          </div>
          <div className="viewer-foot"><span><i /> Only visible rows are rendered · headers stay pinned</span><span>{displayedRowCount.toLocaleString()} {filteredIndices ? "matching" : "total"} rows</span></div>
        </section>}

        {view === "checks" && <section className="check-workspace"><div className="check-head"><div><p className="file-kicker">Separate review workspace</p><h2>Feed check</h2><p>Scan every supported file, then jump straight from a problem to its row and column.</p></div><button className="run-check-button" onClick={() => void runFullCheck()} disabled={checkProgress.running}>{checkProgress.running ? "Check in progress" : checkCompleted ? "Run again" : "Run full feed check"}</button></div><div className="check-scroll"><div className="checks-panel">{checkReport}</div></div><div className="viewer-foot"><span><i /> Checks follow the <a href="https://gtfs.org/documentation/schedule/reference/" target="_blank" rel="noreferrer">GTFS Schedule reference</a></span><span>Runs locally in your browser</span></div></section>}
      </section>

      <section className="steps"><p className="eyebrow">Made for day-to-day feed work</p><h2>Read the data. Check the feed.</h2><div className="step-grid"><div><span>01</span><h3>Open the ZIP</h3><p>The feed stays on your computer and opens directly in the browser.</p></div><div><span>02</span><h3>Choose your task</h3><p>Browse files immediately or run a separate check across the whole feed.</p></div><div><span>03</span><h3>Go straight to the issue</h3><p>Open a result in context with the affected row and column highlighted.</p></div></div></section>
      <footer><span><strong>GTFS Viewer</strong> · An open viewer for public transit data.</span><span>Files never leave your device.</span></footer>
    </main>
  );

}
