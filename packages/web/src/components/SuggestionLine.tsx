import type { LinkSuggestion } from '../api/client.js';

export function SuggestionLine({
  suggestion,
}: {
  suggestion: LinkSuggestion;
}): React.ReactElement | null {
  if (suggestion.confirmed === 'cleaned') return null;
  if (!suggestion.url) {
    return (
      <span className="suggestion-line none" title={suggestion.note ?? ''}>
        ✗ no replacement found{suggestion.note ? ` — ${suggestion.note}` : ''}
      </span>
    );
  }
  const conf = suggestion.confidence;
  return (
    <span className={`suggestion-line ${conf}`}>
      <span className="sugg-icon">✨</span>
      <a href={suggestion.url} target="_blank" rel="noreferrer noopener" className="sugg-url">
        {suggestion.url}
      </a>
      <span className={`sugg-conf conf-${conf}`}>{conf}</span>
      {suggestion.note && <span className="sugg-note">— {suggestion.note}</span>}
    </span>
  );
}
