# Sync safety — why the client's live data can never be changed

The Eclat sync **only reads**. Here are the layers that guarantee it, strongest first.
Show this to the client/IT team if they ask.

## The 4 guarantees

1. **Read-only database account.**
   The agent logs in as `eclat_readonly` (see `create_readonly_login.sql`), which is
   granted `db_datareader` (SELECT) and then **explicitly DENIED** INSERT / UPDATE /
   DELETE / EXECUTE / ALTER / CONTROL. Even if something tried to write, **SQL Server
   itself rejects it.** This is the hard guarantee.

2. **Read-only connection intent.**
   The connection string sets `ApplicationIntent=ReadOnly` and pyodbc opens the
   connection with `readonly=True`. The driver is told, up front, this is read-only.

3. **The code only contains SELECTs.**
   Every query in `sync_sjep.py` is a `SELECT`. There is no INSERT/UPDATE/DELETE/DROP
   anywhere in the agent. It reads rows, then sends them **outbound over HTTPS** to the
   Eclat backend. It opens **no inbound port** on the client PC.

4. **Test-before-pull + proof-by-counts.**
   We always run `python sync_sjep.py --test` first — it only *connects* and logs in,
   it pulls nothing. Then, because we never write, the client's own row counts
   (e.g. `SELECT COUNT(*) FROM JewelTrans`) are **identical before and after** every
   sync. That's the visible proof nothing changed on their side.

## Standard precautions we still take

- **Take a backup first.** Before creating the read-only login, take a normal DB backup
  (insurance only — the agent won't need it).
- **Never use `sa`.** The agent uses the least-privilege `eclat_readonly` account, never
  an admin login.
- **Watermark = no duplicates, no loss.** The agent advances its position only after the
  backend confirms every chunk, so a failed run safely retries — it can't corrupt the
  Eclat side either.

## What touches the client server (and what doesn't)

| Action | Touches client business data? |
|---|---|
| `create_readonly_login.sql` | No — only creates a read-only account definition |
| `--test` connectivity check | No — connects + logs in, reads nothing |
| A sync cycle | Reads only (SELECT); writes **nothing** back |
| Eclat dashboard | Lives in the cloud; client DB never receives a write |
