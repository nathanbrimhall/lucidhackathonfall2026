CREATE TABLE collaboration_tasks (
 id TEXT PRIMARY KEY, office_id TEXT NOT NULL, owner_id TEXT NOT NULL REFERENCES users(user_id),
 creator_id TEXT NOT NULL REFERENCES users(user_id), request_key TEXT NOT NULL, title TEXT NOT NULL,
 status TEXT NOT NULL, priority TEXT NOT NULL, due_at TEXT, linked_to TEXT REFERENCES collaboration_tasks(id),
 source TEXT, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(office_id,creator_id,request_key)
);
CREATE INDEX collaboration_tasks_office ON collaboration_tasks(office_id,updated_at);
CREATE TABLE task_dependencies (blocked_id TEXT NOT NULL REFERENCES collaboration_tasks(id),blocker_id TEXT NOT NULL REFERENCES collaboration_tasks(id),PRIMARY KEY(blocked_id,blocker_id));
CREATE TABLE task_requesters (task_id TEXT NOT NULL REFERENCES collaboration_tasks(id),user_id TEXT NOT NULL REFERENCES users(user_id),PRIMARY KEY(task_id,user_id));
CREATE TABLE office_profiles (user_id TEXT PRIMARY KEY REFERENCES users(user_id),skills TEXT NOT NULL DEFAULT '',allow_interrupt INTEGER NOT NULL DEFAULT 0);
CREATE TABLE desk_messages (id TEXT PRIMARY KEY,office_id TEXT NOT NULL,sender_id TEXT NOT NULL REFERENCES users(user_id),recipient_id TEXT NOT NULL REFERENCES users(user_id),body TEXT NOT NULL,reply_to TEXT REFERENCES desk_messages(id),request_key TEXT NOT NULL,created_at TEXT NOT NULL,read_at TEXT,UNIQUE(sender_id,request_key));
CREATE TABLE collaboration_notices (id TEXT PRIMARY KEY,office_id TEXT NOT NULL,user_id TEXT NOT NULL REFERENCES users(user_id),text TEXT NOT NULL,created_at TEXT NOT NULL,read_at TEXT);
CREATE TABLE message_drafts (id TEXT PRIMARY KEY,office_id TEXT NOT NULL,owner_id TEXT NOT NULL REFERENCES users(user_id),recipient_id TEXT REFERENCES users(user_id),body TEXT NOT NULL,note_id TEXT NOT NULL REFERENCES notes(id),status TEXT NOT NULL,revision INTEGER NOT NULL,created_at TEXT NOT NULL,sent_message_id TEXT REFERENCES desk_messages(id));
