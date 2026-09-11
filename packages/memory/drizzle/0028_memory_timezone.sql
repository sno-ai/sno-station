ALTER TABLE nodix_memories
ADD COLUMN timezone TEXT NOT NULL DEFAULT '__missing_timezone__';
--> statement-breakpoint

UPDATE nodix_memories
SET timezone = 'UTC'
WHERE timezone = '__missing_timezone__';
--> statement-breakpoint

CREATE TRIGGER nodix_memories_timezone_required_before_insert
BEFORE INSERT ON nodix_memories
WHEN NEW.timezone = '__missing_timezone__' OR trim(NEW.timezone) = ''
BEGIN
  SELECT RAISE(ABORT, 'timezone is required');
END;
--> statement-breakpoint

CREATE TRIGGER nodix_memories_timezone_required_before_update
BEFORE UPDATE OF timezone ON nodix_memories
WHEN NEW.timezone = '__missing_timezone__' OR trim(NEW.timezone) = ''
BEGIN
  SELECT RAISE(ABORT, 'timezone is required');
END;
