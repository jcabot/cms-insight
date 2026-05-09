import { useEffect, useRef, useState } from 'react';
import type { SiteSummary } from '../api/client.js';

interface Props {
  site: SiteSummary;
  isFirst: boolean;
  isLast: boolean;
  onActivate(): void;
  onRename(label: string): void;
  onRemove(): void;
  onMove(direction: -1 | 1): void;
  onDragStart(e: React.DragEvent<HTMLLIElement>): void;
  onDragOver(e: React.DragEvent<HTMLLIElement>): void;
  onDrop(e: React.DragEvent<HTMLLIElement>): void;
  onDragEnd(): void;
  isDragOver: boolean;
}

function relativeTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const diff = Date.now() - t;
  const sec = Math.round(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  return iso.slice(0, 10);
}

export function SiteCard(props: Props): React.ReactElement {
  const {
    site,
    isFirst,
    isLast,
    onActivate,
    onRename,
    onRemove,
    onMove,
    onDragStart,
    onDragOver,
    onDrop,
    onDragEnd,
    isDragOver,
  } = props;
  const [editing, setEditing] = useState(false);
  const [labelDraft, setLabelDraft] = useState(site.label);
  const [menuOpen, setMenuOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const cardRef = useRef<HTMLLIElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent): void => {
      if (cardRef.current && !cardRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [menuOpen]);

  function commitLabel(): void {
    const trimmed = labelDraft.trim();
    setEditing(false);
    if (trimmed && trimmed !== site.label) onRename(trimmed);
    else setLabelDraft(site.label);
  }

  function handleRemove(): void {
    setMenuOpen(false);
    if (window.confirm(`Remove "${site.label}" from this dashboard? Its analysis history on disk is preserved.`)) {
      onRemove();
    }
  }

  const analysisRows = Object.entries(site.lastAnalyses);

  return (
    <li
      ref={cardRef}
      className={`site-card${site.isActive ? ' active' : ''}${isDragOver ? ' drag-over' : ''}`}
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      data-site-id={site.id}
    >
      <span className="drag-handle" aria-hidden title="Drag to reorder">
        ⋮⋮
      </span>

      <div className="site-card-main">
        <div className="site-card-head">
          {editing ? (
            <input
              ref={inputRef}
              className="site-label-input"
              value={labelDraft}
              onChange={(e) => setLabelDraft(e.target.value)}
              onBlur={commitLabel}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitLabel();
                if (e.key === 'Escape') {
                  setLabelDraft(site.label);
                  setEditing(false);
                }
              }}
              autoFocus
            />
          ) : (
            <button
              type="button"
              className="site-label"
              onClick={() => {
                setLabelDraft(site.label);
                setEditing(true);
              }}
              title="Click to rename"
            >
              {site.label}
            </button>
          )}
          <span className="site-relpath mono">{site.relPath}/</span>
          {typeof site.postCount === 'number' && (
            <span className="site-postcount">
              {site.postCount} {site.postCount === 1 ? 'post' : 'posts'}
            </span>
          )}
        </div>

        {analysisRows.length > 0 ? (
          <ul className="site-analyses">
            {analysisRows.map(([pluginId, summary]) => (
              <li key={pluginId}>
                <span className="plugin-name">{pluginId}</span>
                <span className="sep" aria-hidden>·</span>
                <span className="headline">{summary.headline}</span>
                <span className="sep" aria-hidden>·</span>
                <span className="when muted" title={summary.finishedAt}>
                  {relativeTime(summary.finishedAt)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="site-empty muted">No analyses run yet.</p>
        )}
      </div>

      <div className="site-card-actions">
        {site.isActive ? (
          <span className="active-pill">Active</span>
        ) : (
          <button type="button" className="primary set-active" onClick={onActivate}>
            Set active
          </button>
        )}

        <div className="reorder-buttons" role="group" aria-label="Reorder">
          <button
            type="button"
            disabled={isFirst}
            onClick={() => onMove(-1)}
            aria-label="Move up"
            title="Move up"
          >
            ↑
          </button>
          <button
            type="button"
            disabled={isLast}
            onClick={() => onMove(1)}
            aria-label="Move down"
            title="Move down"
          >
            ↓
          </button>
        </div>

        <div className="kebab">
          <button
            type="button"
            className="kebab-trigger"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
            title="More"
          >
            ⋯
          </button>
          {menuOpen && (
            <ul className="kebab-menu" role="menu">
              <li role="menuitem">
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    setLabelDraft(site.label);
                    setEditing(true);
                  }}
                >
                  Rename
                </button>
              </li>
              <li role="menuitem">
                <button type="button" className="danger" onClick={handleRemove}>
                  Remove
                </button>
              </li>
            </ul>
          )}
        </div>
      </div>
    </li>
  );
}
