# /office-hours — Daily Briefing App → Chief of Staff AI

Real session transcript showing how `/office-hours` reframes your product before you write code.

---

**You:** I want to build a daily briefing app for my calendar.

**You:** /office-hours

**Claude:** Let me ask you some questions before we start building.

**Question 1: What's the specific pain?**
When was the last time your morning prep actively failed you? Not "it's slow" — when did missing information cause a real problem in a real meeting?

**You:** Last Tuesday. Had a board meeting at 2pm. The calendar invite said "Quarterly Review" with a Zoom link. No agenda, no context. I spent 20 minutes digging through email threads and Notion pages to figure out what was actually being discussed. Found out 5 minutes before the call that the CFO had sent updated financials that changed the entire narrative.

**Claude:** That's not a "daily briefing" problem. That's a context-assembly problem with a tight deadline. Let me push back on your framing.

You said "daily briefing app." But what you actually described is a **personal chief of staff AI**. Here's what I heard:

1. **Meeting prep automation** — pull context from calendar, email, docs, and Slack before each meeting
2. **Stale data detection** — flag when attachments or linked docs have been updated since the invite was created
3. **Priority triage** — not all meetings need prep; the app should know which ones do
4. **Timeline awareness** — prep should happen hours before, not minutes before
5. **Cross-source synthesis** — the answer isn't in any single tool, it's across all of them

**Question 2: Who's the desperate user?**
Is this for you specifically, or do you see other people with this problem?

**You:** Every exec I know. My EA does this manually right now — takes her 45 minutes every morning.

**Claude:** 45 minutes of manual context assembly, daily. That's 195 hours/year of skilled labor on copy-paste work. Your EA is your first beta tester and your validation oracle.

**Question 3: What's the narrowest wedge?**
Of those 5 capabilities, which one alone would have saved you last Tuesday?

**You:** Stale data detection. If I'd known the CFO updated the financials, I would have read them.

**Claude:** Good. That's your v0.1: **"Alert me when documents linked in calendar events change after the invite was sent."** One integration (Google Calendar + Google Drive), one trigger (doc modified_at > invite created_at), one output (notification with diff summary).

**RECOMMENDATION:**
- **Tomorrow:** Ship the stale-doc detector. Google Calendar webhook + Drive API. One afternoon.
- **Week 1:** Add meeting importance scoring (board meetings > 1:1s > standups).
- **Week 2:** Cross-source context assembly (email threads, Slack channels, Notion pages).
- **Month 2:** The full chief of staff — proactive prep, priority triage, follow-up tracking.

Start with the wedge. Validate with your EA. The vision is real, but the wedge is what proves it.

---

*The session continued into `/plan-ceo-review` and `/plan-eng-review`, which built on this framing. The "daily briefing app" never came back — it was always "chief of staff AI" from this point forward.*
