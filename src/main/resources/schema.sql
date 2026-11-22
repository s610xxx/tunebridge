CREATE TABLE IF NOT EXISTS app_users (
    id VARCHAR(36) PRIMARY KEY,
    username VARCHAR(64) NOT NULL UNIQUE,
    password_hash VARCHAR(256) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS migration_history (
    id VARCHAR(40) PRIMARY KEY,
    owner_id VARCHAR(36) NOT NULL REFERENCES app_users(id),
    status VARCHAR(32) NOT NULL,
    write_started BOOLEAN NOT NULL DEFAULT FALSE,
    source_provider VARCHAR(32),
    target_provider VARCHAR(32),
    snapshot CLOB NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Databases created before filtering existed only carry the provider names inside the snapshot.
ALTER TABLE migration_history ADD COLUMN IF NOT EXISTS source_provider VARCHAR(32);
ALTER TABLE migration_history ADD COLUMN IF NOT EXISTS target_provider VARCHAR(32);

CREATE INDEX IF NOT EXISTS migration_history_owner_created
    ON migration_history(owner_id, created_at DESC, id);

CREATE INDEX IF NOT EXISTS migration_history_owner_targets
    ON migration_history(owner_id, target_provider, created_at DESC, id);
