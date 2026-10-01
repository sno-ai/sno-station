ALTER TABLE `nodix_memory_extraction_timestamps`
ADD COLUMN `time_source` text
CHECK (`time_source` IN ('event_at', 'session_time', 'first_resolution'));
