import type { Pool } from 'pg';

// Transactional, serialized and rerunnable; no migration bookkeeping table is needed.
export async function migrate(database: Pool) {
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(7007)");
    await client.query(`
      CREATE TABLE IF NOT EXISTS flash_sale (
        id text PRIMARY KEY CHECK (length(id) > 0 AND id = lower(btrim(id))),
        starts_at timestamptz NOT NULL,
        ends_at timestamptz NOT NULL CHECK (ends_at > starts_at),
        initial_stock integer NOT NULL CHECK (initial_stock >= 0),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS "order" (
        id text PRIMARY KEY CHECK (length(id) > 0),
        flash_sale_id text NOT NULL REFERENCES flash_sale(id),
        user_identifier text NOT NULL CHECK (length(user_identifier) > 0 AND user_identifier = lower(btrim(user_identifier))),
        admitted_at timestamptz NOT NULL,
        completed_at timestamptz NOT NULL CHECK (completed_at >= admitted_at),
        UNIQUE (flash_sale_id, user_identifier)
      );
      CREATE OR REPLACE FUNCTION protect_flash_sale() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'Sale configuration is immutable; create a new sale';
      END $$;
      DROP TRIGGER IF EXISTS immutable_flash_sale ON flash_sale;
      CREATE TRIGGER immutable_flash_sale BEFORE UPDATE OR DELETE ON flash_sale
        FOR EACH ROW EXECUTE FUNCTION protect_flash_sale();
    `);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
