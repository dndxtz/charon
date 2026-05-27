import axios from 'axios';
import { now } from '../utils.js';

// Cache: tweet URL → { data, timestamp }
const tweetCache = new Map();
const TWEET_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function getCachedTweet(url) {
  const entry = tweetCache.get(url);
  if (!entry) return null;
  if (now() - entry.timestamp > TWEET_CACHE_TTL_MS) {
    tweetCache.delete(url);
    return null;
  }
  return entry.data;
}

function setCachedTweet(url, data) {
  tweetCache.set(url, { data, timestamp: now() });
  // Prune oldest entries if cache too large
  if (tweetCache.size > 500) {
    const oldest = tweetCache.keys().next().value;
    tweetCache.delete(oldest);
  }
}

function extractTweetUrl(input) {
  const urls = [
    input?.twitter,
    input?.twitter_username,
    input?.link?.twitter_username,
  ].filter(Boolean).map(String);
  const raw = urls.find(url => /(?:^|\/)status\/\d+/.test(url)) || '';
  if (!raw) return null;
  if (raw.startsWith('i/') || raw.startsWith('communities/')) return null;
  if (raw.startsWith('http')) return raw.replace(/^https?:\/\/(www\.)?twitter\.com/i, 'https://x.com');
  return `https://x.com/${raw.replace(/^@/, '')}`;
}

function toFxTwitter(url) {
  return String(url || '')
    .replace(/^https?:\/\/(www\.)?x\.com/i, 'https://fxtwitter.com')
    .replace(/^https?:\/\/(www\.)?twitter\.com/i, 'https://fxtwitter.com');
}

function toFxTwitterApi(url) {
  return String(url || '')
    .replace(/^https?:\/\/(www\.)?x\.com/i, 'https://api.fxtwitter.com')
    .replace(/^https?:\/\/(www\.)?twitter\.com/i, 'https://api.fxtwitter.com');
}

function decodeHtmlEntities(text) {
  return String(text || '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function extractTweetTextFromFx(data) {
  if (!data) return null;
  if (typeof data === 'object') return data.tweet?.text || data.text || null;
  const ogDescription = data.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i)?.[1]
    || data.match(/<meta[^>]+content=["']([^"']*)["'][^>]+property=["']og:description["']/i)?.[1];
  if (ogDescription) return decodeHtmlEntities(ogDescription).trim();
  const title = data.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  return title ? decodeHtmlEntities(title.replace(/\s+/g, ' ')).trim() : null;
}

function extractTweetMetricsFromFx(data) {
  const tweet = data?.tweet || data;
  if (!tweet || typeof tweet !== 'object') return null;
  return {
    likes: Number(tweet.likes ?? 0),
    retweets: Number(tweet.retweets ?? tweet.reposts ?? 0),
    replies: Number(tweet.replies ?? 0),
    quotes: Number(tweet.quotes ?? 0),
    bookmarks: Number(tweet.bookmarks ?? 0),
    views: tweet.views == null ? null : Number(tweet.views),
    createdAt: tweet.created_at || tweet.date || null,
    createdTimestamp: tweet.created_timestamp || tweet.date_epoch || null,
    authorFollowers: tweet.author?.followers == null ? null : Number(tweet.author.followers),
    authorVerified: Boolean(tweet.author?.verification?.verified || tweet.author?.verified),
    authorScreenName: tweet.author?.screen_name || tweet.user_screen_name || null,
  };
}

function viralityScore(metrics) {
  if (!metrics) return null;
  const views = Number(metrics.views || 0);
  const followers = Number(metrics.authorFollowers || 0);
  const engagement = Number(metrics.likes || 0)
    + Number(metrics.retweets || 0) * 2
    + Number(metrics.quotes || 0) * 2
    + Number(metrics.replies || 0);
  return {
    engagement,
    engagementPerView: views > 0 ? engagement / views * 100 : null,
    engagementPerFollower: followers > 0 ? engagement / followers * 100 : null,
  };
}

async function fetchTwitterNarrative(graduatedCoin, gmgn) {
  const url = extractTweetUrl(graduatedCoin) || extractTweetUrl(gmgn);
  if (!url) return null;

  // Check cache first
  const cached = getCachedTweet(url);
  if (cached) return cached;

  const apiUrl = toFxTwitterApi(url);
  try {
    const api = await axios.get(apiUrl, {
      timeout: 8000,
      headers: { Accept: 'application/json' },
    });
    const text = extractTweetTextFromFx(api.data);
    const metrics = extractTweetMetricsFromFx(api.data);
    const result = { url, fxUrl: toFxTwitter(url), apiUrl, text, metrics, virality: viralityScore(metrics) };
    setCachedTweet(url, result);
    return result;
  } catch (apiErr) {
    console.log(`[twitter] api ${url} ${apiErr.response?.status || ''} ${apiErr.message}`);
    // Cache the failure briefly to avoid re-hitting broken endpoints
    setCachedTweet(url, { url, fxUrl: toFxTwitter(url), text: null, error: apiErr.message });
    return null;
  }
}

export {
  extractTweetUrl,
  toFxTwitter,
  toFxTwitterApi,
  decodeHtmlEntities,
  extractTweetTextFromFx,
  extractTweetMetricsFromFx,
  viralityScore,
  fetchTwitterNarrative,
};
