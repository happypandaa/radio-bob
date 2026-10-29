// Match an AI-recommended song ({title, artist}) to a NetEase search result.
// NetEase titles often carry suffixes such as "(2013 Remaster)" or " - Live",
// and artists are joined with " / ". A strict equality check rejects many
// correct results, while a loose one picks covers or live takes.

// A different performance: only acceptable when the listener asked for it.
const ALTERNATE = /\b(?:live|demo|instrumental|karaoke|remix|cover|acoustic|take)\b|现场|伴奏|翻唱|翻自|纯音乐|dj版|消音/i;
// The same recording re-released: a small tie-breaker only.
const REISSUE = /\b(?:remaster(?:ed)?|mono|stereo|edit|deluxe|anniversary)\b|重制|修复/i;

export function normalize(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

/** Remove bracketed and dash-separated version suffixes from a title. */
export function baseTitle(title) {
  const value = String(title ?? '').normalize('NFKC');
  const stripped = value
    .replace(/\s*[(\[（【「][^)\]）】」]*[)\]）】」]\s*/g, ' ')
    .replace(/\s+[-–—~]\s+.*$/, '')
    .trim();
  return stripped || value.trim();
}

function artistNames(artist) {
  return String(artist ?? '').normalize('NFKC')
    .split(/\s*(?:\/|,|，|、|&|;|；|\bfeat\.?|\bft\.?|\bwith\b)\s*/i)
    .map(name => normalize(name.replace(/^the\s+/i, '')))
    .filter(Boolean);
}

function artistScore(requested, candidate) {
  const wanted = artistNames(requested);
  const found = artistNames(candidate);
  if (!wanted.length || !found.length) return 0;
  let best = 0;
  for (const a of wanted) for (const b of found) {
    if (a === b) best = Math.max(best, 1);
    else if (Math.min(a.length, b.length) >= 2 && (a.includes(b) || b.includes(a))) best = Math.max(best, 0.5);
  }
  return best;
}

function titleScore(requested, candidate) {
  const exactWanted = normalize(requested);
  const exactFound = normalize(candidate);
  if (!exactWanted || !exactFound) return 0;
  if (exactWanted === exactFound) return 3;
  const wanted = normalize(baseTitle(requested));
  const found = normalize(baseTitle(candidate));
  if (wanted && wanted === found) return 2;
  // A short title such as "Ok" must not prefix-match "Okie From Muskogee".
  if (Math.min(wanted.length, found.length) >= 4 && (found.startsWith(wanted) || wanted.startsWith(found))) return 1;
  return 0;
}

/** Score a candidate; 0 means it must not be used. */
export function scoreMatch(requested, candidate) {
  const title = titleScore(requested?.title, candidate?.title);
  if (!title) return 0;
  const artist = artistScore(requested?.artist, candidate?.artist);
  if (!artist) return 0;
  const wanted = String(requested?.title ?? '');
  const found = String(candidate?.title ?? '');
  let penalty = 0;
  if (title < 3 && ALTERNATE.test(found) && !ALTERNATE.test(wanted)) penalty += 1.5;
  if (title < 3 && REISSUE.test(found) && !REISSUE.test(wanted)) penalty += 0.25;
  return title + artist - penalty;
}

/** Highest-scoring candidate; ties keep the search engine's order. */
export function bestMatch(requested, candidates) {
  let best = null;
  let bestScore = 0;
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const score = scoreMatch(requested, candidate);
    if (score > bestScore) { best = candidate; bestScore = score; }
  }
  return best;
}
