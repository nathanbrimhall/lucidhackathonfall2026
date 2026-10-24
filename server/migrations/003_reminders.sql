CREATE TABLE reminders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  office_id TEXT NOT NULL,
  due_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('scheduled', 'due', 'acknowledged', 'canceled')),
  revision INTEGER NOT NULL CHECK (revision > 0),
  record TEXT NOT NULL,
  FOREIGN KEY (user_id, office_id) REFERENCES office_memberships(user_id, office_id)
);
CREATE INDEX reminders_due ON reminders(status, due_at);
CREATE INDEX reminders_owner ON reminders(user_id, office_id);

CREATE TABLE reminder_requests (
  user_id TEXT NOT NULL,
  office_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  response TEXT NOT NULL,
  PRIMARY KEY(user_id, office_id, request_id),
  FOREIGN KEY (user_id, office_id) REFERENCES office_memberships(user_id, office_id)
);

CREATE TABLE notification_outbox (
  id TEXT PRIMARY KEY,
  reminder_id TEXT NOT NULL REFERENCES reminders(id),
  revision INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'acknowledged', 'invalidated')),
  created_at INTEGER NOT NULL,
  UNIQUE(reminder_id, revision)
);
CREATE INDEX reminder_pending_delivery ON notification_outbox(state, reminder_id);
