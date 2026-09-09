ALTER TABLE nodix_memories ADD COLUMN subject TEXT;
--> statement-breakpoint
ALTER TABLE nodix_memories ADD COLUMN attribute TEXT;
--> statement-breakpoint
ALTER TABLE nodix_memories ADD COLUMN valid_from INTEGER;
--> statement-breakpoint
ALTER TABLE nodix_memories ADD COLUMN valid_until INTEGER;
--> statement-breakpoint
ALTER TABLE nodix_memories ADD COLUMN maturity TEXT;
--> statement-breakpoint
ALTER TABLE nodix_memories ADD COLUMN source TEXT;
--> statement-breakpoint
ALTER TABLE nodix_memories ADD COLUMN extractor_version TEXT;
--> statement-breakpoint

CREATE INDEX nodix_idx_memories_project_subject_attribute
ON nodix_memories(project_id, subject, attribute);
--> statement-breakpoint
CREATE INDEX nodix_idx_memories_project_valid_time
ON nodix_memories(project_id, valid_from, valid_until);
--> statement-breakpoint
CREATE INDEX nodix_idx_memories_project_maturity
ON nodix_memories(project_id, maturity);
--> statement-breakpoint
CREATE INDEX nodix_idx_memories_project_source
ON nodix_memories(project_id, source);
--> statement-breakpoint
CREATE INDEX nodix_idx_memories_project_extractor_version
ON nodix_memories(project_id, extractor_version);
--> statement-breakpoint
CREATE INDEX nodix_idx_memories_project_derived_from
ON nodix_memories(project_id, derived_from);
--> statement-breakpoint
CREATE INDEX nodix_idx_memories_project_importance
ON nodix_memories(project_id, importance);
--> statement-breakpoint

CREATE TABLE nodix_memory_relations (
  source_card_id TEXT NOT NULL REFERENCES nodix_memories(id) ON DELETE CASCADE,
  subject TEXT NOT NULL,
  predicate TEXT NOT NULL CHECK (predicate IN (
    'IS_A',
    'WORKS_ON',
    'NEEDS',
    'PREFERS',
    'FORBIDS',
    'USES',
    'DEPENDS_ON',
    'CAUSED',
    'FIXED_BY',
    'DECIDED',
    'SUPERSEDES',
    'GOVERNED_BY',
    'OWNED_BY',
    'MEMBER_OF',
    'LOCATED_AT',
    'HAS_SKILL',
    'INTERESTED_IN',
    'HAS_ACCOUNT',
    'HAS_OCCUPATION',
    'HAS_METRIC',
    'WORKS_AT',
    'ATTENDED',
    'MENTIONS'
  )),
  object TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(source_card_id, subject, predicate, object)
);
--> statement-breakpoint
CREATE INDEX nodix_idx_memory_relations_subject
ON nodix_memory_relations(subject);
--> statement-breakpoint
CREATE INDEX nodix_idx_memory_relations_object
ON nodix_memory_relations(object);
--> statement-breakpoint

CREATE TABLE nodix_memory_suppressions (
  project_id TEXT NOT NULL,
  subject TEXT,
  attribute TEXT,
  content_hash TEXT,
  created_at INTEGER NOT NULL,
  CHECK (
    (
      subject IS NOT NULL AND length(trim(subject)) > 0
      AND attribute IS NOT NULL AND length(trim(attribute)) > 0
      AND content_hash IS NULL
    )
    OR
    (
      subject IS NULL
      AND attribute IS NULL
      AND content_hash IS NOT NULL AND length(trim(content_hash)) > 0
    )
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX nodix_idx_memory_suppressions_key
ON nodix_memory_suppressions(project_id, subject, attribute)
WHERE subject IS NOT NULL AND attribute IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX nodix_idx_memory_suppressions_content
ON nodix_memory_suppressions(project_id, content_hash)
WHERE content_hash IS NOT NULL;
