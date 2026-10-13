-- GuessMe BD — প্রাথমিক স্কিমা (SQLite / libSQL সামঞ্জস্যপূর্ণ)
-- নিয়ম: প্রতিটি স্টেটমেন্ট ";" দিয়ে শেষ হবে এবং ";" অক্ষরটি স্ট্রিং/কমেন্টের ভেতরে থাকবে না।

-- কুইজ: owner_token_hash-এ টোকেনের SHA-256 হ্যাশ থাকে, আসল টোকেন কখনো নয়।
CREATE TABLE IF NOT EXISTS quizzes (
  id               TEXT PRIMARY KEY,
  owner_token_hash TEXT NOT NULL,
  creator_name     TEXT NOT NULL,
  title            TEXT NOT NULL,
  is_closed        INTEGER NOT NULL DEFAULT 0 CHECK (is_closed IN (0, 1)),
  question_count   INTEGER NOT NULL CHECK (question_count BETWEEN 1 AND 30),
  creator_ip_hash  TEXT NOT NULL,
  created_at       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_quizzes_creator_ip_created ON quizzes (creator_ip_hash, created_at);

-- প্রশ্ন: options হলো JSON অ্যারে (২–৪টি স্ট্রিং), correct_index সঠিক উত্তরের ইনডেক্স।
CREATE TABLE IF NOT EXISTS questions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  quiz_id       TEXT NOT NULL REFERENCES quizzes (id) ON DELETE CASCADE,
  position      INTEGER NOT NULL CHECK (position >= 0),
  text          TEXT NOT NULL,
  options_json  TEXT NOT NULL,
  correct_index INTEGER NOT NULL CHECK (correct_index BETWEEN 0 AND 3),
  UNIQUE (quiz_id, position)
);

-- বন্ধুদের খেলা (attempt): কোনো কাঁচা আইপি রাখা হয় না, শুধু HMAC হ্যাশ।
CREATE TABLE IF NOT EXISTS attempts (
  id          TEXT PRIMARY KEY,
  quiz_id     TEXT NOT NULL REFERENCES quizzes (id) ON DELETE CASCADE,
  player_name TEXT NOT NULL,
  score       INTEGER NOT NULL CHECK (score >= 0),
  total       INTEGER NOT NULL CHECK (total >= 1),
  ip_hash     TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_attempts_quiz_created ON attempts (quiz_id, created_at);
CREATE INDEX IF NOT EXISTS idx_attempts_ip_quiz_created ON attempts (ip_hash, quiz_id, created_at);

-- প্রতিটি প্রশ্নের উত্তর
CREATE TABLE IF NOT EXISTS answers (
  attempt_id   TEXT NOT NULL REFERENCES attempts (id) ON DELETE CASCADE,
  question_id  INTEGER NOT NULL REFERENCES questions (id) ON DELETE CASCADE,
  chosen_index INTEGER NOT NULL CHECK (chosen_index BETWEEN 0 AND 3),
  is_correct   INTEGER NOT NULL CHECK (is_correct IN (0, 1)),
  PRIMARY KEY (attempt_id, question_id)
);

CREATE INDEX IF NOT EXISTS idx_answers_question ON answers (question_id);
