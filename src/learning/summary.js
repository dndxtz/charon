import { db } from '../db/connection.js';
import { now, safeJson, parseWindowMs, formatWindow } from '../utils.js';

export function positionSnapshotCandidate(position) {
  return safeJson(position.snapshot_json, {})?.candidate || {};
}

export function summarizeLearningWindow(windowMs) {
  const cutoff = now() - windowMs;
  const positions = db.prepare(`
    SELECT *
    FROM dry_run_positions
    WHERE opened_at_ms >= ?
      AND COALESCE(execution_mode, 'dry_run') = 'dry_run'
    ORDER BY opened_at_ms ASC
  `).all(cutoff);
  const closed = positions.filter(position => position.status === 'closed');
  const winners = closed.filter(position => Number(position.pnl_percent || 0) > 0);
  const losers = closed.filter(position => Number(position.pnl_percent || 0) < 0);
  const totalPnlPercent = closed.reduce((sum, position) => sum + Number(position.pnl_percent || 0), 0);
  const totalPnlSol = closed.reduce((sum, position) => sum + Number(position.pnl_sol || 0), 0);
  const byRoute = new Map();
  // Pre-parse route from snapshot once per position to avoid repeated JSON parsing
  const positionRoutes = new Map();
  function getPositionRoute(position) {
    let route = positionRoutes.get(position.id);
    if (route === undefined) {
      const candidate = safeJson(position.snapshot_json, {})?.candidate || {};
      route = candidate.signals?.route || candidate.signals?.label || 'unknown';
      positionRoutes.set(position.id, route);
    }
    return route;
  }
  for (const position of closed) {
    const route = getPositionRoute(position);
    const row = byRoute.get(route) || { route, count: 0, wins: 0, losses: 0, pnlPercent: 0, pnlSol: 0 };
    row.count += 1;
    row.wins += Number(position.pnl_percent || 0) > 0 ? 1 : 0;
    row.losses += Number(position.pnl_percent || 0) < 0 ? 1 : 0;
    row.pnlPercent += Number(position.pnl_percent || 0);
    row.pnlSol += Number(position.pnl_sol || 0);
    byRoute.set(route, row);
  }
  const batches = db.prepare(`
    SELECT verdict, COUNT(*) AS count, AVG(confidence) AS avg_confidence
    FROM llm_batches
    WHERE created_at_ms >= ?
    GROUP BY verdict
  `).all(cutoff);
  const actions = db.prepare(`
    SELECT action, COUNT(*) AS count
    FROM decision_logs
    WHERE at_ms >= ?
    GROUP BY action
    ORDER BY count DESC
  `).all(cutoff);
  closed.sort((a, b) => Number(b.pnl_percent || 0) - Number(a.pnl_percent || 0));
  const best = closed.slice(0, 5).map(position => ({
    mint: position.mint,
    symbol: position.symbol,
    pnlPercent: Number(position.pnl_percent || 0),
    exitReason: position.exit_reason,
    entryMcap: position.entry_mcap,
    exitMcap: position.exit_mcap,
    route: getPositionRoute(position),
  }));
  const worst = closed.slice(-5).reverse().map(position => ({
    mint: position.mint,
    symbol: position.symbol,
    pnlPercent: Number(position.pnl_percent || 0),
    exitReason: position.exit_reason,
    entryMcap: position.entry_mcap,
    exitMcap: position.exit_mcap,
    route: getPositionRoute(position),
  }));
  return {
    windowMs,
    fromMs: cutoff,
    toMs: now(),
    positions: {
      opened: positions.length,
      closed: closed.length,
      open: positions.length - closed.length,
      wins: winners.length,
      losses: losers.length,
      winRate: closed.length ? winners.length / closed.length * 100 : null,
      totalPnlPercent,
      avgPnlPercent: closed.length ? totalPnlPercent / closed.length : null,
      totalPnlSol,
      byRoute: [...byRoute.values()].map(row => ({
        ...row,
        winRate: row.count ? row.wins / row.count * 100 : null,
        avgPnlPercent: row.count ? row.pnlPercent / row.count : null,
      })).sort((a, b) => b.pnlPercent - a.pnlPercent),
      best,
      worst,
    },
    llm: { batches, actions },
  };
}
