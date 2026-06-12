-- Employee ID integration with the corporate SAP employee master
-- (external read-only MySQL: balcorpdb.sap_employee_details).
--
-- users.employee_id links an ICP account to the company-wide employee ID
-- (sap_employee_details.EMPID). Used for:
--   1. Login with username OR employee ID
--   2. Onboarding auto-fill (admin types the ID, name/dept/designation fetched)
--   3. Admin mapping tab (replaces the retired UCM extensions tab)
--
-- NULL = not yet mapped. UNIQUE so one employee ID can't be on two accounts.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS employee_id VARCHAR(20) UNIQUE;

CREATE INDEX IF NOT EXISTS idx_users_employee_id
  ON users(employee_id) WHERE employee_id IS NOT NULL;
