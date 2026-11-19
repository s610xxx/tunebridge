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
    snapshot CLOB NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS migration_history_owner_created
    ON migration_history(owner_id, created_at DESC, id);
