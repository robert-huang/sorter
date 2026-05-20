import { useMemo, useRef, useState } from 'react';
import type { Item, SlotMeta } from '../lib/types';
import {
  looksLikeHeader,
  parseCsvRows,
  parseExtrasText,
  parseSources,
  type RawRow,
  type SourceParse,
} from '../lib/csv';
import { ImportPreview, type PreviewSource } from './ImportPreview';
import Papa from 'papaparse';

type Mode = 'scratch' | 'preranked';

interface Props {
  /** Meta of the last-used slot we can resume; null when nothing to resume. */
  resumeMeta: SlotMeta | null;
  onResumeActive: () => void;
  onStartScratch: (items: Item[]) => void;
  onStartPreranked: (args: { sublists: Item[][]; extras: Item[] }) => void;
}

interface StagedFile {
  id: string;
  name: string;
  text: string;
  skipHeader: boolean;
  detectedHeader: boolean;
}

function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function StartScreen({
  resumeMeta,
  onResumeActive,
  onStartScratch,
  onStartPreranked,
}: Props) {
  const [mode, setMode] = useState<Mode>('scratch');

  // -------- scratch mode --------
  const [scratchText, setScratchText] = useState('');
  const [scratchSkipHeader, setScratchSkipHeader] = useState(false);
  const scratchFileRef = useRef<HTMLInputElement | null>(null);
  const scratchDetectedHeader = useMemo(() => {
    if (!scratchText.trim()) return false;
    const parsed = Papa.parse<string[]>(scratchText, {
      skipEmptyLines: 'greedy',
      preview: 1,
    });
    const first = parsed.data?.[0];
    return Array.isArray(first) ? looksLikeHeader(first) : false;
  }, [scratchText]);

  const scratchParsed = useMemo(() => {
    if (!scratchText.trim()) {
      return { rows: [] as RawRow[], detectedHeader: false };
    }
    return parseCsvRows(scratchText, 'pasted CSV', scratchSkipHeader);
  }, [scratchText, scratchSkipHeader]);

  const scratchSources: SourceParse[] = useMemo(
    () =>
      scratchParsed.rows.length > 0
        ? [
            {
              sourceName: 'pasted CSV',
              rawRows: scratchParsed.rows,
              detectedHeader: scratchParsed.detectedHeader,
            },
          ]
        : [],
    [scratchParsed],
  );

  const scratchResult = useMemo(
    () => parseSources(scratchSources),
    [scratchSources],
  );

  function onScratchFile(e: React.ChangeEvent<HTMLInputElement>): void {
    const file = e.target.files?.[0];
    if (!file) return;
    file.text().then((t) => setScratchText(t));
    e.target.value = '';
  }

  function onStartScratchClick(): void {
    onStartScratch(scratchResult.items);
  }

  const scratchPreviewSources: PreviewSource[] = useMemo(() => {
    if (scratchResult.perSource.length === 0) return [];
    return scratchResult.perSource;
  }, [scratchResult]);

  // -------- pre-ranked mode --------
  const [stagedFiles, setStagedFiles] = useState<StagedFile[]>([]);
  const [extrasText, setExtrasText] = useState('');
  const [extrasSkipHeader, setExtrasSkipHeader] = useState(false);
  const prerankedFilesRef = useRef<HTMLInputElement | null>(null);

  const extrasDetectedHeader = useMemo(() => {
    if (!extrasText.trim()) return false;
    const parsed = Papa.parse<string[]>(extrasText, {
      skipEmptyLines: 'greedy',
      preview: 1,
    });
    const first = parsed.data?.[0];
    return Array.isArray(first) ? looksLikeHeader(first) : false;
  }, [extrasText]);

  function onPrerankedFiles(e: React.ChangeEvent<HTMLInputElement>): void {
    const files = e.target.files;
    if (!files) return;
    const promises = Array.from(files).map((f) =>
      f.text().then((t): StagedFile => {
        const parsed = Papa.parse<string[]>(t, {
          skipEmptyLines: 'greedy',
          preview: 1,
        });
        const first = parsed.data?.[0];
        const detected = Array.isArray(first) ? looksLikeHeader(first) : false;
        return {
          id: uid(),
          name: f.name,
          text: t,
          skipHeader: false,
          detectedHeader: detected,
        };
      }),
    );
    Promise.all(promises).then((arr) => {
      setStagedFiles((prev) => [...prev, ...arr]);
    });
    e.target.value = '';
  }

  function setStagedSkipHeader(id: string, skip: boolean): void {
    setStagedFiles((prev) =>
      prev.map((f) => (f.id === id ? { ...f, skipHeader: skip } : f)),
    );
  }

  function removeStaged(id: string): void {
    setStagedFiles((prev) => prev.filter((f) => f.id !== id));
  }

  const prerankedResult = useMemo(() => {
    const sources: SourceParse[] = stagedFiles.map((f) => {
      const r = parseCsvRows(f.text, f.name, f.skipHeader);
      return {
        sourceName: f.name,
        rawRows: r.rows,
        detectedHeader: r.detectedHeader,
      };
    });

    // Extras: treat the extras textarea as either a 1-column or multi-column
    // CSV depending on what was typed. If it parses as a CSV with URL/IMAGE
    // columns we honor them; otherwise treat each line as a label only.
    const extrasParsed = extrasText.trim()
      ? parseCsvRows(extrasText, 'extras', extrasSkipHeader)
      : { rows: [] as RawRow[], detectedHeader: false };
    if (extrasParsed.rows.length === 0 && extrasText.trim()) {
      const plain = parseExtrasText(extrasText);
      if (plain.length > 0) {
        sources.push({
          sourceName: 'extras',
          rawRows: plain,
          detectedHeader: false,
        });
      }
    } else if (extrasParsed.rows.length > 0) {
      sources.push({
        sourceName: 'extras',
        rawRows: extrasParsed.rows,
        detectedHeader: extrasParsed.detectedHeader,
      });
    }

    const result = parseSources(sources);
    // Split per-source items back into sublists vs extras using the per-source
    // list. The extras source is the one named 'extras'; everything else is a
    // sublist. We also need to filter the global deduped items down so each
    // appears exactly once (in the FIRST source that contained it).
    const seen = new Set<string>();
    const sublists: Item[][] = [];
    let extras: Item[] = [];
    for (const ps of result.perSource) {
      const isExtras = ps.sourceName === 'extras';
      const taken: Item[] = [];
      for (const it of ps.items) {
        if (seen.has(it.id)) continue;
        seen.add(it.id);
        // Use the FULLY-merged item from the global dedup (it may have URL/
        // IMAGE filled in from a later source).
        const merged = result.items.find((m) => m.id === it.id) ?? it;
        taken.push(merged);
      }
      if (isExtras) {
        extras = taken;
      } else if (taken.length > 0) {
        sublists.push(taken);
      }
    }
    return {
      items: result.items,
      warnings: result.warnings,
      perSource: result.perSource,
      sublists,
      extras,
    };
  }, [stagedFiles, extrasText, extrasSkipHeader]);

  function onStartPrerankedClick(): void {
    onStartPreranked({
      sublists: prerankedResult.sublists,
      extras: prerankedResult.extras,
    });
  }

  // -------- render --------

  return (
    <div className="page">
      {resumeMeta && (
        <div className="resume-cta">
          <div className="grow">
            <div className="title">
              Resume{' '}
              <span className="resume-cta-slot-name">{resumeMeta.name}</span>{' '}
              {resumeMeta.done
                ? '(completed)'
                : `(${resumeMeta.comparisons} comparison${resumeMeta.comparisons === 1 ? '' : 's'} in)`}
            </div>
            <div className="sub">
              {resumeMeta.totalItems} items — last used slot. Other saved
              sorts are in the ⚙ gear menu.
            </div>
          </div>
          <button className="btn primary" onClick={onResumeActive}>
            Resume
          </button>
        </div>
      )}

      <div className="start-mode-toggle" role="tablist">
        <button
          role="tab"
          aria-selected={mode === 'scratch'}
          className={mode === 'scratch' ? 'active' : ''}
          onClick={() => setMode('scratch')}
        >
          Sort from scratch
        </button>
        <button
          role="tab"
          aria-selected={mode === 'preranked'}
          className={mode === 'preranked' ? 'active' : ''}
          onClick={() => setMode('preranked')}
        >
          Merge pre-ranked lists
        </button>
      </div>

      {mode === 'scratch' && (
        <div className="page-section">
          <h2>Sort from scratch</h2>
          <p className="csv-hint">
            One item per row. Format: <code>ITEM, URL (optional), IMAGE (optional)</code>
          </p>
          <textarea
            className="csv-textarea"
            placeholder={`Pit, https://example.com/pit, https://example.com/pit.jpg\nThe Mind, , https://example.com/mind.jpg\nCodenames`}
            value={scratchText}
            onChange={(e) => setScratchText(e.target.value)}
          />
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button
              className="btn"
              onClick={() => scratchFileRef.current?.click()}
            >
              Load CSV file…
            </button>
            <input
              ref={scratchFileRef}
              type="file"
              accept=".csv,text/csv,text/plain"
              style={{ display: 'none' }}
              onChange={onScratchFile}
            />
          </div>
          <div className="checkbox-row">
            <input
              id="scratch-header"
              type="checkbox"
              checked={scratchSkipHeader}
              onChange={(e) => setScratchSkipHeader(e.target.checked)}
            />
            <label htmlFor="scratch-header">First row is a header</label>
            {scratchDetectedHeader && !scratchSkipHeader && (
              <span className="header-hint">
                ⓘ Your first row looks like a header. Check the box to skip it.
              </span>
            )}
          </div>
          <ImportPreview
            sources={scratchPreviewSources}
            totalItems={scratchResult.items.length}
            warnings={scratchResult.warnings}
            startLabel={`Start sorting (${scratchResult.items.length} item${scratchResult.items.length === 1 ? '' : 's'})`}
            startDisabled={scratchResult.items.length < 2}
            onStart={onStartScratchClick}
          />
        </div>
      )}

      {mode === 'preranked' && (
        <div className="page-section">
          <h2>Merge pre-ranked lists</h2>
          <p className="csv-hint">
            Upload one or more CSVs. Each file is treated as a sorted list; the
            row order is the user's expressed ranking within that file.
          </p>
          <div>
            <button
              className="btn"
              onClick={() => prerankedFilesRef.current?.click()}
            >
              Add CSV file(s)…
            </button>
            <input
              ref={prerankedFilesRef}
              type="file"
              accept=".csv,text/csv,text/plain"
              multiple
              style={{ display: 'none' }}
              onChange={onPrerankedFiles}
            />
          </div>
          {stagedFiles.length > 0 && (
            <div className="file-list">
              {stagedFiles.map((f) => (
                <div className="file-row" key={f.id}>
                  <div className="info">
                    <div className="name">{f.name}</div>
                    <div className="meta">{f.text.length} bytes</div>
                    <div className="checkbox-row">
                      <input
                        id={`hdr-${f.id}`}
                        type="checkbox"
                        checked={f.skipHeader}
                        onChange={(e) =>
                          setStagedSkipHeader(f.id, e.target.checked)
                        }
                      />
                      <label htmlFor={`hdr-${f.id}`}>
                        First row is a header
                      </label>
                      {f.detectedHeader && !f.skipHeader && (
                        <span className="header-hint">
                          ⓘ Looks like a header. Check to skip.
                        </span>
                      )}
                    </div>
                  </div>
                  <button
                    className="x-button"
                    onClick={() => removeStaged(f.id)}
                    aria-label={`Remove ${f.name}`}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}

          <div style={{ marginTop: 18 }}>
            <h2 style={{ fontSize: 14, color: 'var(--text-muted)' }}>
              Extras (unranked, optional)
            </h2>
            <p className="csv-hint">
              One label per line (or full CSV rows). These become singleton
              sublists at the <em>front</em> of the queue and get merged first.
            </p>
            <textarea
              className="csv-textarea"
              placeholder={`The Mind\nPit\nCodenames`}
              value={extrasText}
              onChange={(e) => setExtrasText(e.target.value)}
              style={{ minHeight: 100 }}
            />
            <div className="checkbox-row">
              <input
                id="extras-header"
                type="checkbox"
                checked={extrasSkipHeader}
                onChange={(e) => setExtrasSkipHeader(e.target.checked)}
              />
              <label htmlFor="extras-header">First row is a header</label>
              {extrasDetectedHeader && !extrasSkipHeader && (
                <span className="header-hint">
                  ⓘ Looks like a header. Check to skip.
                </span>
              )}
            </div>
          </div>

          <ImportPreview
            sources={prerankedResult.perSource}
            totalItems={prerankedResult.items.length}
            warnings={prerankedResult.warnings}
            sublistCount={prerankedResult.sublists.length}
            singletonCount={prerankedResult.extras.length}
            startLabel={`Start sorting (${prerankedResult.items.length} item${prerankedResult.items.length === 1 ? '' : 's'})`}
            startDisabled={prerankedResult.items.length < 2}
            onStart={onStartPrerankedClick}
          />
        </div>
      )}
    </div>
  );
}
