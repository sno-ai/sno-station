-- The runtime migration entry point performs the conditional object rename before
-- Drizzle records this marker. Static SQLite SQL cannot conditionally ALTER TABLE.
SELECT 1;
