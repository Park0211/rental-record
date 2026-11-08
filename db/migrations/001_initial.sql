CREATE SCHEMA IF NOT EXISTS app;
REVOKE ALL ON SCHEMA app FROM PUBLIC;

CREATE TABLE app.stays (
    id uuid PRIMARY KEY,
    owner_id uuid NOT NULL,
    title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 80),
    city text NOT NULL CHECK (char_length(city) BETWEEN 1 AND 80),
    state text NOT NULL CHECK (char_length(state) = 2),
    street text NOT NULL DEFAULT '',
    unit text NOT NULL DEFAULT '',
    zip_code text NOT NULL DEFAULT '',
    time_zone text NOT NULL,
    archived_at timestamptz,
    deleted_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updateed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.rooms (
    id uuid PRIMARY KEY,
    stay_id uuid NOT NULL REFERENCES app.stays(id),
    name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
    room_type text NOT NULL CHECK (room_type IN ('living_room','bedroom','kitchen','bathroom','hallway','laundry','other')),
    sort_order integer NOT NULL CHECK (sort_order >= 0),
    UNIQUE (id, stay_id)
);

CREATE TABLE app.check_items (
    id uuid PRIMARY KEY,
    stay_id uuid NOT NULL,
    room_id uuid NOT NULL,
    name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
    sort_order integer NOT NULL CHECK (sort_order >= 0),
    UNIQUE (id, stay_id),
    FOREIGN KEY (room_id, stay_id) REFERENCES app.rooms(id, stay_id)
);

CREATE TABLE app.inspections (
    id uuid PRIMARY KEY,
    stay_id uuid NOT NULL REFERENCES app.stays(id),
    kind text NOT NULL CHECK (kind IN ('move_in', 'move_out')),
    status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'completed')),
    inspection_date date,
    edit_version integer NOT NULL DEFAULT 1 CHECK (edit_version > 0),
    baseline_report_id uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    updateed_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (stay_id, kind),
    UNIQUE (id, stay_id),
    UNIQUE (id, stay_id, kind),
    CHECK ((kind = 'move_in' AND baseline_report_id IS NULL) OR (kind = 'move_out' AND baseline_report_id IS NOT NULL))
);

CREATE TABLE app.observations (
    id uuid PRIMARY KEY,
    stay_id uuid NOT NULL,
    inspection_id uuid NOT NULL,
    item_id uuid NOT NULL,
    condition text CHECK (condition IN ('no_issue', 'issue', 'not_applicable', 'not_checked')),
    notes text NOT NULL DEFAULT '' CHECK (char_length(notes) <= 2000),
    updateed_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (inspection_id, item_id),
    UNIQUE (id, stay_id),
    FOREIGN KEY (inspection_id, stay_id) REFERENCES app.inspections(id, stay_id),
    FOREIGN KEY (item_id, stay_id) REFERENCES app.check_items(id, stay_id)
);

CREATE TABLE app.photos (
    id uuid PRIMARY KEY,
    stay_id uuid NOT NULL,
    observation_id uuid NOT NULL,
    client_upload_id uuid NOT NULL,
    source_sha256 text NOT NULL CHECK (char_length(source_sha256) = 64),
    storage_key text NOT NULL UNIQUE,
    preview_key text NOT NULL UNIQUE,
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'failed')),
    stored_mime text NOT NULL DEFAULT 'image/webp',
    byte_size integer,
    width integer,
    height integer,
    uploaded_at timestamptz NOT NULL DEFAULT now(),
    removed_at timestamptz,
    last_error text,
    UNIQUE (stay_id, client_upload_id),
    UNIQUE (id, stay_id),
    FOREIGN KEY (observation_id, stay_id) REFERENCES app.observations(id, stay_id)    
);

CREATE TABLE app.reports (
    id uuid PRIMARY KEY,
    stay_id uuid NOT NULL,
    inspection_id uuid NOT NULL,
    kind text NOT NULL CHECK (kind IN ('move_in', 'move_out')),
    report_version integer NOT NULL CHECK (report_version > 0),
    source_edit_version integer NOT NULL CHECK (source_edit_version > 0),
    request_id uuid NOT NULL,
    snapshot jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (inspection_id, report_version),
    UNIQUE (inspection_id, request_id),
    UNIQUE (id, stay_id),
    FOREIGN KEY (inspection_id, stay_id, kind) REFERENCES app.inspections(id, stay_id, kind)
);

ALTER TABLE app.inspections ADD CONSTRAINT inspection_baseline_fk
    FOREIGN KEY (baseline_report_id, stay_id) REFERENCES app.reports(id, stay_id);

CREATE TABLE app.report_photos (
    stay_id uuid NOT NULL,
    report_id uuid NOT NULL,
    photo_id uuid NOT NULL,
    PRIMARY KEY (report_id, photo_id),
    FOREIGN KEY (report_id, stay_id) REFERENCES app.reports(id, stay_id),
    FOREIGN KEY (photo_id, stay_id) REFERENCES app.photos(id, stay_id)
);

CREATE TABLE app.share_links (
    id uuid PRIMARY KEY,
    stay_id uuid NOT NULL,
    report_id uuid NOT NULL,
    token_hash text NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    CHECK (expires_at > created_at),
    FOREIGN KEY (report_id, stay_id) REFERENCES app.reports(id, stay_id)
);

CREATE INDEX stays_owner_updated_idx ON app.stays(owner_id, archived_at, updated_at DESC);
CREATE INDEX room_stay_order_idx ON app.rooms(stay_id, sort_order);
CREATE INDEX items_room_order_idx ON app.check_items(room_id, sort_order);
CREATE INDEX observations_inspection_idx ON app.observations(inspection_id);
CREATE INDEX photos_observation_current_idx ON app.photos(observation_id, removed_at, status);
CREATE INDEX reports_inspection_version_idx ON app.reports(inspection_id, report_version DESC);
CREATE INDEX report_photos_photo_idx ON app.report_photos(photo_id);
CREATE INDEX share_report_idx ON app.share_links(report_id, created_at DESC);
CREATE UNIQUE INDEX shares_one_unrevoked_idx ON app.share_links(report_id) WHERE revoked_at IS NULL;

CREATE FUNCTION app.reject_report_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Completed reports cannot be updated';
END;
$$;
CREATE TRIGGER report_immutable BEFORE UPDATE ON app.reports
    FOR EACH ROW EXECUTE FUNCTION app.reject_report_update();

DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN
        REVOKE ALL ON SCHEMA app FROM anon;
        REVOKE ALL ON ALL TABLES IN SCHEMA app FROM anon;
    END IF;
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN
        REVOKE ALL ON SCHEMA app FROM authenticated;
        REVOKE ALL ON ALL TABLES IN SCHEMA app FROM authenticated;
    END IF;
END;
$$;
