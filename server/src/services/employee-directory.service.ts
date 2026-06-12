/**
 * Employee Directory — read-only bridge to the corporate SAP employee master.
 *
 * Source: external MySQL (balcorpdb) table `sap_employee_details`, synced from
 * SAP by the corporate side. We NEVER write to it. Used for:
 *   - Onboarding auto-fill: admin types an employee ID → name/dept/designation
 *   - Admin "Employee IDs" tab: search the directory, map IDs to ICP accounts
 *
 * Connection notes:
 *   - Lazy pool: created on first use so the app boots fine when the corporate
 *     DB is unreachable (integration degrades gracefully, login by username
 *     keeps working).
 *   - Only ACTIVE employees are returned (STATUS = 'Active'); withdrawn
 *     employees must not be onboardable or mappable.
 */

import mysql, { Pool } from 'mysql2/promise';
import { config } from '../config';

export interface DirectoryEmployee {
  empId: string;
  name: string;
  designation: string | null;
  department: string | null;
  email: string | null;
  location: string | null;
  status: string;
}

let pool: Pool | null = null;

function isConfigured(): boolean {
  return Boolean(config.extDb.host && config.extDb.user && config.extDb.database);
}

function getPool(): Pool {
  if (!isConfigured()) {
    throw new Error('Employee directory is not configured (EXT_DB_* env vars missing)');
  }
  if (!pool) {
    pool = mysql.createPool({
      host: config.extDb.host,
      port: config.extDb.port,
      user: config.extDb.user,
      password: config.extDb.password,
      database: config.extDb.database,
      connectionLimit: 5,        // read-only lookups; keep footprint tiny
      connectTimeout: 8000,
      enableKeepAlive: true,
    });
  }
  return pool;
}

function mapRow(r: any): DirectoryEmployee {
  return {
    empId: String(r.EMPID).trim(),
    name: String(r.EMPNAME || '').trim(),
    designation: r.EMPDESG ? String(r.EMPDESG).trim() : null,
    department: r.EMPDEPT ? String(r.EMPDEPT).trim() : null,
    email: r.EMAILID ? String(r.EMAILID).trim().toLowerCase() || null : null,
    location: r.LOCATION ? String(r.LOCATION).trim() : null,
    status: String(r.STATUS || '').trim(),
  };
}

/** Exact lookup by employee ID. Returns null when not found or not Active. */
export async function lookupEmployee(empId: string): Promise<DirectoryEmployee | null> {
  const id = String(empId || '').trim();
  if (!id || id.length > 20) return null;
  const [rows] = await getPool().query(
    `SELECT EMPID, EMPNAME, EMPDESG, EMPDEPT, EMAILID, LOCATION, STATUS
       FROM sap_employee_details
      WHERE EMPID = ? AND STATUS = 'Active'
      LIMIT 1`,
    [id],
  );
  const list = rows as any[];
  return list.length ? mapRow(list[0]) : null;
}

/** Search active employees by ID prefix or name substring (admin mapping UI). */
export async function searchEmployees(q: string, limit = 20): Promise<DirectoryEmployee[]> {
  const term = String(q || '').trim();
  if (!term) return [];
  const capped = Math.min(Math.max(limit, 1), 50);
  const [rows] = await getPool().query(
    `SELECT EMPID, EMPNAME, EMPDESG, EMPDEPT, EMAILID, LOCATION, STATUS
       FROM sap_employee_details
      WHERE STATUS = 'Active' AND (EMPID LIKE ? OR EMPNAME LIKE ?)
      ORDER BY EMPNAME
      LIMIT ${capped}`,
    [`${term}%`, `%${term}%`],
  );
  return (rows as any[]).map(mapRow);
}

/** Connectivity probe for the admin health view. */
export async function directoryHealth(): Promise<{ ok: boolean; employees?: number; error?: string }> {
  if (!isConfigured()) return { ok: false, error: 'Not configured (EXT_DB_* env vars missing)' };
  try {
    const [rows] = await getPool().query(
      `SELECT COUNT(*) AS n FROM sap_employee_details WHERE STATUS = 'Active'`,
    );
    return { ok: true, employees: Number((rows as any[])[0]?.n || 0) };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}
