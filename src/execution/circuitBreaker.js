import { db } from '../db/connection.js';
import { now } from '../utils.js';
import { numSetting, boolSetting } from '../db/settings.js';

/**
 * Check if circuit breaker should trip.
 * Returns { tripped, reason } — tripped = true means halt all new trades.
 *
 * Checks:
 * 1. Max daily loss (SOL) exceeded
 * 2. Max consecutive losses hit
 * 3. Max drawdown % exceeded
 */
export function checkCircuitBreaker() {
  if (!boolSetting('circuit_breaker_enabled', true)) {
    return { tripped: false, reason: null };
  }

  const maxDailyLossSol = numSetting('max_daily_loss_sol', 1);
  const maxConsecutive = numSetting('max_consecutive_losses', 3);
  const maxDrawdownPct = numSetting('max_drawdown_pct', 30);

  // 1. Daily loss check: sum pnl_sol for today's closed positions
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const dailyLoss = db.prepare(`
    SELECT COALESCE(SUM(pnl_sol), 0) AS total_loss
    FROM dry_run_positions
    WHERE status = 'closed'
      AND closed_at_ms >= ?
      AND pnl_sol < 0
  `).get(dayStart.getTime());

  if (Math.abs(dailyLoss.total_loss) >= maxDailyLossSol) {
    return {
      tripped: true,
      reason: `Daily loss limit: ${Math.abs(dailyLoss.total_loss).toFixed(3)} SOL ≥ ${maxDailyLossSol} SOL`,
    };
  }

  // 2. Consecutive losses: walk recent closed positions backwards
  const recent = db.prepare(`
    SELECT pnl_sol FROM dry_run_positions
    WHERE status = 'closed' AND pnl_sol IS NOT NULL
    ORDER BY closed_at_ms DESC
    LIMIT ?
  `).all(maxConsecutive);

  if (recent.length >= maxConsecutive && recent.every(r => r.pnl_sol < 0)) {
    return {
      tripped: true,
      reason: `Consecutive losses: ${maxConsecutive} in a row`,
    };
  }

  // 3. Drawdown: check peak vs current total PnL
  const totalPnl = db.prepare(`
    SELECT COALESCE(SUM(pnl_sol), 0) AS total FROM dry_run_positions WHERE status = 'closed'
  `).get();

  // Simple drawdown: if total PnL is negative and exceeds threshold relative to total invested
  const totalInvested = db.prepare(`
    SELECT COALESCE(SUM(size_sol), 0) AS total FROM dry_run_positions WHERE execution_mode = 'live'
  `).get();

  if (totalInvested.total > 0 && totalPnl.total < 0) {
    const drawdownPct = (Math.abs(totalPnl.total) / totalInvested.total) * 100;
    if (drawdownPct >= maxDrawdownPct) {
      return {
        tripped: true,
        reason: `Max drawdown: ${drawdownPct.toFixed(1)}% ≥ ${maxDrawdownPct}%`,
      };
    }
  }

  return { tripped: false, reason: null };
}

/**
 * Reset daily circuit breaker state (call at midnight WIB).
 * In practice the daily loss query uses calendar day, so this is informational.
 */
export function getCircuitBreakerStatus() {
  const dailyLoss = db.prepare(`
    SELECT COALESCE(SUM(pnl_sol), 0) AS total
    FROM dry_run_positions
    WHERE status = 'closed'
      AND closed_at_ms >= ?
      AND pnl_sol < 0
  `).get(new Date().setHours(0, 0, 0, 0));

  const totalPnl = db.prepare(`
    SELECT COALESCE(SUM(pnl_sol), 0) AS total FROM dry_run_positions WHERE status = 'closed'
  `).get();

  const totalInvested = db.prepare(`
    SELECT COALESCE(SUM(size_sol), 0) AS total FROM dry_run_positions WHERE execution_mode = 'live'
  `).get();

  const cb = checkCircuitBreaker();

  return {
    tripped: cb.tripped,
    reason: cb.reason,
    dailyLossSol: Math.abs(dailyLoss.total),
    totalPnlSol: totalPnl.total,
    totalInvestedSol: totalInvested.total,
    drawdownPct: totalInvested.total > 0
      ? Math.min(0, (totalPnl.total / totalInvested.total) * 100)
      : 0,
  };
}
