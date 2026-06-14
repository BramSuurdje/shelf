CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TYPE user_role AS ENUM ('owner', 'admin', 'user');
CREATE TYPE registration_mode AS ENUM ('invite_only', 'open', 'disabled');
CREATE TYPE node_type AS ENUM ('file', 'folder');
CREATE TYPE node_permission AS ENUM ('viewer', 'editor');
CREATE TYPE file_version_status AS ENUM ('pending', 'complete', 'failed', 'deleted');
CREATE TYPE scan_status AS ENUM ('not_required', 'pending', 'clean', 'failed');
CREATE TYPE upload_kind AS ENUM ('single', 'multipart');
CREATE TYPE upload_status AS ENUM ('pending', 'uploading', 'completed', 'aborted', 'expired', 'failed');
CREATE TYPE public_link_status AS ENUM ('active', 'disabled', 'expired');

CREATE TABLE "user" (
  id text PRIMARY KEY,
  name text NOT NULL,
  email text NOT NULL UNIQUE,
  email_verified boolean NOT NULL DEFAULT false,
  image text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  username text NOT NULL UNIQUE,
  display_username text,
  username_changed_at timestamptz,
  role user_role NOT NULL DEFAULT 'user',
  banned boolean NOT NULL DEFAULT false,
  ban_reason text,
  ban_expires timestamptz,
  storage_quota_bytes bigint,
  disabled_at timestamptz,
  onboarding_completed_at timestamptz,
  preferences jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE session (
  id text PRIMARY KEY,
  expires_at timestamptz NOT NULL,
  token text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  ip_address text,
  user_agent text,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE
);

CREATE TABLE account (
  id text PRIMARY KEY,
  account_id text NOT NULL,
  provider_id text NOT NULL,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  access_token text,
  refresh_token text,
  id_token text,
  access_token_expires_at timestamptz,
  refresh_token_expires_at timestamptz,
  scope text,
  password text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE verification (
  id text PRIMARY KEY,
  identifier text NOT NULL,
  value text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE username_history (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  username text NOT NULL UNIQUE,
  reserved_until timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE devices (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  name text NOT NULL,
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE nodes (
  id text PRIMARY KEY,
  owner_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  parent_id text,
  type node_type NOT NULL,
  name text NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  active_file_version_id text,
  size_bytes bigint NOT NULL DEFAULT 0,
  mime_type text,
  deleted_at timestamptz,
  tombstone_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX nodes_owner_idx ON nodes(owner_id);
CREATE INDEX nodes_parent_idx ON nodes(parent_id);
CREATE UNIQUE INDEX nodes_owner_parent_name_active_unique
  ON nodes(owner_id, coalesce(parent_id, ''), name)
  WHERE deleted_at IS NULL;
CREATE INDEX nodes_name_trgm_idx ON nodes USING gin(name gin_trgm_ops);

CREATE TABLE file_versions (
  id text PRIMARY KEY,
  node_id text NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  owner_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  object_key text NOT NULL UNIQUE,
  size_bytes bigint NOT NULL,
  mime_type text NOT NULL,
  checksum_sha256 text,
  etag text,
  status file_version_status NOT NULL DEFAULT 'pending',
  scan_status scan_status NOT NULL DEFAULT 'not_required',
  thumbnail_object_key text,
  thumbnail_status text NOT NULL DEFAULT 'not_required',
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE TABLE node_permissions (
  node_id text NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  permission node_permission NOT NULL,
  inherited_from_node_id text,
  created_by_user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(node_id, user_id)
);

CREATE TABLE public_links (
  id text PRIMARY KEY,
  node_id text NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  owner_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  password_hash text,
  status public_link_status NOT NULL DEFAULT 'active',
  expires_at timestamptz,
  max_downloads integer,
  download_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE upload_sessions (
  id text PRIMARY KEY,
  owner_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  node_id text NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  file_version_id text NOT NULL REFERENCES file_versions(id) ON DELETE CASCADE,
  object_key text NOT NULL,
  kind upload_kind NOT NULL,
  status upload_status NOT NULL DEFAULT 'pending',
  multipart_upload_id text,
  size_bytes bigint NOT NULL,
  reserved_bytes bigint NOT NULL,
  expires_at timestamptz NOT NULL,
  completed_at timestamptz,
  mutation_id text NOT NULL,
  device_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_id, mutation_id)
);

CREATE TABLE multipart_upload_parts (
  upload_session_id text NOT NULL REFERENCES upload_sessions(id) ON DELETE CASCADE,
  part_number integer NOT NULL,
  etag text,
  size_bytes bigint,
  uploaded_at timestamptz,
  PRIMARY KEY(upload_session_id, part_number)
);

CREATE TABLE avatar_upload_sessions (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  object_key text NOT NULL,
  mime_type text NOT NULL,
  size_bytes bigint NOT NULL,
  status upload_status NOT NULL DEFAULT 'pending',
  expires_at timestamptz NOT NULL,
  completed_at timestamptz,
  mutation_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, mutation_id)
);

CREATE TABLE node_events (
  id text PRIMARY KEY,
  cursor text NOT NULL UNIQUE,
  node_id text NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  device_id text,
  mutation_id text NOT NULL,
  type text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, mutation_id, type)
);

CREATE TABLE quotas (
  user_id text PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  quota_bytes bigint NOT NULL,
  updated_by_user_id text REFERENCES "user"(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE storage_usage (
  user_id text PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  used_bytes bigint NOT NULL DEFAULT 0,
  reserved_bytes bigint NOT NULL DEFAULT 0,
  trash_bytes bigint NOT NULL DEFAULT 0,
  recalculated_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app_settings (
  key text PRIMARY KEY,
  value jsonb,
  encrypted boolean NOT NULL DEFAULT false,
  updated_by_user_id text REFERENCES "user"(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_events (
  id text PRIMARY KEY,
  actor_user_id text REFERENCES "user"(id),
  target_user_id text REFERENCES "user"(id),
  node_id text REFERENCES nodes(id),
  type text NOT NULL,
  ip_hash text,
  user_agent_hash text,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE invites (
  id text PRIMARY KEY,
  email text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  role user_role NOT NULL DEFAULT 'user',
  invited_by_user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  accepted_by_user_id text REFERENCES "user"(id),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public_link_access_events (
  id text PRIMARY KEY,
  public_link_id text NOT NULL REFERENCES public_links(id) ON DELETE CASCADE,
  node_id text NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  outcome text NOT NULL,
  ip_hash text,
  user_agent_hash text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE mutation_receipts (
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  mutation_id text NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id, mutation_id)
);
