-- Paired hardware companions (e.g. AI Passport). A device token acts as the
-- member who created the device, only on the device overview and approval
-- resolve routes.
CREATE TABLE devices (
    id text PRIMARY KEY DEFAULT ('dev_' || gen_random_uuid()::text),
    workspace_id text NOT NULL REFERENCES workspaces(id),
    name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 64),
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'revoked')),
    token_hash text UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    firmware_version text CHECK (char_length(firmware_version) <= 32),
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    paired_at timestamptz,
    last_seen_at timestamptz,
    revoked_at timestamptz,
    UNIQUE (workspace_id, id),
    FOREIGN KEY (workspace_id, created_by) REFERENCES workspace_members(workspace_id, user_id),
    CHECK (status <> 'active' OR (token_hash IS NOT NULL AND paired_at IS NOT NULL)),
    CHECK (status <> 'revoked' OR (token_hash IS NULL AND revoked_at IS NOT NULL))
);
CREATE INDEX devices_workspace_created_at_idx ON devices(workspace_id, created_at);

CREATE TABLE device_pairing_codes (
    id text PRIMARY KEY DEFAULT ('pair_' || gen_random_uuid()::text),
    workspace_id text NOT NULL REFERENCES workspaces(id),
    device_id text NOT NULL,
    code_hash text NOT NULL UNIQUE CHECK (code_hash ~ '^[0-9a-f]{64}$'),
    expires_at timestamptz NOT NULL DEFAULT (now() + interval '10 minutes'),
    used_at timestamptz,
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (workspace_id, device_id) REFERENCES devices(workspace_id, id),
    FOREIGN KEY (workspace_id, created_by) REFERENCES workspace_members(workspace_id, user_id),
    CHECK (expires_at > created_at)
);
CREATE INDEX device_pairing_codes_expires_at_idx ON device_pairing_codes(expires_at);

CREATE TRIGGER devices_touch_updated_at BEFORE UPDATE ON devices
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER device_pairing_codes_touch_updated_at BEFORE UPDATE ON device_pairing_codes
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
