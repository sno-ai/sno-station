CREATE TABLE IF NOT EXISTS nodix_provider_project_mappings (
  user_id TEXT NOT NULL,
  external_system TEXT NOT NULL,
  external_project_key TEXT NOT NULL,
  project_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (user_id, external_system, external_project_key),
  UNIQUE (project_id)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS nodix_provider_agent_mappings (
  user_id TEXT NOT NULL,
  external_system TEXT NOT NULL,
  external_agent_key TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (user_id, external_system, external_agent_key),
  UNIQUE (agent_id)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS nodix_provider_project_agents (
  user_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (user_id, project_id, agent_id)
);
