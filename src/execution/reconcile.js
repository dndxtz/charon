import { fetchAllWalletTokenAccounts, fetchLiveTokenBalance } from '../liveExecutor.js';
import { db } from '../db/connection.js';
import { now, json } from '../utils.js';

/**
 * Reconcile wallet balances against DB positions.
 * Finds:
 *   - Tokens in wallet but no DB position → creates missing position record
 *   - DB positions "open" but token balance is 0 → marks as closed (exit_reason: RECONCILE)
 *   - DB positions "pending_entry" (crash mid-swap) → check if tokens arrived, promote to open or close
 */
export async function reconcile() {
  // Include both 'open' and 'pending_entry' positions
  const dbPositions = db.prepare(
    "SELECT * FROM dry_run_positions WHERE status IN ('open', 'pending_entry') ORDER BY opened_at_ms DESC"
  ).all();

  if (!dbPositions.length) {
    console.log('[reconcile] no open/pending positions in DB, skipping');
    return { created: 0, closed: 0 };
  }

  const walletTokens = await fetchAllWalletTokenAccounts();

  // null = RPC error, don't touch positions (safer to skip than to blindly close)
  if (walletTokens === null) {
    console.log('[reconcile] wallet scan failed (RPC error), skipping — no positions changed');
    return { created: 0, closed: 0, skipped: true };
  }

  // Empty array = wallet genuinely has no tokens
  if (walletTokens.length === 0) {
    console.log('[reconcile] wallet has no tokens — marking all DB positions as reconciled closed');
    let closed = 0;
    for (const pos of dbPositions) {
      db.prepare(`
        UPDATE dry_run_positions
        SET status = 'closed', closed_at_ms = ?, exit_reason = 'RECONCILE_ZERO_BALANCE',
            pnl_percent = -100, pnl_sol = -size_sol
        WHERE id = ? AND status IN ('open', 'pending_entry')
      `).run(now(), pos.id);
      closed++;
    }
    if (closed) console.log(`[reconcile] closed ${closed} positions (wallet empty)`);
    return { created: 0, closed };
  }

  // Build mint → amount map from wallet
  const walletMap = new Map();
  for (const t of walletTokens) {
    walletMap.set(t.mint, { amount: t.amount, decimals: t.decimals });
  }

  let created = 0;
  let closed = 0;
  let promoted = 0;

  // Check DB positions
  for (const pos of dbPositions) {
    const walletTok = walletMap.get(pos.mint);

    if (pos.status === 'pending_entry') {
      // Crash happenedmid-swap: check if tokens actually arrived
      if (walletTok && Number(walletTok.amount) > 0) {
        // Swap succeeded — promote to open
        db.prepare(`
          UPDATE dry_run_positions
          SET status = 'open', token_amount_raw = ?
          WHERE id = ? AND status = 'pending_entry'
        `).run(walletTok.amount, pos.id);
        console.log(`[reconcile] promoted pending #${pos.id} (${pos.mint.slice(0, 8)}...) — ${walletTok.amount} tokens in wallet`);
        promoted++;
      } else {
        // Swap never completed — close it
        db.prepare(`
          UPDATE dry_run_positions
          SET status = 'closed', closed_at_ms = ?, exit_reason = 'RECONCILE_PENDING_NO_TOKENS',
              pnl_percent = -100, pnl_sol = -size_sol
          WHERE id = ? AND status = 'pending_entry'
        `).run(now(), pos.id);
        console.log(`[reconcile] closed pending #${pos.id} (${pos.mint.slice(0, 8)}...) — no tokens in wallet`);
        closed++;
      }
      walletMap.delete(pos.mint);
      continue;
    }

    // status = 'open'
    if (!walletTok || Number(walletTok.amount) === 0) {
      const tokenBalance = await fetchLiveTokenBalance(pos.mint);
      if (!tokenBalance || Number(tokenBalance) === 0) {
        db.prepare(`
          UPDATE dry_run_positions
          SET status = 'closed', closed_at_ms = ?, exit_reason = 'RECONCILE_MISSING',
              pnl_percent = ?, pnl_sol = ?
          WHERE id = ? AND status = 'open'
        `).run(
          now(),
          pos.pnl_percent ?? -100,
          pos.pnl_sol ?? -Number(pos.size_sol),
          pos.id,
        );
        console.log(`[reconcile] closed position #${pos.id} (${pos.mint.slice(0, 8)}...) — token not in wallet`);
        closed++;
        walletMap.delete(pos.mint);
      }
    } else {
      walletMap.delete(pos.mint);
    }
  }

  // Any tokens left in walletMap are untracked — create position records
  for (const [mint, { amount }] of walletMap) {
    console.log(`[reconcile] creating missing position for ${mint.slice(0, 8)}... balance: ${amount}`);
    const ts = now();
    const result = db.prepare(`
      INSERT INTO dry_run_positions (
        candidate_id, mint, symbol, status, opened_at_ms, size_sol, entry_price, entry_mcap,
        token_amount_est, high_water_price, high_water_mcap, tp_percent, sl_percent,
        trailing_enabled, trailing_percent, trailing_armed, execution_mode,
        token_amount_raw, strategy_id, snapshot_json
      ) VALUES (
        NULL, ?, ?, 'open', ?, 0, NULL, NULL,
        NULL, NULL, NULL, 50, -25,
        0, 0, 0, 'live',
        ?, 'reconciled', ?, 0
      )
    `).run(
      mint,
      mint.slice(0, 8),
      ts,
      amount,
      json({ source: 'reconciliation', balanceAtReconcile: amount, reconciledAtMs: ts }),
    );
    const positionId = Number(result.lastInsertRowid);
    console.log(`[reconcile] created position #${positionId} for ${mint.slice(0, 8)}... (${amount} tokens)`);
    created++;
  }

  console.log(`[reconcile] done: ${created} created, ${closed} closed, ${promoted} promoted`);
  return { created, closed, promoted };
}
