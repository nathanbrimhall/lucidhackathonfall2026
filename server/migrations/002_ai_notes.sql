CREATE TABLE ai_sessions (
  id TEXT PRIMARY KEY, meeting_session_id TEXT NOT NULL, office_id TEXT NOT NULL,
  request_key TEXT NOT NULL UNIQUE, status TEXT NOT NULL, revision INTEGER NOT NULL,
  record TEXT NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX ai_meeting ON ai_sessions(meeting_session_id, updated_at);
CREATE TABLE ai_consents (
  ai_session_id TEXT NOT NULL REFERENCES ai_sessions(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL, user_id TEXT NOT NULL REFERENCES users(user_id), consent INTEGER NOT NULL,
  PRIMARY KEY(ai_session_id, revision, user_id)
);
CREATE TABLE transcript_segments (
  ai_session_id TEXT NOT NULL REFERENCES ai_sessions(id) ON DELETE CASCADE,
  id TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY(ai_session_id, id)
);
CREATE TABLE notes (
  id TEXT PRIMARY KEY, ai_session_id TEXT NOT NULL UNIQUE REFERENCES ai_sessions(id), record TEXT NOT NULL
);
CREATE TABLE note_readers (
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(user_id),
  PRIMARY KEY(note_id, user_id)
);
CREATE TABLE jobs (
  id TEXT PRIMARY KEY, ai_session_id TEXT NOT NULL REFERENCES ai_sessions(id), revision INTEGER NOT NULL,
  kind TEXT NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT, lease_until INTEGER, created_at INTEGER NOT NULL,
  UNIQUE(ai_session_id, revision, kind)
);
CREATE INDEX ai_jobs_claim ON jobs(state, created_at);
