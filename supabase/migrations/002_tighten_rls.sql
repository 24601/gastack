-- 002_tighten_rls.sql
-- Lock down all anon access. All reads/writes now go through edge functions
-- (which use SUPABASE_SERVICE_ROLE_KEY and bypass RLS).

-- Drop all SELECT policies (anon key should not read telemetry data)
DROP POLICY IF EXISTS "anon_select" ON telemetry_events;
DROP POLICY IF EXISTS "anon_select" ON installations;
DROP POLICY IF EXISTS "anon_select" ON update_checks;

-- Drop dangerous UPDATE policy (was unrestricted on all columns)
DROP POLICY IF EXISTS "anon_update_last_seen" ON installations;

-- Drop INSERT policies (writes go through edge functions now)
DROP POLICY IF EXISTS "anon_insert_only" ON telemetry_events;
DROP POLICY IF EXISTS "anon_insert_only" ON installations;
DROP POLICY IF EXISTS "anon_insert_only" ON update_checks;

-- Explicitly revoke view access (belt-and-suspenders)
REVOKE SELECT ON crash_clusters FROM anon;
REVOKE SELECT ON skill_sequences FROM anon;

-- Drop stale columns that exist live but not in 001_telemetry.sql
ALTER TABLE telemetry_events DROP COLUMN IF EXISTS error_message;
ALTER TABLE telemetry_events DROP COLUMN IF EXISTS failed_step;

-- Cache table for community-pulse aggregation (prevents DoS via repeated queries)
CREATE TABLE IF NOT EXISTS community_pulse_cache (
  id INTEGER PRIMARY KEY DEFAULT 1,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  refreshed_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE community_pulse_cache ENABLE ROW LEVEL SECURITY;
-- No anon policies — only service_role_key (used by edge functions) can read/write
