# /qa — Finding and Fixing a Real Bug

Real session transcript showing `/qa` opening a browser, finding a bug, fixing it with an atomic commit, and verifying the fix.

---

**You:** /qa http://localhost:3000

**Claude:** Starting QA session on http://localhost:3000.

Opening browser and taking initial screenshot...

**Page loaded:** Dashboard — shows user stats, recent activity, settings link.

I'll systematically test the core flows. Starting with navigation.

**Test 1: Navigation links**
✅ Dashboard → Settings: works
✅ Settings → Profile: works
✅ Profile → Dashboard: works
❌ **Dashboard → Billing: 500 error**

```
TypeError: Cannot read properties of undefined (reading 'plan')
  at BillingPage (src/pages/billing.tsx:23)
```

**I SEE THE ISSUE.** The billing page assumes `user.subscription.plan` exists, but free-tier users don't have a subscription object.

Reading `src/pages/billing.tsx`...

```tsx
// Line 23 — the crash
const planName = user.subscription.plan.name;
```

**Fix:** Optional chaining with a fallback for free-tier users.

```tsx
const planName = user.subscription?.plan?.name ?? 'Free';
```

Committing fix...

```
fix: handle free-tier users on billing page (null subscription)

Free-tier users don't have a subscription object.
The billing page crashed with TypeError when accessing
user.subscription.plan.name. Added optional chaining
with 'Free' fallback.
```

**Generating regression test...**

```typescript
// test/billing.test.tsx
test('billing page renders for free-tier user', () => {
  const user = { id: '1', name: 'Test', subscription: null };
  render(<BillingPage user={user} />);
  expect(screen.getByText('Free')).toBeInTheDocument();
});
```

**Verifying fix:** Reloading billing page...

✅ Billing page loads. Shows "Free" plan. No errors.

**Continuing QA...**

**Test 2: Form submission**
✅ Profile edit → saves correctly
✅ Settings toggle → persists on reload

**Test 3: Responsive layout**
✅ 1280px — desktop layout correct
✅ 768px — tablet layout correct
⚠️ 375px — mobile: settings dropdown overflows viewport (non-blocking, filed as issue)

**QA Summary:**
- **1 bug found and fixed** (billing page crash for free-tier users)
- **1 minor issue filed** (mobile dropdown overflow)
- **1 regression test added**
- All other flows pass

---

*The bug was a classic null-reference error that only affected free-tier users — likely never caught in development because the dev always had an active subscription. `/qa` found it in 30 seconds because it tests like a real user, not like someone who knows the codebase.*
