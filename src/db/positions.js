import { db } from './connection.js';
import { now, json } from '../utils.js';
import { numSetting, boolSetting, setting, activeStrategy } from './settings.js';

export function openPositions() {
  return db.prepare('SELECT * FROM dry_run_positions WHERE status = ? ORDER BY opened_at_ms DESC').all('open');
}

export function openPositionCount() {
  return db.prepare('SELECT COUNT(*) AS count FROM dry_run_positions WHERE status = ?').get('open').count;
}

export function canOpenMorePositions() {
  const strat = activeStrategy();
  const max = strat.max_open_positions ?? numSetting('max_open_positions', 3);
  if (max <= 0) return true;
  return openPositionCount() < max;
}

export function tradingMode() {
  const mode = setting('trading_mode', 'dry_run');
  return ['dry_run', 'confirm', 'live'].includes(mode) ? mode : 'dry_run';
}

export function allPositions(limit = 10) {
  return db.prepare('SELECT * FROM dry_run_positions ORDER BY id DESC LIMIT ?').all(limit);
}

export function createDryRunPosition(candidateId, candidate, decision, reason = 'llm_buy') {
  const strat = activeStrategy();
  const sizeSol = strat.position_size_sol ?? numSetting('dry_run_buy_sol', 0.1);
  const entryPrice = Number(candidate.metrics.priceUsd || 0) || null;
  const entryMcap = Number(candidate.metrics.marketCapUsd || candidate.metrics.graduatedMarketCapUsd || 0) || null;
  const tp = Number(decision.suggested_tp_percent || strat.tp_percent || numSetting('default_tp_percent', 50));
  const sl = Number(decision.suggested_sl_percent || strat.sl_percent || numSetting('default_sl_percent', -25));
  const trailingEnabled = (strat.trailing_enabled ?? boolSetting('default_trailing_enabled', true)) ? 1 : 0;
  const trailingPercent = strat.trailing_percent ?? numSetting('default_trailing_percent', 20);

  return db.transaction(() => {
    const existing = db.prepare(`
      SELECT id FROM dry_run_positions WHERE mint = ? AND status = 'open' LIMIT 1
    `).get(candidate.token.mint);
    if (existing) return existing.id;

    const dryRunSignature = candidate.signals?.triggerSignature || `DRY-${candidateId}-${now()}`;

    const result = db.prepare(`
      INSERT INTO dry_run_positions (
        candidate_id, mint, symbol, status, opened_at_ms, size_sol, entry_price, entry_mcap,
        token_amount_est, high_water_price, high_water_mcap, tp_percent, sl_percent,
        trailing_enabled, trailing_percent, trailing_armed, llm_decision_id, strategy_id, snapshot_json,
        holder_count_at_entry, entry_signature, execution_mode
      ) VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, 'dry_run')
    `).run(
      candidateId,
      candidate.token.mint,
      candidate.token.symbol,
      now(),
      sizeSol,
      entryPrice,
      entryMcap,
      null,
      entryPrice,
      entryMcap,
      tp,
      sl,
      trailingEnabled,
      trailingPercent,
      decision.id || null,
      strat.id,
      json({ candidate, decision, reason, strategy: strat.id }),
      Number(candidate.metrics.holderCount || 0),
      dryRunSignature,
    );
    const positionId = Number(result.lastInsertRowid);
    db.prepare(`
      INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
      VALUES (?, ?, 'buy', ?, ?, ?, ?, ?, ?, ?)
    `).run(positionId, candidate.token.mint, now(), entryPrice, entryMcap, sizeSol, null, reason, json({ candidateId, decision }));
    db.prepare(`
      INSERT INTO tp_sl_rules (position_id, tp_percent, sl_percent, trailing_enabled, trailing_percent, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(positionId, tp, sl, trailingEnabled, trailingPercent, now());
    return positionId;
  })();
}

export function createLivePosition(candidateId, candidate, decision, swap, reason = 'live_buy') {
  const strat = activeStrategy();
  const sizeSol = strat.position_size_sol ?? numSetting('dry_run_buy_sol', 0.1);
  const entryPrice = Number(candidate.metrics.priceUsd || 0) || null;
  const entryMcap = Number(candidate.metrics.marketCapUsd || candidate.metrics.graduatedMarketCapUsd || 0) || null;
  const tp = Number(decision.suggested_tp_percent || strat.tp_percent || numSetting('default_tp_percent', 50));
  const sl = Number(decision.suggested_sl_percent || strat.sl_percent || numSetting('default_sl_percent', -25));
  const trailingEnabled = (strat.trailing_enabled ?? boolSetting('default_trailing_enabled', true)) ? 1 : 0;
  const trailingPercent = strat.trailing_percent ?? numSetting('default_trailing_percent', 20);

  return db.transaction(() => {
    const existing = db.prepare(`
      SELECT id FROM dry_run_positions WHERE mint = ? AND status = 'open' LIMIT 1
    `).get(candidate.token.mint);
    if (existing) return existing.id;

    const result = db.prepare(`
      INSERT INTO dry_run_positions (
        candidate_id, mint, symbol, status, opened_at_ms, size_sol, entry_price, entry_mcap,
        token_amount_est, high_water_price, high_water_mcap, tp_percent, sl_percent,
        trailing_enabled, trailing_percent, trailing_armed, llm_decision_id,
        execution_mode, entry_signature, token_amount_raw, strategy_id, snapshot_json,
        holder_count_at_entry
      ) VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'live', ?, ?, ?, ?, ?)
    `).run(
      candidateId,
      candidate.token.mint,
      candidate.token.symbol,
      now(),
      sizeSol,
      entryPrice,
      entryMcap,
      null,
      entryPrice,
      entryMcap,
      tp,
      sl,
      trailingEnabled,
      trailingPercent,
      decision.id || null,
      swap.signature,
      swap.outputAmount || null,
      strat.id,
      json({ candidate, decision, reason, swap, strategy: strat.id }),
      Number(candidate.metrics.holderCount || 0),
    );
    const positionId = Number(result.lastInsertRowid);
    db.prepare(`
      INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
      VALUES (?, ?, 'buy', ?, ?, ?, ?, ?, ?, ?)
    `).run(positionId, candidate.token.mint, now(), entryPrice, entryMcap, sizeSol, null, reason, json({ candidateId, decision, swap }));
    db.prepare(`
      INSERT INTO tp_sl_rules (position_id, tp_percent, sl_percent, trailing_enabled, trailing_percent, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(positionId, tp, sl, trailingEnabled, trailingPercent, now());
    return positionId;
  })();
}
