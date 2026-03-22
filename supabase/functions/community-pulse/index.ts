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

    // This week's active (update_checks)
    const { count: thisWeekChecks } = await supabase
      .from("update_checks")
      .select("*", { count: "exact", head: true })
      .gte("checked_at", weekAgo);

    // Last week's active (for change %)
    const { count: lastWeekChecks } = await supabase
      .from("update_checks")
      .select("*", { count: "exact", head: true })
      .gte("checked_at", twoWeeksAgo)
      .lt("checked_at", weekAgo);

    let current = thisWeekChecks ?? 0;
    let previous = lastWeekChecks ?? 0;

    // Fallback: if update_checks is empty, count distinct sessions from telemetry_events
    if (current === 0) {
      const { data: thisWeekSessions } = await supabase
        .from("telemetry_events")
        .select("session_id")
        .eq("event_type", "skill_run")
        .gte("event_timestamp", weekAgo);

      const { data: lastWeekSessions } = await supabase
        .from("telemetry_events")
        .select("session_id")
        .eq("event_type", "skill_run")
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
