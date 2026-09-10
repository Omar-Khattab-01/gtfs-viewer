"use client";

import { ChangeEvent, DragEvent, UIEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import JSZip from "jszip";
import Papa from "papaparse";

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
  { name: "stops.txt", size: 48291, rowCount: sampleStopRows.length, sampleColumns: ["stop_id", "stop_code", "stop_name", "stop_lat", "stop_lon", "stop_desc"], sampleRows: sampleStopRows },
  { name: "routes.txt", size: 3812, rowCount: 4, sampleColumns: ["route_id", "agency_id", "route_short_name", "route_long_name", "route_type", "route_color"], sampleRows: [["10", "CITY", "10", "Central–Riverside", "3", "15603B"], ["20", "CITY", "20", "North Terminal–University", "3", "3978B7"], ["30", "CITY", "30", "Main Street–Central", "3", "C87619"], ["40", "CITY", "40", "Riverside–North Terminal", "3", "8E4EC6"]] },
  { name: "trips.txt", size: 892104, rowCount: 24, sampleColumns: ["route_id", "service_id", "trip_id", "trip_headsign", "direction_id", "shape_id"], sampleRows: Array.from({ length: 24 }, (_, index) => ["20", "WEEKDAY", `TRIP_20_${3100 + index}`, index % 2 ? "University" : "North Terminal", String(index % 2), `SHAPE_20_${index % 2}`]) },
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
  const [activeTable, setActiveTable] = useState<ActiveTable>(() => tableFromSample(SAMPLE[0]));
  const [query, setQuery] = useState("");
  const [wrap, setWrap] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [status, setStatus] = useState("Example feed · choose a zip to inspect your own data");
  const [loadingFile, setLoadingFile] = useState<string | null>(null);
  const [fileError, setFileError] = useState("");
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(500);
  const inputRef = useRef<HTMLInputElement>(null);
  const tableFrameRef = useRef<HTMLDivElement>(null);
  const zipRef = useRef<JSZip | null>(null);
  const loadIdRef = useRef(0);
  const scrollFrameRef = useRef<number | null>(null);

  const activeFile = files.find((file) => file.name === activeName) || files[0];
  const searchDisabled = activeTable.rowCount > SEARCH_LIMIT;

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

  const loadFeedFile = useCallback(async (file: FeedFile) => {
    const loadId = ++loadIdRef.current;
    setActiveName(file.name);
    setQuery("");
    setFileError("");
    setScrollTop(0);
    if (tableFrameRef.current) tableFrameRef.current.scrollTop = 0;
    if (file.sampleRows) {
      setActiveTable(tableFromSample(file));
      setLoadingFile(null);
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
    } catch {
      if (loadId === loadIdRef.current) setFileError("We couldn’t open this file. Try opening the feed again.");
    } finally {
      if (loadId === loadIdRef.current) setLoadingFile(null);
    }
  }, []);

  const loadZip = useCallback(async (file: File) => {
    if (!file.name.toLowerCase().endsWith(".zip")) {
      setStatus("That doesn’t look like a .zip file. Try a zipped GTFS feed.");
      return;
    }
    try {
      setStatus("Opening feed directory…");
      const zip = await JSZip.loadAsync(file);
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
      zipRef.current = zip;
      setFiles(feedFiles);
      setFeedName(file.name.replace(/\.zip$/i, ""));
      setStatus(`${feedFiles.length} files · ${formatBytes(file.size)} compressed · processed locally`);
      void loadFeedFile(feedFiles[0]);
    } catch {
      setStatus("We couldn’t read that feed. Check that it’s a valid GTFS zip and try again.");
    }
  }, [loadFeedFile]);

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

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="GTFS Viewer home"><span className="brand-mark">G</span><span>GTFS Viewer</span></a>
        <div className="privacy-note"><span className="privacy-dot" /> Your data stays in this browser</div>
        <button className="upload-button" onClick={() => inputRef.current?.click()}><span aria-hidden="true">↑</span> Open GTFS zip</button>
        <input ref={inputRef} className="sr-only" type="file" accept=".zip,application/zip" onChange={onInput} />
      </header>

      <section id="top" className="intro">
        <div><p className="eyebrow">A clearer way to read transit data</p><h1>See the column.<br />Understand the row.</h1></div>
        <p className="intro-copy">Open any zipped GTFS feed and explore every file without losing sight of its headers. No setup, no uploads, no guesswork.</p>
      </section>

      <section className={`workspace ${dragging ? "is-dragging" : ""}`} onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={onDrop}>
        {dragging && <div className="drop-overlay"><strong>Drop your GTFS zip here</strong><span>We’ll open it right in your browser</span></div>}
        <aside className="sidebar">
          <div className="feed-card"><div className="feed-icon">ZIP</div><div className="feed-copy"><strong>{feedName}</strong><span>{status}</span></div></div>
          <div className="file-heading"><span>Files</span><span>{files.length}</span></div>
          <nav className="file-list" aria-label="GTFS files">
            {files.map((file) => (
              <button key={file.name} className={file.name === activeFile?.name ? "file-item active" : "file-item"} onClick={() => void loadFeedFile(file)}>
                <span className="file-glyph">≡</span>
                <span className="file-meta"><strong>{file.name}</strong><small>{file.rowCount === null ? "Open to count rows" : `${file.rowCount.toLocaleString()} rows`} · {formatBytes(file.size)}</small></span>
                <span className="chevron">›</span>
              </button>
            ))}
          </nav>
          <button className="new-feed" onClick={() => inputRef.current?.click()}>＋ Open another feed</button>
        </aside>

        <section className="viewer">
          <div className="viewer-head">
            <div><p className="file-kicker">Viewing file</p><h2>{activeFile?.name || "No file selected"}</h2><p>{loadingFile ? `Preparing ${formatBytes(activeFile?.size || 0)} file…` : `${activeTable.rowCount.toLocaleString()} rows · ${activeTable.columns.length} columns`}</p></div>
            <div className="viewer-tools">
              <label className={`search-box ${searchDisabled ? "disabled" : ""}`} title={searchDisabled ? "Search is disabled for very large files to keep the viewer responsive." : undefined}>
                <span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={searchDisabled ? "Search off for large files" : "Search this file"} aria-label="Search this file" disabled={searchDisabled} />{query && <button onClick={() => setQuery("")} aria-label="Clear search">×</button>}
              </label>
              <button className={`wrap-button ${wrap ? "active" : ""}`} onClick={() => setWrap((value) => !value)} title="Toggle cell text wrapping">↵ <span>Wrap</span></button>
            </div>
          </div>

          <div ref={tableFrameRef} className="table-frame" onScroll={onTableScroll}>
            {!loadingFile && !fileError && (
              <table className={wrap ? "data-table wraps" : "data-table"}>
                <thead><tr><th className="row-number">#</th>{activeTable.columns.map((column, index) => <th key={`${column}-${index}`} style={{ "--column-color": COLORS[index % COLORS.length], "--column-accent": ACCENTS[index % ACCENTS.length] } as React.CSSProperties}><span>{column}</span></th>)}</tr></thead>
                <tbody>
                  {startIndex > 0 && <tr className="virtual-spacer" aria-hidden="true"><td colSpan={activeTable.columns.length + 1} style={{ height: startIndex * scrollStep }} /></tr>}
                  {visibleRows.map(({ displayIndex, sourceIndex, cells }) => <tr key={sourceIndex} style={{ height: ROW_HEIGHT }}><td className="row-number">{sourceIndex + 1}</td>{activeTable.columns.map((_, cellIndex) => <td key={cellIndex} style={{ "--column-color": COLORS[cellIndex % COLORS.length] } as React.CSSProperties} title={cells[cellIndex]}>{cells[cellIndex] || <span className="empty">—</span>}</td>)}</tr>)}
                  {endIndex < displayedRowCount && <tr className="virtual-spacer" aria-hidden="true"><td colSpan={activeTable.columns.length + 1} style={{ height: (displayedRowCount - endIndex) * scrollStep }} /></tr>}
                </tbody>
              </table>
            )}
            {loadingFile && <div className="loading-state"><span className="loading-ring" /><strong>Preparing {loadingFile}</strong><span>Large files are indexed in the background so scrolling stays smooth.</span></div>}
            {fileError && <div className="empty-state"><strong>Couldn’t open file</strong><span>{fileError}</span></div>}
            {!loadingFile && !fileError && displayedRowCount === 0 && <div className="empty-state"><strong>No matching rows</strong><span>Try a different search term.</span></div>}
          </div>
          <div className="viewer-foot"><span><i /> Only visible rows are rendered · headers stay pinned</span><span>{displayedRowCount.toLocaleString()} {filteredIndices ? "matching" : "total"} rows</span></div>
        </section>
      </section>

      <section className="steps"><p className="eyebrow">Built for curious people</p><h2>From zip to clarity in seconds.</h2><div className="step-grid"><div><span>01</span><h3>Drop in a feed</h3><p>Choose any standard GTFS zip from your computer.</p></div><div><span>02</span><h3>Pick a file</h3><p>Move between stops, routes, trips, and schedules.</p></div><div><span>03</span><h3>Follow the data</h3><p>Pinned, color-coded headers keep every value in context.</p></div></div></section>
      <footer><span><strong>GTFS Viewer</strong> · A simple, open viewer for public transit data.</span><span>Files never leave your device.</span></footer>
    </main>
  );
}
