import WebSocket from 'ws';
import { PUMP_PROGRAM, PUMP_AMM, DISC_DIST_FEES, SOLANA_WS_URL } from '../config.js';
import { now, pruneSeen, lamToSol, discMatch, parseDistFees } from '../utils.js';
import { numSetting, boolSetting } from '../db/settings.js';
import { storeSignalEvent } from './trending.js';
import { graduated } from './graduated.js';
import { trending } from './trending.js';
import { buildFeeSnapshot } from '../pipeline/candidateBuilder.js';

export const seenFeeClaims = new Map();
let candidateHandler = null;

export function setCandidateHandler(fn) {
  candidateHandler = fn;
}

export async function handleFeeClaim(fee, signature) {
  const sol = lamToSol(fee.distributed);
  if (sol < numSetting('min_fee_claim_sol', 2)) return;
  const graduatedCoin = graduated.get(fee.mint) || null;
  const trendingToken = boolSetting('trending_enabled', true) ? trending.get(fee.mint) || null : null;
  if (!graduatedCoin && !trendingToken) return;

  const key = `${signature}:${fee.mint}:${fee.distributed}`;
  pruneSeen(seenFeeClaims, 10 * 60_000);
  if (seenFeeClaims.has(key)) return;
  storeSignalEvent(fee.mint, 'fee_claim', 'pump_logs', { signature, fee: buildFeeSnapshot(fee, signature) });
  const route = graduatedCoin && trendingToken
    ? 'fee_graduated_trending'
    : graduatedCoin
      ? 'fee_graduated'
      : 'fee_trending';
  if (candidateHandler) {
    await candidateHandler({
      mint: fee.mint,
      fee,
      signature,
      graduatedCoin,
      trendingToken,
      route,
    });
  }
  seenFeeClaims.set(key, now());
}

async function processLog(logInfo) {
  const { signature, logs, err } = logInfo;
  if (err || !logs) return;
  for (const line of logs) {
    if (!line.startsWith('Program data: ')) continue;
    let data;
    try {
      data = Buffer.from(line.slice('Program data: '.length), 'base64');
    } catch {
      continue;
    }
    if (data.length < 8 || !discMatch(data, DISC_DIST_FEES)) continue;
    try {
      await handleFeeClaim(parseDistFees(data), signature);
    } catch (error) {
      console.log(`[fee] parse/alert failed: ${error.message}`);
    }
  }
}

export function startWebsocket() {
  const wsUrl = SOLANA_WS_URL;
  let ws;
  let pingTimer;
  function connect() {
    ws = new WebSocket(wsUrl);
    ws.on('open', () => {
      console.log('[ws] connected');
      for (const [id, program] of [[1, PUMP_PROGRAM], [2, PUMP_AMM]]) {
        ws.send(JSON.stringify({
          jsonrpc: '2.0',
          id,
          method: 'logsSubscribe',
          params: [{ mentions: [program] }, { commitment: 'confirmed' }],
        }));
      }
      pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.ping();
      }, 30_000);
    });
    ws.on('message', raw => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      const value = msg.params?.result?.value;
      if (msg.method === 'logsNotification' && value) {
        processLog(value).catch(error => console.log(`[ws] process failed: ${error.message}`));
      }
    });
    ws.on('close', () => {
      clearInterval(pingTimer);
      console.log('[ws] closed, reconnecting in 5s');
      setTimeout(connect, 5000);
    });
    ws.on('error', error => console.log(`[ws] ${error.message}`));
  }
  connect();
}
