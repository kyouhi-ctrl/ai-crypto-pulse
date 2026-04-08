#!/usr/bin/env node
/**
 * AI + Crypto News Aggregator
 * Fetches trending data from multiple sources, writes to data/news.json
 * Then commits and pushes to GitHub for Cloudflare Pages deployment.
 */

import { writeFileSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, 'data');
const OUTPUT_FILE = join(DATA_DIR, 'news.json');

mkdirSync(DATA_DIR, { recursive: true });

// ─── Hacker News ───────────────────────────────────────────────
async function fetchHackerNews() {
  const res = await fetch('https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=15');
  const json = await res.json();
  return json.hits.map(h => ({
    title: h.title,
    url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
    score: h.points || 0,
    source: 'Hacker News',
    time: new Date(h.created_at).toISOString(),
  }));
}

// ─── GitHub Trending (by recent stars) ──────────────────────────
async function fetchGitHubTrending() {
  const res = await fetch(
    'https://api.github.com/search/repositories?q=pushed:>2026-04-01&sort=stars&order=desc&per_page=15',
    { headers: { 'User-Agent': 'news-aggregator', 'Accept': 'application/vnd.github.v3+json' } }
  );
  const json = await res.json();
  return (json.items || []).map(r => ({
    title: r.full_name,
    description: r.description,
    url: r.html_url,
    score: r.stargazers_count,
    source: 'GitHub',
    time: r.pushed_at,
  }));
}

// ─── CoinGecko Trending ─────────────────────────────────────────
async function fetchCoinGeckoTrending() {
  try {
    const res = await fetch('https://api.coingecko.com/api/v3/search/trending');
    const json = await res.json();
    return (json.coins || []).slice(0, 10).map(c => ({
      title: c.item.name + ' (' + c.item.symbol.toUpperCase() + ')',
      url: `https://www.coingecko.com/en/coins/${c.item.id}`,
      score: c.item.market_cap_rank || 0,
      source: 'CoinGecko',
      time: new Date().toISOString(),
    }));
  } catch {
    return [];
  }
}

// ─── Reddit r/CryptoCurrency ─────────────────────────────────────
async function fetchRedditCrypto() {
  try {
    const res = await fetch('https://www.reddit.com/r/CryptoCurrency/hot.json?limit=10', {
      headers: { 'User-Agent': 'news-aggregator/1.0' }
    });
    const json = await res.json();
    return (json.data?.children || []).map(p => ({
      title: p.data.title,
      url: `https://reddit.com${p.data.permalink}`,
      score: p.data.score || 0,
      source: 'Reddit',
      time: new Date(p.data.created_utc * 1000).toISOString(),
    }));
  } catch {
    return [];
  }
}

// ─── ArXiv AI Papers ────────────────────────────────────────────
async function fetchArxivAI() {
  try {
    const res = await fetch(
      'https://export.arxiv.org/api/query?search_query=cat:cs.AI&sortBy=submittedDate&sortOrder=descending&max_results=10'
    );
    const text = await res.text();
    const items = [];
    const regex = /<entry>[\s\S]*?<title>([\s\S]*?)<\/title>[\s\S]*?<id>([\s\S]*?)<\/id>[\s\S]*?<\/entry>/g;
    let match;
    while ((match = regex.exec(text)) !== null && items.length < 8) {
      items.push({
        title: match[1].replace(/<[^>]+>/g, '').trim(),
        url: match[2].trim(),
        score: 0,
        source: 'ArXiv',
        time: new Date().toISOString(),
      });
    }
    return items;
  } catch {
    return [];
  }
}

// ─── GitHub push helper ─────────────────────────────────────────
function gitPush() {
  try {
    execSync('git add data/news.json', { cwd: __dirname });
    const diff = execSync('git diff --staged --stat', { cwd: __dirname }).toString();
    if (!diff) {
      console.log('[Git] No changes to commit.');
      return;
    }
    execSync('git commit -m "Update news data ' + new Date().toISOString() + '"', { cwd: __dirname });
    execSync('git push origin main', { cwd: __dirname });
    console.log('[Git] Pushed successfully.');
  } catch (e) {
    console.error('[Git] Push failed:', e.message);
  }
}

// ─── Main ───────────────────────────────────────────────────────
async function main() {
  console.log('[Aggregator] Starting fetch...');
  const start = Date.now();

  const [hn, gh, cg, reddit, arxiv] = await Promise.allSettled([
    fetchHackerNews(),
    fetchGitHubTrending(),
    fetchCoinGeckoTrending(),
    fetchRedditCrypto(),
    fetchArxivAI(),
  ]);

  const result = {
    updatedAt: new Date().toISOString(),
    ai: {
      hackerNews: hn.status === 'fulfilled' ? hn.value : [],
      github: gh.status === 'fulfilled' ? gh.value : [],
      arxiv: arxiv.status === 'fulfilled' ? arxiv.value : [],
    },
    crypto: {
      coingecko: cg.status === 'fulfilled' ? cg.value : [],
      reddit: reddit.status === 'fulfilled' ? reddit.value : [],
    },
  };

  writeFileSync(OUTPUT_FILE, JSON.stringify(result, null, 2));
  const elapsed = Date.now() - start;
  console.log(`[Aggregator] Done in ${elapsed}ms.`);
  console.log(`  AI: HN=${result.ai.hackerNews.length} GH=${result.ai.github.length} arXiv=${result.ai.arxiv.length}`);
  console.log(`  Crypto: CG=${result.crypto.coingecko.length} Reddit=${result.crypto.reddit.length}`);

  // Auto-push to GitHub if inside a git repo
  try {
    execSync('git rev-parse --is-inside-work-tree', { cwd: __dirname, stdio: 'ignore' });
    gitPush();
  } catch {
    // Not in a git repo, skip push
    console.log('[Git] Not a git repo, skipping push.');
  }
}

main().catch(console.error);
