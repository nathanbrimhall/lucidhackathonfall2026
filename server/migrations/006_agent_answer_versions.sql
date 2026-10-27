-- Preserve the exact fact and audience grant used by each answer revision.
CREATE TABLE agent_answer_versions (
  request_id TEXT NOT NULL REFERENCES agent_requests(id),
  revision INTEGER NOT NULL,
  answer TEXT NOT NULL,
  allow_publication INTEGER NOT NULL,
  actor_id TEXT NOT NULL REFERENCES users(user_id),
  request_key TEXT NOT NULL,
  input TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(request_id, revision),
  UNIQUE(request_id, request_key)
);
INSERT INTO agent_answer_versions
SELECT id, revision, answer, allow_publication, recipient_id, response_key, response_input, created_at
FROM agent_requests WHERE status='answered' AND answer IS NOT NULL AND response_key IS NOT NULL;
