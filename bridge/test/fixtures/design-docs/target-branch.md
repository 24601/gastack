# Auth Refactor — OAuth2 Migration

## Overview

Migrate the authentication system from session-based to OAuth2 tokens.
This work targets the `feat/auth-refactor` feature branch.

**Target branch: feat/auth-refactor**

## Tasks

### 1. Replace session middleware with token validation

Swap out the Express session middleware for a JWT validation layer.
All routes must validate the Bearer token from the Authorization header.

**Acceptance criteria:**
- Session middleware removed from app.ts
- JWT validation middleware added
- All protected routes require valid token

### 2. Add token refresh endpoint

Create `/auth/refresh` endpoint that accepts a refresh token and returns
a new access token + refresh token pair.

**Acceptance criteria:**
- POST /auth/refresh accepts refresh_token body parameter
- Returns new access_token and refresh_token
- Old refresh token is invalidated

### 3. Update client SDK to use tokens

Update the JavaScript client SDK to store tokens in memory (not cookies)
and auto-refresh before expiration.

**Acceptance criteria:**
- Client stores tokens in closure, not localStorage
- Auto-refresh fires 60s before access_token expiration
- Refresh failure triggers re-authentication flow

## Next Steps

- [ ] Load testing with token validation
- [ ] Security audit of token storage
