import { db } from '../db/connection.js';
import { now, json } from '../utils.js';
import { fetchJupiterAsset } from '../enrichment/jupiter.js';
import { firstPositiveNumber } from '../utils.js';

let candidateHandler = null;

export function setCandidateHandler(fn) { candidateHandler = fn; }

export function storePriceAlert({ mint, strategyId, alertType, targetPriceUsd, targetMcapUsd, targetAthDistancePercent, signal, expiresMs }) {
  // Check if alert already exists for this mint
  const existing = db.prepare(
    "SELECT id FROM price_alerts WHERE mint = ? AND status = 'pending' LIMIT 1"
  ).get(mint);
  if (existing) return existing.id;

  const result = db.prepare(`
    INSERT INTO price_alerts (mint, strategy_id, alert_type, target_price_usd, target_mcap_usd, target_ath_distance_percent,
      candidate_json, signals_json, status, created_at_ms, expires_at_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
  `).run(
    mint,
    strategyId,
    alertType,
    targetPriceUsd || null,
    targetMcapUsd || null,
    targetAthDistancePercent || null,
    json({}),
    json(signal),
    now(),
    now() + (expiresMs || 24 * 60 * 60 * 1000),
  );
  const id = Number(result.lastInsertRowid);
  console.log(`[dip] alert #${id} for ${mint.slice(0, 8)}... target price: $${targetPriceUsd?.toFixed(8) || '?'}`);
  return id;
}

export function getActiveAlerts() {
  return db.prepare(
    "SELECT * FROM price_alerts WHERE status = 'pending' AND expires_at_ms > ?"
  ).all(now());
}

export function getAlertStats() {
  const pending = db.prepare("SELECT COUNT(*) as c FROM price_alerts WHERE status = 'pending'").get().c;
  const triggered = db.prepare("SELECT COUNT(*) as c FROM price_alerts WHERE status = 'triggered'").get().c;
  const expired = db.prepare("SELECT COUNT(*) as c FROM price_alerts WHERE status = 'expired'").get().c;
  return { pending, triggered, expired };
}

export async function monitorPriceAlerts() {
  const alerts = getActiveAlerts();
  if (!alerts.length) return;

  let triggered = 0;
  let expired = 0;

  for (const alert of alerts) {
    // Check if expired
    if (now() > alert.expires_at_ms) {
      db.prepare("UPDATE price_alerts SET status = 'expired' WHERE id = ?").run(alert.id);
      expired++;
      continue;
    }

    try {
      const asset = await fetchJupiterAsset(alert.mint);
      const currentPrice = firstPositiveNumber(asset?.usdPrice);
      const currentMcap = firstPositiveNumber(asset?.mcap, asset?.fdv);

      if (!currentPrice) continue;

      let shouldTrigger = false;

      // Check price target
      if (alert.target_price_usd && currentPrice <= alert.target_price_usd) {
        shouldTrigger = true;
      }

      // Check mcap target (if we stored a mcap-based target)
      if (alert.target_mcap_usd && currentMcap && currentMcap <= alert.target_mcap_usd) {
        shouldTrigger = true;
      }

      if (shouldTrigger && candidateHandler) {
        const signal = JSON.parse(alert.signals_json || '{}');
        await candidateHandler({
          mint: alert.mint,
          fee: signal.feeClaim ? {
            mint: alert.mint,
            distributed: BigInt(Math.floor(signal.feeClaim.distributedSol * 1e9)),
            shareholders: (signal.feeClaim.shareholders || []).map(h => ({ pubkey: h.address, bps: h.bps })),
          } : null,
          signature: signal.feeClaim?.signature || null,
          graduatedCoin: signal.graduated || null,
          trendingToken: signal.trending || null,
          route: `dip_${alert.strategy_id}`,
        });

        db.prepare("UPDATE price_alerts SET status = 'triggered', triggered_at_ms = ? WHERE id = ?").run(now(), alert.id);
        triggered++;
        console.log(`[dip] triggered ${alert.mint.slice(0, 8)}... at $${currentPrice.toFixed(8)} (target: $${alert.target_price_usd?.toFixed(8)})`);
      }
    } catch (err) {
      console.log(`[dip] alert ${alert.id} error: ${err.message}`);
    }
  }

  if (triggered || expired) {
    console.log(`[dip] ${triggered} triggered, ${expired} expired, ${alerts.length - triggered - expired} remaining`);
  }
}

// Clean up old alerts periodically
export function cleanupAlerts() {
  const cutoff = now() - 7 * 24 * 60 * 60 * 1000; // 7 days
  const result = db.prepare("DELETE FROM price_alerts WHERE status IN ('triggered', 'expired') AND created_at_ms < ?").run(cutoff);
  if (result.changes > 0) console.log(`[dip] cleaned ${result.changes} old alerts`);
}
