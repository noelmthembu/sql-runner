import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AlertCircle, Braces, Check, ChevronDown, ChevronRight, CircleHelp, Clipboard, Code2, Columns3, Copy, Database, KeyRound, Play, RotateCcw, Share2, Table2, Timer, Upload, Zap } from 'lucide-react';
import initSqlJs from 'sql.js';
import type { Database as SqlJsDatabase, SqlJsStatic, SqlValue } from 'sql.js';
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { sampleDatabase } from '@/data/sample-database';

const queryClient = new QueryClient();

export type Cell = string | number | boolean | Uint8Array | null;
export type Row = Record<string, Cell>;
type QueryResult = { status: 'success' | 'error' | 'empty'; duration: number; rows: Row[]; columns: string[]; error?: string };
type SchemaColumn = readonly [string, string, boolean];
type TableInfo = { name: string; rowCount: number; columns: SchemaColumn[] };
type SqliteSource = { name: string; db: SqlJsDatabase; tables: TableInfo[]; isSample: boolean };

const defaultQuery = 'SELECT * FROM sales LIMIT 10;';

let sqlJsPromise: Promise<SqlJsStatic> | undefined;

function loadSqlJs() {
  sqlJsPromise ??= initSqlJs({ locateFile: () => wasmUrl });
  return sqlJsPromise;
}

function quoteIdentifier(value: string) {
  return `"${value.replace(/"/g, '""')}"`;
}

function normalizeIdentifier(value: string, fallback: string) {
  return value.toLowerCase().trim().replace(/[^a-z0-9_]+/g, '_').replace(/^(\d)/, '_$1') || fallback;
}

function toCell(value: unknown): Cell {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value instanceof Uint8Array) return value;
  return JSON.stringify(value);
}

function toSqlValue(value: Cell): SqlValue {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Uint8Array || typeof value === 'string' || typeof value === 'number' || value === null) return value;
  return null;
}

function inferSqlType(values: Cell[]) {
  const nonEmpty = values.filter((value) => value !== null && value !== '');
  if (nonEmpty.length && nonEmpty.every((value) => typeof value === 'number')) return nonEmpty.every((value) => Number.isInteger(value)) ? 'INTEGER' : 'REAL';
  if (nonEmpty.length && nonEmpty.every((value) => typeof value === 'boolean')) return 'INTEGER';
  return 'TEXT';
}

function toDisplayType(type: string) {
  const normalized = type.toUpperCase();
  if (normalized.includes('INT') || normalized.includes('REAL') || normalized.includes('NUM') || normalized.includes('DEC') || normalized.includes('FLOA') || normalized.includes('DOUB')) return 'numeric';
  if (normalized.includes('BOOL')) return 'boolean';
  if (normalized.includes('DATE') || normalized.includes('TIME')) return 'date';
  return 'text';
}

function parseCsv(text: string) {
  const records: string[][] = [];
  let row: string[] = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === '"' && quoted && next === '"') { value += '"'; index += 1; continue; }
    if (char === '"') { quoted = !quoted; continue; }
    if (char === ',' && !quoted) { row.push(value.trim()); value = ''; continue; }
    if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && next === '\n') index += 1;
      row.push(value.trim()); value = '';
      if (row.some((cell) => cell.length)) records.push(row);
      row = [];
      continue;
    }
    value += char;
  }
  row.push(value.trim());
  if (row.some((cell) => cell.length)) records.push(row);
  const headers = records.shift()?.map((header, index) => normalizeIdentifier(header, `column_${index + 1}`)) ?? [];
  return records.map((cells) => Object.fromEntries(headers.map((header, index) => {
    const cell = cells[index] ?? '';
    if (cell === '') return [header, null];
    if (/^-?\d+(?:\.\d+)?$/.test(cell)) return [header, Number(cell)];
    if (cell.toLowerCase() === 'true' || cell.toLowerCase() === 'false') return [header, cell.toLowerCase() === 'true'];
    return [header, cell];
  })) as Row);
}

