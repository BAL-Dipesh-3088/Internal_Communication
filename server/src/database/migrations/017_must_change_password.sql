-- Forced password change at first login (enterprise temp-password flow).
--
-- TRUE when the current password is a TEMPORARY one that someone other than
-- the account owner knows:
--   - set at onboarding (admin chose the initial password), and
--   - set whenever an admin resets the password.
-- The login flow blocks the app behind a "set your new password" gate until
-- the user picks their own password, which clears the flag.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT false;
