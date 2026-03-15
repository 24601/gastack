/**
 * CLI handler for gstack-sync commands.
 * Called by bin/gstack-sync via `bun run`.
 */

import * as fs from 'fs';
import { getTeamConfig, resolveSyncConfig, clearAuthTokens, isSyncConfigured } from './sync-config';
import { runDeviceAuth } from './auth';
import { pushEvalRun, pushRetro, pushQAReport, pushShipLog, pullTable, drainQueue, getSyncStatus } from './sync';
import { readJSON } from './util';

const command = process.argv[2];

async function main() {
  switch (command) {
    case 'setup':
      await cmdSetup();
      break;
    case 'status':
      await cmdStatus();
      break;
    case 'push-eval':
      await cmdPushFile('eval', process.argv[3]);
      break;
    case 'push-retro':
      await cmdPushFile('retro', process.argv[3]);
      break;
    case 'push-qa':
      await cmdPushFile('qa', process.argv[3]);
      break;
    case 'push-ship':
      await cmdPushFile('ship', process.argv[3]);
      break;
    case 'pull':
      await cmdPull();
      break;
    case 'drain':
      await cmdDrain();
      break;
    case 'logout':
      cmdLogout();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      process.exit(1);
  }
}

async function cmdSetup(): Promise<void> {
  const team = getTeamConfig();
  if (!team) {
    console.error('No .gstack-sync.json found in project root.');
    console.error('Ask your team admin to set up team sync first.');
    process.exit(1);
  }

  console.log(`Team: ${team.team_slug}`);
  console.log(`Supabase: ${team.supabase_url}`);

  try {
    const tokens = await runDeviceAuth(team);
    console.log(`\nAuthenticated as ${tokens.email || tokens.user_id}`);
    console.log('Sync is now enabled. Run `gstack-sync status` to verify.');
  } catch (err: any) {
    console.error(`\nAuth failed: ${err.message}`);
    process.exit(1);
  }
}

async function cmdStatus(): Promise<void> {
  const status = await getSyncStatus();

  console.log('gstack sync status');
  console.log('─'.repeat(40));
  console.log(`  Configured:     ${status.configured ? 'yes' : 'no (.gstack-sync.json not found)'}`);
  console.log(`  Authenticated:  ${status.authenticated ? 'yes' : 'no (run gstack-sync setup)'}`);
  console.log(`  Sync enabled:   ${status.syncEnabled ? 'yes' : 'no'}`);
  console.log(`  Connection:     ${status.connectionOk ? 'ok' : 'failed'}`);
  console.log(`  Queue:          ${status.queueSize} items${status.queueOldest ? ` (oldest: ${status.queueOldest})` : ''}`);
  console.log(`  Cache:          ${status.cacheLastPull ? `last pull ${status.cacheLastPull}` : 'never pulled'}`);

  if (status.queueSize > 100) {
    console.log(`\n  WARNING: Queue has ${status.queueSize} items. Run 'gstack-sync drain' to flush.`);
  }
  if (status.queueOldest) {
    const ageMs = Date.now() - new Date(status.queueOldest).getTime();
    if (ageMs > 86_400_000) {
      console.log(`\n  WARNING: Oldest queue entry is ${Math.round(ageMs / 3_600_000)}h old. Run 'gstack-sync drain'.`);
    }
  }
}

async function cmdPushFile(type: string, filePath: string): Promise<void> {
  if (!filePath) {
    console.error(`Usage: gstack-sync push-${type} <file.json>`);
    process.exit(1);
  }

  if (!isSyncConfigured()) {
    // Silent exit — sync not configured is normal for solo users
    process.exit(0);
  }

  const data = readJSON<Record<string, unknown>>(filePath);
  if (!data) {
    console.error(`Cannot read ${filePath}`);
    process.exit(1);
  }

  let ok = false;
  switch (type) {
    case 'eval':
      ok = await pushEvalRun(data);
      break;
    case 'retro':
      ok = await pushRetro(data);
      break;
    case 'qa':
      ok = await pushQAReport(data);
      break;
    case 'ship':
      ok = await pushShipLog(data);
      break;
  }

  if (ok) {
    console.log(`Synced ${type} to team store`);
  }
  // Silent on failure — queued for retry
}

async function cmdPull(): Promise<void> {
  if (!isSyncConfigured()) {
    console.error('Sync not configured. Run gstack-sync setup first.');
    process.exit(1);
  }

  const tables = ['eval_runs', 'retro_snapshots', 'qa_reports', 'ship_logs', 'greptile_triage'];
  let total = 0;

  for (const table of tables) {
    const rows = await pullTable(table);
    total += rows.length;
    if (rows.length > 0) {
      console.log(`  ${table}: ${rows.length} rows`);
    }
  }

  console.log(`\nPulled ${total} total rows to local cache.`);
}

async function cmdDrain(): Promise<void> {
  const result = await drainQueue();
  console.log(`Queue drain: ${result.success} synced, ${result.failed} failed, ${result.remaining} remaining`);
}

function cmdLogout(): void {
  const team = getTeamConfig();
  if (!team) {
    console.log('No team config found — nothing to clear.');
    return;
  }

  clearAuthTokens(team.supabase_url);
  console.log(`Cleared auth tokens for ${team.supabase_url}`);
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
