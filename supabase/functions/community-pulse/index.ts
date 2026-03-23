// gstack community-pulse edge function
// Returns weekly active installation count for preamble display.
// Cached for 1 hour via Cache-Control header.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

Deno.serve(async () => {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
  );

  try {
    // Count unique update checks in the last 7 days (install base proxy)
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();

    // This week's unique installs (by install_fingerprint, filtered to source=live)
    const { data: thisWeekData } = await supabase
      .from("update_checks")
      .select("install_fingerprint")
      .eq("source", "live")
      .gte("checked_at", weekAgo);

    // Last week's unique installs (for change %)
    const { data: lastWeekData } = await supabase
      .from("update_checks")
      .select("install_fingerprint")
      .eq("source", "live")
      .gte("checked_at", twoWeeksAgo)
      .lt("checked_at", weekAgo);

    let current = new Set((thisWeekData ?? []).map((e: { install_fingerprint: string }) => e.install_fingerprint).filter(Boolean)).size;
    let previous = new Set((lastWeekData ?? []).map((e: { install_fingerprint: string }) => e.install_fingerprint).filter(Boolean)).size;

    // Fallback: if no fingerprinted data, count distinct sessions from telemetry_events
    if (current === 0) {
      const { data: thisWeekSessions } = await supabase
        .from("telemetry_events")
        .select("session_id")
        .eq("event_type", "skill_run")
        .eq("source", "live")
        .gte("event_timestamp", weekAgo);

      const { data: lastWeekSessions } = await supabase
        .from("telemetry_events")
        .select("session_id")
        .eq("event_type", "skill_run")
        .eq("source", "live")
        .gte("event_timestamp", twoWeeksAgo)
        .lt("event_timestamp", weekAgo);

      current = new Set((thisWeekSessions ?? []).map((e: { session_id: string }) => e.session_id)).size;
      previous = new Set((lastWeekSessions ?? []).map((e: { session_id: string }) => e.session_id)).size;
    }
    const changePct = previous > 0
      ? Math.round(((current - previous) / previous) * 100)
      : 0;

    return new Response(
      JSON.stringify({
        weekly_active: current,
        change_pct: changePct,
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=3600", // 1 hour cache
        },
      }
    );
  } catch {
    return new Response(
      JSON.stringify({ weekly_active: 0, change_pct: 0 }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
});