function createDatabaseFromRows(SQL: SqlJsStatic, database: Record<string, Row[]>) {
  const db = new SQL.Database();
  Object.entries(database).forEach(([table, rows]) => {
    const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
    if (!columns.length) return;
    const definitions = columns.map((column) => `${quoteIdentifier(column)} ${inferSqlType(rows.map((row) => row[column] ?? null))}`).join(', ');
    db.run(`CREATE TABLE ${quoteIdentifier(table)} (${definitions});`);
    const statement = db.prepare(`INSERT INTO ${quoteIdentifier(table)} (${columns.map(quoteIdentifier).join(', ')}) VALUES (${columns.map(() => '?').join(', ')});`);
    rows.forEach((row) => statement.run(columns.map((column) => toSqlValue(row[column] ?? null))));
    statement.free();
  });
  return db;
}

function inspectDatabase(db: SqlJsDatabase): TableInfo[] {
  const tableResult = db.exec(`SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name;`);
  return (tableResult[0]?.values ?? []).map(([rawName]) => {
    const name = String(rawName);
    const columnResult = db.exec(`PRAGMA table_info(${quoteIdentifier(name)});`);
    const columns = (columnResult[0]?.values ?? []).map((row) => {
      const [, columnName, type, , , primaryKey] = row as [number, string, string, number | null, null, number];
      return [columnName, toDisplayType(type ?? ''), primaryKey > 0] as SchemaColumn;
    });
    const countResult = db.exec(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(name)};`);
    const rowCount = Number(countResult[0]?.values[0]?.[0] ?? 0);
    return { name, rowCount, columns };
  });
}

function createSource(SQL: SqlJsStatic, name: string, database: Record<string, Row[]>, isSample: boolean): SqliteSource {
  const db = createDatabaseFromRows(SQL, database);
  return { name, db, tables: inspectDatabase(db), isSample };
}

async function readDatabaseFile(file: File, SQL: SqlJsStatic) {
  const filename = normalizeIdentifier(file.name.replace(/\.[^.]+$/, ''), 'uploaded_data');
  const extension = file.name.toLowerCase().split('.').pop();
  if (extension === 'sqlite' || extension === 'db') {
    let db: SqlJsDatabase;
    try {
      db = new SQL.Database(new Uint8Array(await file.arrayBuffer()));
    } catch {
      throw new Error('That file is not a readable SQLite database.');
    }
    const tables = inspectDatabase(db);
    if (!tables.length) {
      db.close();
      throw new Error('No tables were found in that SQLite database.');
    }
    return { name: filename, db, tables, isSample: false } satisfies SqliteSource;
  }

  const text = await file.text();
  if (extension === 'csv') return createSource(SQL, filename, { [filename]: parseCsv(text) }, false);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('That file is not valid JSON.');
  }
  const tables: Record<string, Row[]> = Array.isArray(parsed)
    ? { [filename]: parsed.map((row) => row as Row) }
    : typeof parsed === 'object' && parsed !== null
      ? Object.fromEntries(Object.entries(parsed).filter(([, value]) => Array.isArray(value)).map(([table, value]) => [table, value as Row[]]))
      : {};
  const validTables = Object.fromEntries(Object.entries(tables)
    .filter(([table, rows]) => /^[a-z_][a-z0-9_]*$/i.test(table) && rows.every((row) => row && typeof row === 'object' && !Array.isArray(row)))
    .map(([table, rows]) => [normalizeIdentifier(table, 'uploaded_data'), rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [normalizeIdentifier(key, 'column'), toCell(value)])) as Row)]));
  if (!Object.keys(validTables).length) throw new Error('JSON must contain an array of rows or an object whose values are row arrays.');
  return createSource(SQL, filename, validTables, false);
}

function executeSql(sql: string, source: SqliteSource | null): QueryResult {
  const started = performance.now();
  const clean = sql.trim().replace(/;+\s*$/, '');
  if (!clean) return { status: 'empty', duration: 0, rows: [], columns: [] };
  if (/\b(update|delete|insert|drop|alter|create|truncate|grant|pragma|replace|reindex|vacuum)\b/i.test(clean) || clean.includes(';')) {
    return { status: 'error', duration: Math.round(performance.now() - started), rows: [], columns: [], error: 'That statement is blocked. The runner accepts one safe SELECT query only.' };
  }
  if (!/^(select|with)\b/i.test(clean)) {
    return { status: 'error', duration: Math.round(performance.now() - started), rows: [], columns: [], error: 'Only SELECT statements are enabled in this browser demo.' };
  }
  if (!source) {
    return { status: 'error', duration: Math.round(performance.now() - started), rows: [], columns: [], error: 'The browser SQLite engine is still loading. Try again in a moment.' };
  }
  try {
    const result = source.db.exec(clean)[0];
    const columns = result?.columns ?? [];
    const rows = (result?.values ?? []).map((values) => Object.fromEntries(columns.map((column, index) => [column, toCell(values[index])])) as Row);
    return { status: 'success', duration: Math.max(1, Math.round(performance.now() - started)), rows, columns };
  } catch (error) {
    return { status: 'error', duration: Math.max(1, Math.round(performance.now() - started)), rows: [], columns: [], error: error instanceof Error ? error.message : 'SQLite could not run that query.' };
  }
}

function copyText(text: string) {
  if (navigator.clipboard) void navigator.clipboard.writeText(text);
}

function SchemaPanel({
  activeTable,
  setActiveTable,
  source,
  onUseSample,
  onUpload,
  uploadError,
}: {
  activeTable: string;
  setActiveTable: (table: string) => void;
  source: SqliteSource | null;
  onUseSample: () => void;
  onUpload: () => void;
  uploadError: string | null;
}) {
  const tables = source?.tables ?? [];
  return (
    <aside className="schema-panel" aria-label="Connected database schema">
      <div className="eyebrow">Connected source</div>
      <div className="schema-heading"><h2>{source?.name ?? 'sample_db'}</h2><span>{source?.isSample ? 'SQLite' : 'local file'}</span></div>
      <div className="source-switcher" aria-label="Database source">
        <button type="button" className={`source-button ${source?.isSample ? 'is-selected' : ''}`} onClick={onUseSample} data-testid="button-use-sample-db">
          <Database size={13} /><span>sample_db</span><small>built-in</small>
        </button>
        <button type="button" className="upload-button" onClick={onUpload} data-testid="button-upload-db">
          <Zap size={13} /><span>upload CSV / JSON / SQLite</span>
        </button>
      </div>
      {uploadError && <div className="upload-error" role="alert" data-testid="status-upload-error"><AlertCircle size={13} /><span>{uploadError}</span></div>}
      <div className="schema-tables">
        {tables.length ? tables.map((table) => (
          <button type="button" className={`schema-table ${activeTable === table.name ? 'is-active' : ''}`} key={table.name} onClick={() => setActiveTable(table.name)} data-testid={`button-table-${table.name}`}>
            <div className="table-line">
              <span className="table-name">{activeTable === table.name ? <ChevronDown size={14} /> : <ChevronRight size={14} />}<Table2 size={14} />{table.name}</span>
              <span className="table-count">{table.rowCount} rows</span>
            </div>
            {activeTable === table.name && <div className="column-list">{table.columns.map(([name, type, key]) => <div className="column-row" key={name} data-testid={`column-${table.name}-${name}`}>{key ? <KeyRound size={11} /> : <Columns3 size={11} />}<span>{name}</span><span className="type-pill">{type}</span></div>)}</div>}
          </button>
        )) : <div className="schema-loading">{source ? 'No tables found.' : 'Loading SQLite engine…'}</div>}
      </div>
      <div className="schema-note"><CircleHelp size={14} /><span>Click a table to inspect its columns. Uploaded files stay local to this browser.</span></div>
    </aside>
  );
}

function formatCell(value: Cell) {
  if (value instanceof Uint8Array) return `[blob · ${value.byteLength} bytes]`;
  return value;
}

function ResultTable({ result }: { result: QueryResult }) {
  if (result.status === 'error') return <div className="error-box" role="alert" data-testid="status-query-error"><AlertCircle size={17} /><span>{result.error}</span></div>;
  if (result.status === 'empty') return <div className="empty-results"><strong>Nothing to show yet</strong>Run a SELECT query to inspect returned rows.</div>;
  if (!result.rows.length) return <div className="empty-results" data-testid="status-empty-results"><strong>Query ran successfully</strong>No rows matched the current filters.</div>;
  return (
    <div className="result-body">
      <table className="result-table">
        <thead><tr>{result.columns.map((column) => <th key={column}>{column}</th>)}</tr></thead>
        <tbody>{result.rows.map((row, index) => <tr key={`${index}-${JSON.stringify(row)}`} data-testid={`row-result-${index}`}>{result.columns.map((column) => <td key={column}>{row[column] === null || row[column] === undefined ? <span className="null-value">NULL</span> : typeof row[column] === 'number' ? <span className="number-value">{Number.isInteger(row[column]) ? row[column].toLocaleString() : row[column].toFixed(2)}</span> : formatCell(row[column])}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

function Home() {
  const [sql, setSql] = useState(defaultQuery);
  const [result, setResult] = useState<QueryResult>({ status: 'empty', duration: 0, rows: [], columns: [] });
  const [running, setRunning] = useState(false);
  const [copied, setCopied] = useState<'query' | 'results' | null>(null);
  const [activeTable, setActiveTable] = useState('sales');
  const [source, setSource] = useState<SqliteSource | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [snippetCopied, setSnippetCopied] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const sourceRef = useRef<SqliteSource | null>(null);
  const [compact, setCompact] = useState(() => {
    const embed = new URLSearchParams(window.location.search).get('embed');
    return embed === '1' || embed === 'compact';
  });
  const lineCount = useMemo(() => Math.max(1, sql.split('\n').length), [sql]);

  useEffect(() => {
    let cancelled = false;
    void loadSqlJs().then((SQL) => {
      if (cancelled) return;
      const next = createSource(SQL, 'sample_db', sampleDatabase, true);
      sourceRef.current = next;
      setSource(next);
      setResult(executeSql(defaultQuery, next));
    }).catch((error) => {
      if (!cancelled) setUploadError(error instanceof Error ? `Could not load browser SQLite: ${error.message}` : 'Could not load browser SQLite.');
    });
    return () => {
      cancelled = true;
      sourceRef.current?.db.close();
      sourceRef.current = null;
    };
  }, []);

  const replaceSource = useCallback((next: SqliteSource) => {
    sourceRef.current?.db.close();
    sourceRef.current = next;
    setSource(next);
  }, []);

  const runQuery = useCallback(() => {
    const currentSource = source;
    setRunning(true);
    window.setTimeout(() => { setResult(executeSql(sql, currentSource)); setRunning(false); }, 180);
  }, [sql, source]);

  const clearQuery = useCallback(() => { setSql(''); setResult({ status: 'empty', duration: 0, rows: [], columns: [] }); }, []);

  const useSampleDatabase = useCallback(() => {
    void loadSqlJs().then((SQL) => {
      const next = createSource(SQL, 'sample_db', sampleDatabase, true);
      replaceSource(next);
       setActiveTable('sales');
      setUploadError(null);
      setSql(defaultQuery);
      setResult(executeSql(defaultQuery, next));
    }).catch((error) => setUploadError(error instanceof Error ? error.message : 'Could not load the sample database.'));
  }, [replaceSource]);

  const uploadDatabase = async (file: File) => {
    try {
      const SQL = await loadSqlJs();
      const next = await readDatabaseFile(file, SQL);
      const firstTable = next.tables[0]?.name;
      if (!firstTable) throw new Error('No tables were found in that file.');
      replaceSource(next);
      setActiveTable(firstTable);
      setUploadError(null);
      const nextQuery = `SELECT * FROM ${quoteIdentifier(firstTable)} LIMIT 10;`;
      setSql(nextQuery);
      setResult(executeSql(nextQuery, next));
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : 'Could not read that file.');
    }
  };

  const handleCopy = (kind: 'query' | 'results') => {
    const text = kind === 'query' ? sql : result.rows.map((row) => result.columns.map((column) => row[column] instanceof Uint8Array ? `[blob · ${row[column].byteLength} bytes]` : row[column] ?? 'NULL').join('\t')).join('\n');
    copyText(text);
    setCopied(kind);
    window.setTimeout(() => setCopied(null), 1400);
  };

  const toggleCompact = () => {
    const nextCompact = !compact;
    setCompact(nextCompact);
    const url = new URL(window.location.href);
    if (nextCompact) url.searchParams.set('embed', '1');
    else url.searchParams.delete('embed');
    window.history.replaceState({}, '', url);
  };

  const shareSnippet = useMemo(() => {
    const embedUrl = new URL(window.location.href);
    embedUrl.search = '';
    embedUrl.hash = '';
    embedUrl.searchParams.set('embed', '1');
    return `<iframe
  src="${embedUrl.toString()}"
  title="Query bench SQL runner"
  width="100%"
  height="640"
  style="border: 0; border-radius: 8px;"
  loading="lazy"
></iframe>`;
  }, []);

  const copySnippet = () => {
    copyText(shareSnippet);
    setSnippetCopied(true);
    window.setTimeout(() => setSnippetCopied(false), 1600);
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); runQuery(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [runQuery]);

  const statusLabel = running ? 'Executing' : result.status === 'error' ? 'Query error' : result.status === 'empty' ? 'Ready' : 'Success';
  const resultText = result.status === 'success' ? `${result.rows.length} row${result.rows.length === 1 ? '' : 's'} returned` : result.status === 'error' ? 'Fix the query and run it again' : 'Awaiting a query';
  const databaseName = source?.name ?? 'sample_db';
  return (
    <main className={`runner-shell ${compact ? 'compact-mode' : ''}`}>
      <header className="topbar">
        <div className="brand"><div className="brand-mark">SQL</div><span className="brand-name">Query bench</span><span className="brand-subtitle">an embeddable runner</span></div>
        <div className="top-actions">
          {compact && <button className="compact-upload-button" type="button" onClick={() => fileInputRef.current?.click()} data-testid="button-compact-upload"><Upload size={13} /> upload data</button>}
          <button className="share-toggle" type="button" onClick={() => { setShareOpen((open) => !open); setAboutOpen(false); }} aria-expanded={shareOpen} data-testid="button-share-runner"><Share2 size={14} /> share runner</button>
          <button className={`embed-cue embed-toggle ${compact ? 'is-active' : ''}`} type="button" onClick={toggleCompact} aria-pressed={compact} title={compact ? 'Exit compact embed mode' : 'Open compact embed mode'} data-testid="button-compact-mode"><Code2 size={13} /> {compact ? 'exit compact' : 'compact embed'}</button>
          <button className="icon-button" type="button" title="About this runner" onClick={() => { setAboutOpen((open) => !open); setShareOpen(false); }} aria-expanded={aboutOpen} data-testid="button-about"><CircleHelp size={17} /></button>
          {shareOpen && <div className="share-panel" role="dialog" aria-label="Share this runner" data-testid="panel-share-runner"><div className="share-panel-heading"><div><strong>Share this runner</strong><span>Drop it into your docs.</span></div><button className="share-close" type="button" onClick={() => setShareOpen(false)} aria-label="Close share panel">×</button></div><p>Use the iframe snippet below to embed the workbench wherever your team reads documentation.</p><div className="snippet-wrap"><textarea readOnly value={shareSnippet} aria-label="Iframe embed snippet" data-testid="text-iframe-snippet" /><button className="snippet-copy" type="button" onClick={copySnippet} data-testid="button-copy-iframe-snippet">{snippetCopied ? <Check size={13} /> : <Copy size={13} />}{snippetCopied ? 'copied' : 'copy snippet'}</button></div><div className="share-panel-note"><span className="status-dot" /> Includes compact mode and runs locally in the browser.</div></div>}
          {aboutOpen && <div className="about-popover" role="status" data-testid="text-about-runner"><strong>Query bench</strong><span>A tiny SELECT-only workspace for local databases. Add <code>?embed=1</code> to open the compact iframe view. No data leaves this page.</span></div>}
        </div>
      </header>
      <div className="workspace">
        <SchemaPanel activeTable={activeTable} setActiveTable={setActiveTable} source={source} onUseSample={useSampleDatabase} onUpload={() => fileInputRef.current?.click()} uploadError={uploadError} />
        <input ref={fileInputRef} type="file" accept=".csv,.json,.sqlite,.db,text/csv,application/json,application/x-sqlite3" className="file-input" onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadDatabase(file); event.target.value = ''; }} aria-label="Upload CSV, JSON, or SQLite data" />
        <section className="main-column">
          <div className="intro-row">
            <div><div className="eyebrow">Local playground / 01</div><h1>Ask the {databaseName}.</h1><p>Write a focused query, run it against local relational data, and read the result without leaving the page.</p></div>
            <div className="database-badge"><span className="status-dot" /> {databaseName} <span style={{ color: 'var(--muted)' }}>in browser</span></div>
          </div>
          <section className="editor-card" aria-label="SQL editor">
            <div className="card-bar"><div className="card-title"><Braces size={15} /> query.sql <span className="card-meta">— read-only connection</span></div><button className="copy-button" type="button" onClick={() => handleCopy('query')} data-testid="button-copy-query">{copied === 'query' ? <Check size={13} /> : <Copy size={13} />}{copied === 'query' ? 'copied' : 'copy query'}</button></div>
            <div className="editor-wrap">
              <div className="line-numbers" aria-hidden="true">{Array.from({ length: lineCount }, (_, index) => <div key={index}>{String(index + 1).padStart(2, '0')}</div>)}</div>
              <textarea className="sql-editor" value={sql} onChange={(event) => setSql(event.target.value)} spellCheck={false} aria-label="SQL query" data-testid="input-sql-query" />
            </div>
            <div className="editor-footer"><span className="shortcut"><span className="key">⌘</span><span className="key">↵</span> to run</span><div className="editor-actions"><button className="clear-button" type="button" onClick={clearQuery} data-testid="button-clear-query"><RotateCcw size={13} /> clear</button><button className={`run-button ${running ? 'is-running' : ''}`} type="button" onClick={runQuery} disabled={running} data-testid="button-run-query"><Play size={13} fill="currentColor" />{running ? 'running' : 'run query'}</button></div></div>
          </section>
          <section className="results-card" aria-label="Query results">
            <div className="card-bar">
              <div className="results-heading"><div className={`result-status ${running ? 'running' : result.status}`} data-testid="status-query-result">{running ? <Timer size={14} /> : result.status === 'error' ? <AlertCircle size={14} /> : <Check size={14} />}{statusLabel}</div><div className="result-stats"><span><b>{result.status === 'success' ? result.rows.length : '—'}</b> rows</span><span><b>{running ? '—' : `${result.duration} ms`}</b> duration</span><span>{resultText}</span></div></div>
              <button className="copy-button" type="button" onClick={() => handleCopy('results')} disabled={!result.rows.length} data-testid="button-copy-results">{copied === 'results' ? <Check size={13} /> : <Clipboard size={13} />}{copied === 'results' ? 'copied' : 'copy results'}</button>
            </div>
            <ResultTable result={result} />
          </section>
          <div className="footer-note"><span><Zap size={11} style={{ verticalAlign: '-2px', marginRight: 4 }} />No network request • safe SELECT sandbox</span><span>v0.5 / browser SQLite</span></div>
        </section>
      </div>
    </main>
  );
}

function App() {
  return <QueryClientProvider client={queryClient}><TooltipProvider><ErrorBoundary><Home /></ErrorBoundary><Toaster /></TooltipProvider></QueryClientProvider>;
}

export default App;