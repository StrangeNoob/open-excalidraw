-- What a personal access token may do: 'read' (safe methods only), 'write'
-- (adds unsafe methods but not /api/v1/admin) or 'full' (everything its owner
-- can do over REST). NULL is a token minted before scopes existed and resolves
-- to 'full', so tokens already deployed keep working unchanged.
ALTER TABLE personal_access_tokens
  ADD COLUMN scopes TEXT CHECK (scopes IN ('read', 'write', 'full'));
