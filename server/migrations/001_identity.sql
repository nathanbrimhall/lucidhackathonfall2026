CREATE TABLE users (
  user_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE office_memberships (
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  office_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, office_id)
);
